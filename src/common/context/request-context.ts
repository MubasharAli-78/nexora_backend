/** The authenticated, tenant-scoped context resolved by the guards for every request. */
export interface RequestContext {
  userId: string;
  sessionId: string;
  tenantId: string;
  tenantSlug: string;
  membershipId: string;
  roles: string[];
  primaryRole: string;
  permissions: string[];
  storeScope: string[];
  rbacVersion: number;
  membershipPermissionVersion: number;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}
