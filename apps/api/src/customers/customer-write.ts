/**
 * Customer writes shared by POST /api/customers and check-in (nested `newCustomer`, same transaction).
 */
import type { ConsentChange, ConsentChannel, CreateCustomerData, NormalizedPhone } from '@repairos/contracts';
import type { ScopedTx } from '@repairos/db';

export const CONSENT_COLUMN: Record<ConsentChannel, 'marketingSmsAt' | 'marketingEmailAt' | 'marketingWhatsappAt'> = {
  SMS: 'marketingSmsAt',
  EMAIL: 'marketingEmailAt',
  WHATSAPP: 'marketingWhatsappAt',
};

/** Inserts the customer, phones and one consent event per granted channel. Returns the new id. */
export async function insertCustomer(tx: ScopedTx, shopId: string, userId: string, data: CreateCustomerData): Promise<string> {
  const now = new Date();
  const granted = Object.fromEntries(data.consents.map((c) => [CONSENT_COLUMN[c.channel], now]));
  const customer = await tx.customer.create({
    data: {
      shopId,
      kind: data.kind,
      firstName: data.kind === 'PERSON' ? data.firstName : null,
      lastName: data.kind === 'PERSON' ? data.lastName : null,
      businessName: data.kind === 'BUSINESS' ? data.businessName : null,
      businessContactName: data.kind === 'BUSINESS' ? data.businessContactName : null,
      displayName: data.displayName,
      email: data.email,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2,
      city: data.city,
      region: data.region,
      postcode: data.postcode,
      notes: data.notes,
      tags: data.tags,
      preferredChannel: data.preferredChannel,
      serviceOptOutSms: data.serviceOptOutSms,
      serviceOptOutEmail: data.serviceOptOutEmail,
      serviceOptOutWhatsapp: data.serviceOptOutWhatsapp,
      createdByUserId: userId,
      ...granted,
    },
  });
  await insertPhones(tx, shopId, customer.id, data.phones);
  await appendConsentEvents(tx, shopId, customer.id, userId, data.consents, now);
  return customer.id;
}

export async function insertPhones(tx: ScopedTx, shopId: string, customerId: string, phones: readonly NormalizedPhone[]): Promise<void> {
  if (phones.length === 0) return;
  await tx.customerPhone.createMany({
    data: phones.map((p) => ({
      ...(p.id ? { id: p.id } : {}),
      shopId,
      customerId,
      e164: p.e164,
      digits: p.e164.slice(1),
      label: p.label,
      isPrimary: p.isPrimary,
      isWhatsapp: p.isWhatsapp,
      position: p.position,
    })),
  });
}

export async function appendConsentEvents(
  tx: ScopedTx,
  shopId: string,
  customerId: string,
  userId: string,
  changes: readonly ConsentChange[],
  at = new Date(),
): Promise<void> {
  if (changes.length === 0) return;
  await tx.customerConsentEvent.createMany({
    data: changes.map((c) => ({
      shopId,
      customerId,
      channel: c.channel,
      purpose: c.purpose,
      state: c.state,
      source: c.source,
      note: c.note,
      recordedByUserId: userId,
      createdAt: at,
    })),
  });
}

/** Denormalised consent columns after `changes` (granted → now, withdrawn → null). */
export function consentColumns(changes: readonly ConsentChange[], at = new Date()) {
  return Object.fromEntries(changes.map((c) => [CONSENT_COLUMN[c.channel], c.state === 'GRANTED' ? at : null]));
}
