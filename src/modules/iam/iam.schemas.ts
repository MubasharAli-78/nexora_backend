import { z } from 'zod';

export const createRoleSchema = z.object({
  key: z.string().min(2).regex(/^[a-z0-9_]+$/, 'key must be lowercase alphanumeric/underscore'),
  name: z.string().min(1),
  description: z.string().optional(),
  scopeLevel: z.enum(['tenant', 'store']).default('tenant'),
  permissionKeys: z.array(z.string()).optional(),
});
export type CreateRoleDto = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
});
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

export const setRolePermissionsSchema = z.object({
  permissionIds: z.array(z.string().uuid()).optional(),
  permissionKeys: z.array(z.string()).optional(),
});
export type SetRolePermissionsDto = z.infer<typeof setRolePermissionsSchema>;

export const createAssignmentSchema = z.object({
  membershipId: z.string().uuid(),
  roleId: z.string().uuid(),
  scopeType: z.enum(['tenant', 'store']).default('tenant'),
  scopeId: z.string().uuid().optional(),
});
export type CreateAssignmentDto = z.infer<typeof createAssignmentSchema>;
