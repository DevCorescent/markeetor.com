'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api-client';

type Order = { keyId: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: { name: string; email: string } };
type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayCtor = new (o: Record<string, unknown>) => { open: () => void; on: (ev: string, fn: (r: { error?: { description?: string } }) => void) => void };

function loadCheckout() {
  return new Promise<RazorpayCtor>((resolve, reject) => {
    const w = window as unknown as { Razorpay?: RazorpayCtor };
    if (w.Razorpay) return resolve(w.Razorpay);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error('Payment window failed to load')));
    s.onerror = () => reject(new Error('Payment window failed to load'));
    document.body.appendChild(s);
  });
}

/** Pays a credit request with Razorpay Checkout; credits are added as soon as the payment is verified. */
export function PayOnlineButton({ creditRequestId, label = 'Pay online now', onPaid }: { creditRequestId: string; label?: string; onPaid?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    setBusy(true);
    try {
      const [Razorpay, order] = await Promise.all([loadCheckout(), api<Order>('/api/v1/payments/razorpay/order', { body: { creditRequestId } })]);
      const rz = new Razorpay({
        key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency, name: order.name, description: order.description,
        prefill: order.prefill, theme: { color: '#111111' },
        modal: { ondismiss: () => setBusy(false) },
        handler: async (r: RazorpayResponse) => {
          try {
            await api('/api/v1/payments/razorpay/verify', { body: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } });
            toast.success('Payment received — credits added');
            await qc.invalidateQueries({ predicate: (q) => /^\/api\/v1\/(credits|finance|marketplace)/.test(String(q.queryKey[0] ?? '')) });
            onPaid?.();
          } catch (e) {
            toast.error(errorMessage(e), { description: 'If money was taken, it will be matched automatically within a few minutes.' });
          } finally {
            setBusy(false);
          }
        },
      });
      rz.on('payment.failed', (r) => { toast.error(r.error?.description ?? 'Payment failed'); setBusy(false); });
      rz.open();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };
  return <Button variant="primary" loading={busy} onClick={pay}><CreditCard /> {label}</Button>;
}
