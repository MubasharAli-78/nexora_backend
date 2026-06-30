import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '../../src/shared/rbac/permissions.catalog';

/**
 * Seeds the GLOBAL role templates (tenant_id = null). Per-tenant role copies are
 * created at tenant-creation time via provisionTenantRbac().
 */
export async function seedGlobalRoleTemplates(prisma: PrismaClient): Promise<void> {
  for (const def of SYSTEM_ROLES) {
    const existing = await prisma.role.findFirst({ where: { tenantId: null, key: def.key } });
    if (!existing) {
      await prisma.role.create({
        data: {
          tenantId: null,
          key: def.key,
          name: def.name,
          description: def.description,
          scopeLevel: 'tenant',
          isSystem: def.isSystem,
          isDefault: def.isDefault,
        },
      });
    }
  }
  console.log(`  • roles: ${SYSTEM_ROLES.length} global role templates ensured`);
}
