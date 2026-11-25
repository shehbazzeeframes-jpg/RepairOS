'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { zodResolver } from '@hookform/resolvers/zod';
import { ForgotPasswordInput, RESET_PASSWORD_PAGE } from '@repairos/contracts';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { AuthLayout } from '@/components/AuthLayout';
import { FormTextInput } from '@/components/form';
import { requestPasswordReset } from '@/lib/auth-extras';

type FormInput = z.input<typeof ForgotPasswordInput>;

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<FormInput>({
    resolver: zodResolver(ForgotPasswordInput),
    defaultValues: { email: '' },
  });

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    const result = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}${RESET_PASSWORD_PAGE}`,
    });
    // Same answer whether or not the account exists; only rate limits and outages are reported.
    if (result.status === 429) return setError('Too many attempts. Wait a minute and try again.');
    if (result.status === 0 || result.status >= 500) {
      return setError('Something went wrong on our side. Please try again.');
    }
    setSentTo(email.trim());
  });

  const footer = (
    <Text color="secondary">
      Remembered it? <Link href="/sign-in">Back to sign in</Link>
    </Text>
  );

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" footer={footer}>
        <VStack gap={4}>
          <Text>
            If an account exists for <Text weight="semibold">{sentTo}</Text>, we&apos;ve sent a link
            to reset your password. It expires in 1 hour.
          </Text>
          <Text color="secondary">
            Nothing after a few minutes? Check your spam folder, or try again.
          </Text>
          <Button label="Try another email" onClick={() => setSentTo(null)} width="100%" />
        </VStack>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to choose a new password."
      footer={footer}
    >
      <form onSubmit={onSubmit} noValidate aria-label="Reset your password">
        <FormLayout defaultOptionality="required">
          {error ? <Banner status="error" title="Could not send the link" description={error} /> : null}
          <FormTextInput
            control={control}
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@yourshop.com"
            hasAutoFocus
          />
          <Button
            type="submit"
            label={isSubmitting ? 'Sending…' : 'Send reset link'}
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
