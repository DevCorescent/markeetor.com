import { prisma } from '../db';
import { randomToken, safeEqual, sha256 } from '../crypto';
import { buildContext, type AuthContext, type RequestMeta } from './context';

/** Key format: lck_<prefix>_<secret>. Only the prefix and a SHA-256 of the secret are stored. */
export function generateApiKey() {
  const prefix = randomToken(6).replace(/[-_]/g, 'a').slice(0, 8).toLowerCase();
  const secret = randomToken(32);
  return { prefix, secret, raw: `lck_${prefix}_${secret}`, hash: sha256(secret) };
}

export async function authenticateApiKey(raw: string, meta: RequestMeta): Promise<AuthContext | null> {
  const m = /^lck_([a-z0-9]{8})_([A-Za-z0-9_-]{20,100})$/.exec(raw);
  if (!m) return null;
  const key = await prisma.apiKey.findUnique({ where: { prefix: m[1] } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) return null;
  if (!safeEqual(key.keyHash, sha256(m[2]))) return null;
  // The key acts as its creator, narrowed to the key's scopes. If the creator loses a
  // permission (or is suspended), the key loses it too.
  const creator = await prisma.user.findUnique({ where: { id: key.createdById } });
  if (!creator || creator.status !== 'ACTIVE') return null;
  const ctx = await buildContext(creator.id, meta, null);
  const scopes = new Set(key.scopes);
  ctx.permissions = new Set([...ctx.permissions].filter((p) => scopes.has(p)));
  ctx.apiKeyId = key.id;
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), lastUsedIp: meta.ip } }).catch(() => null);
  return ctx;
}
