import { z } from 'zod';

export const createInvitationSchema = z.object({
  email: z.string().email(),
  roleId: z.string().uuid().optional(),
  roleKey: z.string().optional(), // alternative to roleId, e.g. "light_user"
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1).optional(),
});
export type AcceptInvitationDto = z.infer<typeof acceptInvitationSchema>;

export const previewQuerySchema = z.object({ token: z.string().min(10) });
