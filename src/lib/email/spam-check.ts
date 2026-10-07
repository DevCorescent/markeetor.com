import type { Block, EmailDesign } from './types';

/**
 * Content checks that mirror what spam filters (SpamAssassin, Gmail, Microsoft) penalise. Runs in the
 * editor as you type; it cannot see DNS or sender reputation (see Senders → Deliverability for those).
 */

export type ContentIssue = { level: 'fail' | 'warn' | 'info'; message: string };

const PHRASES = [
  'act now', 'apply now', 'as seen on', 'buy direct', 'call now', 'cash bonus', 'click below', 'click here', 'congratulations', 'dear friend',
  'double your', 'earn extra cash', 'eliminate debt', 'exclusive deal', 'extra income', 'fast cash', 'for free', 'free gift', 'free access', 'free money',
  'free trial', 'get paid', 'guaranteed', 'increase sales', 'limited time', 'lowest price', 'make money', 'miracle', 'no catch', 'no cost', 'no credit check',
  'no obligation', 'once in a lifetime', 'order now', 'risk-free', 'risk free', 'special promotion', 'this is not spam', 'urgent', 'what are you waiting for',
  'winner', 'you have been selected', 'you won', '100% free', '100% satisfied', 'best price', 'cheap', 'credit card', 'lose weight', 'work from home', 'viagra', 'casino', 'crypto giveaway',
];
const SHORTENERS = /^(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|buff\.ly|shorturl\.at|rb\.gy|tiny\.cc|s\.id)$/i;

const stripTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ');

function blockText(b: Block): string {
  switch (b.type) {
    case 'heading': return b.text;
    case 'text': case 'footer': case 'html': return stripTags(b.html);
    case 'quote': return `${stripTags(b.html)} ${b.author}`;
    case 'columns': return `${stripTags(b.left)} ${stripTags(b.right)}`;
    case 'button': return b.label;
    default: return '';
  }
}

function links(design: EmailDesign): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const b of design.blocks) {
    if (b.type === 'button') out.push({ href: b.url, text: b.label });
    if (b.type === 'image' && b.href) out.push({ href: b.href, text: '' });
    const htmls = b.type === 'columns' ? [b.left, b.right] : 'html' in b ? [b.html] : [];
    for (const h of htmls) for (const m of h.matchAll(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) out.push({ href: m[1], text: stripTags(m[2]).trim() });
  }
  return out;
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

export function checkContent(doc: { subject: string; preheader?: string | null; design: EmailDesign }, opts: { marketing?: boolean } = {}): { score: number; issues: ContentIssue[] } {
  const issues: ContentIssue[] = [];
  const add = (level: ContentIssue['level'], message: string) => issues.push({ level, message });
  const subject = doc.subject.trim();
  const body = doc.design.blocks.map(blockText).join(' ').replace(/\{\{\s*\w+\s*\}\}/g, 'Name').replace(/\s+/g, ' ').trim();
  const words = body.split(' ').filter(Boolean);
  const lower = `${subject} ${body}`.toLowerCase();

  // Subject line.
  if (!subject) add('fail', 'The subject line is empty.');
  else {
    if (subject.length > 70) add('warn', `The subject is ${subject.length} characters; keep it under about 60 so it isn’t cut off.`);
    const letters = subject.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 8 && letters === letters.toUpperCase()) add('fail', 'The subject is ALL CAPS, a strong spam signal.');
    else if ((subject.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !/^(HTTP|HTTPS|HTML|PDF|CRM|API|USA|GST|INR|USD)$/.test(w)).length >= 2) add('warn', 'Several shouted (ALL CAPS) words in the subject.');
    if ((subject.match(/!/g) ?? []).length > 1) add('warn', 'Use at most one exclamation mark in the subject.');
    if (/[$€£₹]{2,}|\$\d+.*free/i.test(subject)) add('warn', 'Money symbols in the subject look promotional.');
    if (/^(re|fw|fwd):/i.test(subject)) add('fail', 'Starting with “Re:” or “Fwd:” when it isn’t a reply is deceptive and penalised.');
  }
  if (!doc.preheader?.trim()) add('info', 'Add preview text: it shows next to the subject in the inbox and improves opens.');

  // Wording.
  const hits = PHRASES.filter((p) => lower.includes(p));
  if (hits.length) add(hits.length >= 3 ? 'fail' : 'warn', `Spam-trigger wording: ${hits.slice(0, 5).map((h) => `“${h}”`).join(', ')}. Rephrase more naturally.`);
  if ((body.match(/!/g) ?? []).length > 4) add('warn', 'Lots of exclamation marks in the body.');
  const shouted = words.filter((w) => w.length >= 4 && /^[A-Z]+$/.test(w)).length;
  if (words.length && shouted / words.length > 0.1) add('warn', 'Too much ALL CAPS text in the body.');

  // Length and images.
  const images = doc.design.blocks.filter((b) => b.type === 'image');
  if (words.length < 25) add('warn', `Only ${words.length} words of text. Very short emails, or emails that are mostly images, are filtered more often; aim for 50+ words.`);
  if (images.length && words.length < images.length * 60) add('warn', 'The email is image-heavy. Keep a healthy amount of real text (roughly 60 words per image).');
  if (images.some((b) => b.type === 'image' && !b.alt.trim())) add('warn', 'Give every image alt text.');
  if (images.some((b) => b.type === 'image' && /placehold\.co|placeholder|via\.placeholder/i.test(b.src))) add('fail', 'Replace the placeholder image with your own.');
  if (doc.design.blocks.some((b) => b.type === 'html' && /<(form|script|iframe|object|embed)\b/i.test(b.html))) add('fail', 'Forms, scripts and embedded frames are blocked by mail clients and flagged by filters.');

  // Links.
  const ls = links(doc.design);
  for (const l of ls) {
    const href = l.href.trim();
    if (href.includes('{{')) continue; // variables (unsubscribe, sign-in links) are filled in at send time
    if (!href || href === 'https://' || href === 'http://' || href === '#') { add('fail', `“${l.text || 'A link'}” has no real web address.`); continue; }
    const host = hostOf(href);
    if (!host) continue;
    if (SHORTENERS.test(host)) add('fail', `Link shorteners (${host}) are heavily penalised. Use the full address.`);
    if (/^(localhost|127\.|10\.|192\.168\.)/.test(host) || /\.local$/.test(host)) add('fail', `A link points to a private address (${host}).`);
    if (href.startsWith('http://')) add('warn', `Use https for ${host}.`);
    const shown = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(l.text) ? hostOf(l.text.startsWith('http') ? l.text : `https://${l.text}`) : null;
    if (shown && shown !== host && !host.endsWith(`.${shown}`)) add('fail', `Link text shows ${shown} but goes to ${host}; filters treat this as phishing.`);
  }
  if (ls.length > 15) add('warn', `${ls.length} links is a lot; keep it under about 15.`);
  const hasUnsub = JSON.stringify(doc.design.blocks).includes('unsubscribeUrl');
  if (!hasUnsub) add(opts.marketing === false ? 'info' : 'fail', 'Add an unsubscribe link ({{unsubscribeUrl}}). Gmail and Yahoo require it for bulk mail, and people who can’t unsubscribe press “Report spam” instead.');

  const score = Math.max(0, 100 - issues.reduce((n, i) => n + (i.level === 'fail' ? 20 : i.level === 'warn' ? 7 : 2), 0));
  return { score, issues };
}
