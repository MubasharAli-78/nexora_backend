import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../../src/shared/rbac/permissions.catalog';

export async function seedPermissions(prisma: PrismaClient): Promise<void> {
  for (const p of PERMISSIONS) {
    const existing = await prisma.permission.findFirst({
      where: { tenantId: null, key: p.key },
    });
    if (existing) {
      await prisma.permission.update({
        where: { id: existing.id },
        data: { module: p.module, action: p.action, description: p.description, riskLevel: p.riskLevel, isSystem: true },
      });
    } else {
      await prisma.permission.create({
        data: { tenantId: null, key: p.key, module: p.module, action: p.action, description: p.description, riskLevel: p.riskLevel, isSystem: true },
      });
    }
  }
  console.log(`  • permissions: ${PERMISSIONS.length} system permissions ensured`);
}
