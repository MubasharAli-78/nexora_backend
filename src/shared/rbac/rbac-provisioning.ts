import { Prisma, PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES, ALL_PERMISSION_KEYS } from './permissions.catalog';

type Db = PrismaClient | Prisma.TransactionClient;

export interface ProvisionedRbac {
  ownerRoleId: string;
  lightUserRoleId: string;
  roleIdsByKey: Record<string, string>;
}

/**
 * Creates the per-tenant copies of the system roles (owner, light_user) and links
 * their permissions. Idempotent: existing roles are reused. Permissions must already
 * be seeded as global rows (see permissions.seed.ts).
 */
export async function provisionTenantRbac(db: Db, tenantId: string): Promise<ProvisionedRbac> {
  const permissions = await db.permission.findMany({
    where: { tenantId: null },
    select: { id: true, key: true },
  });
  const permIdByKey = new Map(permissions.map((p) => [p.key, p.id]));
  const roleIdsByKey: Record<string, string> = {};

  for (const def of SYSTEM_ROLES) {
    let role = await db.role.findFirst({ where: { tenantId, key: def.key } });
    if (!role) {
      role = await db.role.create({
        data: {
          tenantId,
          key: def.key,
          name: def.name,
          description: def.description,
          scopeLevel: 'tenant',
          isSystem: def.isSystem,
          isDefault: def.isDefault,
        },
      });
    }
    roleIdsByKey[def.key] = role.id;

    const keys = def.permissions === 'ALL' ? ALL_PERMISSION_KEYS : def.permissions;
    const permissionIds = keys
      .map((k) => permIdByKey.get(k))
      .filter((id): id is string => Boolean(id));

    await db.rolePermission.deleteMany({ where: { roleId: role.id } });
    if (permissionIds.length) {
      await db.rolePermission.createMany({
        data: permissionIds.map((permissionId) => ({
          roleId: role!.id,
          permissionId,
          tenantId,
        })),
        skipDuplicates: true,
      });
    }
  }

  return {
    ownerRoleId: roleIdsByKey['owner'],
    lightUserRoleId: roleIdsByKey['light_user'],
    roleIdsByKey,
  };
}
