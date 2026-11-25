'use client';

import { useEffect, useRef, useState } from 'react';

export type HistoryMode = 'push' | 'replace';

/**
 * A list page's search box bound to the URL's `q` (CU5.5 / TL1.4: "in the URL, back button works").
 *
 * - Typing is debounced into the URL. One search is one history entry: its first commit pushes, later
 *   commits of the same search (more typing after a pause) replace that entry. Leaving the box, another
 *   filter or Back/Forward starts a new search.
 * - Back/Forward (any URL change that isn't this box's own commit) puts the URL's `q` back in the box.
 * - `reset` (Clear filters) cancels a pending commit, so a commit made from filters captured before
 *   the clear can't put them back (the customer-list flake).
 */
export function useUrlSearch(
  urlQ: string,
  commit: (q: string, mode: HistoryMode) => void,
  debounceMs: number,
) {
  const [value, setValue] = useState(urlQ);
  // The URL value last seen, and the value this box last committed (to tell its own URL changes apart).
  const [seenQ, setSeenQ] = useState(urlQ);
  const [ownQ, setOwnQ] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const inSearch = useRef(false);
  const lastCommitted = useRef<string | null>(null);
  const commitRef = useRef(commit);
  const urlQRef = useRef(urlQ);
  useEffect(() => {
    commitRef.current = commit;
    urlQRef.current = urlQ;
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (urlQ !== seenQ) {
    setSeenQ(urlQ);
    setOwnQ(null);
    if (urlQ !== ownQ) setValue(urlQ);
  }
  useEffect(() => {
    // A URL change from elsewhere (Back, a link, Clear filters) ends the current search.
    if (urlQ !== lastCommitted.current) inSearch.current = false;
    lastCommitted.current = null;
  }, [urlQ]);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };

  const onChange = (next: string) => {
    setValue(next);
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      const q = next.trim();
      if (q === urlQRef.current) return;
      setOwnQ(q);
      lastCommitted.current = q;
      commitRef.current(q, inSearch.current ? 'replace' : 'push');
      inSearch.current = true;
    }, debounceMs);
  };

  return {
    value,
    onChange,
    /** Leaving the box ends this search: the next one gets its own history entry. */
    onBlur: () => {
      inSearch.current = false;
    },
    /** Set the box without committing (Clear filters), cancelling any pending commit. */
    reset: (next = '') => {
      cancel();
      inSearch.current = false;
      setValue(next);
    },
  };
}
