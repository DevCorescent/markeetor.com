'use client';
import { useEffect } from 'react';

const SKIP = '.table-keep, .email-canvas, .email-rte';

/** Tables rendered by DataTable/SimpleTable label themselves (data-rt); for hand-written tables this copies each column header onto its cells (data-label) so tables can render as cards on phones (see globals.css). */
function label(table: HTMLTableElement) {
  if (table.hasAttribute('data-rt') || table.closest(SKIP)) return;
  const head = table.tHead?.rows[table.tHead.rows.length - 1];
  if (!head) return;
  const headers: string[] = [];
  for (const th of Array.from(head.cells)) {
    const text = (th.textContent ?? '').replace(/\s+/g, ' ').trim();
    for (let i = 0; i < th.colSpan; i++) headers.push(text);
  }
  for (const body of [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])]) {
    for (const row of Array.from(body.rows)) {
      let col = 0;
      let primary = false;
      for (const cell of Array.from(row.cells)) {
        const h = headers[col] ?? '';
        col += cell.colSpan;
        if (cell.colSpan > 1) continue;
        const isSelect = !h && !(cell.textContent ?? '').trim() && !!cell.querySelector('[role="checkbox"], input[type="checkbox"]');
        set(cell, 'data-select', isSelect ? '' : null);
        set(cell, 'data-label', h || null);
        const isPrimary = !primary && !!h;
        if (isPrimary) primary = true;
        set(cell, 'data-primary', isPrimary ? '' : null);
      }
    }
  }
}

function set(el: Element, name: string, value: string | null) {
  if (value === null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

export function ResponsiveTables() {
  useEffect(() => {
    let frame = 0;
    let ready = false;
    const run = () => { frame = 0; document.querySelectorAll('table').forEach(label); };
    const schedule = () => { if (ready && !frame) frame = requestAnimationFrame(run); };
    // Start after load so server-rendered rows are hydrated before we add attributes to them.
    const start = () => setTimeout(() => { ready = true; run(); }, 300);
    if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
    // Child-list changes only: our own attribute writes never re-trigger the observer.
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { obs.disconnect(); window.removeEventListener('load', start); if (frame) cancelAnimationFrame(frame); };
  }, []);
  return null;
}
