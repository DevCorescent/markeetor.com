import type { Prisma, SmtpAccount } from '@prisma/client';
import { generateKeyPairSync } from 'node:crypto';
import { resolveCname, resolveMx, resolveTxt } from 'node:dns/promises';
import { audit } from '../audit';
import { assertCan, type AuthContext } from '../auth/context';
import { decrypt, encrypt } from '../crypto';
import { withPlatform } from '../db';
import { AppError, notFound } from '../errors';

/**
 * Deliverability: everything that decides inbox vs spam that the app controls (SMTP greeting name,
 * DKIM signing, standard headers, never linking to non-public URLs) plus a DNS checker for the parts
 * only the domain owner can fix (SPF, DKIM, DMARC, MX).
 */

export const domainOf = (email: string) => email.split('@')[1]?.toLowerCase().trim() ?? '';

/** True when APP_URL is a public https origin, i.e. safe to put in emails (tracking, unsubscribe, links). */
export function publicAppUrl(url = process.env.APP_URL ?? '') {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    return !(h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '::1');
  } catch {
    return false;
  }
}

/** Tracking pixels and redirect links are only added when they point at a real public https domain. */
export const trackingAllowed = () => publicAppUrl() || process.env.NODE_ENV === 'test';

/** SMTP transport extras for a sender: greeting (EHLO) name of the From domain and DKIM signing when enabled. */
export function transportExtras(acc: Pick<SmtpAccount, 'fromEmail' | 'dkimEnabled' | 'dkimSelector' | 'dkimPrivateKeyEnc'>) {
  const domain = domainOf(acc.fromEmail);
  return {
    // Without this nodemailer greets with the machine's hostname (e.g. "laptop.local"), a classic spam signal.
    ...(domain ? { name: domain } : {}),
    ...(acc.dkimEnabled && acc.dkimSelector && acc.dkimPrivateKeyEnc && domain
      ? { dkim: { domainName: domain, keySelector: acc.dkimSelector, privateKey: decrypt(acc.dkimPrivateKeyEnc) } }
      : {}),
  };
}

/**
 * Headers every bulk/marketing email needs for Gmail & Yahoo: RFC 8058 one-click unsubscribe (pointing at an
 * endpoint that accepts the provider's POST) and a Feedback-ID for Gmail Postmaster Tools.
 */
