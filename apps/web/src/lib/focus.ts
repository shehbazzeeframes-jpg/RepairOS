/**
 * Keyboard and focus helpers shared by check-in and the list pages (proven in the check-in
 * prototype, spec §2.5 and R4).
 */

/** Keys that are typing, so single-letter shortcuts must not fire. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement)
    return !['radio', 'checkbox', 'button', 'submit'].includes(el.type);
  return el.getAttribute('role') === 'combobox';
}

/**
 * Moves focus once the target has rendered, and keeps it there for a few frames: an Astryx
 * Typeahead moves focus to its selected-value chip right after a pick, which would otherwise win.
 * The next key press is the person moving on, so it stops re-asserting focus then (R4).
 */
export function focusSoon(find: () => HTMLElement | null | undefined, frames = 4): void {
  let n = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  window.addEventListener('keydown', cancel, { capture: true, once: true });
  const step = () => {
    if (cancelled) return;
    const el = find();
    if (el && document.activeElement !== el) el.focus();
    if (++n < frames) requestAnimationFrame(step);
    else window.removeEventListener('keydown', cancel, { capture: true });
  };
  requestAnimationFrame(step);
}

export function focusIn(el: HTMLElement | null, selector: string, frames?: number): void {
  focusSoon(() => el?.querySelector<HTMLElement>(selector), frames);
}

/** Focus the control a visible label names (Astryx inputs take no id; their labels point at them). */
export function focusField(el: HTMLElement | null, label: string): void {
  focusSoon(() => {
    const match = [...(el?.querySelectorAll('label') ?? [])].find((l) =>
      (l.textContent ?? '').trim().startsWith(label),
    );
    const id = match?.getAttribute('for');
    return id ? document.getElementById(id) : null;
  });
}

/**
 * ↑/↓ between the row links of a table (the first link in each body row), ↵ follows the link
 * natively. Attach to the element that wraps the Table.
 */
export function onRowLinkKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const target = e.target as HTMLElement;
  const links = [
    ...e.currentTarget.querySelectorAll<HTMLAnchorElement>('tbody tr td:first-child a[href]'),
  ];
  const i = links.indexOf(target as HTMLAnchorElement);
  if (i === -1) return;
  e.preventDefault();
  links[e.key === 'ArrowDown' ? Math.min(i + 1, links.length - 1) : Math.max(i - 1, 0)]?.focus();
}
