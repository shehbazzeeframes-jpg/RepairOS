import type { EmailProvider } from '@repairos/email';
import { describe, expect, it, vi } from 'vitest';
import { processEmailJob } from './email-jobs';

const message = { to: 'sam@example.com', subject: 'Invite', html: '<a href="http://x/invite/SECRET">x</a>', text: 'SECRET' };
const track = { kind: 'invite' as const, shopId: 'shop', invitationId: 'inv', sendCount: 2 };

function deps(send: EmailProvider['send']) {
  return {
    provider: { name: 'outbox' as const, send: vi.fn(send) },
    markInvite: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('processEmailJob', () => {
  it('sends and marks the invite SENT', async () => {
    const d = deps(async () => ({ id: 'm1' }));
    await expect(processEmailJob({ id: '1', data: { message, track }, attemptsMade: 0, opts: { attempts: 3 } }, d)).resolves.toEqual({
      id: 'm1',
    });
    expect(d.provider.send).toHaveBeenCalledWith(message);
    expect(d.markInvite).toHaveBeenCalledWith(track, 'SENT');
  });

  it('rethrows for a retry and marks FAILED only on the last attempt', async () => {
    const d = deps(async () => {
      throw new Error('smtp down');
    });
    await expect(processEmailJob({ id: '1', data: { message, track }, attemptsMade: 0, opts: { attempts: 3 } }, d)).rejects.toThrow('smtp down');
    expect(d.markInvite).not.toHaveBeenCalled();
    await expect(processEmailJob({ id: '1', data: { message, track }, attemptsMade: 2, opts: { attempts: 3 } }, d)).rejects.toThrow('smtp down');
    expect(d.markInvite).toHaveBeenCalledWith(track, 'FAILED');
  });

  it('never logs the message body (it holds the invite link)', async () => {
    const d = deps(async () => {
      throw new Error('nope');
    });
    await processEmailJob({ id: '1', data: { message }, attemptsMade: 2, opts: { attempts: 3 } }, d).catch(() => undefined);
    const logged = JSON.stringify([...d.logger.info.mock.calls, ...d.logger.warn.mock.calls, ...d.logger.error.mock.calls]);
    expect(logged).not.toContain('SECRET');
  });
});
