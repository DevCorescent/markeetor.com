import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { decrypt, encrypt, randomToken, sha256 } from '../crypto';
import { productName } from '../branding';

authenticator.options = { window: 1, step: 30, digits: 6 };

export function newTotpSecret() {
  return authenticator.generateSecret(20);
}

export async function totpProvisioning(email: string, secret: string) {
  const uri = authenticator.keyuri(email, await productName(), secret);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } });
  return { uri, qr };
}

export function verifyTotp(secret: string, token: string): boolean {
  const clean = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  try {
    return authenticator.check(clean, secret);
  } catch {
    return false;
  }
}

export const encryptSecret = encrypt;
export const decryptSecret = decrypt;

export function newRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () => randomToken(6).replace(/[-_]/g, 'x').slice(0, 8).toUpperCase());
  return { codes, hashes: codes.map((c) => sha256(c)) };
}

export function matchRecoveryCode(hashes: string[], code: string): string | null {
  const h = sha256(code.trim().toUpperCase());
  return hashes.includes(h) ? h : null;
}
