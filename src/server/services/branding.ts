import type { Prisma } from '@prisma/client';
import { audit } from '../audit';
import type { AuthContext } from '../auth/context';
import { BRAND_ASSET_KINDS, type BrandAssetKind } from '../branding';
import { withPlatform } from '../db';
import { AppError } from '../errors';
import { getSetting, invalidateSetting, type BrandAsset } from '../settings';
import { fileExists, putBuffer, readStream, removeFile } from '../storage';

const LIMITS: Record<BrandAssetKind, { bytes: number; types: string[]; label: string }> = {
  logo: { bytes: 2 * 1024 * 1024, types: ['png', 'jpeg', 'webp', 'svg'], label: 'Logo' },
  logoDark: { bytes: 2 * 1024 * 1024, types: ['png', 'jpeg', 'webp', 'svg'], label: 'Dark-theme logo' },
  favicon: { bytes: 512 * 1024, types: ['png', 'ico', 'svg'], label: 'Favicon' },
  // Social crawlers reliably support only PNG and JPEG.
  ogImage: { bytes: 5 * 1024 * 1024, types: ['png', 'jpeg'], label: 'Social share image' },
};

const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg', ico: 'ico' };

/** Identifies the image type from its bytes — the file name and declared type are never trusted. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && buf.toString('utf8').toLowerCase().includes('<svg')) return 'svg';
  return null;
}

/**
 * SVG is active content. Even though brand files are served with a sandboxing CSP, anything that can
 * script, load remote resources or embed foreign markup is rejected outright.
 */
export function assertSafeSvg(buf: Buffer) {
  const s = buf.toString('utf8').toLowerCase();
  const banned = [/<script/, /\son[a-z]+\s*=/, /javascript:/, /<foreignobject/, /<iframe/, /<embed/, /<object/, /<!entity/, /<!doctype/, /(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)/, /url\(\s*["']?\s*(?!#|data:image\/)/, /@import/];
  if (banned.some((r) => r.test(s))) throw new AppError('VALIDATION_FAILED', 'This SVG contains scripts, event handlers or external references. Export a plain SVG or use PNG.');
}

const keyFor = (kind: BrandAssetKind, a: BrandAsset) => `branding/${kind}-${a.v}.${a.ext}`;

export async function uploadBrandAsset(ctx: AuthContext, kind: BrandAssetKind, buf: Buffer) {
  const lim = LIMITS[kind];
  if (!buf.length) throw new AppError('VALIDATION_FAILED', 'The file is empty');
  if (buf.length > lim.bytes) throw new AppError('PAYLOAD_TOO_LARGE', `${lim.label} must be under ${Math.round(lim.bytes / 1024)} KB`);
  const type = sniffImage(buf);
  if (!type || !lim.types.includes(type)) throw new AppError('UNSUPPORTED_MEDIA', `${lim.label} must be ${lim.types.map((t) => t.toUpperCase()).join(', ')}`);
  if (type === 'svg') assertSafeSvg(buf);

  const assets = await getSetting('branding.assets');
  const before = assets[kind];
  const next: BrandAsset = { v: Date.now(), type: MIME[type], ext: EXT[type], size: buf.length };
  await putBuffer(keyFor(kind, next), buf);
  const value = { ...assets, [kind]: next };
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'branding.assets' }, create: { key: 'branding.assets', value: value as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.branding.asset_uploaded', targetType: 'platform_setting', targetId: `branding.assets.${kind}`, organizationId: null, before: before ? { ...before } : null, after: { ...next } });
  });
  invalidateSetting('branding.assets');
  if (before) await removeFile(keyFor(kind, before)).catch(() => null);
  return next;
}

export async function removeBrandAsset(ctx: AuthContext, kind: BrandAssetKind) {
  const assets = await getSetting('branding.assets');
  const before = assets[kind];
  if (!before) return;
  const value = { ...assets, [kind]: null };
  await withPlatform(async (tx) => {
    await tx.platformSetting.upsert({ where: { key: 'branding.assets' }, create: { key: 'branding.assets', value: value as Prisma.InputJsonValue, updatedById: ctx.user.id }, update: { value: value as Prisma.InputJsonValue, updatedById: ctx.user.id } });
    await audit(tx, ctx, { action: 'settings.branding.asset_removed', targetType: 'platform_setting', targetId: `branding.assets.${kind}`, organizationId: null, before: { ...before } });
  });
  invalidateSetting('branding.assets');
  await removeFile(keyFor(kind, before)).catch(() => null);
}

/** Returns a readable stream + metadata for a brand file, or null when none is uploaded. */
export async function openBrandAsset(kind: BrandAssetKind) {
  const a = (await getSetting('branding.assets'))[kind];
  if (!a || !(await fileExists(keyFor(kind, a)))) return null;
  return { asset: a, stream: readStream(keyFor(kind, a)) };
}

export const brandAssetLimits = Object.fromEntries(BRAND_ASSET_KINDS.map((k) => [k, { maxKb: Math.round(LIMITS[k].bytes / 1024), types: LIMITS[k].types }]));
