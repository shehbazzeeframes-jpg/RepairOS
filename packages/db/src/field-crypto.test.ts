import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptField,
  encryptField,
  FieldDecryptError,
  FieldKeyError,
  isFieldKeyUnset,
  needsReencryption,
  parseFieldKeyring,
  passcodeAad,
  passcodeColumns,
  passcodeFromRow,
} from './field-crypto';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const AAD = passcodeAad('shop_a', 'device_1');

describe('parseFieldKeyring', () => {
  it('accepts one 32-byte base64 key as version 1', () => {
    const ring = parseFieldKeyring(k1);
    expect(ring.currentVersion).toBe(1);
    expect(ring.versions).toEqual([1]);
  });

  it('accepts a rotation list, current key first', () => {
    const ring = parseFieldKeyring(`v2:${k2}, v1:${k1}`);
    expect(ring.currentVersion).toBe(2);
    expect(ring.versions).toEqual([2, 1]);
  });

  it.each([
    ['missing', undefined],
    ['empty', '  '],
    ['placeholder', 'change-me'],
    ['short', randomBytes(16).toString('base64')],
    ['long', randomBytes(48).toString('base64')],
    ['not base64', 'this is not base64 at all!!'],
    ['all-zero key', Buffer.alloc(32).toString('base64')],
    ['bad list entry', `v2:${k2},${k1}`],
    ['duplicate version', `v1:${k1},v1:${k2}`],
  ])('rejects a %s key', (_label, raw) => {
    expect(() => parseFieldKeyring(raw)).toThrow(FieldKeyError);
  });

  it('does not expose key material on the keyring object', () => {
    const ring = parseFieldKeyring(k1);
    const dump = JSON.stringify(ring) + String(Object.values(ring));
    expect(dump).not.toContain(k1);
    expect(dump).not.toContain(Buffer.from(k1, 'base64').toString('hex'));
  });

  it('isFieldKeyUnset distinguishes "not configured" from malformed', () => {
    expect(isFieldKeyUnset(undefined)).toBe(true);
    expect(isFieldKeyUnset('change-me')).toBe(true);
    expect(isFieldKeyUnset('short')).toBe(false);
    expect(isFieldKeyUnset(k1)).toBe(false);
  });
});

describe('encryptField / decryptField', () => {
  const ring = parseFieldKeyring(k1);

  it('round-trips PINs (leading zeros), passwords (unicode) and patterns', () => {
    for (const v of ['0007', '00001234', 'Pässwörd 🔒 with spaces', '1-5-9-6-3', 'x'.repeat(64)]) {
      const enc = encryptField(ring, v, AAD);
      expect(enc.keyVersion).toBe(1);
      expect(enc.iv).toHaveLength(12);
      expect(enc.tag).toHaveLength(16);
      expect(decryptField(ring, enc, AAD)).toBe(v);
    }
  });

  it('uses a fresh IV every time (same plaintext → different ciphertext)', () => {
    const a = encryptField(ring, '123456', AAD);
    const b = encryptField(ring, '123456', AAD);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('never contains the plaintext in any stored column, in any encoding', () => {
    for (const v of ['123456', 'hunter2hunter2', '1-2-3-6-9']) {
      const enc = encryptField(ring, v, AAD);
      const cols = passcodeColumns(enc);
      const stored = [cols.passcodeCiphertext, cols.passcodeIv, cols.passcodeTag].map((b) => Buffer.from(b));
      for (const buf of stored) {
        expect(buf.includes(Buffer.from(v, 'utf8'))).toBe(false);
        expect(buf.toString('latin1')).not.toContain(v);
        expect(buf.toString('hex')).not.toContain(Buffer.from(v).toString('hex'));
        expect(buf.toString('base64')).not.toContain(Buffer.from(v).toString('base64').replace(/=+$/, ''));
      }
    }
  });

  it('detects tampering with the ciphertext, IV or tag', () => {
    const enc = encryptField(ring, '4321', AAD);
    const flip = (b: Buffer) => {
      const c = Buffer.from(b);
      c[0] = c[0]! ^ 0x01;
      return c;
    };
    expect(() => decryptField(ring, { ...enc, ciphertext: flip(enc.ciphertext) }, AAD)).toThrow(FieldDecryptError);
    expect(() => decryptField(ring, { ...enc, iv: flip(enc.iv) }, AAD)).toThrow(FieldDecryptError);
    expect(() => decryptField(ring, { ...enc, tag: flip(enc.tag) }, AAD)).toThrow(FieldDecryptError);
    expect(() => decryptField(ring, { ...enc, tag: enc.tag.subarray(0, 8) }, AAD)).toThrow(FieldDecryptError);
  });

  it('refuses a ciphertext moved to another device or shop (AAD)', () => {
    const enc = encryptField(ring, '4321', AAD);
    expect(() => decryptField(ring, enc, passcodeAad('shop_a', 'device_2'))).toThrow(FieldDecryptError);
    expect(() => decryptField(ring, enc, passcodeAad('shop_b', 'device_1'))).toThrow(FieldDecryptError);
  });

  it('fails with the wrong key or an unknown key version', () => {
    const enc = encryptField(ring, '4321', AAD);
    expect(() => decryptField(parseFieldKeyring(k2), enc, AAD)).toThrow(FieldDecryptError);
    expect(() => decryptField(ring, { ...enc, keyVersion: 7 }, AAD)).toThrow(FieldDecryptError);
  });

  it('rotation: old values still decrypt, new ones use the new key, and are flagged for re-encryption', () => {
    const old = encryptField(ring, '2468', AAD);
    const rotated = parseFieldKeyring(`v2:${k2},v1:${k1}`);
    expect(decryptField(rotated, old, AAD)).toBe('2468');
    expect(needsReencryption(rotated, old)).toBe(true);
    const fresh = encryptField(rotated, '2468', AAD);
    expect(fresh.keyVersion).toBe(2);
    expect(needsReencryption(rotated, fresh)).toBe(false);
    // Once v1 is removed, the old value is unreadable (PASSCODE_UNREADABLE) instead of silently wrong.
    expect(() => decryptField(parseFieldKeyring(`v2:${k2}`), old, AAD)).toThrow(FieldDecryptError);
  });

  it('passcodeFromRow reads the Device columns back', () => {
    const enc = encryptField(ring, '9999', AAD);
    const row = { ...passcodeColumns(enc) };
    expect(decryptField(ring, passcodeFromRow(row)!, AAD)).toBe('9999');
    expect(passcodeFromRow({ passcodeCiphertext: null, passcodeIv: null, passcodeTag: null, passcodeKeyVersion: null })).toBeNull();
  });
});
