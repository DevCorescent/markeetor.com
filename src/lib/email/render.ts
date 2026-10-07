import type { Block, EmailDesign, EmailSettings, Variables } from './types';

/**
 * Renders a block document to email-client-safe HTML (table layout, inline styles, bulletproof
 * buttons, hidden preheader) plus a plain-text alternative. Pure and isomorphic: the editor preview
 * and the sending worker use the same function. Rich-text HTML must already be sanitized
 * (server: sanitizeEmailHtml) — this function escapes all variables and plain-text fields.
 */

const FONTS: Record<EmailSettings['font'], string> = {
  Helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  Arial: 'Arial, Helvetica, sans-serif',
  Inter: "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  Georgia: "Georgia, 'Times New Roman', serif",
  Trebuchet: "'Trebuchet MS', Helvetica, sans-serif",
};

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const color = (c: string, fallback: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback);

/** Replaces {{variable}} tokens. Values are HTML-escaped unless `raw` (used for URLs, which are validated separately). */
export function interpolate(input: string, vars: Variables, mode: 'html' | 'text' = 'html') {
  return input.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, key: string) => {
    const v = (vars as Record<string, string | undefined>)[key] ?? '';
    return mode === 'html' ? escapeHtml(v) : v;
  });
}

/** Only http(s) and mailto links survive; anything else (javascript:, data:) becomes "#". */
export function safeUrl(raw: string, vars: Variables) {
  const url = interpolate(raw.trim(), vars, 'text');
  if (/^(https?:\/\/|mailto:)/i.test(url) || url.startsWith('#')) return escapeHtml(url);
  return '#';
}

export const DEFAULT_SETTINGS: EmailSettings = {
  width: 600, background: '#f4f4f5', canvas: '#ffffff', text: '#18181b', muted: '#71717a',
  accent: '#0a0a0a', accentText: '#ffffff', font: 'Helvetica', radius: 10, padding: 40,
};

