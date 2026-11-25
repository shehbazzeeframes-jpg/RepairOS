'use client';

import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Table } from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import { useToast } from '@astryxdesign/core/Toast';
import { VisuallyHidden } from '@astryxdesign/core/VisuallyHidden';
import { VStack } from '@astryxdesign/core/VStack';
import { UserPlusIcon, UsersIcon } from '@heroicons/react/24/outline';
import {
  InviteLinkResponse,
  ROLE_LABELS,
  StaffListItem,
  canManageRole,
  type Role,
  type StaffStatus,
} from '@repairos/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { LoadError, PageIntro, RowsSkeleton } from '@/components/PageStates';
import { RequirePermission, useCan } from '@/components/RequirePermission';
import {
  ChangeRoleDialog,
  InviteDialog,
  InviteLinkDialog,
  SEAT_LIMIT_MESSAGE,
} from '@/components/staff/dialogs';
import { apiFetch } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { qk, useStaff } from '@/lib/queries';
import { useSession } from '@/lib/shop-context';
import { formatDateTime, formatLongDate } from '@/lib/timezone';

type Filter = 'current' | 'deactivated' | 'all';
const FILTERS: Record<Filter, readonly StaffStatus[]> = {
  current: ['ACTIVE', 'INVITED'],
  deactivated: ['DEACTIVATED'],
  all: ['ACTIVE', 'INVITED', 'DEACTIVATED'],
};

type RowAction = 'resend' | 'revoke' | 'link' | 'deactivate' | 'reactivate';

interface Confirming {
  row: StaffListItem;
  action: 'revoke' | 'deactivate';
}

function displayName(row: StaffListItem): string {
  return row.name ?? row.email;
}

function StatusCell({ row }: { row: StaffListItem }) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="wrap">
      {row.status === 'ACTIVE' ? <Badge variant="success" label="Active" /> : null}
      {row.status === 'DEACTIVATED' ? <Badge label="Deactivated" /> : null}
      {row.status === 'INVITED' ? (
        row.inviteExpired ? (
          <Badge variant="warning" label="Expired" />
        ) : (
          <Badge variant="info" label="Invited" />
        )
      ) : null}
      {row.inviteEmailStatus === 'FAILED' ? <Badge variant="error" label="Email failed" /> : null}
      {row.clockedIn ? (
        <HStack gap={1} vAlign="center">
          <StatusDot variant="success" label="Clocked in now" />
          <Text type="supporting">Clocked in now</Text>
        </HStack>
      ) : null}
    </HStack>
  );
}

