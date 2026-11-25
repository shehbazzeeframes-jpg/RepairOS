'use client';

import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Layout, LayoutContent, LayoutPanel } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { NoAccess } from '@/components/PageStates';
import { settingsItemFor, visibleSettingsNav } from '@/lib/permissions';
import { useSession } from '@/lib/shop-context';

/**
 * Settings frame (Astryx settings-sidebar template): a labelled section list beside the page.
 * Only items the user has permission for are listed; at ≤ 900px the list becomes tabs.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const pathname = usePathname();
  const isCompact = useMediaQuery('(max-width: 900px)');
  const items = visibleSettingsNav(me.permissions);
  const current = settingsItemFor(pathname)?.href ?? '';

  if (items.length === 0) return <NoAccess />;

  if (isCompact) {
    return (
      <VStack gap={5}>
        <TabList value={current} onChange={() => undefined} hasDivider aria-label="Settings">
          {items.map((item) => (
            <Tab key={item.href} value={item.href} label={item.label} href={item.href} />
          ))}
        </TabList>
        {children}
      </VStack>
    );
  }

  return (
    <Layout
      height="auto"
      start={
        <LayoutPanel width={220} label="Settings" role="navigation" isScrollable={false}>
          <VStack gap={2} paddingInlineEnd={4}>
            <Text type="supporting" weight="semibold" color="secondary">
              Settings
            </Text>
            <List edge="outset">
              {items.map((item) => (
                <ListItem
                  key={item.href}
                  label={item.label}
                  href={item.href}
                  isSelected={current === item.href}
                  aria-current={current === item.href ? 'page' : undefined}
                />
              ))}
            </List>
          </VStack>
        </LayoutPanel>
      }
      content={
        <LayoutContent isScrollable={false} label="Settings page">
          <VStack gap={6} paddingInlineStart={8}>
            {children}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
