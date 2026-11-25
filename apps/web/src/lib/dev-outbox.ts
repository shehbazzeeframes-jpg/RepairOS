import { z } from 'zod';

/**
 * Dev-only email outbox (tech-lead decision D6). Not in contracts: the API serves it only outside
 * production. GET /api/dev/outbox → { items } newest first; GET /api/dev/outbox/:id → one item.
 */
export const OutboxEmail = z.object({
  id: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  text: z.string().nullable().optional().transform((v) => v ?? ''),
  html: z.string().nullable().optional().transform((v) => v ?? ''),
  createdAt: z.string(),
});
export type OutboxEmail = z.infer<typeof OutboxEmail>;

export const OutboxList = z.object({ items: z.array(OutboxEmail) });

/** The page exists in dev builds, and in the e2e build that sets NEXT_PUBLIC_DEV_OUTBOX=1. */
export function isDevOutboxEnabled(env: { NODE_ENV?: string; NEXT_PUBLIC_DEV_OUTBOX?: string }): boolean {
  return env.NODE_ENV !== 'production' || env.NEXT_PUBLIC_DEV_OUTBOX === '1';
}

export function recipients(email: Pick<OutboxEmail, 'to'>): string {
  return Array.isArray(email.to) ? email.to.join(', ') : email.to;
}

export interface OutboxLink {
  url: string;
  /** Path inside this app (invite / reset links), opened in the same tab. */
  appPath: string | null;
}

const APP_PATHS = /^\/(invite\/|reset-password|api\/auth\/reset-password\/)/;

/** Unique http(s) links in an email's text (and html as a fallback), app links first. */
export function extractLinks(email: Pick<OutboxEmail, 'text' | 'html'>): OutboxLink[] {
  const source = `${email.text}\n${email.html.replace(/&amp;/g, '&')}`;
  const urls = [...new Set(source.match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
  return urls
    .map((url) => {
      let appPath: string | null = null;
      try {
        const parsed = new URL(url);
        if (APP_PATHS.test(parsed.pathname)) appPath = `${parsed.pathname}${parsed.search}`;
      } catch {
        appPath = null;
      }
      return { url, appPath };
    })
    .sort((a, b) => Number(b.appPath !== null) - Number(a.appPath !== null));
}
