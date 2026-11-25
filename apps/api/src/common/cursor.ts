import { validationFailed } from './errors';

/** Opaque keyset cursor: base64url of a JSON array of the sort-key values of the last row. */
export function encodeKeyset(values: readonly (string | number | boolean | null)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

type Kind = 'string' | 'number' | 'boolean' | 'date' | 'date?' | 'string?';

/**
 * Decodes a cursor made by `encodeKeyset` and checks each value against `kinds` ("date" = ISO string, "?" =
 * nullable). Anything else → 400 VALIDATION_FAILED at ["cursor"].
 */
export function decodeKeyset(cursor: string | undefined, kinds: readonly Kind[]): unknown[] | null {
  if (cursor === undefined) return null;
  const bad = () => validationFailed([{ path: ['cursor'], message: 'Invalid cursor' }]);
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(values) || values.length !== kinds.length) throw bad();
  return values.map((v, i) => {
    const kind = kinds[i]!;
    if (v === null && kind.endsWith('?')) return null;
    switch (kind.replace('?', '')) {
      case 'string':
        if (typeof v === 'string' && v.length <= 200) return v;
        break;
      case 'number':
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        break;
      case 'boolean':
        if (typeof v === 'boolean') return v;
        break;
      case 'date':
        if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v);
        break;
    }
    throw bad();
  });
}
