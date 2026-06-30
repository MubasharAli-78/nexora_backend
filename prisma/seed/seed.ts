import { PrismaClient } from '@prisma/client';
import { seedPermissions } from './permissions.seed';
import { seedGlobalRoleTemplates } from './roles.seed';
import { seedProviders } from './providers.seed';
import { seedDemoTenant } from './demo-tenant.seed';

const prisma = new PrismaClient();

async function main() {
  console.log('▶ Seeding Nexora reference data...');
  await seedPermissions(prisma);
  await seedGlobalRoleTemplates(prisma);
  await seedProviders(prisma);
  await seedDemoTenant(prisma);
  console.log('✅ Seed complete.');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
