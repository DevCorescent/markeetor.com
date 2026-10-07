import { describe, expect, it } from 'vitest';
import { detectColumns, detectDelimiter, detectHeaderRow, lookupCountry, toUtf8 } from '@/server/services/import-detect';

describe('smart column detection', () => {
  it('maps unusual header names', () => {
    const headers = ['E-mail Address', 'Mob No.', 'Org', 'Designation', 'Nation', 'Lead Temperature', 'Notes'];
    const rows = [
      ['ann@acme.io', '98765 43210', 'Acme', 'CTO', 'IN', 'hot', 'met at expo'],
      ['bob@beta.io', '+44 7700 900123', 'Beta', 'CEO', 'GB', 'warm', ''],
      ['cy@gamma.io', '(415) 555-0100', 'Gamma', 'VP', 'US', 'cold', 'follow up'],
    ];
    const { mapping, details } = detectColumns(headers, rows, 'US');
    expect(mapping).toMatchObject({ 'E-mail Address': 'email', 'Mob No.': 'phone', Org: 'company', Designation: 'jobTitle', Nation: 'country', 'Lead Temperature': 'priority', Notes: 'custom:notes' });
    expect(details['E-mail Address'].confidence).toBeGreaterThanOrEqual(0.9);
    expect(details['E-mail Address'].reasons.join(' ')).toMatch(/email/i);
  });

  it('maps columns by content when headers are meaningless', () => {
    const headers = ['Column 1', 'Column 2', 'Column 3'];
    const rows = Array.from({ length: 10 }, (_, i) => [`Person Number${String.fromCharCode(65 + i)}`, `user${i}@mail.com`, `+1 415 555 01${10 + i}`]);
    const { mapping } = detectColumns(headers, rows);
    expect(mapping['Column 2']).toBe('email');
    expect(mapping['Column 3']).toBe('phone');
    expect(mapping['Column 1']).toBe('fullName');
  });

  it('distrusts a header contradicted by its values', () => {
    const { mapping } = detectColumns(['Email', 'Contact'], [['+14155550100', 'a@b.co'], ['+14155550101', 'c@d.co']]);
    expect(mapping.Contact).toBe('email');
    expect(mapping.Email).not.toBe('email');
  });

  it('treats a second phone column as secondary phone and keeps first/last names', () => {
    const { mapping } = detectColumns(['First Name', 'Last Name', 'Mobile', 'Landline'], [['Ann', 'Lee', '+14155550100', '+14155550199']]);
    expect(mapping).toMatchObject({ 'First Name': 'firstName', 'Last Name': 'lastName', Mobile: 'phone', Landline: 'secondaryPhone' });
  });

  it('ignores empty columns', () => {
    expect(detectColumns(['Name', 'Blank'], [['Ann Lee', ''], ['Bo Ma', '']]).mapping.Blank).toBe('ignore');
  });
});

describe('file structure detection', () => {
  it('detects delimiters', () => {
    expect(detectDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('name,"city, state"\nAnn,"Austin, TX"')).toBe(',');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
  });
  it('finds the header row below title lines, or none at all', () => {
    expect(detectHeaderRow([['Q3 Lead Export'], ['Generated 2026-09-01'], ['Name', 'Email', 'Phone'], ['Ann', 'ann@x.io', '4155550100']])).toBe(3);
    expect(detectHeaderRow([['Ann Lee', 'ann@x.io', '+14155550100'], ['Bo Ma', 'bo@x.io', '+14155550101']])).toBe(0);
  });
  it('repairs text encodings', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name,Email\nJosé,j@x.io', 'utf16le')]);
    expect(toUtf8(utf16)).toMatchObject({ text: 'Name,Email\nJosé,j@x.io', encoding: 'UTF-16LE' });
    const latin1 = Buffer.from([0x4a, 0x6f, 0x73, 0xe9]);
    expect(toUtf8(latin1)).toMatchObject({ text: 'José', encoding: 'Windows-1252' });
    expect(toUtf8(Buffer.from('﻿ok', 'utf8')).text).toBe('ok');
  });
  it('normalises country names and codes', () => {
    expect(lookupCountry('usa')?.name).toBe('United States');
    expect(lookupCountry('IN')?.name).toBe('India');
    expect(lookupCountry('United Kingdom')?.code).toBe('GB');
    expect(lookupCountry('Narnia')).toBeNull();
  });
});
