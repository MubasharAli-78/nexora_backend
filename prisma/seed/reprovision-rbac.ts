/**
 * One-shot script: re-provisions the light_user role permissions for all existing tenants.
 * Run with:  npx ts-node -r tsconfig-paths/register prisma/seed/reprovision-rbac.ts
 */
import { PrismaClient } from '@prisma/client';
import { provisionTenantRbac } from '../../src/shared/rbac/rbac-provisioning';

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  console.log(`Re-provisioning RBAC for ${tenants.length} tenant(s)…`);
  for (const t of tenants) {
    await provisionTenantRbac(prisma, t.id);
    console.log(`  ✓ ${t.slug} (${t.id})`);
  }
  console.log('Done.');
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
