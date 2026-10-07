/**
 * Minimal five-field cron evaluator for the repeatable job schedules.
 *
 *   ┌───────── minute        0-59
 *   │ ┌─────── hour          0-23
 *   │ │ ┌───── day of month  1-31
 *   │ │ │ ┌─── month         1-12
 *   │ │ │ │ ┌─ day of week   0-6 (Sunday = 0, 7 also accepted)
 *   * * * * *
 *
 * Supported per field: `*`, a number, a list (`1,15`), a range (`1-5`), and a step on
 * either (`*​/15`, `1-20/2`). Not supported: names (`MON`, `JAN`), `?`, `L`, `W`, `#`,
 * seconds, or years — none of the schedules in this codebase need them, and rejecting
 * them loudly is safer than silently mis-scheduling a purge job.
 *
 * Matching follows Vixie cron: when BOTH day-of-month and day-of-week are restricted,
 * a day matches if EITHER does. All times are UTC, so schedules do not shift with the
 * host timezone or daylight saving.
 */

type Field = { min: number; max: number; values: Set<number> };

const RANGES: [min: number, max: number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

function parseField(raw: string, [min, max]: [number, number], index: number): Field {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [spec, stepRaw] = part.split('/');
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) throw new Error(`Invalid step in cron field ${index + 1}: "${part}"`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new Error(`Step must be >= 1 in cron field ${index + 1}: "${part}"`);

    let lo: number;
    let hi: number;
    if (spec === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(spec)) {
      lo = hi = Number(spec);
      // A bare number with a step means "from here to the end of the range".
      if (stepRaw !== undefined) hi = max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(spec);
      if (!m) throw new Error(`Unsupported cron field ${index + 1}: "${part}"`);
      lo = Number(m[1]);
      hi = Number(m[2]);
    }

    // Day-of-week 7 is Sunday, same as 0.
    if (index === 4) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron field ${index + 1} out of range (${min}-${max}): "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw new Error(`Cron field ${index + 1} matches nothing: "${raw}"`);
  return { min, max, values };
}

export type CronExpr = {
  fields: [Field, Field, Field, Field, Field];
  /** True when the expression restricts both day-of-month and day-of-week. */
  domAndDowRestricted: boolean;
};

export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  const fields = parts.map((p, i) => parseField(p, RANGES[i], i)) as CronExpr['fields'];
  return { fields, domAndDowRestricted: parts[2] !== '*' && parts[4] !== '*' };
}

function matches(expr: CronExpr, d: Date): boolean {
  const [minute, hour, dom, month, dow] = expr.fields;
  if (!minute.values.has(d.getUTCMinutes())) return false;
  if (!hour.values.has(d.getUTCHours())) return false;
  if (!month.values.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom.values.has(d.getUTCDate());
  const dowOk = dow.values.has(d.getUTCDay());
  // Vixie-cron OR semantics when both are restricted; otherwise both must hold.
  return expr.domAndDowRestricted ? domOk || dowOk : domOk && dowOk;
}

/**
 * The first matching minute strictly after `from`. Scans minute by minute, bounded to
 * four years so an impossible date (e.g. `0 0 30 2 *`) throws instead of looping.
 */
export function nextCronRun(expr: string | CronExpr, from: Date = new Date()): Date {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = 366 * 4 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(parsed, d)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error(`Cron expression never matches within 4 years: "${typeof expr === 'string' ? expr : '(parsed)'}"`);
}
