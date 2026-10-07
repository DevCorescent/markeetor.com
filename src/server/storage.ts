import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Private object storage boundary (local filesystem implementation). Files live outside the web root
 * and are only reachable through authorized, audited API routes. Keys are always generated server-side.
 * Swap this module for an S3/GCS implementation with server-side encryption in production.
 */
function root() {
  return path.resolve(process.env.STORAGE_DIR ?? './storage');
}

function resolveKey(key: string) {
  if (!/^[a-z0-9_-]+(\/[a-zA-Z0-9_.-]+)+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  const full = path.resolve(root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function putBuffer(key: string, data: Buffer) {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, data, { mode: 0o600 });
  return key;
}

export async function putStream(key: string, stream: Readable) {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await pipeline(stream, createWriteStream(full, { mode: 0o600 }));
  return key;
}

export function localPath(key: string) {
  return resolveKey(key);
}

export function readStream(key: string) {
  return createReadStream(resolveKey(key));
}

export async function removeFile(key: string) {
  await rm(resolveKey(key), { force: true });
}

export async function fileExists(key: string) {
  try {
    await stat(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}
