/** Tech lead decision A11-c: the customer export is a full subject-access export (all notes, never passcodes). */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { CustomerExport } from '@repairos/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerWithShop, type OwnerWithShop } from './fixtures';
import { createTestApp } from './helpers';
import { checkInNew } from './s2';

let app: NestExpressApplication;
let owner: OwnerWithShop;

beforeAll(async () => {
  app = await createTestApp();
  owner = await ownerWithShop(app, { shopName: 'Export Shop' });
});
afterAll(async () => {
  await app?.close();
});

describe('A11-c: full subject-access export', () => {
  it('includes customer notes, device notes and every ticket note (labelled), never the passcode', async () => {
    const t = await checkInNew(owner.agent, { firstName: 'Export', lastName: 'Full', passcode: { lockType: 'PIN', value: '864213' } });
    const current = await owner.agent.get(`/api/customers/${t.customer.id}`).expect(200);
    await owner.agent.patch(`/api/customers/${t.customer.id}`).send({ notes: 'Prefers mornings', version: current.body.version }).expect(200);
    await owner.agent.patch(`/api/devices/${t.device.id}`).send({ notes: 'Dent near camera' }).expect(200);
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Internal: board damage' }).expect(201);
    await owner.agent.post(`/api/tickets/${t.id}/notes`).send({ body: 'Your phone is ready', visibility: 'CUSTOMER' }).expect(201);
    await owner.agent.post(`/api/tickets/${t.id}/cancel`).send({ reason: 'OTHER', returnedConfirmed: true, note: 'Customer moved away' }).expect(200);
    const res = await owner.agent.get(`/api/customers/${t.customer.id}/export`).expect(200);
    const body = CustomerExport.parse(res.body);
    expect(body.customer.notes).toBe('Prefers mornings');
    expect(body.devices[0]!.notes).toBe('Dent near camera');
    expect(body.tickets[0]!.notes.map((n) => [n.visibility, n.visibilityLabel, n.body])).toEqual([
      ['INTERNAL', 'Internal', 'Internal: board damage'],
      ['CUSTOMER', 'Visible to customer', 'Your phone is ready'],
    ]);
    expect(body.tickets[0]!.customerVisibleNotes.map((n) => n.body)).toEqual(['Your phone is ready']);
    expect(body.tickets[0]).toMatchObject({ cancelReason: 'OTHER', cancelNote: 'Customer moved away' });
    expect(res.text).not.toContain('864213');
    expect(res.text).not.toMatch(/passcodeCiphertext|passcodeIv|passcodeTag/);
  });
});
