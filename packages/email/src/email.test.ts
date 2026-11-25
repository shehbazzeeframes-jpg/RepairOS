import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmailProvider,
  DEV_EMAIL_FROM,
  EmailSendError,
  inviteEmail,
  listOutbox,
  loadEmailConfig,
  OutboxEmailProvider,
  passwordResetEmail,
  readOutboxItem,
  ResendEmailProvider,
  subjectSafe,
} from './index';

const message = { to: 'sam@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', replyTo: 'owner@example.com' };

describe('ResendEmailProvider', () => {
  it('POSTs to /emails with bearer auth, from, reply_to and both bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 }));
    const provider = new ResendEmailProvider({ apiKey: 're_test', from: 'RepairOS <x@y.z>', fetch: fetchMock as typeof fetch });
    await expect(provider.send(message)).resolves.toEqual({ id: 'msg_123' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'RepairOS <x@y.z>',
      to: ['sam@example.com'],
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      reply_to: 'owner@example.com',
    });
  });

  it('throws EmailSendError with the status on an error response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'Invalid from' }), { status: 422 }));
    const provider = new ResendEmailProvider({ apiKey: 're_test', from: 'x@y.z', fetch: fetchMock as typeof fetch });
    const err = await provider.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect(err).toMatchObject({ status: 422, message: expect.stringContaining('Invalid from') });
  });

  it('throws EmailSendError when the network fails', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const provider = new ResendEmailProvider({ apiKey: 're_test', from: 'x@y.z', fetch: fetchMock as typeof fetch });
    await expect(provider.send(message)).rejects.toBeInstanceOf(EmailSendError);
  });
});

describe('OutboxEmailProvider', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes JSON files and lists them newest first', async () => {
    dir = await mkdtemp(join(tmpdir(), 'outbox-'));
    const provider = new OutboxEmailProvider(dir, DEV_EMAIL_FROM);
    const first = await provider.send({ ...message, subject: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await provider.send({ ...message, subject: 'second' });

    expect(await readdir(dir)).toHaveLength(2);
    const stored = JSON.parse(await readFile(join(dir, `${first.id}.json`), 'utf8'));
    expect(stored).toMatchObject({ from: DEV_EMAIL_FROM, replyTo: 'owner@example.com', to: 'sam@example.com' });

    const items = await listOutbox(dir);
    expect(items.map((i) => i.subject)).toEqual(['second', 'first']);
    expect(Object.keys(items[0]!).sort()).toEqual(['createdAt', 'html', 'id', 'subject', 'text', 'to']);
    expect(await readOutboxItem(dir, second.id)).toMatchObject({ id: second.id, subject: 'second' });
  });

  it('caps the list, treats a missing dir as empty and refuses path-like ids', async () => {
    dir = await mkdtemp(join(tmpdir(), 'outbox-'));
    const provider = new OutboxEmailProvider(dir, DEV_EMAIL_FROM);
    for (let i = 0; i < 3; i++) await provider.send(message);
    expect(await listOutbox(dir, 2)).toHaveLength(2);
    expect(await listOutbox(join(dir, 'missing'))).toEqual([]);
    expect(await readOutboxItem(dir, '../../etc/passwd')).toBeNull();
    expect(await readOutboxItem(dir, 'nope')).toBeNull();
  });
});

