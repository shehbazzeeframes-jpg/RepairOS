'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AuthLayout } from '@/components/AuthLayout';
import { FormTextInput } from '@/components/form';
import { FullPageLoader } from '@/components/FullPageLoader';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { PASSWORD_MIN, SignUpForm } from '@/lib/auth-schemas';
import { useInviteContext } from '@/lib/invite-context';
import { meQueryKey } from '@/lib/me';
import { useSessionGate } from '@/lib/session-gate';

function SignUp() {
  const invite = useInviteContext();
  useSessionGate('guest', { invite: invite.token });
  const router = useRouter();
  const queryClient = useQueryClient();
  const [apiError, setApiError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    setValue,
    formState: { isSubmitting },
  } = useForm<SignUpForm>({
    resolver: zodResolver(SignUpForm),
    defaultValues: { name: '', email: '', password: '' },
  });
  const lockedEmail = invite.email;

  // The account must use the invited email, so it is prefilled and read-only.
  useEffect(() => {
    if (lockedEmail) setValue('email', lockedEmail);
  }, [lockedEmail, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    setApiError(null);
    const { error } = await authClient.signUp.email({
      name: values.name,
      email: lockedEmail ?? values.email,
      password: values.password,
    });
    if (error) {
      setApiError(authErrorMessage(error));
      return;
    }
    queryClient.removeQueries({ queryKey: ['shop'] });
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    router.replace(invite.returnTo ?? '/onboarding');
  });

  if (invite.isLoading) return <FullPageLoader />;
  const signInHref = invite.token ? `/sign-in?invite=${invite.token}` : '/sign-in';

  return (
    <AuthLayout
      title="Create your account"
      subtitle={
        invite.shopName
          ? `Joining ${invite.shopName}. Create your account to accept the invite.`
          : 'Start your 14-day free trial. No card needed.'
      }
      footer={
        <Text color="secondary">
          Already have an account? <Link href={signInHref}>Sign in</Link>
        </Text>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Create your account">
        <FormLayout defaultOptionality="required">
          {apiError ? (
            <Banner status="error" title="Could not create your account" description={apiError} />
          ) : null}
          <FormTextInput
            control={control}
            name="name"
            label="Your name"
            autoComplete="name"
            placeholder="Alex Morgan"
            hasAutoFocus
          />
          <FormTextInput
            control={control}
            name="email"
            label="Work email"
            type="email"
            autoComplete="email"
            placeholder="you@yourshop.com"
            isReadOnly={lockedEmail !== null}
            description={lockedEmail ? 'The invite is for this email.' : undefined}
          />
          <FormTextInput
            control={control}
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            description={`At least ${PASSWORD_MIN} characters.`}
          />
          <Button
            type="submit"
            label={isSubmitting ? 'Creating account…' : 'Create account'}
            variant="primary"
            size="lg"
            width="100%"
            isLoading={isSubmitting}
          />
        </FormLayout>
      </form>
    </AuthLayout>
  );
}

export default function SignUpPage() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <SignUp />
    </Suspense>
  );
}
