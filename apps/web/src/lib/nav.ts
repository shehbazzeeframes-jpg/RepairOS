import {
  ChartBarIcon,
  Cog6ToothIcon,
  CubeIcon,
  HomeIcon,
  ShoppingCartIcon,
  UsersIcon,
  WrenchScrewdriverIcon,
} from '@heroicons/react/24/outline';
import {
  ChartBarIcon as ChartBarSolid,
  Cog6ToothIcon as Cog6ToothSolid,
  CubeIcon as CubeSolid,
  HomeIcon as HomeSolid,
  ShoppingCartIcon as ShoppingCartSolid,
  UsersIcon as UsersSolid,
  WrenchScrewdriverIcon as WrenchScrewdriverSolid,
} from '@heroicons/react/24/solid';
import type { ComponentType, SVGProps } from 'react';

type SvgIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavItem {
  href: string;
  label: string;
  icon: SvgIcon;
  selectedIcon: SvgIcon;
  /** Sprint that delivers this area (placeholder pages say "Coming in Sprint N"). */
  sprint?: number;
  description?: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Front desk',
    items: [
      { href: '/', label: 'Dashboard', icon: HomeIcon, selectedIcon: HomeSolid },
      {
        href: '/tickets',
        label: 'Tickets',
        icon: WrenchScrewdriverIcon,
        selectedIcon: WrenchScrewdriverSolid,
        sprint: 2,
        description: 'Check in devices, track repairs and keep customers updated.',
      },
      {
        href: '/customers',
        label: 'Customers',
        icon: UsersIcon,
        selectedIcon: UsersSolid,
        sprint: 2,
        description: 'Customer profiles, their devices and repair history.',
      },
      {
        href: '/pos',
        label: 'POS',
        icon: ShoppingCartIcon,
        selectedIcon: ShoppingCartSolid,
        sprint: 5,
        description: 'Check out repairs and retail items, take split payments and print receipts.',
      },
    ],
  },
  {
    title: 'Back office',
    items: [
      {
        href: '/inventory',
        label: 'Inventory',
        icon: CubeIcon,
        selectedIcon: CubeSolid,
        sprint: 4,
        description: 'Parts and accessories, stock levels, low-stock alerts and purchase orders.',
      },
      {
        href: '/reports',
        label: 'Reports',
        icon: ChartBarIcon,
        selectedIcon: ChartBarSolid,
        sprint: 6,
        description: 'Sales, turnaround time, technician performance and tax summaries.',
      },
      {
        href: '/settings',
        label: 'Settings',
        icon: Cog6ToothIcon,
        selectedIcon: Cog6ToothSolid,
        sprint: 1,
        description: 'Shop profile, tax rates, staff and roles.',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

export function navItemFor(href: string): NavItem {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) throw new Error(`No nav item for ${href}`);
  return item;
}

/** The nav item that owns a pathname (exact match for "/", prefix match otherwise). */
export function activeNavHref(pathname: string): string | undefined {
  if (pathname === '/') return '/';
  return NAV_ITEMS.find(
    (i) => i.href !== '/' && (pathname === i.href || pathname.startsWith(`${i.href}/`)),
  )?.href;
}
