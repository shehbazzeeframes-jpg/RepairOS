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
import { PASSWORD_MIN, SignUpForm } from '@/lib/auth-schemas';
import { meQueryKey } from '@/lib/me';
import { useSessionGate } from '@/lib/session-gate';

export default function SignUpPage() {
  useSessionGate('guest');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [apiError, setApiError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<SignUpForm>({
    resolver: zodResolver(SignUpForm),
    defaultValues: { name: '', email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setApiError(null);
    const { error } = await authClient.signUp.email({
      name: values.name,
      email: values.email,
      password: values.password,
    });
    if (error) {
      setApiError(authErrorMessage(error));
      return;
    }
    await queryClient.invalidateQueries({ queryKey: meQueryKey });
    router.replace('/onboarding');
  });

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Start your 14-day free trial. No card needed."
      footer={
        <Text color="secondary">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </Text>
      }
    >
      <form onSubmit={onSubmit} noValidate aria-label="Create your account">
        <FormLayout defaultOptionality="required">
          {apiError ? (
            <Banner status="error" title="Could not create your account" description={apiError} />
          ) : null}
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <TextInput
                label="Your name"
                autoComplete="name"
                placeholder="Alex Morgan"
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
            name="email"
            render={({ field, fieldState }) => (
              <TextInput
                label="Work email"
                type="email"
                autoComplete="email"
                placeholder="you@yourshop.com"
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
          <Controller
            control={control}
            name="password"
            render={({ field, fieldState }) => (
              <TextInput
                label="Password"
                type="password"
                autoComplete="new-password"
                description={`At least ${PASSWORD_MIN} characters.`}
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
