import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().min(1).optional(), // optional; if omitted we pick the user's primary tenant
});
export type LoginDto = z.infer<typeof loginSchema>;

export const switchTenantSchema = z.object({
  tenantSlug: z.string().min(1),
});
export type SwitchTenantDto = z.infer<typeof switchTenantSchema>;

export const signupSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  companyName: z.string().min(1, 'Company name is required'),
  tenantSlug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, and hyphens')
    .optional(),
});
export type SignupDto = z.infer<typeof signupSchema>;

export const verifySignupSchema = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type VerifySignupDto = z.infer<typeof verifySignupSchema>;

export const resendSignupSchema = z.object({ email: z.string().email() });
export type ResendSignupDto = z.infer<typeof resendSignupSchema>;
