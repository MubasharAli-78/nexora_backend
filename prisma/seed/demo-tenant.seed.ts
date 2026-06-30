import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { provisionTenantRbac } from '../../src/shared/rbac/rbac-provisioning';

const DEMO_OWNER_EMAIL = 'owner@fashionco.test';
const DEMO_OWNER_PASSWORD = 'Owner123!';
const DEMO_TENANT_SLUG = 'fashionco';

/**
 * Creates a demo tenant + owner login + one store + a little sample commerce data
 * so the dashboard renders immediately. Idempotent on the tenant slug / owner email.
 */
export async function seedDemoTenant(prisma: PrismaClient): Promise<void> {
  // Owner user
  const emailNormalized = DEMO_OWNER_EMAIL.toLowerCase();
  let owner = await prisma.user.findUnique({ where: { emailNormalized } });
  if (!owner) {
    owner = await prisma.user.create({
      data: {
        email: DEMO_OWNER_EMAIL,
        emailNormalized,
        fullName: 'Demo Owner',
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userCredential.create({
      data: { userId: owner.id, passwordHash: await argon2.hash(DEMO_OWNER_PASSWORD, { type: argon2.argon2id }) },
    });
  }

  // Tenant
  let tenant = await prisma.tenant.findUnique({ where: { slug: DEMO_TENANT_SLUG } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name: 'Fashion Co',
        slug: DEMO_TENANT_SLUG,
        status: 'active',
        planKey: 'pro',
        timezone: 'UTC',
        defaultCurrency: 'USD',
        ownerUserId: owner.id,
      },
    });
    await prisma.tenantDomain.create({
      data: { tenantId: tenant.id, domain: `${DEMO_TENANT_SLUG}.nexora.com`, domainType: 'system', isPrimary: true, verifiedAt: new Date() },
    });
  }

  // RBAC for the tenant + owner membership/assignment
  const { ownerRoleId } = await provisionTenantRbac(prisma, tenant.id);
  let membership = await prisma.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId: tenant.id, userId: owner.id } },
  });
  if (!membership) {
    membership = await prisma.tenantMembership.create({
      data: { tenantId: tenant.id, userId: owner.id, status: 'active', joinedAt: new Date() },
    });
  }
  const existingAssignment = await prisma.roleAssignment.findFirst({
    where: { tenantId: tenant.id, membershipId: membership.id, roleId: ownerRoleId },
  });
  if (!existingAssignment) {
    await prisma.roleAssignment.create({
      data: { tenantId: tenant.id, membershipId: membership.id, roleId: ownerRoleId, scopeType: 'tenant' },
    });
  }

  // Demo store
  let store = await prisma.store.findFirst({ where: { tenantId: tenant.id, slug: 'fashionco-main' } });
  if (!store) {
    store = await prisma.store.create({
      data: { tenantId: tenant.id, name: 'Fashion Co Main', slug: 'fashionco-main', platform: 'manual', currency: 'USD', status: 'active' },
    });
  }

  // A few demo products + an order so dashboards aren't empty
  const productCount = await prisma.product.count({ where: { tenantId: tenant.id } });
  if (productCount === 0) {
    const sample = [
      { title: 'Classic White Tee', price: 29.0, type: 'Apparel' },
      { title: 'Denim Jacket', price: 119.0, type: 'Apparel' },
      { title: 'Leather Sneakers', price: 89.0, type: 'Footwear' },
    ];
    for (let i = 0; i < sample.length; i++) {
      const s = sample[i];
      const product = await prisma.product.create({
        data: {
          tenantId: tenant.id, storeId: store.id, externalSource: 'manual', externalId: `seed-${i + 1}`,
          title: s.title, handle: s.title.toLowerCase().replace(/\s+/g, '-'), status: 'active', productType: s.type,
          tagsJson: ['seed'],
        },
      });
      await prisma.productVariant.create({
        data: {
          tenantId: tenant.id, storeId: store.id, productId: product.id, externalId: `seed-${i + 1}-v1`,
          title: 'Default', sku: `SKU-${i + 1}`, priceAmount: s.price, currency: 'USD', position: 0,
        },
      });
    }

    const customer = await prisma.commerceCustomer.create({
      data: {
        tenantId: tenant.id, storeId: store.id, externalSource: 'manual', externalId: 'seed-cust-1',
        firstName: 'Ava', lastName: 'Stone', displayName: 'Ava Stone', state: 'enabled',
        numberOfOrders: 1, amountSpent: 148.0, currency: 'USD', lastOrderAt: new Date(),
      },
    });
    await prisma.order.create({
      data: {
        tenantId: tenant.id, storeId: store.id, customerId: customer.id, externalSource: 'manual', externalId: 'seed-order-1',
        orderNumber: '1001', financialStatus: 'paid', fulfillmentStatus: 'fulfilled', orderStatus: 'delivered',
        currency: 'USD', subtotalAmount: 148.0, totalAmount: 148.0, processedAt: new Date(),
      },
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await prisma.dailySalesMetric.create({
      data: {
        tenantId: tenant.id, storeId: store.id, metricDate: today, ordersCount: 1,
        grossSales: 148.0, netSales: 148.0, avgOrderValue: 148.0, currency: 'USD',
      },
    });
  }

  console.log(`  • demo tenant: ${tenant.slug} (owner login: ${DEMO_OWNER_EMAIL} / ${DEMO_OWNER_PASSWORD})`);
}
