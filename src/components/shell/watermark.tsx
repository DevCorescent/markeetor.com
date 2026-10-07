'use client';
import { useEffect, useState } from 'react';
import { useResolvedTheme } from './theme';

/**
 * Visible, user-specific watermark over sensitive client views. This deters casual screenshots and
 * makes leaked captures attributable; it does not (and cannot) prevent screenshots or photography.
 */
export function Watermark({ label }: { label: string }) {
  const [stamp, setStamp] = useState('');
  const theme = useResolvedTheme();
  useEffect(() => {
    const tick = () => setStamp(new Date().toISOString().slice(0, 16).replace('T', ' '));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, []);
  const text = `${label} · ${stamp} UTC`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'><text x='0' y='120' transform='rotate(-22 210 110)' fill='${theme === 'light' ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.035)'}' font-family='ui-sans-serif,system-ui' font-size='13'>${text.replace(/[<>&'"]/g, '')}</text></svg>`;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-30 select-none"
      style={{ backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`, backgroundRepeat: 'repeat' }}
    />
  );
}
