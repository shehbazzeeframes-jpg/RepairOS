'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Link } from '@astryxdesign/core/Link';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import {
  API_ERROR_MESSAGES,
  AcceptInviteResponse,
  InviteToken,
  ROLE_LABELS,
  type InvitePreview,
  type MeResponse,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { AuthLayout } from '@/components/AuthLayout';
import { ErrorState } from '@/components/ErrorState';
import { apiFetch } from '@/lib/api';
import { errorMessage, hasErrorCode } from '@/lib/errors';
import { meQueryKey } from '@/lib/me';
import { qk, useInvitePreview } from '@/lib/queries';
import { useSessionGate } from '@/lib/session-gate';
import { useSignOut, useSwitchShop } from '@/lib/shops';

const INVALID = API_ERROR_MESSAGES.INVITE_INVALID ?? "This invite link isn't valid.";

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(iso));
}

function InviteCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <AuthLayout title={title} footer={footer}>
      <VStack gap={5}>{children}</VStack>
    </AuthLayout>
  );
}

function InvalidInvite() {
  return (
    <InviteCard title="Invite not valid">
      <Text>{INVALID}</Text>
      <Text color="secondary">Ask the shop to send you a new invite.</Text>
      <Button label="Go to RepairOS" width="100%" href="/" />
    </InviteCard>
  );
}

type Valid = Extract<InvitePreview, { state: 'VALID' }>;

function ValidInvite({
  token,
  invite,
  me,
}: {
  token: string;
  invite: Valid;
  me: MeResponse | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const signOut = useSignOut(null);

  const accept = useMutation({
    mutationFn: () =>
      apiFetch(`/api/invites/${token}/accept`, AcceptInviteResponse, { method: 'POST' }),
    onSuccess: async (res) => {
      queryClient.removeQueries({ queryKey: ['shop'] });
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      showToast({ body: `Welcome to ${res.shopName}` });
      router.replace('/');
    },
    onError: (err) => {
      // Expired/revoked meanwhile: show the current state of the link.
      if (hasErrorCode(err, 'INVITE_EXPIRED', 'INVITE_REVOKED', 'INVITE_INVALID')) {
        void queryClient.invalidateQueries({ queryKey: qk.invite(token) });
      }
    },
  });

  const details = (
    <>
      <Text>
        {invite.inviterName} invited you to join <Text weight="semibold">{invite.shopName}</Text> as{' '}
        {ROLE_LABELS[invite.role]}.
      </Text>
      <MetadataList label={{ position: 'start', width: 96 }}>
        <MetadataListItem label="Email">{invite.email}</MetadataListItem>
        <MetadataListItem label="Role">{ROLE_LABELS[invite.role]}</MetadataListItem>
        <MetadataListItem label="Expires">{formatDate(invite.expiresAt)}</MetadataListItem>
      </MetadataList>
    </>
  );

  if (!me) {
    return (
      <InviteCard title={`Join ${invite.shopName}`}>
        {details}
        <VStack gap={2}>
          <Button
            label="Create account"
            variant="primary"
            size="lg"
            width="100%"
            href={`/sign-up?invite=${token}`}
          />
          <Button
            label="I already have an account"
            size="lg"
            width="100%"
            href={`/sign-in?invite=${token}`}
          />
        </VStack>
      </InviteCard>
    );
  }

  const matches = me.user.email.trim().toLowerCase() === invite.email.trim().toLowerCase();
  const mismatch = !matches || hasErrorCode(accept.error, 'INVITE_EMAIL_MISMATCH');
  if (mismatch) {
    return (
      <InviteCard title={`Join ${invite.shopName}`}>
        <Banner
          status="warning"
          title="Wrong account"
          description={(API_ERROR_MESSAGES.INVITE_EMAIL_MISMATCH ?? '')
            .replace('{inviteEmail}', invite.email)
            .replace('{email}', me.user.email)}
        />
        <Text color="secondary">
          Sign out, then sign in or create an account with {invite.email}.
        </Text>
        <Button
          label="Sign out and continue"
          variant="primary"
          size="lg"
          width="100%"
          onClick={() => void signOut()}
        />
      </InviteCard>
    );
  }

  return (
    <InviteCard
      title={`Join ${invite.shopName}`}
      footer={<Text color="secondary">Signed in as {me.user.email}</Text>}
    >
      {details}
      {accept.isError ? (
        <Banner status="error" title="Could not join" description={errorMessage(accept.error)} />
      ) : null}
      <Button
        label={accept.isPending ? 'Joining…' : `Join ${invite.shopName}`}
        variant="primary"
        size="lg"
        width="100%"
        isLoading={accept.isPending}
        onClick={() => accept.mutate()}
      />
    </InviteCard>
  );
}

function AlreadyJoined({ shopId, shopName }: { shopId: string; shopName: string }) {
  const switchShop = useSwitchShop();
  return (
    <InviteCard title="Already joined">
      <Text>You&apos;ve already joined {shopName}.</Text>
      {switchShop.isError ? (
        <Banner
          status="error"
          title="Could not open the shop"
          description={errorMessage(switchShop.error)}
        />
      ) : null}
      <Button
        label={`Go to ${shopName}`}
        variant="primary"
        size="lg"
        width="100%"
        isLoading={switchShop.isPending}
        onClick={() => switchShop.mutate(shopId)}
      />
    </InviteCard>
  );
}

export default function InvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const wellFormed = InviteToken.safeParse(token).success;
  // Public page: never redirected (not even to onboarding); /api/me only tells us who is signed in.
  const gate = useSessionGate('public');
  const preview = useInvitePreview(token, wellFormed);

  if (!wellFormed) return <InvalidInvite />;
  if (gate.status === 'error')
    return <ErrorState message={gate.error.message} onRetry={gate.retry} />;
  if (gate.status === 'loading' || preview.isPending) {
    return (
      <InviteCard title="Opening your invite">
        <VStack hAlign="center" padding={4}>
          <Spinner size="lg" aria-label="Loading invite" />
        </VStack>
      </InviteCard>
    );
  }
  if (preview.isError) {
    if (hasErrorCode(preview.error, 'INVITE_INVALID', 'NOT_FOUND')) return <InvalidInvite />;
    return (
      <ErrorState message={errorMessage(preview.error)} onRetry={() => void preview.refetch()} />
    );
  }

  const invite = preview.data;
  switch (invite.state) {
    case 'VALID':
      return <ValidInvite token={token} invite={invite} me={gate.me} />;
    case 'EXPIRED':
      return (
        <InviteCard title="Invite expired" footer={<Link href="/">Go to RepairOS</Link>}>
          <Text>
            This invite expired on {formatDate(invite.expiresAt)}. Ask {invite.inviterName} to send
            a new one.
          </Text>
        </InviteCard>
      );
    case 'REVOKED':
      return (
        <InviteCard title="Invite no longer valid" footer={<Link href="/">Go to RepairOS</Link>}>
          <Text>{API_ERROR_MESSAGES.INVITE_REVOKED}</Text>
        </InviteCard>
      );
    case 'ACCEPTED':
      return <AlreadyJoined shopId={invite.shopId} shopName={invite.shopName} />;
  }
}
