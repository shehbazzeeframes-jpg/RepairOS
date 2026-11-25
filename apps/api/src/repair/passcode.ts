/**
 * Device passcodes (A15, DV3–DV5). The plaintext only ever exists in the request body (validated by contracts
 * `PasscodeInput`) and in the reveal response; it is encrypted here before it reaches the database and is never
 * logged, audited (only `{ lockType }`), exported or put in the timeline.
 */
import { formatPattern, type LockType, type PasscodeInput, SECRET_LOCK_TYPES } from '@repairos/contracts';
import { CLEARED_PASSCODE_COLUMNS, encryptField, type FieldKeyring, passcodeAad, passcodeColumns, type ScopedTx } from '@repairos/db';
import { ApiException } from '../common/errors';
import { writeAudit } from '../common/audit';

/** The secret string to encrypt for a passcode input, or null for NONE / NOT_SHARED. */
function secretOf(input: PasscodeInput): string | null {
  switch (input.lockType) {
    case 'PIN':
    case 'PASSWORD':
      return input.value;
    case 'PATTERN':
      return formatPattern(input.pattern);
    default:
      return null;
  }
}

/** Device columns for a passcode input (encrypted with AAD bound to shop + device). */
export function passcodeData(keyring: FieldKeyring | null, shopId: string, deviceId: string, input: PasscodeInput) {
  const secret = secretOf(input);
  if (secret === null) return { lockType: input.lockType, ...CLEARED_PASSCODE_COLUMNS };
  if (!keyring) {
    // Dev/test without FIELD_ENCRYPTION_KEY: refuse rather than store anything readable.
    throw new ApiException(500, 'INTERNAL', 'Passcode storage is not configured (FIELD_ENCRYPTION_KEY)');
  }
  return {
    lockType: input.lockType,
    ...passcodeColumns(encryptField(keyring, secret, passcodeAad(shopId, deviceId))),
    passcodeSetAt: new Date(),
  };
}

export const isSecretLock = (t: LockType) => SECRET_LOCK_TYPES.includes(t);

/** Audits `device.passcode_changed` with lock types only (never the value). */
export async function auditPasscodeChange(
  tx: ScopedTx,
  e: { shopId: string; actorUserId: string; deviceId: string; before: LockType | null; after: LockType },
): Promise<void> {
  await writeAudit(tx, {
    shopId: e.shopId,
    actorUserId: e.actorUserId,
    action: 'device.passcode_changed',
    entityId: e.deviceId,
    before: e.before === null ? null : { lockType: e.before },
    after: { lockType: e.after },
  });
}

/**
 * DV5: when a ticket closes and the shop setting is on, delete its device's passcode unless another non-closed
 * ticket still needs it. Writes the `passcode_deleted` timeline event (system). Returns true when deleted.
 */
export async function deletePasscodeOnClose(
  tx: ScopedTx,
  opts: { shopId: string; ticketId: string; deviceId: string; settingOn: boolean },
): Promise<boolean> {
  if (!opts.settingOn) return false;
  const device = await tx.device.findFirst({ where: { id: opts.deviceId }, select: { passcodeKeyVersion: true } });
  if (!device || device.passcodeKeyVersion === null) return false;
  const others = await tx.ticket.count({ where: { deviceId: opts.deviceId, id: { not: opts.ticketId }, statusCategory: { not: 'CLOSED' } } });
  if (others > 0) return false;
  await tx.device.update({ where: { id: opts.deviceId }, data: { ...CLEARED_PASSCODE_COLUMNS } });
  await tx.ticketEvent.create({
    data: { shopId: opts.shopId, ticketId: opts.ticketId, actorUserId: null, type: 'passcode_deleted', data: { reason: 'closed' } },
  });
  return true;
}
