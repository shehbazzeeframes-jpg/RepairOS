import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config';

const prodEmail = { RESEND_API_KEY: 're_x', EMAIL_FROM: 'RepairOS <no-reply@example.com>' };

describe('worker config (M2, D6, L5)', () => {
  it('refuses to start without an explicit NODE_ENV', () => {
    expect(() => loadWorkerConfig({ APP_DATABASE_URL: 'postgresql://a@b/c' })).toThrow(/NODE_ENV/);
  });

  it('outside development/test requires RESEND_API_KEY, EMAIL_FROM and APP_DATABASE_URL', () => {
    expect(() => loadWorkerConfig({ NODE_ENV: 'production', APP_DATABASE_URL: 'postgresql://a@b/c' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadWorkerConfig({ NODE_ENV: 'production', ...prodEmail })).toThrow(/APP_DATABASE_URL/);
    expect(() => loadWorkerConfig({ NODE_ENV: 'staging', ...prodEmail })).toThrow(/APP_DATABASE_URL/);
    const ok = loadWorkerConfig({ NODE_ENV: 'production', ...prodEmail, APP_DATABASE_URL: 'postgresql://a@b/c' });
    expect(ok).toMatchObject({ nodeEnv: 'production', appDatabaseUrl: 'postgresql://a@b/c', email: { provider: 'resend' } });
  });

  it('development may run without APP_DATABASE_URL, on the file outbox', () => {
    expect(loadWorkerConfig({ NODE_ENV: 'development' })).toMatchObject({ appDatabaseUrl: null, email: { provider: 'outbox' } });
  });
});
