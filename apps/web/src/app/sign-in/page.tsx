'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { HStack } from '@astryxdesign/core/HStack';
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
import { SignInForm } from '@/lib/auth-schemas';
import { useInviteContext } from '@/lib/invite-context';
import { meQueryKey } from '@/lib/me';
import { useSessionGate } from '@/lib/session-gate';

function SignIn() {
  const invite = useInviteContext();
  useSessionGate('guest', { invite: invite.token });
  const router = useRouter();
  const queryClient = useQueryClient();
  const [apiError, setApiError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    getValues,
    setValue,
    formState: { isSubmitting },
  } = useForm<SignInForm>({
    resolver: zodResolver(SignInForm),
    defaultValues: { email: '', password: '' },
  });

  // Prefill (editable) with the invited email once the preview loads.
  useEffect(() => {
    if (invite.email && !getValues('email')) setValue('email', invite.email);
  }, [invite.email, getValues, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    setApiError(null);
    const { error } = await authClient.signIn.email({
      email: values.email,
      password: values.password,
    });
    if (error) {
      setApiError(authErrorMessage(error));
      return;
    }
    queryClient.removeQueries({ queryKey: ['shop'] });
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    router.replace(invite.returnTo ?? '/');
  });

  const signUpHref = invite.token ? `/sign-up?invite=${invite.token}` : '/sign-up';

  return (
    <AuthLayout
      title="Sign in"
      subtitle={
        invite.shopName ? `Sign in to join ${invite.shopName}.` : 'Welcome back to your shop.'
      }
      footer={
        <Text color="secondary">
          New to RepairOS? <Link href={signUpHref}>Create an account</Link>
        </Text>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Sign in">
        <FormLayout defaultOptionality="required">
          {apiError ? (
            <Banner status="error" title="Could not sign you in" description={apiError} />
          ) : null}
          <FormTextInput
            control={control}
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@yourshop.com"
            hasAutoFocus
          />
          <FormTextInput
            control={control}
            name="password"
            label="Password"
            type="password"
            autoComplete="current-password"
          />
          <HStack hAlign="end">
            <Link href="/forgot-password" type="supporting">
              Forgot password?
            </Link>
          </HStack>
          <Button
            type="submit"
            label={isSubmitting ? 'Signing in…' : 'Sign in'}
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

export default function SignInPage() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <SignIn />
    </Suspense>
  );
}
