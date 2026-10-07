import { z } from 'zod';

/** Shared filter DSL used by advanced filter builders and validated server-side against a field whitelist. */
export type FieldType = 'text' | 'enum' | 'number' | 'date' | 'boolean';
export type FilterField = { key: string; label: string; type: FieldType; options?: { value: string; label: string }[] };

export const OPS: Record<FieldType, { value: string; label: string }[]> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'empty', label: 'is empty' },
    { value: 'not_empty', label: 'is not empty' },
  ],
  enum: [
    { value: 'in', label: 'is any of' },
    { value: 'not_in', label: 'is none of' },
    { value: 'empty', label: 'is empty' },
    { value: 'not_empty', label: 'is not empty' },
  ],
  number: [
    { value: 'gte', label: '≥' },
    { value: 'lte', label: '≤' },
    { value: 'eq', label: '=' },
  ],
  date: [
    { value: 'after', label: 'after' },
    { value: 'before', label: 'before' },
    { value: 'last_days', label: 'in the last N days' },
    { value: 'older_days', label: 'older than N days' },
    { value: 'empty', label: 'is empty' },
    { value: 'not_empty', label: 'is set' },
  ],
  boolean: [
    { value: 'true', label: 'is yes' },
    { value: 'false', label: 'is no' },
  ],
};

export const conditionSchema = z.object({
  field: z.string().max(60),
  op: z.string().max(20),
  value: z.union([z.string().max(500), z.number(), z.array(z.string().max(200)).max(200), z.null()]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export const filterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  conditions: z.array(conditionSchema).max(25).default([]),
});
export type Filter = z.infer<typeof filterSchema>;

/** Parses the JSON-encoded `filter` query parameter safely. */
export function parseFilterParam(raw: unknown): Filter {
  if (!raw || typeof raw !== 'string') return { conditions: [] };
  try {
    return filterSchema.parse(JSON.parse(raw));
  } catch {
    return { conditions: [] };
  }
}

export const sortSchema = z.object({ id: z.string().max(60), desc: z.boolean() });

/** Selection of records for bulk actions: explicit ids, or "everything matching filter" minus exclusions. */
export const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('ids'), ids: z.array(z.string().max(64)).min(1).max(5000) }),
  z.object({ mode: z.literal('filter'), filter: filterSchema, excludeIds: z.array(z.string().max(64)).max(5000).default([]) }),
]);
export type Selection = z.infer<typeof selectionSchema>;
