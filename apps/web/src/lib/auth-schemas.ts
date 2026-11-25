import { z } from 'zod';

/**
 * Sign-in / sign-up form schemas. Better Auth owns these endpoints, so there is no
 * shared contract yet; the limits mirror Better Auth's defaults (password 8-128).
 */
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

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export const SignUpForm = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80, 'Use 80 characters or fewer'),
  email,
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Use ${PASSWORD_MAX} characters or fewer`),
});
export type SignUpForm = z.infer<typeof SignUpForm>;
