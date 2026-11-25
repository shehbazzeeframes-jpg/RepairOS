/** Sprint 2 API test helpers: check-in through the real endpoint, valid IMEIs, statuses by name. */
import { randomUUID } from 'node:crypto';
import { type CreateTicketInput, type TicketDetail, TicketStatusListResponse } from '@repairos/contracts';
import type { Agent } from './helpers';

/** A Luhn-valid 15-digit IMEI from a 14-digit body (deterministic per seed). */
export function imei(seed: number): string {
  const body = `35${String(seed).padStart(12, '0')}`.slice(0, 14);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

let phoneSeq = 1000;
/** A unique valid US number (+1 212 555 xxxx is not valid in libphonenumber; 212-2xx is). */
export function usPhone(): string {
  phoneSeq++;
  return `+1212${String(2000000 + phoneSeq).slice(-7)}`;
}

export async function statuses(agent: Agent): Promise<Record<string, { id: string; category: string }>> {
  const list = TicketStatusListResponse.parse((await agent.get('/api/ticket-statuses').expect(200)).body);
  return Object.fromEntries(list.items.map((s) => [s.name, { id: s.id, category: s.category }]));
}

export interface CheckInOpts {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  imei?: string | null;
  passcode?: CreateTicketInput['devicePasscode'];
  extra?: Partial<CreateTicketInput>;
  key?: string;
}

/** POST /api/tickets with a new customer + new device. */
export async function checkInNew(agent: Agent, o: CheckInOpts = {}): Promise<TicketDetail> {
  const body: CreateTicketInput = {
    newCustomer: {
      firstName: o.firstName ?? 'Ana',
      lastName: o.lastName ?? 'Lopez',
      phones: [{ number: o.phone ?? usPhone() }],
      ...(o.email ? { email: o.email } : {}),
    },
    newDevice: {
      type: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 13',
      ...(o.imei === null ? {} : { imei: o.imei ?? imei(Math.floor(Math.random() * 1e9)) }),
      ...(o.passcode ? { passcode: o.passcode } : {}),
    },
    issues: [{ code: 'SCREEN_CRACKED' }],
    ...o.extra,
  };
  const req = agent.post('/api/tickets');
  if (o.key) req.set('Idempotency-Key', o.key);
  const res = await req.send(body);
  if (res.status !== 201) throw new Error(`check-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as TicketDetail;
}

/** POST /api/tickets for an existing customer + device. */
export async function checkInExisting(agent: Agent, customerId: string, deviceId: string, extra: Partial<CreateTicketInput> = {}): Promise<TicketDetail> {
  const res = await agent.post('/api/tickets').send({ customerId, deviceId, issues: [{ code: 'BATTERY' }], ...extra });
  if (res.status !== 201) throw new Error(`check-in failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as TicketDetail;
}

export const newKey = () => randomUUID();
