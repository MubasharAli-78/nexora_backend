import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface ResolvedMembershipContext {
  membershipId: string;
  roles: string[];
  primaryRole: string;
  permissions: string[];
  storeScope: string[]; // empty array = access to all stores in the tenant
  rbacVersion: number;
  membershipPermissionVersion: number;
}

/**
 * Resolves the effective roles + permissions + store scope for a (user, tenant)
 * pair straight from the database. This is the single source of truth used to mint
 * JWT claims at login / refresh / invitation accept.
 */
@Injectable()
export class MembershipContextService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(userId: string, tenantId: string): Promise<ResolvedMembershipContext> {
    return this.prisma.withTenantContext({ tenantId, userId, membershipId: '' }, async (tx) => {
      // Fetch tenant + membership in parallel — two independent lookups.
      const [tenant, membership] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId } }),
        tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId } } }),
      ]);

      if (!tenant) throw new NotFoundException({ code: 'tenant_not_found', message: 'Tenant not found' });
      if (!membership || membership.status !== 'active') {
        throw new NotFoundException({ code: 'membership_not_found', message: 'No active membership in tenant' });
      }

      // Single query: fetch role assignments with their roles AND permissions in one round-trip.
      const assignments = await tx.roleAssignment.findMany({
        where: { tenantId, membershipId: membership.id },
        include: {
          role: {
            include: {
              permissions: { include: { permission: { select: { key: true } } } },
            },
          },
        },
      });
      if (assignments.length === 0) {
        return {
          membershipId: membership.id,
          roles: [],
          primaryRole: '',
          permissions: [],
          storeScope: [],
          rbacVersion: tenant.rbacVersion,
          membershipPermissionVersion: membership.membershipPermissionVersion,
        };
      }

      const roleKeys = [...new Set(assignments.map((a) => a.role.key))];
      const permissions = [
        ...new Set(assignments.flatMap((a) => a.role.permissions.map((rp) => rp.permission.key))),
      ];

      // Store scope: a tenant-scoped assignment grants all stores ([]). Otherwise the
      // union of explicit store ids.
      const hasTenantScope = assignments.some((a) => a.scopeType === 'tenant');
      const storeScope = hasTenantScope
        ? []
        : [...new Set(assignments.filter((a) => a.scopeId).map((a) => a.scopeId as string))];

      const primaryRole = roleKeys.includes('owner') ? 'owner' : roleKeys[0] ?? '';

      return {
        membershipId: membership.id,
        roles: roleKeys,
        primaryRole,
        permissions,
        storeScope,
        rbacVersion: tenant.rbacVersion,
        membershipPermissionVersion: membership.membershipPermissionVersion,
      };
    });
  }
}
