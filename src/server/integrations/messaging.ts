import { AppError } from '../errors';

/**
 * Outbound messaging boundary (SMS, WhatsApp Business, email-from-workspace).
 *
 * Not exposed in the UI in this release: contact attempts are *logged* (self-reported), never sent.
 * To add a provider, implement `MessagingProvider`, register it in `providerFor`, and require:
 *   - credentials from environment / secrets manager only (see Settings → Integrations),
 *   - a consent check (latest ConsentRecord for the channel must not be OPTED_OUT),
 *   - a CommunicationLog row with verification = PROVIDER_VERIFIED and the provider message id,
 *   - signed-webhook verification for delivery receipts / inbound messages.
 */
export type Channel = 'SMS' | 'WHATSAPP' | 'EMAIL';

export interface MessagingProvider {
  channel: Channel;
  send(msg: { to: string; body: string; templateId?: string }): Promise<{ providerMessageId: string }>;
  verifyWebhook(headers: Headers, rawBody: string): boolean;
}

const REQUIRED_ENV: Record<Channel, string[]> = {
  SMS: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  WHATSAPP: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
  EMAIL: ['SMTP_URL'],
};

export function isConfigured(channel: Channel) {
  return REQUIRED_ENV[channel].every((k) => Boolean(process.env[k]));
}

export function providerFor(channel: Channel): MessagingProvider {
  if (!isConfigured(channel)) throw new AppError('PRECONDITION_FAILED', `${channel} is not configured. Set ${REQUIRED_ENV[channel].join(', ')}.`);
  throw new AppError('PRECONDITION_FAILED', `${channel} sending is not implemented in this release`);
}
