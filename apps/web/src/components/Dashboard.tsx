'use client';

import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Heading, Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import {
  BanknotesIcon,
  CheckBadgeIcon,
  InboxStackIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';
import { formatMoney } from '@/lib/format';
import { useSession } from '@/lib/shop-context';

interface StatCardProps {
  label: string;
  value: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  emptyText: string;
}

function StatCard({ label, value, icon, emptyText }: StatCardProps) {
  return (
    <Card padding={5} height="100%">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={icon} size="sm" color="secondary" />
          <Text weight="medium" color="secondary">
            {label}
          </Text>
        </HStack>
        <Text type="display-3" hasTabularNumbers>
          {value}
        </Text>
        <Text type="supporting" color="secondary">
          {emptyText}
        </Text>
      </VStack>
    </Card>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function Dashboard() {
  const { me, shop } = useSession();
  const today = new Intl.DateTimeFormat(shop.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: shop.timezone,
  }).format(new Date());

  return (
    <VStack gap={6}>
      <VStack gap={1}>
        <Heading level={1}>Welcome, {firstName(me.user.name)}</Heading>
        <Text color="secondary">
          {today} at {shop.name}
        </Text>
      </VStack>

      <Grid columns={{ minWidth: 220, max: 3 }} gap={4}>
        <StatCard
          label="Open tickets"
          value="0"
          icon={InboxStackIcon}
          emptyText="No repairs in progress yet."
        />
        <StatCard
          label="Ready for pickup"
          value="0"
          icon={CheckBadgeIcon}
          emptyText="Finished repairs waiting for customers show here."
        />
        <StatCard
          label="Today's sales"
          value={formatMoney(0, { currency: shop.currency, locale: shop.locale })}
          icon={BanknotesIcon}
          emptyText="Payments taken at the counter today."
        />
      </Grid>

      <Card padding={8}>
        <EmptyState
          headingLevel={2}
          icon={<Icon icon={InboxStackIcon} size="lg" color="secondary" />}
          title="No tickets yet"
          description="Check in your first device to start tracking repairs. Ticket check-in arrives in Sprint 2."
          actions={
            <Button
              label="New ticket"
              variant="primary"
              icon={<Icon icon={PlusIcon} />}
              href="/tickets"
            />
          }
        />
      </Card>
    </VStack>
  );
}
