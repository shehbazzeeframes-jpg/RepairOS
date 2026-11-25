'use client';

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { FormLayout } from '@astryxdesign/core/FormLayout';
import { Link } from '@astryxdesign/core/Link';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { AuthLayout } from '@/components/AuthLayout';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { SignInForm } from '@/lib/auth-schemas';
import { meQueryKey } from '@/lib/me';
import { useSessionGate } from '@/lib/session-gate';

export default function SignInPage() {
  useSessionGate('guest');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [apiError, setApiError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<SignInForm>({
    resolver: zodResolver(SignInForm),
    defaultValues: { email: '', password: '' },
  });

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
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    router.replace('/');
  });

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back to your shop."
      footer={
        <Text color="secondary">
          New to RepairOS? <Link href="/sign-up">Create an account</Link>
        </Text>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Sign in">
        <FormLayout defaultOptionality="required">
          {apiError ? (
            <Banner status="error" title="Could not sign you in" description={apiError} />
          ) : null}
          <Controller
            control={control}
            name="email"
            render={({ field, fieldState }) => (
              <TextInput
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@yourshop.com"
                value={field.value}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                ref={field.ref}
                htmlName={field.name}
                hasAutoFocus
                status={
                  fieldState.error
                    ? { type: 'error', message: fieldState.error.message }
                    : undefined
                }
              />
            )}
          />
          <Controller
            control={control}
            name="password"
            render={({ field, fieldState }) => (
              <TextInput
                label="Password"
                type="password"
                autoComplete="current-password"
                value={field.value}
                onChange={(v) => field.onChange(v)}
                onBlur={field.onBlur}
                ref={field.ref}
                htmlName={field.name}
                status={
                  fieldState.error
                    ? { type: 'error', message: fieldState.error.message }
                    : undefined
                }
              />
            )}
          />
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
