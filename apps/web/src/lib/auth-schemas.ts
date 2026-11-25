import { PASSWORD_MIN_LENGTH, PasswordSchema } from '@repairos/contracts';
import { z } from 'zod';

/** Sign-in / sign-up form schemas. Password policy comes from contracts (same as Better Auth's config). */
const email = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .email('Enter a valid email address');

export const SignInForm = z.object({
  email,
  password: z.string().min(1, 'Enter your password'),
});
export type SignInForm = z.infer<typeof SignInForm>;

export const PASSWORD_MIN = PASSWORD_MIN_LENGTH;

export const SignUpForm = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80, 'Use 80 characters or fewer'),
  email,
  password: PasswordSchema,
});
export type SignUpForm = z.infer<typeof SignUpForm>;

/** New password + confirmation for /reset-password. */
export const NewPasswordForm = z
  .object({ password: PasswordSchema, confirm: z.string().min(1, 'Type the password again') })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: "Passwords don't match" });
export type NewPasswordForm = z.infer<typeof NewPasswordForm>;
