/**
 * Field encryption for device passcodes (A15, DV3): AES-256-GCM with versioned keys.
 *
 * Key material comes from FIELD_ENCRYPTION_KEY:
 *   - one key, standard base64 of 32 random bytes (`openssl rand -base64 32`) → key version 1;
 *   - or, for rotation, a comma-separated list of `v<N>:<base64>` entries, current key FIRST:
 *       FIELD_ENCRYPTION_KEY="v2:<new key>,v1:<old key>"
 *     New values are encrypted with the first key; values carrying an older `keyVersion` still decrypt as long as
 *     that version stays in the list. `needsReencryption()` finds them for a re-encryption script (out of scope in
 *     Sprint 2, see the story's edge cases), after which the old entry can be removed.
 *
 * Every value gets a fresh random 96-bit IV and a 128-bit tag. Callers bind the ciphertext to its row with
 * additional authenticated data (`passcodeAad(shopId, deviceId)`), so a ciphertext copied onto another device
 * (or shop) fails to decrypt instead of revealing that device's passcode.
 *
 * Never log, audit or return a decrypted value except from the reveal endpoint.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Values that mean "not configured" (from .env.example and common placeholders). */
const PLACEHOLDERS = new Set(['change-me', 'changeme', 'placeholder', 'secret', 'your-key-here', 'xxx']);

export class FieldKeyError extends Error {
  override name = 'FieldKeyError';
}

/** Decryption failed: wrong or missing key version, tampered ciphertext/IV/tag, or wrong AAD (API: PASSCODE_UNREADABLE). */
export class FieldDecryptError extends Error {
  override name = 'FieldDecryptError';
}

export interface FieldKeyring {
  /** Version used for new encryptions. */
  readonly currentVersion: number;
  /** Versions available for decryption (includes currentVersion). */
  readonly versions: readonly number[];
}

/** Keys live in a WeakMap, not on the keyring object, so they never show up in a log or JSON dump of the config. */
const KEY_MATERIAL = new WeakMap<FieldKeyring, ReadonlyMap<number, Buffer>>();

export interface EncryptedField {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeKey(b64: string, label: string): Buffer {
  const s = b64.trim();
  if (!s || PLACEHOLDERS.has(s.toLowerCase())) throw new FieldKeyError(`${label} is a placeholder`);
  if (!BASE64.test(s) || s.length % 4 !== 0) throw new FieldKeyError(`${label} is not valid base64`);
  const key = Buffer.from(s, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new FieldKeyError(`${label} must be ${KEY_BYTES} bytes (base64 of 32 random bytes: openssl rand -base64 32); got ${key.length}`);
  }
  if (key.every((b) => b === key[0])) throw new FieldKeyError(`${label} is not random (all bytes equal)`);
  return key;
}

/** True when FIELD_ENCRYPTION_KEY is unset, empty or a known placeholder ("not configured", as opposed to malformed). */
export function isFieldKeyUnset(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim();
  return s === '' || PLACEHOLDERS.has(s.toLowerCase());
}

/** Parses FIELD_ENCRYPTION_KEY (see the file comment). Throws FieldKeyError when missing, short, placeholder or malformed. */
export function parseFieldKeyring(raw: string | null | undefined): FieldKeyring {
  const s = (raw ?? '').trim();
  if (!s) throw new FieldKeyError('FIELD_ENCRYPTION_KEY is not set');
  const keys = new Map<number, Buffer>();
  let currentVersion: number;
  if (!s.includes(':')) {
    keys.set(1, decodeKey(s, 'FIELD_ENCRYPTION_KEY'));
    currentVersion = 1;
  } else {
    const entries = s.split(',').map((e) => e.trim()).filter(Boolean);
    currentVersion = 0;
    for (const entry of entries) {
      const m = /^v([1-9]\d{0,5}):(.+)$/.exec(entry);
      if (!m) throw new FieldKeyError('FIELD_ENCRYPTION_KEY entries must look like "v2:<base64>,v1:<base64>"');
      const version = Number(m[1]);
      if (keys.has(version)) throw new FieldKeyError(`FIELD_ENCRYPTION_KEY lists key version ${version} twice`);
      keys.set(version, decodeKey(m[2]!, `FIELD_ENCRYPTION_KEY v${version}`));
      if (!currentVersion) currentVersion = version;
    }
    if (!currentVersion) throw new FieldKeyError('FIELD_ENCRYPTION_KEY is not set');
  }
  const keyring: FieldKeyring = Object.freeze({ currentVersion, versions: Object.freeze([...keys.keys()]) });
  KEY_MATERIAL.set(keyring, keys);
  return keyring;
}

function keyFor(keyring: FieldKeyring, version: number): Buffer | undefined {
  return KEY_MATERIAL.get(keyring)?.get(version);
}

/** AAD binding a passcode ciphertext to its device row. */
export function passcodeAad(shopId: string, deviceId: string): string {
  return `device-passcode:${shopId}:${deviceId}`;
}

/** Encrypts `plaintext` (UTF-8) with the current key. `aad` must be given again to decrypt. */
export function encryptField(keyring: FieldKeyring, plaintext: string, aad: string): EncryptedField {
  const key = keyFor(keyring, keyring.currentVersion);
  if (!key) throw new FieldKeyError('Unknown keyring (create it with parseFieldKeyring)');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: keyring.currentVersion };
}

/** Decrypts a value from `encryptField`. Throws FieldDecryptError on any failure (never returns garbage). */
export function decryptField(keyring: FieldKeyring, value: EncryptedField, aad: string): string {
  const key = keyFor(keyring, value.keyVersion);
  if (!key) throw new FieldDecryptError(`No key for version ${value.keyVersion}`);
  if (value.iv.length !== IV_BYTES || value.tag.length !== TAG_BYTES) throw new FieldDecryptError('Malformed encrypted value');
  try {
    const decipher = createDecipheriv(ALGORITHM, key, value.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new FieldDecryptError('Encrypted value could not be decrypted');
  }
}

/** True when the value was encrypted with an older key version (rotation: decrypt + encryptField again). */
export function needsReencryption(keyring: FieldKeyring, value: Pick<EncryptedField, 'keyVersion'>): boolean {
  return value.keyVersion !== keyring.currentVersion;
}

/** The Device columns for an encrypted passcode (spread into a Prisma create/update). */
export function passcodeColumns(value: EncryptedField) {
  return {
    passcodeCiphertext: new Uint8Array(value.ciphertext),
    passcodeIv: new Uint8Array(value.iv),
    passcodeTag: new Uint8Array(value.tag),
    passcodeKeyVersion: value.keyVersion,
  };
}

/** The Device columns that clear a passcode. */
export const CLEARED_PASSCODE_COLUMNS = {
  passcodeCiphertext: null,
  passcodeIv: null,
  passcodeTag: null,
  passcodeKeyVersion: null,
  passcodeSetAt: null,
} as const;

/** Reads the encrypted passcode back from a Device row; null when none is stored. */
export function passcodeFromRow(row: {
  passcodeCiphertext: Uint8Array | null;
  passcodeIv: Uint8Array | null;
  passcodeTag: Uint8Array | null;
  passcodeKeyVersion: number | null;
}): EncryptedField | null {
  if (!row.passcodeCiphertext || !row.passcodeIv || !row.passcodeTag || row.passcodeKeyVersion === null) return null;
  return {
    ciphertext: Buffer.from(row.passcodeCiphertext),
    iv: Buffer.from(row.passcodeIv),
    tag: Buffer.from(row.passcodeTag),
    keyVersion: row.passcodeKeyVersion,
  };
}
