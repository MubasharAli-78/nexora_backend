import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';
/**
 * Declares the permission keys required for a route. The PermissionsGuard enforces
 * that ALL listed permissions are present in the request context.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
