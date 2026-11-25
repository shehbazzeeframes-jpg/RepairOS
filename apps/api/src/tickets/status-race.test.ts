import { describe, expect, it } from 'vitest';
import { ApiException } from '../common/errors';
import { mapStatusRace, STATUS_CHANGED_MESSAGE } from './tickets.service';

const prismaError = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

function mapped(err: unknown): unknown {
  try {
    mapStatusRace(err);
  } catch (e) {
    return e;
  }
  throw new Error('mapStatusRace returned');
}

describe('mapStatusRace (backstop behind the status row lock)', () => {
  it.each([
    ['P2003 on the status FK', prismaError('PrismaClientKnownRequestError', 'Foreign key constraint violated on the constraint: `tickets_shopId_statusId_statusCategory_fkey`', { code: 'P2003', meta: { field_name: 'tickets_shopId_statusId_statusCategory_fkey (index)' } })],
    ['raw FK text on statusIdBeforeClose', prismaError('PrismaClientUnknownRequestError', 'insert or update on table "tickets" violates foreign key constraint "tickets_shopId_statusIdBeforeClose_fkey"')],
    ['closed_at CHECK', prismaError('PrismaClientUnknownRequestError', 'new row for relation "tickets" violates check constraint "tickets_closed_at_check"')],
  ])('%s → 409 CONFLICT', (_label, err) => {
    const e = mapped(err);
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).getStatus()).toBe(409);
    expect((e as ApiException).getResponse()).toMatchObject({ code: 'CONFLICT', message: STATUS_CHANGED_MESSAGE });
  });

  it('rethrows anything else unchanged', () => {
    const other = prismaError('PrismaClientKnownRequestError', 'Foreign key constraint violated on the constraint: `tickets_assigneeUserId_shopId_fkey`', { code: 'P2003' });
    expect(mapped(other)).toBe(other);
    const plain = new Error('boom');
    expect(mapped(plain)).toBe(plain);
  });
});
