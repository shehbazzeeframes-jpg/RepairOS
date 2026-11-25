/**
 * Version-conflict helpers for edit forms (spec §0.2, TE1.4: "Reload (refetch, form keeps values where
 * unchanged)"). After a 409 STALE_RECORD the form has three copies of every field:
 *
 * - `base`: what the form was opened (or last reloaded) with,
 * - `mine`: what the person has on screen now,
 * - `fresh`: what the server holds now.
 *
 * Reload keeps only the fields the person actually edited (`mine` differs from `base`) and takes every
 * other field from `fresh`; the new baseline is `fresh`, so the next save sends only real changes and
 * never writes a stale copy of a field someone else changed.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keys of `mine` whose value differs from `base`. */
export function editedKeys<T extends object>(base: T, mine: T): (keyof T)[] {
  return (Object.keys(mine) as (keyof T)[]).filter((k) => !same(base[k], mine[k]));
}

/**
 * Three-way merge of a flat form. `nestedKeys` are record fields (e.g. a checklist) merged per entry,
 * so ticking one checklist item doesn't keep stale copies of the others.
 */
export function rebaseForm<T extends object>(
  base: T,
  mine: T,
  fresh: T,
  nestedKeys: readonly (keyof T)[] = [],
): T {
  const out = { ...fresh };
  for (const k of editedKeys(base, mine)) {
    if (nestedKeys.includes(k)) {
      const b = (base[k] ?? {}) as Record<string, unknown>;
      const m = (mine[k] ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...((fresh[k] ?? {}) as Record<string, unknown>) };
      for (const sub of editedKeys(b, m)) merged[sub] = m[sub];
      out[k] = merged as T[keyof T];
    } else {
      out[k] = mine[k];
    }
  }
  return out;
}

/** Only the entries of `next` that differ from `prev` (for PATCH bodies). */
export function changedEntries<T extends Record<string, unknown>>(prev: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (!same(prev[k], next[k])) out[k] = next[k];
  }
  return out;
}
