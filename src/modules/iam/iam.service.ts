import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/database/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import type {
  CreateRoleDto,
  UpdateRoleDto,
  SetRolePermissionsDto,
  CreateAssignmentDto,
} from './iam.schemas';

@Injectable()
export class IamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All permissions available to the tenant: system (global) + tenant-custom. */
  listPermissions(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const perms = await tx.permission.findMany({
        where: { OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
        orderBy: [{ module: 'asc' }, { key: 'asc' }],
      });
      return perms.map((p) => ({
        id: p.id,
        key: p.key,
        module: p.module,
        action: p.action,
        description: p.description,
        riskLevel: p.riskLevel,
        isSystem: p.isSystem,
      }));
    });
  }

  listRoles(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const roles = await tx.role.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      });
      const rolePerms = await tx.rolePermission.findMany({
        where: { tenantId: ctx.tenantId },
        include: { permission: true },
      });
      const byRole = new Map<string, string[]>();
      for (const rp of rolePerms) {
        const arr = byRole.get(rp.roleId) ?? [];
        arr.push(rp.permission.key);
        byRole.set(rp.roleId, arr);
      }
      return roles.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        scopeLevel: r.scopeLevel,
        isSystem: r.isSystem,
        isDefault: r.isDefault,
        permissionKeys: byRole.get(r.id) ?? [],
      }));
    });
  }

  async createRole(ctx: RequestContext, dto: CreateRoleDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const existing = await tx.role.findFirst({ where: { tenantId: ctx.tenantId, key: dto.key } });
      if (existing) throw new BadRequestException({ code: 'role_exists', message: 'Role key already exists' });

      const role = await tx.role.create({
        data: {
          tenantId: ctx.tenantId,
          key: dto.key,
          name: dto.name,
          description: dto.description,
          scopeLevel: dto.scopeLevel,
          isSystem: false,
          createdByUserId: ctx.userId,
        },
      });

      if (dto.permissionKeys?.length) {
        const perms = await tx.permission.findMany({
          where: { key: { in: dto.permissionKeys }, OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
        });
        await tx.rolePermission.createMany({
          data: perms.map((p) => ({ roleId: role.id, permissionId: p.id, tenantId: ctx.tenantId })),
          skipDuplicates: true,
        });
      }

      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'roles.created', resourceType: 'role', resourceId: role.id, after: { key: role.key } });
      return { id: role.id, key: role.key, name: role.name };
    });
  }

  async updateRole(ctx: RequestContext, roleId: string, dto: UpdateRoleDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
      if (!role) throw new NotFoundException({ code: 'role_not_found', message: 'Role not found' });
      const updated = await tx.role.update({ where: { id: roleId }, data: { name: dto.name ?? role.name, description: dto.description ?? role.description } });
      return { id: updated.id, name: updated.name, description: updated.description };
    });
  }

  async deleteRole(ctx: RequestContext, roleId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
      if (!role) throw new NotFoundException({ code: 'role_not_found', message: 'Role not found' });
      if (role.isSystem) throw new ForbiddenException({ code: 'system_role', message: 'System roles cannot be deleted' });
      const assignments = await tx.roleAssignment.count({ where: { roleId, tenantId: ctx.tenantId } });
      if (assignments > 0) throw new BadRequestException({ code: 'role_in_use', message: 'Role is assigned to members' });
      await tx.role.delete({ where: { id: roleId } });
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'roles.deleted', resourceType: 'role', resourceId: roleId });
      return { id: roleId, deleted: true };
    });
  }

  /**
   * Atomic permission toggle (doc 04 §7). Delegates to the stored procedure
   * app.set_role_permissions which bumps tenant rbac_version + affected members'
   * membership_permission_version, so stale JWTs are forced to refresh.
   */
  async setRolePermissions(ctx: RequestContext, roleId: string, dto: SetRolePermissionsDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: roleId, tenantId: ctx.tenantId } });
      if (!role) throw new NotFoundException({ code: 'role_not_found', message: 'Role not found' });

      // Resolve permission ids (accept ids or keys).
      let permissionIds = dto.permissionIds ?? [];
      if ((!permissionIds || permissionIds.length === 0) && dto.permissionKeys?.length) {
        const perms = await tx.permission.findMany({
          where: { key: { in: dto.permissionKeys }, OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
        });
        permissionIds = perms.map((p) => p.id);
      } else if (permissionIds.length) {
        const valid = await tx.permission.findMany({
          where: { id: { in: permissionIds }, OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
          select: { id: true },
        });
        permissionIds = valid.map((p) => p.id);
      }

      const idsSql = permissionIds.length
        ? Prisma.sql`ARRAY[${Prisma.join(permissionIds)}]::uuid[]`
        : Prisma.sql`ARRAY[]::uuid[]`;
      await tx.$executeRaw`select app.set_role_permissions(${ctx.tenantId}::uuid, ${roleId}::uuid, ${idsSql}, ${ctx.userId}::uuid)`;

      return { roleId, permissionCount: permissionIds.length, applied: true };
    });
  }

  async createAssignment(ctx: RequestContext, dto: CreateAssignmentDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const [membership, role] = await Promise.all([
        tx.tenantMembership.findFirst({ where: { id: dto.membershipId, tenantId: ctx.tenantId } }),
        tx.role.findFirst({ where: { id: dto.roleId, tenantId: ctx.tenantId } }),
      ]);
      if (!membership) throw new NotFoundException({ code: 'membership_not_found', message: 'Membership not found' });
      if (!role) throw new NotFoundException({ code: 'role_not_found', message: 'Role not found' });

      const assignment = await tx.roleAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          membershipId: dto.membershipId,
          roleId: dto.roleId,
          scopeType: dto.scopeType,
          scopeId: dto.scopeId ?? null,
          createdByUserId: ctx.userId,
        },
      });
      // Force the affected member to refresh permissions.
      await tx.tenantMembership.update({
        where: { id: dto.membershipId },
        data: { membershipPermissionVersion: { increment: 1 } },
      });
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'roles.assigned', resourceType: 'role_assignment', resourceId: assignment.id, after: { membershipId: dto.membershipId, roleId: dto.roleId } });
      return { id: assignment.id };
    });
  }

  async deleteAssignment(ctx: RequestContext, assignmentId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const assignment = await tx.roleAssignment.findFirst({ where: { id: assignmentId, tenantId: ctx.tenantId } });
      if (!assignment) throw new NotFoundException({ code: 'assignment_not_found', message: 'Assignment not found' });
      await tx.roleAssignment.delete({ where: { id: assignmentId } });
      await tx.tenantMembership.update({
        where: { id: assignment.membershipId },
        data: { membershipPermissionVersion: { increment: 1 } },
      });
      return { id: assignmentId, deleted: true };
    });
  }
}
