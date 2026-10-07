import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';

/**
 * Polite, SSRF-safe HTTP fetcher for public company websites.
 *  - http(s) only, standard ports, no credentials in URLs
 *  - every connection's resolved address is checked at connect time (no private, loopback, link-local,
 *    CGNAT, multicast or metadata ranges — also defeats DNS rebinding)
 *  - redirects are followed manually (max 3) and re-validated
 *  - hard timeout and response-size cap; HTML/XML/text only
 *  - honours robots.txt for our user agent
 */

export const USER_AGENT = `LeadsCRM-Enrichment/1.0 (+${process.env.APP_URL ?? 'https://localhost'}/bot)`;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;

function privateV4(ip: string) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function isBlockedAddress(ip: string) {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateV4(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

/** DNS lookup that refuses to connect to internal addresses. */
export const safeLookup: LookupFunction = (hostname, options, cb) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err, '', 4);
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as { address: string; family: number }[];
    const ok = list.filter((a) => !isBlockedAddress(a.address));
    if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error(`Blocked address for ${hostname}`), { code: 'EBLOCKED' }), '', 4);
    if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof ok) => void)(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
};

export class FetchError extends Error {
  constructor(message: string, public code: string) { super(message); }
}

export function validateUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError('Invalid URL', 'invalid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs', 'invalid');
  if (u.username || u.password) throw new FetchError('Credentials in URL', 'invalid');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) throw new FetchError('Non-standard port', 'invalid');
  if (isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw new FetchError('IP addresses are not crawled', 'invalid');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) throw new FetchError('Invalid host', 'invalid');
  return u;
}

export type FetchResult = { url: string; status: number; contentType: string; body: string };

function once(u: URL, accept: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', lookup: safeLookup, timeout: TIMEOUT_MS,
      headers: { 'user-agent': USER_AGENT, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en;q=0.9,*;q=0.5' },
    }, (res) => {
      const type = String(res.headers['content-type'] ?? '');
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) { res.resume(); return resolve({ status, headers: res.headers, body: '' }); }
      if (status === 200 && type && !/text\/html|application\/xhtml|text\/plain|xml/i.test(type)) { res.destroy(); return reject(new FetchError(`Unsupported content type ${type}`, 'type')); }
      const enc = String(res.headers['content-encoding'] ?? '');
      const stream = enc.includes('br') ? res.pipe(zlib.createBrotliDecompress()) : enc.includes('gzip') ? res.pipe(zlib.createGunzip()) : enc.includes('deflate') ? res.pipe(zlib.createInflate()) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); stream.destroy(); resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (e: Error) => reject(new FetchError(e.message, 'decode')));
    });
    req.on('timeout', () => req.destroy(new FetchError('Timed out', 'timeout')));
    req.on('error', (e: Error & { code?: string }) => reject(e instanceof FetchError ? e : new FetchError(e.message, e.code === 'EBLOCKED' ? 'blocked' : 'network')));
    req.end();
  });
}

export async function safeFetch(raw: string, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'): Promise<FetchResult> {
  let u = validateUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const r = await once(u, accept);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      u = validateUrl(new URL(r.headers.location, u).toString());
      continue;
    }
    return { url: u.toString(), status: r.status, contentType: String(r.headers['content-type'] ?? ''), body: r.body };
  }
  throw new FetchError('Too many redirects', 'redirects');
}

// ── robots.txt ─────────────────────────────────────────────────────

export type Robots = { allow: string[]; disallow: string[]; delayMs: number };

/** Rules for our agent (or `*`). Longest matching rule wins; Allow wins ties. */
export function parseRobots(txt: string): Robots {
  const groups: { agents: string[]; allow: string[]; disallow: string[]; delay: number }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [k, v] = [m[1].toLowerCase(), m[2].trim()];
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], allow: [], disallow: [], delay: 0 }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (k === 'allow' && v) cur.allow.push(v);
    if (k === 'disallow' && v) cur.disallow.push(v);
    if (k === 'crawl-delay') cur.delay = Math.min(10, Number(v) || 0);
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && 'leadscrm-enrichment'.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  return { allow: mine?.allow ?? [], disallow: mine?.disallow ?? [], delayMs: (mine?.delay ?? 0) * 1000 };
}

const ruleMatch = (rule: string, path: string) => {
  const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
  return re.test(path);
};
export function robotsAllows(r: Robots, path: string) {
  const a = r.allow.filter((x) => ruleMatch(x, path)).sort((x, y) => y.length - x.length)[0];
  const d = r.disallow.filter((x) => ruleMatch(x, path)).sort((x, y) => y.length - x.length)[0];
  if (!d) return true;
  return Boolean(a && a.length >= d.length);
}

export async function fetchRobots(origin: string): Promise<Robots> {
  try {
    const r = await safeFetch(`${origin}/robots.txt`, 'text/plain,*/*;q=0.5');
    if (r.status >= 400 && r.status < 500) return { allow: [], disallow: [], delayMs: 0 };
    if (r.status >= 500) return { allow: [], disallow: ['/'], delayMs: 0 }; // server trouble: treat as "don't crawl"
    return parseRobots(r.body.slice(0, 200_000));
  } catch {
    return { allow: [], disallow: [], delayMs: 0 };
  }
}
