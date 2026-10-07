import { withPlatform, type Tx } from '../db';
import { logger } from '../logger';

export type MessageEventType = 'QUEUED' | 'DEFERRED' | 'SENT' | 'RETRY' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'OPENED' | 'CLICKED' | 'UNSUBSCRIBED' | 'RESENT';

type EventInput = { type: MessageEventType; detail?: string | null; url?: string | null; ip?: string | null; userAgent?: string | null };

/** Appends to a message's delivery timeline. Never throws: history must not break sending. */
export async function recordMessageEvent(messageId: string, e: EventInput, tx?: Tx) {
  const data = { messageId, type: e.type, detail: e.detail?.slice(0, 500) ?? null, url: e.url?.slice(0, 2000) ?? null, ip: e.ip ?? null, userAgent: e.userAgent?.slice(0, 300) ?? null };
  try {
    if (tx) await tx.emailMessageEvent.create({ data });
    else await withPlatform((t) => t.emailMessageEvent.create({ data }));
  } catch (err) {
    logger.warn({ err, messageId, type: e.type }, 'failed to record email event');
  }
}