export function bulkHeaders(opts: { trackingToken: string; feedbackId: string; marketing: boolean }) {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  const headers: Record<string, string> = { 'Feedback-ID': `${opts.feedbackId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}:markeetor` };
  if (opts.marketing) {
    headers['List-Unsubscribe'] = `<${base}/api/v1/email/unsubscribe/${opts.trackingToken}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

// ── DKIM keys ──────────────────────────────────────────────────────

const dkimTxt = (publicKey: string) => `v=DKIM1; k=rsa; p=${publicKey}`;

async function loadPlatformSender(ctx: AuthContext, id: string) {
  const acc = await withPlatform((tx) => tx.smtpAccount.findFirst({ where: { id, deletedAt: null, organizationId: ctx.scope === 'PLATFORM' ? null : ctx.orgId! } }));
  if (!acc) throw notFound('Sender');
  return acc;
}

/** Generates (or replaces) a 2048-bit DKIM key for a sender. Signing starts once the DNS record is verified. */
export async function generateDkim(ctx: AuthContext, id: string) {
  assertCan(ctx, 'email.manage', 'crm.email.manage');
  const acc = await loadPlatformSender(ctx, id);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const d = new Date();
  const selector = `mk${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  await withPlatform(async (tx) => {
    await tx.smtpAccount.update({ where: { id }, data: { dkimSelector: selector, dkimPublicKey: pub, dkimPrivateKeyEnc: encrypt(pem), dkimEnabled: false } });
    await audit(tx, ctx, { action: 'email.smtp.dkim_generated', targetType: 'smtp_account', targetId: id, organizationId: acc.organizationId, metadata: { selector } });
  });
  return dkimRecord({ ...acc, dkimSelector: selector, dkimPublicKey: pub });
}

export function dkimRecord(acc: Pick<SmtpAccount, 'fromEmail' | 'dkimSelector' | 'dkimPublicKey'>) {
  if (!acc.dkimSelector || !acc.dkimPublicKey) return null;
  return { host: `${acc.dkimSelector}._domainkey.${domainOf(acc.fromEmail)}`, type: 'TXT', value: dkimTxt(acc.dkimPublicKey) };
}

/** Turns DKIM signing on (only once the public key is visible in DNS) or off. */
export async function setDkim(ctx: AuthContext, id: string, enabled: boolean, resolver: Resolver = dnsResolver) {
  assertCan(ctx, 'email.manage', 'crm.email.manage');
  const acc = await loadPlatformSender(ctx, id);
  if (enabled) {
    if (!acc.dkimSelector || !acc.dkimPublicKey) throw new AppError('PRECONDITION_FAILED', 'Generate a DKIM key first');
    const txt = await lookupTxt(resolver, `${acc.dkimSelector}._domainkey.${domainOf(acc.fromEmail)}`);
    if (!txt.some((t) => t.replace(/\s+/g, '').includes(acc.dkimPublicKey!))) {
      throw new AppError('PRECONDITION_FAILED', 'The DKIM record is not visible in DNS yet. Add it at your DNS provider, wait a few minutes and try again.');
    }
  }
  await withPlatform(async (tx) => {
    await tx.smtpAccount.update({ where: { id }, data: { dkimEnabled: enabled } });
    await audit(tx, ctx, { action: enabled ? 'email.smtp.dkim_enabled' : 'email.smtp.dkim_disabled', targetType: 'smtp_account', targetId: id, organizationId: acc.organizationId });
  });
  return { enabled };
}

// ── DNS checks ─────────────────────────────────────────────────────

export type Resolver = { txt: (name: string) => Promise<string[][]>; mx: (name: string) => Promise<{ exchange: string; priority: number }[]>; cname: (name: string) => Promise<string[]> };
const dnsResolver: Resolver = { txt: resolveTxt, mx: resolveMx, cname: resolveCname };

async function lookupTxt(r: Resolver, name: string) {
  try {
    return (await r.txt(name)).map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

type Provider = { match: RegExp; name: string; spf: string; dkimSelectors: string[]; freeDomains?: string[] };
const PROVIDERS: Provider[] = [
  { match: /(^|\.)(gmail|google|googlemail)\.com$/, name: 'Google Workspace / Gmail', spf: 'include:_spf.google.com', dkimSelectors: ['google'], freeDomains: ['gmail.com', 'googlemail.com'] },
  { match: /(office365|outlook)\.com$/, name: 'Microsoft 365', spf: 'include:spf.protection.outlook.com', dkimSelectors: ['selector1', 'selector2'], freeDomains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'] },
  { match: /amazonaws\.com$/, name: 'Amazon SES', spf: 'include:amazonses.com', dkimSelectors: [] },
  { match: /sendgrid\.net$/, name: 'SendGrid', spf: 'include:sendgrid.net', dkimSelectors: ['s1', 's2', 'smtpapi'] },
  { match: /mailgun\.org$/, name: 'Mailgun', spf: 'include:mailgun.org', dkimSelectors: ['k1', 'mx', 'smtp', 'mailo'] },
  { match: /postmarkapp\.com$/, name: 'Postmark', spf: 'include:spf.mtasv.net', dkimSelectors: ['pm'] },
  { match: /zoho\.(com|in|eu)$/, name: 'Zoho Mail', spf: 'include:zoho.com', dkimSelectors: ['zmail', 'zoho'], freeDomains: ['zohomail.com'] },
  { match: /(brevo|sendinblue)\.com$/, name: 'Brevo', spf: 'include:spf.brevo.com', dkimSelectors: ['mail', 'brevo1'] },
  { match: /hostinger\.com$/, name: 'Hostinger Email', spf: 'include:_spf.mail.hostinger.com', dkimSelectors: ['hostingermail-a', 'hostingermail-b', 'hostingermail-c', 'hostingermail1', 'hostingermail2', 'hostingermail3'] },
  { match: /titan\.email$/, name: 'Titan Email', spf: 'include:spf.titan.email', dkimSelectors: ['titan1', 'titan2'] },
  { match: /secureserver\.net$/, name: 'GoDaddy Email', spf: 'include:secureserver.net', dkimSelectors: ['default'] },
  { match: /privateemail\.com$/, name: 'Namecheap Private Email', spf: 'include:spf.privateemail.com', dkimSelectors: ['default'] },
];
const FREE_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'gmx.com', 'mail.com', 'zohomail.com', 'yandex.com'];
const COMMON_SELECTORS = ['default', 'dkim', 'mail', 'selector1', 'selector2', 'google', 's1', 's2', 'k1'];

export type Check = { key: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string; fix?: { host: string; type: string; value: string } | null };

/** Checks a sender's domain and settings against what Gmail, Yahoo and Microsoft require. Never sends mail. */
export async function analyzeSender(acc: Pick<SmtpAccount, 'host' | 'username' | 'fromEmail' | 'status' | 'dailyLimit' | 'dkimEnabled' | 'dkimSelector' | 'dkimPublicKey'>, r: Resolver = dnsResolver): Promise<{ score: number; domain: string; provider: string | null; checks: Check[] }> {
  const domain = domainOf(acc.fromEmail);
  const host = acc.host.toLowerCase();
  const provider = PROVIDERS.find((p) => p.match.test(host)) ?? null;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // 1. From address domain.
  if (FREE_MAIL.includes(domain)) {
    const own = provider?.freeDomains?.includes(domain);
    add({
      key: 'domain', label: 'Sending domain', status: own ? 'warn' : 'fail',
      detail: own
        ? `${domain} is a free mailbox. It works for a few personal emails a day, but bulk or automated mail from a free address lands in spam. Send from your own domain (e.g. hello@yourcompany.com).`
        : `You are sending as @${domain} through ${acc.host}. ${domain} publishes a strict DMARC policy, so receivers reject or spam this mail. Use an address on your own domain.`,
    });
  } else {
    add({ key: 'domain', label: 'Sending domain', status: 'pass', detail: `Mail is sent as @${domain}, your own domain.` });
  }

  // 2. SMTP login vs From.
  const userDomain = acc.username.includes('@') ? domainOf(acc.username) : null;
  if (userDomain && userDomain !== domain && provider && /Google|Microsoft|Zoho/.test(provider.name)) {
    add({ key: 'alignment', label: 'From address matches the mailbox', status: 'warn', detail: `You log in as ${acc.username} but send as ${acc.fromEmail}. ${provider.name} rewrites or rejects the From address unless it is a verified alias of that mailbox.` });
  }

  const ownDomain = !FREE_MAIL.includes(domain);
  if (ownDomain && domain) {
    // 3. MX.
    let mx: { exchange: string }[] = [];
    try {
      mx = await r.mx(domain);
    } catch {}
    add(mx.length
      ? { key: 'mx', label: 'Domain can receive mail (MX)', status: 'pass', detail: `MX: ${mx.slice(0, 2).map((m) => m.exchange).join(', ')}` }
      : { key: 'mx', label: 'Domain can receive mail (MX)', status: 'warn', detail: `${domain} has no MX record, so replies and bounces cannot be delivered. Some filters treat this as a sign of a throwaway domain.` });

    // 4. SPF.
    const txt = await lookupTxt(r, domain);
    const spf = txt.filter((t) => t.toLowerCase().startsWith('v=spf1'));
    const want = provider?.spf ?? null;
    if (!spf.length) {
      add({ key: 'spf', label: 'SPF', status: 'fail', detail: `No SPF record: receivers cannot tell that ${acc.host} may send for ${domain}.`, fix: { host: domain, type: 'TXT', value: `v=spf1 ${want ?? 'include:<your email provider>'} ~all` } });
    } else if (spf.length > 1) {
      add({ key: 'spf', label: 'SPF', status: 'fail', detail: 'There are several SPF records. Only one is allowed; merge them into one record.', fix: { host: domain, type: 'TXT', value: `v=spf1 ${want ?? ''} ~all`.replace(/\s+/g, ' ') } });
    } else if (/\s\+all\b/.test(spf[0])) {
      add({ key: 'spf', label: 'SPF', status: 'fail', detail: '“+all” lets anyone send as your domain. Use ~all or -all.' });
    } else if (want && !spf[0].includes(want.replace('include:', ''))) {
      add({ key: 'spf', label: 'SPF', status: 'fail', detail: `Your SPF record does not include ${provider!.name}: ${spf[0]}`, fix: { host: domain, type: 'TXT', value: spf[0].replace(/\s*([~?-]all)\s*$/, ` ${want} $1`) } });
    } else {
      add({ key: 'spf', label: 'SPF', status: want ? 'pass' : 'warn', detail: want ? spf[0] : `${spf[0]}. Make sure it authorises ${acc.host}.` });
    }

    // 5. DKIM.
    if (acc.dkimSelector && acc.dkimPublicKey) {
      const rec = await lookupTxt(r, `${acc.dkimSelector}._domainkey.${domain}`);
      const live = rec.some((t) => t.replace(/\s+/g, '').includes(acc.dkimPublicKey!));
      add(live
        ? { key: 'dkim', label: 'DKIM', status: acc.dkimEnabled ? 'pass' : 'warn', detail: acc.dkimEnabled ? `Signing with selector ${acc.dkimSelector}.` : 'The DKIM record is published. Turn signing on.' }
        : { key: 'dkim', label: 'DKIM', status: 'fail', detail: 'The DKIM key was generated but its DNS record is not visible yet.', fix: dkimRecord(acc) });
    } else {
      const selectors = [...new Set([...(provider?.dkimSelectors ?? []), ...COMMON_SELECTORS])];
      let found: string | null = null;
      for (const sel of selectors) {
        const name = `${sel}._domainkey.${domain}`;
        const t = await lookupTxt(r, name);
        let cname: string[] = [];
        if (!t.length) try { cname = await r.cname(name); } catch {}
        if (t.some((x) => /p=/.test(x)) || cname.length) { found = sel; break; }
      }
      add(found
        ? { key: 'dkim', label: 'DKIM', status: 'pass', detail: `A DKIM key is published at selector “${found}”. Make sure ${provider?.name ?? 'your provider'} signs with it, or generate one here.` }
        : { key: 'dkim', label: 'DKIM', status: 'fail', detail: `No DKIM signature for ${domain}. Gmail and Yahoo require DKIM; without it mail goes to spam. Generate a key below (or turn on DKIM in ${provider?.name ?? 'your email provider'}).` });
    }

    // 6. DMARC.
    const dmarc = (await lookupTxt(r, `_dmarc.${domain}`)).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
    if (!dmarc) {
      add({ key: 'dmarc', label: 'DMARC', status: 'fail', detail: 'No DMARC record. Gmail and Yahoo require one for anyone sending in bulk.', fix: { host: `_dmarc.${domain}`, type: 'TXT', value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; adkim=r; aspf=r` } });
    } else {
      const p = /p=(\w+)/i.exec(dmarc)?.[1]?.toLowerCase();
      add({ key: 'dmarc', label: 'DMARC', status: 'pass', detail: p === 'none' ? `${dmarc} (monitoring only; move to p=quarantine once reports look clean)` : dmarc });
    }
  }

  // 7. Links in emails.
  const app = process.env.APP_URL ?? '';
  add(publicAppUrl(app)
    ? { key: 'links', label: 'Links, tracking & unsubscribe', status: 'pass', detail: `Emails link to ${new URL(app).origin}.` }
    : { key: 'links', label: 'Links, tracking & unsubscribe', status: 'fail', detail: `APP_URL is “${app || 'not set'}”. Emails would contain links to a private or non-https address, which spam filters flag (and recipients can’t open). Open/click tracking is switched off until APP_URL is your public https domain.` });

  // 8. Sender health.
  if (acc.status !== 'VERIFIED') add({ key: 'smtp', label: 'SMTP connection', status: 'warn', detail: 'This sender has not passed “Verify” yet.' });
  if (acc.dailyLimit > 2000) add({ key: 'volume', label: 'Sending volume', status: 'warn', detail: `Daily limit is ${acc.dailyLimit}. New domains should warm up: start around 50–200 a day and increase gradually over 2–4 weeks.` });

  const weight = { pass: 1, warn: 0.5, fail: 0 };
  const score = Math.round((checks.reduce((n, c) => n + weight[c.status], 0) / checks.length) * 100);
  return { score, domain, provider: provider?.name ?? null, checks };
}

export async function checkSender(ctx: AuthContext, id: string, resolver: Resolver = dnsResolver) {
  assertCan(ctx, 'email.manage', 'crm.email.manage');
  const acc = await loadPlatformSender(ctx, id);
  const result = await analyzeSender(acc, resolver);
  await withPlatform((tx) => tx.smtpAccount.update({ where: { id }, data: { deliverability: result as unknown as Prisma.InputJsonValue, deliverabilityAt: new Date() } }));
  return { ...result, dkim: dkimRecord(acc), dkimEnabled: acc.dkimEnabled, checkedAt: new Date() };
}
