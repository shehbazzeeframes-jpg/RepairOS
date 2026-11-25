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
 * Row-locks a device (shop-scoped) for the rest of the transaction. Run it as its own statement BEFORE counting the
 * device's tickets: under READ COMMITTED the next statement then sees every ticket change committed by a transaction
 * that held the lock before us (H1: two tickets of one device closing at the same time). Check-in on an existing
 * device takes the same lock, so a close never misses a ticket being created for the device.
 */
export async function lockDevice(tx: ScopedTx, deviceId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "devices" WHERE "id" = ${deviceId} AND "shopId" = app_current_shop_id() FOR UPDATE`;
}

/**
 * Deletes a device's passcode when the shop setting is on, the device has one, and no non-closed ticket other than
 * `exceptTicketId` uses the device. Locks the device first (`lockDevice`). Returns true when deleted.
 */
async function deleteUnusedPasscode(tx: ScopedTx, opts: { deviceId: string; exceptTicketId: string | null; settingOn: boolean }): Promise<boolean> {
  if (!opts.settingOn) return false;
  await lockDevice(tx, opts.deviceId);
  const device = await tx.device.findFirst({ where: { id: opts.deviceId }, select: { passcodeKeyVersion: true } });
  if (!device || device.passcodeKeyVersion === null) return false;
  const others = await tx.ticket.count({
    where: { deviceId: opts.deviceId, statusCategory: { not: 'CLOSED' }, ...(opts.exceptTicketId ? { id: { not: opts.exceptTicketId } } : {}) },
  });
  if (others > 0) return false;
  await tx.device.update({ where: { id: opts.deviceId }, data: { ...CLEARED_PASSCODE_COLUMNS } });
  return true;
}

/**
 * H1: a ticket moved off a device. Call AFTER the ticket row points at the new device: the old device's passcode is
 * deleted (setting on) when no non-closed ticket uses it any more. No timeline event: the ticket's `device_changed`
 * event tells the story, and the passcode no longer belongs to this ticket's device.
 */
export async function deletePasscodeOfReleasedDevice(tx: ScopedTx, opts: { deviceId: string; settingOn: boolean }): Promise<boolean> {
  return deleteUnusedPasscode(tx, { deviceId: opts.deviceId, exceptTicketId: null, settingOn: opts.settingOn });
}

/**
 * DV5: when a ticket closes and the shop setting is on, delete its device's passcode unless another non-closed
 * ticket still needs it (device row-locked first, H1). Writes the `passcode_deleted` timeline event (system).
 * Returns true when deleted.
 */
export async function deletePasscodeOnClose(
  tx: ScopedTx,
  opts: { shopId: string; ticketId: string; deviceId: string; settingOn: boolean },
): Promise<boolean> {
  const deleted = await deleteUnusedPasscode(tx, { deviceId: opts.deviceId, exceptTicketId: opts.ticketId, settingOn: opts.settingOn });
  if (!deleted) return false;
  await tx.ticketEvent.create({
    data: { shopId: opts.shopId, ticketId: opts.ticketId, actorUserId: null, type: 'passcode_deleted', data: { reason: 'closed' } },
  });
  return true;
}
