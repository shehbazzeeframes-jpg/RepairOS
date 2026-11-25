'use client';

import { useListFocus } from '@astryxdesign/core/hooks';
import { VStack } from '@astryxdesign/core/VStack';
import type { ReactNode } from 'react';

/**
 * One Tab stop for a group of buttons (issue chips, accessories, pattern dots): arrow keys move
 * between them, Home/End jump to the ends, Space/Enter press. Wraps an Astryx ToggleButtonGroup or
 * Grid, whose buttons are otherwise each a Tab stop (the prototype measured 12 + 9 + 9 extra stops).
 * Uses Astryx `useListFocus` with its roving tab index.
 */
export function RovingGroup({
  children,
  orientation = 'both',
}: {
  children: ReactNode;
  orientation?: 'horizontal' | 'vertical' | 'both';
}) {
  const { listRef, handleKeyDown, handleFocus } = useListFocus({
    itemSelector: 'button:not([disabled])',
    orientation,
    hasRovingTabIndex: true,
    wrap: false,
  });
  return (
    <VStack ref={listRef} onKeyDown={handleKeyDown} onFocus={handleFocus}>
      {children}
    </VStack>
  );
}
