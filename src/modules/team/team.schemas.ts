import { z } from 'zod';

export const updateStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'removed']),
});
export type UpdateStatusDto = z.infer<typeof updateStatusSchema>;

export const updateRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).min(1),
});
export type UpdateRolesDto = z.infer<typeof updateRolesSchema>;
