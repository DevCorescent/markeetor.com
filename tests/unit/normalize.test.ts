import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from '@/lib/mask';
import { passwordProblems } from '@/server/auth/password';
import { decrypt, encrypt, shortCode } from '@/server/crypto';
import { buildLeadWhere } from '@/server/services/lead-filters';
import { normalizeEmail, normalizePhone, safeCell, toCsv } from '@/server/services/normalize';
import { detectKind } from '@/server/services/import-parse';
import { normalizeRow } from '@/server/services/imports';

describe('normalization', () => {
  it('normalizes and validates emails', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toEqual({ value: 'john.doe@example.com' });
    expect(normalizeEmail('mailto:a@b.co').value).toBe('a@b.co');
    expect(normalizeEmail('not-an-email').error).toBeTruthy();
    expect(normalizeEmail('').value).toBeNull();
  });

  it('normalizes phones to E.164, handling spreadsheet artefacts', () => {
    expect(normalizePhone('(415) 555-0100', 'US').value).toBe('+14155550100');
    expect(normalizePhone('00447700900123', 'US').value).toBe('+447700900123');
    expect(normalizePhone("'9876543210", 'IN').value).toBe('+919876543210');
    expect(normalizePhone('9.198765e+11', 'IN').value).toBe('+919876500000');
    expect(normalizePhone('12', 'US').error).toBeTruthy();
  });

  it('neutralises spreadsheet formula injection in generated CSV', () => {
    for (const bad of ['=HYPERLINK("x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd']) expect(safeCell(bad).startsWith("'")).toBe(true);
    expect(safeCell('Normal')).toBe('Normal');
    expect(toCsv([['=1+1', 'a,b', 'q"x']])).toBe(`'=1+1,"a,b","q""x"`);
  });

  it('masks contact details', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
    expect(maskPhone('+14155550123')).toMatch(/0123$/);
    expect(maskPhone('+14155550123')).not.toContain('555');
  });
});

describe('import parsing safety', () => {
  it('accepts files only by extension AND content signature', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(detectKind('leads.xlsx', zip)).toBe('xlsx');
    expect(detectKind('leads.csv', zip)).toBeNull(); // zip disguised as csv
    expect(detectKind('leads.xlsx', Buffer.from('a,b\n1,2'))).toBeNull(); // text disguised as xlsx
    expect(detectKind('leads.csv', Buffer.from([0x61, 0x00, 0x62]))).toBeNull(); // binary
    expect(detectKind('leads.xls', zip)).toBeNull();
    expect(detectKind('leads.xlsm', zip)).toBeNull();
    expect(detectKind('leads.csv', Buffer.from('name,email\n'))).toBe('csv');
  });

  it('validates rows against configured rules', () => {
    const opts = { dedupeKeys: ['email', 'phone'] as ('email' | 'phone')[], onDuplicate: 'skip' as const, requireName: true, requireContact: true, requireEmail: false, requirePhone: false, defaultCountry: 'US', autoConfirm: false };
    const mapping = { Name: 'fullName', Mail: 'email', Tel: 'phone', S: 'score', P: 'priority' };
    const ok = normalizeRow({ Name: 'JANE DOE', Mail: 'Jane@X.io', Tel: '', S: '150', P: 'urgent' }, mapping, opts, { source: 'Web', campaign: null });
    expect(ok.errors).toEqual([]);
    expect(ok.row.fullName).toBe('Jane Doe');
    expect(ok.row.score).toBe(100);
    expect(ok.row.priority).toBe('URGENT');
    expect(ok.row.source).toBe('Web');
    const bad = normalizeRow({ Name: '', Mail: 'nope', Tel: '1' }, mapping, opts, { source: null, campaign: null });
    expect(bad.errors).toContain('Name is missing');
    expect(bad.errors).toContain('No valid email or phone');
  });
});

describe('filter compiler', () => {
  it('ignores unknown fields and never passes raw input through', () => {
    const w = buildLeadWhere({ conditions: [{ field: '__proto__', op: 'eq', value: 'x' }, { field: 'passwordHash', op: 'eq', value: 'x' }] }, 'active');
    expect(JSON.stringify(w)).not.toContain('passwordHash');
    expect(JSON.stringify(w)).not.toContain('__proto__');
  });
  it('drops invalid enum values', () => {
    const w = buildLeadWhere({ conditions: [{ field: 'priority', op: 'in', value: ['HIGH', 'DROP TABLE'] }] }, 'all');
    expect(JSON.stringify(w)).toContain('HIGH');
    expect(JSON.stringify(w)).not.toContain('DROP TABLE');
  });
});

describe('credentials & crypto', () => {
  it('enforces password policy', () => {
    expect(passwordProblems('short', 12)).not.toHaveLength(0);
    expect(passwordProblems('alllowercaseletters', 12)).not.toHaveLength(0);
    expect(passwordProblems('Password123!', 12, [])).toHaveLength(1); // too common
    expect(passwordProblems('Jane-Secure-9988', 12, ['jane@x.com'])).toContain('Password must not contain your name or email');
    expect(passwordProblems('Tr1cky-Horse-Battery', 12, ['bob@x.com'])).toHaveLength(0);
  });
  it('round-trips AES-GCM and detects tampering', () => {
    const c = encrypt('totp-secret');
    expect(decrypt(c)).toBe('totp-secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
  it('generates readable codes', () => {
    expect(shortCode('ORG')).toMatch(/^ORG-[A-Z2-9]{6}$/);
  });
});