function StaffPageContent() {
  const { me, shop } = useSession();
  const myRole = me.role as Role;
  const canManage = useCan()('staff.manage');
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [filter, setFilter] = useState<Filter>('current');
  const [inviting, setInviting] = useState(false);
  const [changingRole, setChangingRole] = useState<StaffListItem | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [linkShown, setLinkShown] = useState<{
    row: StaffListItem;
    link: InviteLinkResponse;
    copied: boolean;
  } | null>(null);
  const query = useStaff(FILTERS[filter]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.staffAll });

  const act = useMutation({
    mutationFn: async ({ row, action }: { row: StaffListItem; action: RowAction }) => {
      switch (action) {
        case 'resend':
          return apiFetch(`/api/staff/invites/${row.id}/resend`, StaffListItem, { method: 'POST' });
        case 'revoke':
          return apiFetch(`/api/staff/invites/${row.id}/revoke`, z.unknown(), { method: 'POST' });
        case 'link':
          return apiFetch(`/api/staff/invites/${row.id}/link`, InviteLinkResponse, { method: 'POST' });
        case 'deactivate':
        case 'reactivate':
          return apiFetch(`/api/staff/${row.id}/${action}`, StaffListItem, { method: 'POST' });
      }
    },
    onSuccess: async (data, { row, action }) => {
      setConfirming(null);
      const name = displayName(row);
      if (action === 'link') {
        const link = data as InviteLinkResponse;
        let copied = false;
        try {
          await navigator.clipboard.writeText(link.url);
          copied = true;
        } catch {
          copied = false;
        }
        setLinkShown({ row, link, copied });
      } else {
        showToast({
          body: {
            resend: `Invite sent again to ${row.email}`,
            revoke: `Invite for ${row.email} revoked`,
            deactivate: `${name} deactivated`,
            reactivate: `${name} reactivated`,
          }[action],
        });
      }
      await refresh();
    },
    onError: (err, { row }) => {
      setConfirming(null);
      showToast({ body: errorMessage(err, { email: row.email, name: row.name ?? row.email }), type: 'error' });
    },
  });

  const rows = query.data?.items ?? [];
  const seats = query.data?.seats;
  const atLimit = seats ? seats.used >= seats.limit : false;
  const onlyMe = filter === 'current' && rows.length === 1 && rows[0]?.isSelf;

  const actionsFor = (row: StaffListItem) => {
    if (!canManage || row.isSelf || !canManageRole(myRole, row.role)) return [];
    const run = (action: RowAction) => () => act.mutate({ row, action });
    if (row.kind === 'INVITE') {
      return [
        { label: 'Resend invite', onClick: run('resend') },
        { label: 'Copy invite link', description: 'For WhatsApp or text', onClick: run('link') },
        { type: 'divider' as const },
        {
          label: row.inviteExpired ? 'Remove invite…' : 'Revoke invite…',
          variant: 'destructive' as const,
          onClick: () => setConfirming({ row, action: 'revoke' }),
        },
      ];
    }
    if (row.status === 'DEACTIVATED') return [{ label: 'Reactivate', onClick: run('reactivate') }];
    return [
      { label: 'Change role…', onClick: () => setChangingRole(row) },
      { type: 'divider' as const },
      {
        label: 'Deactivate…',
        variant: 'destructive' as const,
        onClick: () => setConfirming({ row, action: 'deactivate' }),
      },
    ];
  };

  const inviteButton = canManage ? (
    <Button
      label="Invite staff"
      variant="primary"
      icon={<Icon icon={UserPlusIcon} />}
      isDisabled={atLimit}
      tooltip={atLimit ? SEAT_LIMIT_MESSAGE : undefined}
      onClick={() => setInviting(true)}
    />
  ) : null;

  return (
    <>
      <title>Staff · RepairOS</title>
      <HStack gap={6} hAlign="between" vAlign="end" wrap="wrap">
        <PageIntro title="Staff" description="Everyone who can sign in to this shop, and pending invites." />
        {inviteButton}
      </HStack>

      {seats ? (
        <VStack gap={2} maxWidth={420}>
          <ProgressBar
            label="Seats"
            value={seats.used}
            max={seats.limit}
            hasValueLabel
            formatValueLabel={(v, max) => `${v} of ${max} users`}
            variant={atLimit ? 'warning' : 'accent'}
          />
          <Text type="supporting" color="secondary">
            Active users and pending invites count toward your plan.
          </Text>
        </VStack>
      ) : null}

      {atLimit && canManage ? (
        <Banner status="warning" title="All seats are in use" description={SEAT_LIMIT_MESSAGE} />
      ) : null}

      <HStack>
        <SegmentedControl label="Show" value={filter} onChange={(v) => setFilter(v as Filter)} size="sm">
          <SegmentedControlItem value="current" label="Active & invited" />
          <SegmentedControlItem value="deactivated" label="Deactivated" />
          <SegmentedControlItem value="all" label="All" />
        </SegmentedControl>
      </HStack>

      {query.isPending ? (
        <RowsSkeleton rows={4} label="Loading staff" />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <VStack gap={4}>
          <Table
            data={rows}
            idKey="id"
            textOverflow="truncate"
            emptyState={
              <EmptyState
                isCompact
                title={filter === 'deactivated' ? 'No deactivated staff' : 'No one here yet'}
              />
            }
            columns={[
              {
                key: 'name',
                header: 'Name',
                renderCell: (r) => (
                  <HStack gap={2} vAlign="center">
                    <Text weight="medium" maxLines={1}>
                      {r.name ?? '—'}
                    </Text>
                    {r.isSelf ? <Badge variant="purple" label="You" /> : null}
                  </HStack>
                ),
              },
              {
                key: 'email',
                header: 'Email',
                renderCell: (r) => (
                  <Text color="secondary" maxLines={1}>
                    {r.email}
                  </Text>
                ),
              },
              {
                key: 'role',
                header: 'Role',
                width: { type: 'pixel', value: 120 },
                renderCell: (r) => ROLE_LABELS[r.role],
              },
              {
                key: 'status',
                header: 'Status',
                renderCell: (r) => <StatusCell row={r} />,
              },
              {
                key: 'lastClockIn',
                header: 'Last clock-in',
                renderCell: (r) => {
                  if (r.kind === 'INVITE') {
                    const when = r.inviteExpiresAt ? formatLongDate(r.inviteExpiresAt, shop) : '';
                    return (
                      <VStack gap={0.5}>
                        <Text type="supporting" color="secondary">
                          {r.inviteExpired ? `Expired on ${when}` : `Expires ${when}`}
                        </Text>
                        {r.inviteEmailStatus === 'FAILED' && canManage && canManageRole(myRole, r.role) ? (
                          <Text type="supporting">
                            Email failed.{' '}
                            <Link
                              href="#"
                              onClick={(e) => {
                                e.preventDefault();
                                act.mutate({ row: r, action: 'resend' });
                              }}
                            >
                              Resend
                            </Link>
                          </Text>
                        ) : null}
                      </VStack>
                    );
                  }
                  return r.lastClockInAt ? (
                    <Text hasTabularNumbers>{formatDateTime(r.lastClockInAt, shop)}</Text>
                  ) : (
                    <Text color="secondary">Never</Text>
                  );
                },
              },
              {
                key: 'actions',
                header: <VisuallyHidden>Actions</VisuallyHidden>,
                width: { type: 'pixel', value: 64 },
                align: 'end',
                renderCell: (r) => {
                  const items = actionsFor(r);
                  return items.length > 0 ? (
                    <MoreMenu label={`Actions for ${displayName(r)}`} alignment="end" items={items} />
                  ) : null;
                },
              },
            ]}
          />
          {onlyMe ? (
            <EmptyState
              icon={<Icon icon={UsersIcon} size="lg" color="secondary" />}
              title="You're the only one here. Invite your team."
              description="Front desk staff can check in repairs, and technicians can work on them."
              actions={inviteButton}
            />
          ) : null}
        </VStack>
      )}

      {inviting ? (
        <InviteDialog
          myRole={myRole}
          onClose={() => setInviting(false)}
          onInvited={refresh}
          onResendExisting={(email) => {
            const row = rows.find((r) => r.kind === 'INVITE' && r.email === email);
            if (row) act.mutate({ row, action: 'resend' });
            else showToast({ body: 'Open the invite in the list to resend it.', type: 'error' });
          }}
        />
      ) : null}
      {changingRole ? (
        <ChangeRoleDialog
          member={changingRole}
          myRole={myRole}
          onClose={() => setChangingRole(null)}
          onChanged={refresh}
        />
      ) : null}
      {linkShown ? (
        <InviteLinkDialog
          link={linkShown.link}
          email={linkShown.row.email}
          copied={linkShown.copied}
          expiresOn={formatLongDate(linkShown.link.expiresAt, shop)}
          onClose={() => setLinkShown(null)}
        />
      ) : null}
      <AlertDialog
        isOpen={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming?.action === 'deactivate'
            ? `Deactivate ${confirming ? displayName(confirming.row) : ''}?`
            : `Revoke the invite for ${confirming?.row.email ?? ''}?`
        }
        description={
          confirming?.action === 'deactivate'
            ? `${displayName(confirming.row)} will lose access to ${shop.name} immediately. If they're clocked in, they'll be clocked out. Their history stays.`
            : 'The link in their email will stop working and the seat is freed.'
        }
        actionLabel={confirming?.action === 'deactivate' ? 'Deactivate' : 'Revoke invite'}
        isActionLoading={act.isPending}
        onAction={() => confirming && act.mutate(confirming)}
      />
    </>
  );
}

export default function StaffPage() {
  return (
    <RequirePermission permission="staff.view">
      <StaffPageContent />
    </RequirePermission>
  );
}
