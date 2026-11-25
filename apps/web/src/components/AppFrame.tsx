'use client';

/*
 * Responsive contract for the signed-in shell (from Astryx docs layout/responsive):
 *   > 1180px   SideNav expanded | content
 *   <= 1180px  SideNav starts collapsed to icons (useMediaQuery); the toggle still expands it
 *   < md       SideNav moves into AppShell's mobile drawer (mobileNav default breakpoint "md")
 * The TopNav keeps shop name, search, clock, "New ticket" and the user menu at every width;
 * below 1180px the search field narrows; below 900px "New ticket" and the clock drop to icon-only.
 */

import { AppShell } from '@astryxdesign/core/AppShell';
import { Avatar } from '@astryxdesign/core/Avatar';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Icon } from '@astryxdesign/core/Icon';
import { NavIcon } from '@astryxdesign/core/NavIcon';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { VStack } from '@astryxdesign/core/VStack';
import {
  ArrowRightStartOnRectangleIcon,
  BuildingStorefrontIcon,
  Cog6ToothIcon,
  PlusIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import { API_ERROR_MESSAGES } from '@repairos/contracts';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ClockControl } from './ClockControl';
import { dismissAccessRemoved, useAccessRemoved } from '@/lib/access-removed';
import { errorMessage } from '@/lib/errors';
import { roleLabel } from '@/lib/me';
import { NAV_GROUPS, activeNavHref } from '@/lib/nav';
import { hiddenMainNav, visibleSettingsNav } from '@/lib/permissions';
import { useSession } from '@/lib/shop-context';
import { MAX_OWNED_SHOPS, ownedShopCount, useSignOut, useSwitchShop } from '@/lib/shops';

const NARROW_QUERY = '(max-width: 1180px)';
const COMPACT_QUERY = '(max-width: 900px)';

function UserMenu() {
  const { me, shop } = useSession();
  const router = useRouter();
  const showToast = useToast();
  const signOut = useSignOut();
  const switchShop = useSwitchShop();
  const showSettings = visibleSettingsNav(me.permissions).length > 0;
  const atShopLimit = ownedShopCount(me) >= MAX_OWNED_SHOPS;

  return (
    <DropdownMenu
      alignment="end"
      menuWidth={280}
      menuMaxHeight={560}
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
      {showSettings ? (
        <DropdownMenuItem label="Settings" icon={Cog6ToothIcon} href="/settings" />
      ) : null}
      {me.memberships.length > 1 ? (
        <>
          <DropdownMenuDivider />
          <DropdownMenuGroup title="Switch shop">
            <DropdownMenuRadioGroup
              label="Switch shop"
              value={shop.id}
              onChange={(shopId) => {
                if (shopId === shop.id) return;
                switchShop.mutate(shopId, {
                  onError: (err) => showToast({ body: errorMessage(err), type: 'error' }),
                });
              }}
            >
              {me.memberships.map((m) => (
                <DropdownMenuRadioItem
                  key={m.shopId}
                  value={m.shopId}
                  label={m.shopName}
                  description={roleLabel(m.role)}
                />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </>
      ) : null}
      <DropdownMenuDivider />
      <DropdownMenuItem
        label="Create a new shop"
        icon={BuildingStorefrontIcon}
        isDisabled={atShopLimit}
        description={atShopLimit ? API_ERROR_MESSAGES.SHOP_LIMIT_REACHED : undefined}
        onClick={() => router.push('/onboarding?new=1')}
      />
      <DropdownMenuItem
        label="Sign out"
        icon={ArrowRightStartOnRectangleIcon}
        onClick={() => void signOut()}
      />
    </DropdownMenu>
  );
}

/** S5.5: shown when the API moved the user off a shop they lost; stays until dismissed (BUG-03). */
function AccessRemovedBanner() {
  const { me } = useSession();
  const removed = useAccessRemoved(me.activeShop?.id ?? null);
  if (!removed) return null;
  return (
    <Banner
      status="warning"
      title={`You no longer have access to ${removed.shopName}.`}
      description={`You're now working in ${me.activeShop?.name ?? 'another shop'}.`}
      isDismissable
      onDismiss={dismissAccessRemoved}
    />
  );
}

export function AppFrame({ children }: { children: ReactNode }) {
  const { me, shop } = useSession();
  const pathname = usePathname();
  const selected = activeNavHref(pathname);
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isCompact = useMediaQuery(COMPACT_QUERY);
  // null = follow the viewport; a boolean = the user's explicit choice via the toggle.
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const isCollapsed = userCollapsed ?? isNarrow;
  const [search, setSearch] = useState('');
  const hidden = hiddenMainNav(me.permissions);

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
              width={isNarrow ? 260 : 380}
              enterKeyHint="search"
            />
          }
          endContent={
            <>
              <ClockControl isCompact={isCompact} />
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
              {group.items
                .filter((item) => !hidden.has(item.href))
                .map((item) => (
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
      <VStack gap={6}>
        <AccessRemovedBanner />
        {children}
      </VStack>
    </AppShell>
  );
}
