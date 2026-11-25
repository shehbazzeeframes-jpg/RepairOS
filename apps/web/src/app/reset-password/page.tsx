'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MIN_LENGTH } from '@repairos/contracts';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
import { AuthLayout } from '@/components/AuthLayout';
import { FormTextInput } from '@/components/form';
import { FullPageLoader } from '@/components/FullPageLoader';
import { isInvalidToken, resetPassword } from '@/lib/auth-extras';
import { NewPasswordForm } from '@/lib/auth-schemas';

const backToSignIn = (
  <Text color="secondary">
    <Link href="/sign-in">Back to sign in</Link>
  </Text>
);

function ExpiredLink() {
  return (
    <AuthLayout title="This link has expired" footer={backToSignIn}>
      <VStack gap={4}>
        <Text>This reset link has expired or was already used. Links work once, for 1 hour.</Text>
        <Button label="Request a new link" variant="primary" width="100%" href="/forgot-password" />
      </VStack>
    </AuthLayout>
  );
}

function ResetPassword() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const linkError = searchParams.get('error');
  const [state, setState] = useState<'form' | 'done' | 'expired'>('form');
  const [error, setError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<NewPasswordForm>({
    resolver: zodResolver(NewPasswordForm),
    defaultValues: { password: '', confirm: '' },
  });

  if (!token || linkError || state === 'expired') return <ExpiredLink />;

  if (state === 'done') {
    return (
      <AuthLayout title="Password updated">
        <VStack gap={4}>
          <Text>Your password has been changed. Sign in with your new password.</Text>
          <Button label="Sign in" variant="primary" width="100%" href="/sign-in" />
        </VStack>
      </AuthLayout>
    );
  }

  const onSubmit = handleSubmit(async ({ password }) => {
    setError(null);
    const result = await resetPassword({ newPassword: password, token });
    if (result.ok) return setState('done');
    if (result.status === 429) return setError('Too many attempts. Wait a minute and try again.');
    if (isInvalidToken(result)) return setState('expired');
    setError('Something went wrong on our side. Please try again.');
  });

  return (
    <AuthLayout title="Choose a new password" footer={backToSignIn}>
      <form onSubmit={onSubmit} noValidate aria-label="Choose a new password">
        <FormLayout defaultOptionality="required">
          {error ? <Banner status="error" title="Could not reset your password" description={error} /> : null}
          <FormTextInput
            control={control}
            name="password"
            label="New password"
            type="password"
            autoComplete="new-password"
            description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
            hasAutoFocus
          />
          <FormTextInput
            control={control}
            name="confirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
          />
          <Button
            type="submit"
            label={isSubmitting ? 'Saving…' : 'Save new password'}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <ResetPassword />
    </Suspense>
  );
}
