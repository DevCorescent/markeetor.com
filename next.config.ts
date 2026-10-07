import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

// Strict CSP. Next.js needs 'unsafe-inline' for its inline bootstrap scripts unless nonces are wired up;
// see DEVELOPMENT.md → Known limitations.
const csp = [
  "default-src 'self'",
  // Razorpay Checkout (online credit purchases) loads its script and payment frame from razorpay.com.
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"} https://checkout.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.razorpay.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com",
  "frame-src https://api.razorpay.com https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['@node-rs/argon2', 'bullmq', 'ioredis', 'exceljs', 'pino'],
  async headers() {
    return [
      {
        // Attachment viewer responses set their own CSP and may only be framed by this origin.
        source: '/api/v1/crm/attachments/:id',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // Lead-capture forms are meant to be embedded on clients' websites: framing allowed, nothing else relaxed.
        source: '/f/:slug*',
        headers: [
          { key: 'Content-Security-Policy', value: csp.replace("frame-ancestors 'none'", 'frame-ancestors *') },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        source: '/((?!api/v1/crm/attachments/|f/).*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
