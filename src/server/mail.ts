import { prisma, withPlatform } from './db';
import { logger } from './logger';

/**
 * System email boundary (invitations, password resets, scheduled reports). Every message is recorded
 * in `outbound_emails`. Delivery uses SMTP_URL if set, otherwise the platform's default VERIFIED SMTP
 * sender (Email → Senders). With neither, messages are stored as LOGGED_ONLY in the development outbox.
 */
async function platformSender() {
  return withPlatform((tx) => tx.smtpAccount.findFirst({ where: { organizationId: null, isDefault: true, deletedAt: null, status: 'VERIFIED' } }));
}

export async function sendEmail(msg: { to: string; subject: string; body: string }) {
  const configured = Boolean(process.env.SMTP_URL) || Boolean(await platformSender().catch(() => null));
  const row = await prisma.outboundEmail.create({
    data: { to: msg.to, subject: msg.subject.slice(0, 300), body: msg.body, status: configured ? 'QUEUED' : 'LOGGED_ONLY', provider: configured ? 'smtp' : null },
  });
  if (configured) {
    const { enqueue } = await import('./jobs/queues');
    await enqueue('email', 'deliver', { emailId: row.id }, { jobId: `email-${row.id}` }).catch((err) => logger.error({ err }, 'failed to enqueue email'));
  } else {
    logger.info({ subject: msg.subject, emailId: row.id }, 'No SMTP configured; email stored in outbox only');
  }
  return row;
}

/** Adds `name=<domain>` so the SMTP greeting uses the sending domain instead of the machine's hostname. */
function withGreetingName(url: string, domain: string | undefined) {
  if (!domain || /[?&]name=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(domain)}`;
}

export async function deliverEmail(emailId: string) {
  const row = await prisma.outboundEmail.findUnique({ where: { id: emailId } });
  if (!row || row.status !== 'QUEUED') return;
  const nodemailer = await import('nodemailer');
  const acc = process.env.SMTP_URL ? null : await platformSender();
  const mailFromDomain = /@([^>\s]+)/.exec(process.env.MAIL_FROM ?? '')?.[1];
  const transport = process.env.SMTP_URL
    ? nodemailer.createTransport(withGreetingName(process.env.SMTP_URL, mailFromDomain))
    : acc
      ? await (await import('./services/email')).transportFor(acc)
      : null;
  if (!transport) {
    await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'LOGGED_ONLY' } });
    return;
  }
  try {
    const from = acc ? { name: acc.fromName, address: acc.fromEmail } : (process.env.MAIL_FROM ?? 'no-reply@localhost');
    // Auto-Submitted marks system mail (invites, resets) as automated so it is never auto-replied to.
    await transport.sendMail({ from, to: row.to, subject: row.subject, text: row.body, headers: { 'Auto-Submitted': 'auto-generated' } });
    await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), provider: acc ? `smtp:${acc.label}` : 'smtp' } });
  } catch (err) {
    await prisma.outboundEmail.update({ where: { id: row.id }, data: { status: 'FAILED', error: String((err as Error).message).slice(0, 500) } });
    throw err;
  } finally {
    transport.close();
  }
}
