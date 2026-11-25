import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { EmailMessage, EmailProvider, SendResult } from './provider';

/** What the dev outbox API returns per email (`GET /api/dev/outbox`). */
export interface OutboxItem {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  createdAt: string;
}

/** Stored file shape: the item plus envelope fields. */
interface OutboxFile extends OutboxItem {
  from: string;
  replyTo: string | null;
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Walks up from `start` to the directory holding pnpm-workspace.yaml (the repo root); falls back to `start`. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** `<repo>/.outbox` (gitignored). */
export function defaultOutboxDir(): string {
  return join(findRepoRoot(), '.outbox');
}

/**
 * Dev/test adapter: writes each email as `<dir>/<id>.json`. Ids start with a zero-padded timestamp,
 * so sorting names descending lists the newest first.
 */
export class OutboxEmailProvider implements EmailProvider {
  readonly name = 'outbox' as const;

  constructor(
    readonly dir: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<SendResult> {
    await mkdir(this.dir, { recursive: true });
    const now = new Date();
    const id = `${String(now.getTime()).padStart(15, '0')}-${randomBytes(6).toString('hex')}`;
    const file: OutboxFile = {
      id,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      createdAt: now.toISOString(),
      from: this.from,
      replyTo: message.replyTo ?? null,
    };
    await writeFile(join(this.dir, `${id}.json`), JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { id };
  }
}

function toItem(f: OutboxFile): OutboxItem {
  return { id: f.id, to: f.to, subject: f.subject, text: f.text, html: f.html, createdAt: f.createdAt };
}

/** Newest first, at most `limit`. A missing directory is an empty outbox. */
export async function listOutbox(dir: string, limit = 50): Promise<OutboxItem[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -5))
    .filter((id) => ID.test(id))
    .sort()
    .reverse()
    .slice(0, limit);
  const items: OutboxItem[] = [];
  for (const id of ids) {
    const item = await readOutboxItem(dir, id);
    if (item) items.push(item);
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id.localeCompare(a.id)));
}

/** One item by id, or null (also for ids that are not plain file names, so no path traversal). */
export async function readOutboxItem(dir: string, id: string): Promise<OutboxItem | null> {
  if (!ID.test(id)) return null;
  try {
    return toItem(JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as OutboxFile);
  } catch {
    return null;
  }
}
