import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { createReadStream } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { detectDelimiter, detectHeaderRow } from './import-detect';

export const MAX_COLUMNS = 100;
export const MAX_CELL = 1000;

export type FileKind = 'csv' | 'xlsx';
export type ParseOptions = { delimiter?: string | null; sheetName?: string | null };

/** Validates file type by extension AND content signature. Rejects anything else (including legacy .xls and macro-enabled workbooks). */
export function detectKind(fileName: string, head: Buffer): FileKind | null {
  const ext = fileName.toLowerCase().split('.').pop();
  const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (ext === 'xlsx') return isZip ? 'xlsx' : null;
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    if (isZip) return null;
    // UTF-16 text legitimately contains NUL bytes; anything else with NULs is binary.
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    if (!utf16 && head.subarray(0, 8192).includes(0)) {
      // Allow BOM-less UTF-16 (NUL in every other byte); reject other binary content.
      if (head.length < 64) return null;
      let nul = 0;
      for (const b of head.subarray(0, 2000)) if (b === 0) nul++;
      if (nul < Math.min(head.length, 2000) / 4) return null;
    }
    return 'csv';
  }
  return null;
}

/** Converts an ExcelJS cell value to plain text. Formulas are never evaluated — only their cached result is read. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) >= 1e9 ? v.toFixed(0) : String(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
    if ('result' in v) return cellText((v as { result: ExcelJS.CellValue }).result);
    if ('error' in v) return '';
  }
  return '';
}

const clip = (s: string) => (s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s);

/** Streams every row (including any header) as arrays of strings, from the chosen sheet / with the chosen delimiter. */
export async function* iterateRows(path: string, kind: FileKind, opts: ParseOptions = {}): AsyncGenerator<string[]> {
  // Fail with something an operator can act on. The usual cause is STORAGE_DIR differing
  // between the web process (which wrote the upload) and the worker (which reads it) —
  // they must point at the same directory, and on more than one host it must be shared.
  try {
    await access(path);
  } catch {
    throw new Error(`Uploaded file is missing from storage (${path}). Check that STORAGE_DIR is the same for the web server and the worker.`);
  }

  if (kind === 'csv') {
    const parser = Papa.parse(Papa.NODE_STREAM_INPUT, { header: false, skipEmptyLines: 'greedy', delimiter: opts.delimiter ?? '' });
    const source = createReadStream(path, { encoding: 'utf8' });
    // A stream 'error' event with no listener is fatal to the whole process, not just this
    // call — an unreadable upload would take down the worker (and then crash-loop on the
    // same job) or the web server. Forwarding it into the parser makes the for-await below
    // reject instead, so the caller fails the one import and everything else keeps running.
    source.on('error', (err) => parser.destroy(err));
    source.pipe(parser);
    let first = true;
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        let cells = row.slice(0, MAX_COLUMNS).map((c) => clip(String(c ?? '')));
        if (first) {
          cells = cells.map((c, i) => (i === 0 ? c.replace(/^﻿/, '') : c));
          first = false;
        }
        yield cells;
      }
    } finally {
      source.destroy();
    }
    return;
  }
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit', entries: 'emit' });
  let index = 0;
  for await (const sheet of reader) {
    const name = (sheet as unknown as { name?: string }).name ?? `Sheet${index + 1}`;
    index++;
    if (opts.sheetName && name !== opts.sheetName) {
      for await (const _row of sheet) void _row; // drain
      continue;
    }
    for await (const row of sheet) {
      const values = (row.values as ExcelJS.CellValue[]).slice(1, MAX_COLUMNS + 1);
      const cells = Array.from({ length: values.length }, (_, i) => clip(cellText(values[i]).trim()));
      if (cells.every((c) => c === '')) continue;
      yield cells;
    }
    break;
  }
}

export async function readHead(path: string, bytes = 8192) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Lists worksheets with their non-empty row counts (XLSX only). */
export async function listSheets(path: string) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, { sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit', entries: 'emit' });
  const out: { name: string; rows: number }[] = [];
  let i = 0;
  for await (const sheet of reader) {
    const name = (sheet as unknown as { name?: string }).name ?? `Sheet${i + 1}`;
    i++;
    let rows = 0;
    for await (const row of sheet) {
      const vals = (row.values as ExcelJS.CellValue[]).slice(1);
      if (vals.some((v) => cellText(v).trim() !== '')) rows++;
      if (rows > 500_000) break;
    }
    out.push({ name, rows });
  }
  return out;
}

export function uniqueHeaders(raw: string[], width: number) {
  const seen = new Map<string, number>();
  return Array.from({ length: width }, (_, i) => {
    const h = (raw[i] ?? '').trim() || `Column ${i + 1}`;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} (${n})` : h;
  });
}

export type Analysis = { headers: string[]; headerRow: number; sample: string[][]; delimiter: string | null; sheetName: string | null; sheets: { name: string; rows: number }[]; topRows: string[][] };

/**
 * Inspects a file: picks the delimiter (CSV) or the most populated sheet (XLSX), finds the header row,
 * and returns headers plus a sample of data rows for detection and preview.
 */
export async function analyze(path: string, kind: FileKind, prefs: { sheetName?: string | null; headerRow?: number | null; delimiter?: string | null } = {}): Promise<Analysis> {
  let delimiter: string | null = null;
  let sheets: { name: string; rows: number }[] = [];
  let sheetName: string | null = null;
  if (kind === 'csv') {
    delimiter = prefs.delimiter ?? detectDelimiter((await readHead(path, 65_536)).toString('utf8'));
  } else {
    sheets = await listSheets(path);
    sheetName = prefs.sheetName && sheets.some((s) => s.name === prefs.sheetName) ? prefs.sheetName : ([...sheets].sort((a, b) => b.rows - a.rows)[0]?.name ?? null);
  }
  const rows: string[][] = [];
  for await (const r of iterateRows(path, kind, { delimiter, sheetName })) {
    rows.push(r);
    if (rows.length >= 260) break;
  }
  const headerRow = prefs.headerRow != null && prefs.headerRow >= 0 && prefs.headerRow <= 20 ? prefs.headerRow : detectHeaderRow(rows);
  const width = Math.min(MAX_COLUMNS, Math.max(0, ...rows.slice(0, 50).map((r) => r.length)));
  const headers = headerRow === 0 ? uniqueHeaders([], width) : uniqueHeaders(rows[headerRow - 1] ?? [], width);
  const sample = rows.slice(headerRow).filter((r) => r.some((c) => c.trim()));
  return { headers, headerRow, sample, delimiter, sheetName, sheets, topRows: rows.slice(0, 8) };
}

/** Back-compat helper used by older callers: headers + sample with auto-detected structure. */
export async function preview(path: string, kind: FileKind, sampleSize = 15) {
  const a = await analyze(path, kind);
  return { headers: a.headers, sample: a.sample.slice(0, sampleSize) };
}
