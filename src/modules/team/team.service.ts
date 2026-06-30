import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import type { UpdateStatusDto, UpdateRolesDto } from './team.schemas';

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const members = await tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId, status: { not: 'removed' } },
        include: { user: true, roleAssignments: { include: { role: true } } },
        orderBy: { createdAt: 'asc' },
      });
      // pending invitations surfaced alongside members
      const invitations = await tx.tenantInvitation.findMany({
        where: { tenantId: ctx.tenantId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      return {
        members: members.map((m) => ({
          membershipId: m.id,
          userId: m.userId,
          email: m.user.email,
          fullName: m.user.fullName,
          status: m.status,
          roles: m.roleAssignments.map((ra) => ({ id: ra.role.id, key: ra.role.key, name: ra.role.name })),
          joinedAt: m.joinedAt,
          lastAccessedAt: m.lastAccessedAt,
        })),
        pendingInvitations: invitations.map((i) => ({ id: i.id, email: i.emailNormalized, status: i.status, expiresAt: i.expiresAt })),
      };
    });
  }

  async getMember(ctx: RequestContext, membershipId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const m = await tx.tenantMembership.findFirst({
        where: { id: membershipId, tenantId: ctx.tenantId },
        include: { user: true, roleAssignments: { include: { role: true } } },
      });
      if (!m) throw new NotFoundException({ code: 'member_not_found', message: 'Member not found' });
      return {
        membershipId: m.id,
        userId: m.userId,
        email: m.user.email,
        fullName: m.user.fullName,
        status: m.status,
        roles: m.roleAssignments.map((ra) => ({ id: ra.role.id, key: ra.role.key, name: ra.role.name })),
      };
    });
  }

  async updateStatus(ctx: RequestContext, membershipId: string, dto: UpdateStatusDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const m = await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId: ctx.tenantId }, include: { user: true } });
      if (!m) throw new NotFoundException({ code: 'member_not_found', message: 'Member not found' });
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      if (tenant?.ownerUserId === m.userId && dto.status !== 'active') {
        throw new ForbiddenException({ code: 'cannot_modify_owner', message: 'The tenant owner cannot be suspended or removed' });
      }
      const updated = await tx.tenantMembership.update({
        where: { id: membershipId },
        data: { status: dto.status, membershipPermissionVersion: { increment: 1 } },
      });
      // Revoking access: kill the user's active sessions in this tenant.
      if (dto.status !== 'active') {
        await tx.userSession.updateMany({
          where: { userId: m.userId, currentTenantId: ctx.tenantId, status: 'active' },
          data: { status: 'revoked', revokedAt: new Date() },
        });
      }
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'users.status_changed', resourceType: 'membership', resourceId: membershipId, after: { status: dto.status } });
      return { membershipId: updated.id, status: updated.status };
    });
  }

  async updateRoles(ctx: RequestContext, membershipId: string, dto: UpdateRolesDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const m = await tx.tenantMembership.findFirst({ where: { id: membershipId, tenantId: ctx.tenantId } });
      if (!m) throw new NotFoundException({ code: 'member_not_found', message: 'Member not found' });

      const roles = await tx.role.findMany({ where: { id: { in: dto.roleIds }, tenantId: ctx.tenantId } });
      if (roles.length !== dto.roleIds.length) {
        throw new NotFoundException({ code: 'role_not_found', message: 'One or more roles not found in tenant' });
      }

      await tx.roleAssignment.deleteMany({ where: { tenantId: ctx.tenantId, membershipId } });
      await tx.roleAssignment.createMany({
        data: roles.map((r) => ({ tenantId: ctx.tenantId, membershipId, roleId: r.id, scopeType: 'tenant', createdByUserId: ctx.userId })),
        skipDuplicates: true,
      });
      await tx.tenantMembership.update({ where: { id: membershipId }, data: { membershipPermissionVersion: { increment: 1 } } });

      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'users.roles_changed', resourceType: 'membership', resourceId: membershipId, after: { roleIds: dto.roleIds } });
      return { membershipId, roleIds: dto.roleIds };
    });
  }

  async removeMember(ctx: RequestContext, membershipId: string) {
    return this.updateStatus(ctx, membershipId, { status: 'removed' });
  }
}
