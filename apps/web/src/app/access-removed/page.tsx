'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { AuthLayout } from '@/components/AuthLayout';
import { ErrorState } from '@/components/ErrorState';
import { FullPageLoader } from '@/components/FullPageLoader';
import { errorMessage } from '@/lib/errors';
import { roleLabel } from '@/lib/me';
import { useSessionGate } from '@/lib/session-gate';
import { useSignOut, useSwitchShop } from '@/lib/shops';

/** Every membership is deactivated (`activeShop: null`, `accessRemoved` set): not onboarding. */
export default function AccessRemovedPage() {
  const gate = useSessionGate('access-removed');
  const signOut = useSignOut();
  const switchShop = useSwitchShop();

  if (gate.status === 'error') return <ErrorState message={gate.error.message} onRetry={gate.retry} />;
  if (gate.status === 'loading' || !gate.me?.accessRemoved) return <FullPageLoader />;
  const { me } = gate;
  const shopName = me.accessRemoved?.shopName ?? 'this shop';

  return (
    <AuthLayout
      width={560}
      title={`You no longer have access to ${shopName}`}
      footer={<Text color="secondary">Signed in as {me.user.email}</Text>}
    >
      <VStack gap={5}>
        <Text>
          An owner or manager of {shopName} removed your access. Your account still works: you can
          open another shop you belong to, or set up your own.
        </Text>
        {switchShop.isError ? (
          <Banner status="error" title="Could not open that shop" description={errorMessage(switchShop.error)} />
        ) : null}
        {me.memberships.length > 0 ? (
          <VStack gap={2}>
            <Text weight="semibold">Your other shops</Text>
            <List hasDividers>
              {me.memberships.map((m) => (
                <ListItem
                  key={m.shopId}
                  label={m.shopName}
                  description={roleLabel(m.role)}
                  onClick={() => switchShop.mutate(m.shopId)}
                  endContent={<Text color="accent">Open</Text>}
                />
              ))}
            </List>
          </VStack>
        ) : null}
        <VStack gap={2}>
          <Button
            label="Create your own shop"
            variant="primary"
            size="lg"
            width="100%"
            href="/onboarding"
          />
          <Button label="Sign out" size="lg" width="100%" onClick={() => void signOut()} />
        </VStack>
      </VStack>
    </AuthLayout>
  );
}
