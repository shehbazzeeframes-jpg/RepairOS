'use client';

/*
 * Responsive contract for the signed-in shell (from Astryx docs layout/responsive):
 *   > 1180px   SideNav expanded | content
 *   <= 1180px  SideNav starts collapsed to icons (useMediaQuery); the toggle still expands it
 *   < md       SideNav moves into AppShell's mobile drawer (mobileNav default breakpoint "md")
 * The TopNav keeps shop name, search, "New ticket" and the user menu at every width;
 * below 1180px the search field narrows; below 900px "New ticket" drops to icon-only.
 */

import { AppShell } from '@astryxdesign/core/AppShell';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Button } from '@astryxdesign/core/Button';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { NavIcon } from '@astryxdesign/core/NavIcon';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { VStack } from '@astryxdesign/core/VStack';
import {
  ArrowRightStartOnRectangleIcon,
  Cog6ToothIcon,
  PlusIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { authClient } from '@/lib/auth-client';
import { roleLabel } from '@/lib/me';
import { NAV_GROUPS, activeNavHref } from '@/lib/nav';
import { useSession } from '@/lib/shop-context';

const NARROW_QUERY = '(max-width: 1180px)';
const COMPACT_QUERY = '(max-width: 900px)';

function UserMenu() {
  const { me } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    router.replace('/sign-in');
  };

  return (
    <DropdownMenu
      alignment="end"
      menuWidth={240}
      hasChevron={false}
      button={{
        label: `Account: ${me.user.name}`,
        variant: 'ghost',
        isIconOnly: true,
        icon: <Avatar name={me.user.name} size="sm" tooltip={false} />,
      }}
      header={
        <VStack gap={0.5} padding={3}>
          <Text weight="semibold" maxLines={1}>
            {me.user.name}
          </Text>
          <Text type="supporting" color="secondary" maxLines={1}>
            {roleLabel(me.role)} · {me.user.email}
          </Text>
        </VStack>
      }
    >
      <DropdownMenuItem label="Settings" icon={Cog6ToothIcon} href="/settings" />
      <DropdownMenuItem
        label="Sign out"
        icon={ArrowRightStartOnRectangleIcon}
        onClick={() => void signOut()}
      />
    </DropdownMenu>
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const { shop } = useSession();
  const pathname = usePathname();
  const selected = activeNavHref(pathname);
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isCompact = useMediaQuery(COMPACT_QUERY);
  // null = follow the viewport; a boolean = the user's explicit choice via the toggle.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const isCollapsed = userCollapsed ?? isNarrow;
  const [search, setSearch] = useState('');

  return (
    <AppShell
      contentPadding={6}
      topNav={
        <TopNav
          label="Shop"
          heading={
            <TopNavHeading
              heading={shop.name}
              headingHref="/"
              logo={<NavIcon icon={<Icon icon={WrenchScrewdriverIcon} size="sm" />} />}
            />
          }
          centerContent={
            <TextInput
              type="search"
              label="Search"
              isLabelHidden
              placeholder="Search tickets, customers, IMEI…"
              startIcon="search"
              value={search}
              onChange={setSearch}
              width={isNarrow ? 300 : 420}
              enterKeyHint="search"
            />
          }
          endContent={
            <>
              <Button
                label="New ticket"
                variant="primary"
                icon={<Icon icon={PlusIcon} />}
                isIconOnly={isCompact}
                href="/tickets"
              />
              <UserMenu />
            </>
          }
        />
      }
      sideNav={
        <SideNav
          aria-label="Main"
          collapsible={{
            isCollapsed,
            onCollapsedChange: setUserCollapsed,
            hasButton: true,
          }}
        >
          {NAV_GROUPS.map((group) => (
            <SideNavSection key={group.title} title={group.title}>
              {group.items.map((item) => (
                <SideNavItem
                  key={item.href}
                  label={item.label}
                  href={item.href}
                  icon={item.icon}
                  selectedIcon={item.selectedIcon}
                  isSelected={selected === item.href}
                />
              ))}
            </SideNavSection>
          ))}
        </SideNav>
      }
    >
      {children}
    </AppShell>
  );
}