describe('email config (D6)', () => {
  it('production refuses to start without RESEND_API_KEY and EMAIL_FROM', () => {
    expect(() => loadEmailConfig({ NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => loadEmailConfig({ NODE_ENV: 'production', RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/);
    expect(() => loadEmailConfig({ NODE_ENV: 'production', EMAIL_FROM: 'a@b.c' })).toThrow(/RESEND_API_KEY/);
    expect(loadEmailConfig({ NODE_ENV: 'production', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c' }).provider).toBe('resend');
  });

  it('M2: NODE_ENV must be explicit; any value other than development/test needs Resend', () => {
    expect(() => loadEmailConfig({})).toThrow(/NODE_ENV/);
    expect(() => loadEmailConfig({ NODE_ENV: '  ' })).toThrow(/NODE_ENV/);
    expect(() => loadEmailConfig({ NODE_ENV: 'staging' })).toThrow(/RESEND_API_KEY and EMAIL_FROM/);
    expect(() => loadEmailConfig({ NODE_ENV: 'prod', RESEND_API_KEY: 're_x' })).toThrow(/EMAIL_FROM/);
    expect(loadEmailConfig({ NODE_ENV: 'test' }).provider).toBe('outbox');
  });

  it('uses the outbox when RESEND_API_KEY is unset, Resend only when it is set', () => {
    const dev = loadEmailConfig({ NODE_ENV: 'development', EMAIL_OUTBOX_DIR: '/tmp/x' });
    expect(dev).toMatchObject({ provider: 'outbox', from: DEV_EMAIL_FROM, outboxDir: '/tmp/x' });
    expect(createEmailProvider(dev).name).toBe('outbox');
    const withKey = loadEmailConfig({ NODE_ENV: 'development', RESEND_API_KEY: 're_x' });
    expect(createEmailProvider(withKey).name).toBe('resend');
    expect(loadEmailConfig({ NODE_ENV: 'test' }).outboxDir).toMatch(/\.outbox$/);
  });
});

describe('templates', () => {
  it('invite email has the subject, inviter, shop, role, button, link and expiry, escaped', () => {
    const email = inviteEmail({
      inviterName: 'Ava <Owner>',
      inviterEmail: 'ava@shop.test',
      shopName: 'Fix & Go',
      roleLabel: 'Front desk',
      roleDescription: 'Checks in devices and takes payments.',
      url: 'http://localhost:3000/invite/abc',
      expiresText: '12/02/2026, 9:00 AM EST',
    });
    expect(email.subject).toBe('Ava Owner invited you to join Fix & Go on RepairOS');
    expect(email.html).toContain('Ava &lt;Owner&gt; (ava@shop.test) has invited you to join <strong>Fix &amp; Go</strong> as <strong>Front desk</strong>');
    expect(email.html).toContain('href="http://localhost:3000/invite/abc"');
    expect(email.html).toContain('Accept invite');
    expect(email.html).not.toContain('<Owner>');
    expect(email.text).toContain('http://localhost:3000/invite/abc');
    expect(email.text).toContain('This invite expires on 12/02/2026, 9:00 AM EST.');
    expect(email.text).toContain("If you weren't expecting this, you can ignore this email.");
  });

  it('L4: names in the subject lose URLs, host names and angle brackets', () => {
    const email = inviteEmail({
      inviterName: 'Support <https://evil.example/login>',
      inviterEmail: 'x@y.z',
      shopName: 'Verify now at secure-login.com/reset or www.phish.net',
      roleLabel: 'Front desk',
      roleDescription: 'd',
      url: 'http://localhost:3000/invite/abc',
      expiresText: 'soon',
    });
    expect(email.subject).toBe('Support invited you to join Verify now at or on RepairOS');
    expect(email.subject).not.toMatch(/https?:|www\.|\.com|\.net|[<>]/);
    expect(email.html).toContain('<title>RepairOS</title>');
    expect(subjectSafe('Fix.It Repairs', 'a shop')).toBe('Fix.It Repairs');
    expect(subjectSafe('<<>> http://x.y', 'a shop')).toBe('a shop');
    expect(subjectSafe('a'.repeat(200), 'x')).toHaveLength(80);
  });

  it('password reset email has the link in both parts', () => {
    const email = passwordResetEmail({ name: 'Sam', url: 'http://x/api/auth/reset-password/t?callbackURL=y', expiresIn: '1 hour' });
    expect(email.subject).toBe('Reset your RepairOS password');
    expect(email.html).toContain('Reset password');
    expect(email.text).toContain('http://x/api/auth/reset-password/t?callbackURL=y');
  });
});
