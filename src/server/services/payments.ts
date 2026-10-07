import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthContext } from '../auth/context';
import { withPlatform } from '../db';
import { AppError, notFound } from '../errors';
import { logger } from '../logger';
import { completeCreditRequest } from './credits';
import { getFinance } from './finance';

/**
 * Online payments for credit purchases via Razorpay Orders + Checkout.
 *   1. createPaymentOrder → Razorpay order for the credit request's total (in paise).
 *   2. The browser opens Razorpay Checkout; on success it posts {order_id, payment_id, signature}.
 *   3. verifyPayment checks HMAC-SHA256(order_id|payment_id, key_secret) and completes the credit request
 *      (credits added, receipt + invoice issued). The webhook (`payment.captured` / `order.paid`, signed with
 *      RAZORPAY_WEBHOOK_SECRET) does the same server-to-server, so a closed tab never loses a payment.
 * Needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET; off otherwise.
 */

export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

export async function onlinePaymentsEnabled() {
  return razorpayConfigured() && (await getFinance()).payments.razorpay;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export const paymentSignature = (orderId: string, paymentId: string, secret: string) => createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
export const webhookSignature = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('hex');

export async function createPaymentOrder(ctx: AuthContext, creditRequestId: string) {
  if (!(await onlinePaymentsEnabled())) throw new AppError('PRECONDITION_FAILED', 'Online payments are not available');
  const r = await withPlatform((tx) => tx.creditRequest.findUnique({ where: { id: creditRequestId } }));
  if (!r || r.organizationId !== ctx.orgId) throw notFound('Credit request');
  if (!['PENDING', 'AWAITING_PAYMENT'].includes(r.status)) throw new AppError('CONFLICT', 'This request is already closed');
  const amount = Math.round(Number(r.total) * 100);
  if (amount < 100) throw new AppError('VALIDATION_FAILED', 'Amount too small for online payment');
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ amount, currency: r.currency, receipt: r.code.slice(0, 40), notes: { creditRequestId: r.id, organizationId: r.organizationId } }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
  if (!res.ok || !body.id) {
    logger.warn({ status: res.status, error: body.error }, 'razorpay order failed');
    throw new AppError('INTERNAL', body.error?.description ?? 'Could not start the payment. Please try again.');
  }
  await withPlatform((tx) => tx.paymentOrder.create({ data: { providerOrderId: body.id!, creditRequestId: r.id, organizationId: r.organizationId, amount: Number(r.total), currency: r.currency, createdById: ctx.user.id } }));
  const f = await getFinance();
  return {
    keyId: process.env.RAZORPAY_KEY_ID!, orderId: body.id, amount, currency: r.currency,
    name: f.seller.legalName || 'Lead credits', description: `${(r.credits + r.bonusCredits).toLocaleString()} credits · ${r.code}`,
    prefill: { name: ctx.user.name, email: ctx.user.email },
  };
}

/** Marks the order paid and completes the credit request (idempotent). */
async function settle(orderId: string, paymentId: string) {
  const o = await withPlatform((tx) => tx.paymentOrder.findUnique({ where: { providerOrderId: orderId } }));
  if (!o) throw notFound('Payment');
  if (o.status === 'PAID') return { status: 'PAID' as const, already: true };
  await withPlatform((tx) => tx.paymentOrder.update({ where: { id: o.id }, data: { status: 'PAID', providerPaymentId: paymentId, paidAt: new Date() } }));
  const req = await withPlatform((tx) => tx.creditRequest.findUniqueOrThrow({ where: { id: o.creditRequestId }, select: { status: true } }));
  if (req.status === 'PENDING' || req.status === 'AWAITING_PAYMENT') {
    const payer = await withPlatform((tx) => tx.user.findUnique({ where: { id: o.createdById }, select: { id: true, email: true } }));
    // System actor for the audit trail: the paying client, via the gateway.
    const sys = { user: { id: payer?.id ?? o.createdById, email: payer?.email ?? '', name: 'Online payment (Razorpay)', mfaEnabled: false }, scope: 'PLATFORM', orgId: null, permissions: new Set<string>(), requestId: `rzp-${paymentId}`, ip: null, userAgent: 'razorpay' } as unknown as AuthContext;
    await completeCreditRequest(sys, o.creditRequestId, { paymentMethod: 'Razorpay (online)', paymentReference: paymentId, note: 'Paid online' });
  }
  return { status: 'PAID' as const, already: false };
}

export async function verifyPayment(ctx: AuthContext, input: { orderId: string; paymentId: string; signature: string }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new AppError('PRECONDITION_FAILED', 'Online payments are not available');
  const o = await withPlatform((tx) => tx.paymentOrder.findUnique({ where: { providerOrderId: input.orderId } }));
  if (!o || o.organizationId !== ctx.orgId) throw notFound('Payment');
  if (!safeEqual(paymentSignature(input.orderId, input.paymentId, secret), input.signature)) {
    await withPlatform((tx) => tx.paymentOrder.update({ where: { id: o.id }, data: { status: 'FAILED', error: 'Signature mismatch' } }));
    throw new AppError('VALIDATION_FAILED', 'Payment could not be verified');
  }
  return settle(input.orderId, input.paymentId);
}

/** Razorpay webhook (raw body + X-Razorpay-Signature). */
export async function handleRazorpayWebhook(raw: string, signature: string | null) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature || !safeEqual(webhookSignature(raw, secret), signature)) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
  const ev = JSON.parse(raw) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string; error_description?: string } } } };
  const p = ev.payload?.payment?.entity;
  if (!p?.order_id || !p.id) return { ignored: true };
  if (ev.event === 'payment.captured' || ev.event === 'order.paid') return settle(p.order_id, p.id).catch((err) => { logger.warn({ err }, 'razorpay webhook: unknown order'); return { ignored: true }; });
  if (ev.event === 'payment.failed') await withPlatform((tx) => tx.paymentOrder.updateMany({ where: { providerOrderId: p.order_id!, status: 'CREATED' }, data: { status: 'FAILED', error: p.error_description?.slice(0, 300) ?? 'Payment failed' } }));
  return { ok: true };
}
