/**
 * Recent items for global search (A19): per user + shop in browser storage, newest first, capped at
 * `RECENT_ITEMS_MAX`, cleared on sign-out. Storage may be unavailable (private mode): every access is
 * guarded and the feature quietly does nothing then.
 */
import { RECENT_ITEMS_MAX, RecentItem, recentItemsKey } from '@repairos/contracts';
import { z } from 'zod';

const RecentList = z.array(RecentItem);

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRecent(userId: string, shopId: string): RecentItem[] {
  try {
    const raw = storage()?.getItem(recentItemsKey(userId, shopId));
    if (!raw) return [];
    const parsed = RecentList.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(0, RECENT_ITEMS_MAX) : [];
  } catch {
    return [];
  }
}

function write(userId: string, shopId: string, items: RecentItem[]) {
  try {
    storage()?.setItem(recentItemsKey(userId, shopId), JSON.stringify(items));
  } catch {
    // storage full or blocked: recent items are a convenience only
  }
}

/** Pure: the list after opening `item` (moved to the front, de-duplicated, capped). */
export function withRecent(list: readonly RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...list.filter((i) => !(i.kind === item.kind && i.id === item.id))].slice(
    0,
    RECENT_ITEMS_MAX,
  );
}

export function addRecent(
  userId: string,
  shopId: string,
  item: Omit<RecentItem, 'openedAt'>,
  now = new Date(),
): void {
  write(
    userId,
    shopId,
    withRecent(readRecent(userId, shopId), { ...item, openedAt: now.toISOString() }),
  );
}

/** Drop an entry that now 404s. */
export function removeRecent(userId: string, shopId: string, kind: RecentItem['kind'], id: string) {
  const list = readRecent(userId, shopId);
  const next = list.filter((i) => !(i.kind === kind && i.id === id));
  if (next.length !== list.length) write(userId, shopId, next);
}

/** Sign-out: forget this user's recent items in every shop. */
export function clearRecentForUser(userId: string): void {
  const s = storage();
  if (!s) return;
  try {
    const prefix = recentItemsKey(userId, '');
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // ignore
  }
}