function blockHtml(b: Block, s: EmailSettings, vars: Variables): string {
  const font = FONTS[s.font] ?? FONTS.Helvetica;
  const textColor = color(s.text, '#18181b');
  const muted = color(s.muted, '#71717a');
  const accent = color(s.accent, '#0a0a0a');
  const pad = `0 ${s.padding}px`;
  const td = (inner: string, extra = '') => `<tr><td style="padding:${pad};${extra}">${inner}</td></tr>`;
  switch (b.type) {
    case 'heading': {
      const size = b.level === 1 ? 30 : b.level === 2 ? 22 : 18;
      return td(`<h${b.level} style="margin:0 0 14px;font-family:${font};font-size:${size}px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${textColor};text-align:${b.align}">${interpolate(escapeHtml(b.text), vars)}</h${b.level}>`);
    }
    case 'text':
      return td(`<div style="margin:0 0 16px;font-family:${font};font-size:15px;line-height:1.65;color:${textColor};text-align:${b.align}">${interpolate(b.html, vars)}</div>`);
    case 'quote':
      return td(`<div style="margin:0 0 18px;padding:4px 0 4px 18px;border-left:3px solid ${accent};font-family:${font};font-size:16px;line-height:1.6;font-style:italic;color:${textColor}">${interpolate(b.html, vars)}${b.author ? `<div style="margin-top:8px;font-style:normal;font-size:13px;color:${muted}">— ${interpolate(escapeHtml(b.author), vars)}</div>` : ''}</div>`);
    case 'button': {
      const solid = b.variant === 'solid';
      const bg = solid ? accent : 'transparent';
      const fg = solid ? color(s.accentText, '#ffffff') : accent;
      const width = b.fullWidth ? 'width:100%;' : '';
      return td(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${b.align}" style="margin:6px ${b.align === 'center' ? 'auto' : '0'} 22px;${width}"><tr><td align="center" bgcolor="${solid ? accent : ''}" style="border-radius:${s.radius}px;${solid ? '' : `border:1.5px solid ${accent};`}background:${bg}"><a href="${safeUrl(b.url, vars)}" target="_blank" style="display:inline-block;${b.fullWidth ? 'width:100%;box-sizing:border-box;' : ''}padding:13px 26px;font-family:${font};font-size:15px;font-weight:600;color:${fg};text-decoration:none;border-radius:${s.radius}px">${interpolate(escapeHtml(b.label), vars)}</a></td></tr></table>`);
    }
    case 'image': {
      const w = Math.round(((s.width - s.padding * 2) * Math.max(10, Math.min(100, b.width))) / 100);
      const img = `<img src="${safeUrl(b.src, vars)}" alt="${escapeHtml(b.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;border-radius:${Math.min(s.radius, 12)}px;margin:${b.align === 'center' ? '0 auto' : b.align === 'right' ? '0 0 0 auto' : '0'}" />`;
      return td(`<div style="margin:0 0 20px">${b.href ? `<a href="${safeUrl(b.href, vars)}" target="_blank">${img}</a>` : img}</div>`);
    }
    case 'divider':
      return td(`<div style="margin:8px 0 24px;border-top:1px solid #e4e4e7;line-height:0;font-size:0">&nbsp;</div>`);
    case 'spacer':
      return `<tr><td style="height:${Math.max(4, Math.min(160, b.height))}px;line-height:0;font-size:0">&nbsp;</td></tr>`;
    case 'columns':
      return td(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr>
<td class="col" width="50%" valign="top" style="padding-right:12px;font-family:${font};font-size:14px;line-height:1.6;color:${textColor}">${interpolate(b.left, vars)}</td>
<td class="col" width="50%" valign="top" style="padding-left:12px;font-family:${font};font-size:14px;line-height:1.6;color:${textColor}">${interpolate(b.right, vars)}</td></tr></table>`);
    case 'footer':
      return td(`<div style="margin:8px 0 0;padding-top:20px;border-top:1px solid #e4e4e7;font-family:${font};font-size:12px;line-height:1.6;color:${muted};text-align:center">${interpolate(b.html, vars)}</div>`);
    case 'html':
      return td(interpolate(b.html, vars));
  }
}

export function renderEmail(design: EmailDesign, opts: { preheader?: string | null; vars: Variables; trackingPixelUrl?: string | null }) {
  const s = { ...DEFAULT_SETTINGS, ...design.settings };
  const rows = design.blocks.map((b) => blockHtml(b, s, opts.vars)).join('\n');
  const pre = opts.preheader ? interpolate(escapeHtml(opts.preheader), opts.vars) : '';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<title></title>
<style>@media (max-width:620px){.container{width:100%!important}.col{display:block!important;width:100%!important;padding:0 0 12px!important}}a{color:${color(s.accent, '#0a0a0a')}}</style>
</head>
<body style="margin:0;padding:0;background:${color(s.background, '#f4f4f5')};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${pre}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${color(s.background, '#f4f4f5')}"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" class="container" width="${s.width}" cellpadding="0" cellspacing="0" border="0" style="width:${s.width}px;max-width:100%;background:${color(s.canvas, '#ffffff')};border-radius:${s.radius}px">
<tr><td style="height:${s.padding}px;line-height:0;font-size:0">&nbsp;</td></tr>
${rows}
<tr><td style="height:${s.padding}px;line-height:0;font-size:0">&nbsp;</td></tr>
</table>
</td></tr></table>
${opts.trackingPixelUrl ? `<img src="${escapeHtml(opts.trackingPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />` : ''}
</body></html>`;
  return { html, text: toText(design, opts.vars) };
}

export function toText(design: EmailDesign, vars: Variables) {
  const strip = (h: string) =>
    interpolate(h, vars, 'text')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<li>/gi, '• ')
      .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  return design.blocks
    .map((b) => {
      switch (b.type) {
        case 'heading': return interpolate(b.text, vars, 'text');
        case 'text': case 'footer': case 'html': return strip(b.html);
        case 'quote': return `"${strip(b.html)}"${b.author ? ` — ${b.author}` : ''}`;
        case 'button': return `${interpolate(b.label, vars, 'text')}: ${interpolate(b.url, vars, 'text')}`;
        case 'columns': return `${strip(b.left)}\n\n${strip(b.right)}`;
        case 'divider': return '———';
        default: return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}
