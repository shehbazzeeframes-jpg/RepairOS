import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp } from '../src/app.factory';
import { type AppConfig, loadConfig } from '../src/config';

export const APP_URL = 'http://localhost:3000';

/** One outbox directory per test file (tests send email synchronously into it). */
export const TEST_OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'repairos-outbox-'));

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const appDbUrl = process.env.APP_DATABASE_URL_TEST;
  if (!appDbUrl) throw new Error('APP_DATABASE_URL_TEST must be set');
  return {
    ...loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      APP_URL,
      APP_DATABASE_URL: appDbUrl,
      LOG_LEVEL: 'silent',
      AUTH_RATE_LIMIT_MAX: '1000',
      INVITE_PREVIEW_RATE_LIMIT: '1000',
      RESEND_API_KEY: '',
      EMAIL_OUTBOX_DIR: TEST_OUTBOX_DIR,
      EMAIL_DELIVERY: 'sync',
    }),
    ...overrides,
  };
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<NestExpressApplication> {
  return createApp(testConfig(overrides));
}

export type Agent = ReturnType<typeof request.agent>;

/** A cookie-keeping client that sends the web app's Origin (as the same-origin proxy does). */
export function agentFor(app: NestExpressApplication): Agent {
  return request.agent(app.getHttpServer()).set('Origin', APP_URL);
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@test.repairos.dev`;
}

export async function signUp(agent: Agent, name = 'Test User', email = uniqueEmail()) {
  const res = await agent.post('/api/auth/sign-up/email').send({ name, email, password: 'Password123!' });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { email, userId: (res.body as { user: { id: string } }).user.id };
}
