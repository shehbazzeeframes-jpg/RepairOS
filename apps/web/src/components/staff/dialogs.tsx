'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Selector } from '@astryxdesign/core/Selector';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { VStack } from '@astryxdesign/core/VStack';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  API_ERROR_MESSAGES,
  CreateInviteInput,
  ROLE_LABELS,
  StaffListItem,
  manageableRoles,
  type InviteLinkResponse,
  type Role,
} from '@repairos/contracts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import type { z } from 'zod';
import { FormSelector, FormTextInput } from '@/components/form';
import { apiFetch } from '@/lib/api';
import { errorCode, errorMessage, hasErrorCode } from '@/lib/errors';

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: 'Everything, including billing',
  MANAGER: 'Runs the shop: settings, staff and reports',
  FRONT_DESK: 'Check-in, customers and the till',
  TECHNICIAN: 'Works on repairs and parts',
};

export const roleOptions = (roles: readonly Role[]) =>
  roles.map((r) => ({ value: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] }));

type InviteInput = z.input<typeof CreateInviteInput>;

export function InviteDialog({
  myRole,
  onClose,
  onInvited,
  onResendExisting,
}: {
  myRole: Role;
  onClose: () => void;
  onInvited: () => Promise<unknown>;
  /** Resend the pending invite for an email that already has one (INVITE_PENDING). */
  onResendExisting: (email: string) => void;
}) {
  const showToast = useToast();
  const roles = manageableRoles(myRole);
  const { control, handleSubmit, setError, getValues } = useForm<InviteInput, unknown, CreateInviteInput>({
    resolver: zodResolver(CreateInviteInput) as unknown as Resolver<InviteInput, unknown, CreateInviteInput>,
    defaultValues: { email: '', role: roles.includes('TECHNICIAN') ? 'TECHNICIAN' : roles[0] },
  });

  const invite = useMutation({
    mutationFn: (input: CreateInviteInput) =>
      apiFetch('/api/staff/invites', StaffListItem, { method: 'POST', json: input }),
    onSuccess: async (row) => {
      showToast({ body: `Invite sent to ${row.email}` });
      onClose();
      await onInvited();
    },
    onError: (err, input) => {
      if (hasErrorCode(err, 'ALREADY_MEMBER', 'INVITE_PENDING', 'MEMBER_DEACTIVATED')) {
        setError('email', { type: 'server', message: errorMessage(err, { email: input.email }) });
      }
    },
  });

  const code = errorCode(invite.error);
  const fieldError = code === 'ALREADY_MEMBER' || code === 'INVITE_PENDING' || code === 'MEMBER_DEACTIVATED';

  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={480}>
      <DialogHeader
        title="Invite staff"
        subtitle="They'll get an email with a link to join. The link expires in 7 days."
        onOpenChange={(open) => !open && onClose()}
      />
      <form onSubmit={handleSubmit((v) => invite.mutate(v))} noValidate aria-label="Invite staff">
        <VStack gap={5} padding={6}>
          {invite.isError && !fieldError ? (
            <Banner
              status={code === 'SEAT_LIMIT_REACHED' ? 'warning' : 'error'}
              title={code === 'SEAT_LIMIT_REACHED' ? 'No seats left' : 'Could not send the invite'}
              description={errorMessage(invite.error)}
            />
          ) : null}
          {code === 'INVITE_PENDING' ? (
            <Banner
              status="info"
              title="Already invited"
              description="Send the same person a fresh link instead."
              endContent={
                <Button
                  label="Resend"
                  size="sm"
                  onClick={() => {
                    onResendExisting(getValues('email').trim().toLowerCase());
                    onClose();
                  }}
                />
              }
            />
          ) : null}
          <FormLayout defaultOptionality="required">
            <FormTextInput
              control={control}
              name="email"
              label="Email"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              hasAutoFocus
            />
            <FormSelector control={control} name="role" label="Role" options={roleOptions(roles)} />
          </FormLayout>
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={invite.isPending ? 'Sending…' : 'Send invite'}
              isLoading={invite.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

export function ChangeRoleDialog({
  member,
  myRole,
  onClose,
  onChanged,
}: {
  member: StaffListItem;
  myRole: Role;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const showToast = useToast();
  const roles = manageableRoles(myRole);
  const [role, setRole] = useState<Role>(member.role);
  const change = useMutation({
    mutationFn: () =>
      apiFetch(`/api/staff/${member.id}/role`, StaffListItem, { method: 'PATCH', json: { role } }),
    onSuccess: async (row) => {
      showToast({ body: `${row.name ?? row.email} is now ${ROLE_LABELS[row.role]}` });
      onClose();
      await onChanged();
    },
  });
  const name = member.name ?? member.email;
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} purpose="form" width={440}>
      <DialogHeader
        title={`Change ${name}'s role`}
        subtitle="The new role applies on their next action."
        onOpenChange={(open) => !open && onClose()}
      />
      <form
        noValidate
        aria-label="Change role"
        onSubmit={(e) => {
          e.preventDefault();
          if (role === member.role) onClose();
          else change.mutate();
        }}
      >
        <VStack gap={5} padding={6}>
          {change.isError ? (
            <Banner status="error" title="Could not change the role" description={errorMessage(change.error)} />
          ) : null}
          <SelectorRole value={role} onChange={setRole} roles={roles} />
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="ghost" onClick={onClose} />
            <Button
              type="submit"
              variant="primary"
              label={change.isPending ? 'Saving…' : 'Change role'}
              isLoading={change.isPending}
            />
          </HStack>
        </VStack>
      </form>
    </Dialog>
  );
}

function SelectorRole({
  value,
  onChange,
  roles,
}: {
  value: Role;
  onChange: (role: Role) => void;
  roles: Role[];
}) {
  return (
    <Selector
      label="Role"
      value={value}
      onChange={(v) => v && onChange(v as Role)}
      options={roleOptions(roles)}
    />
  );
}

/** Shown after "Copy invite link": the link (also put on the clipboard) and what it means. */
export function InviteLinkDialog({
  link,
  email,
  copied,
  expiresOn,
  onClose,
}: {
  link: InviteLinkResponse;
  email: string;
  copied: boolean;
  expiresOn: string;
  onClose: () => void;
}) {
  const showToast = useToast();
  return (
    <Dialog isOpen onOpenChange={(open) => !open && onClose()} width={520}>
      <DialogHeader
        title={copied ? 'Invite link copied' : 'Invite link ready'}
        subtitle={`For ${email}`}
        onOpenChange={(open) => !open && onClose()}
      />
      <VStack gap={4} padding={6}>
        <Text>
          Paste it into WhatsApp or a text message to send it yourself. This new link replaced the
          emailed one and expires on {expiresOn}. Only someone signed in as {email} can use it.
        </Text>
        <HStack gap={2} vAlign="end">
          <TextInput label="Invite link" value={link.url} isReadOnly width="100%" />
          <Button
            label="Copy"
            icon={<Icon icon="copy" />}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(link.url)
                .then(() => showToast({ body: 'Link copied' }))
                .catch(() => showToast({ body: 'Select the link and copy it', type: 'error' }));
            }}
          />
        </HStack>
        <HStack hAlign="end">
          <Button label="Done" variant="primary" onClick={onClose} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

export const SEAT_LIMIT_MESSAGE = API_ERROR_MESSAGES.SEAT_LIMIT_REACHED ?? '';
