/**
 * One-shot bootstrap: ensure a Shopify-backed store + integration exist for a
 * tenant, then run a full sync (products → customers → orders) into the Nexora DB.
 *
 * Reuses the real DI-wired services (IntegrationsService, SyncService, Prisma) so
 * the same code path the API uses is exercised. Credentials come from .env
 * (SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET).
 *
 *   npx ts-node -T src/bootstrap-shopify.ts [tenantSlug]
 */
import 'dotenv/config';
// Use the session pooler (DIRECT_URL, 5432) for this one-off script so it does
// not contend with the running dev server on the transaction pooler (6543).
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;
// Commerce sync does many sequential remote round-trips; give transactions room.
if (!process.env.PRISMA_TX_TIMEOUT_MS) process.env.PRISMA_TX_TIMEOUT_MS = '240000';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaService } from './shared/database/prisma.service';
import { IntegrationsService } from './modules/integrations/integrations.module';
import { SyncService } from './modules/integrations/sync.service';
import type { RequestContext } from './common/context/request-context';

async function main() {
  const tenantSlug = process.argv[2] ?? 'mubashar';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });

  try {
    const prisma = app.get(PrismaService);
    const integrations = app.get(IntegrationsService);
    const sync = app.get(SyncService);

    // ── Resolve tenant + an owner membership to build a request context ──────
    // Raw SQL for the pre-context lookups (RLS GUCs aren't set yet).
    const tenantRows = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT id, name FROM app.tenants WHERE slug = $1 LIMIT 1`,
      tenantSlug,
    );
    const tenant = tenantRows[0];
    if (!tenant) throw new Error(`Tenant "${tenantSlug}" not found`);

    const memberRows = await prisma.$queryRawUnsafe<Array<{ id: string; user_id: string }>>(
      `SELECT id, user_id FROM app.tenant_memberships
       WHERE tenant_id = $1::uuid AND status = 'active'
       ORDER BY created_at ASC LIMIT 1`,
      tenant.id,
    );
    const membership = memberRows[0];
    if (!membership) throw new Error(`No active membership for tenant "${tenantSlug}"`);

    const ctx: RequestContext = {
      tenantId: tenant.id,
      userId: membership.user_id,
      membershipId: membership.id,
    } as RequestContext;

    console.log(`\n▶ Tenant: ${tenant.name} (${tenant.id})`);

    // ── Ensure a store exists ────────────────────────────────────────────────
    let store = await prisma.withTenantContext(ctx, (tx) =>
      tx.store.findFirst({ where: { tenantId: tenant.id, deletedAt: null } }),
    );
    if (!store) {
      store = await prisma.withTenantContext(ctx, (tx) =>
        tx.store.create({
          data: {
            tenantId: tenant.id,
            name: 'Shopify Store',
            slug: 'shopify-store',
            platform: 'shopify',
            currency: 'USD',
            primaryDomain: process.env.SHOPIFY_SHOP_DOMAIN ?? null,
          },
        }),
      );
      console.log(`✓ Created store ${store.id}`);
    } else {
      console.log(`✓ Using existing store ${store.id} (${store.name})`);
    }

    // ── Ensure a Shopify integration exists (credentials = env) ──────────────
    let integration = await prisma.withTenantContext(ctx, (tx) =>
      tx.tenantIntegration.findFirst({
        where: { tenantId: tenant.id, provider: { key: 'shopify' } },
        include: { provider: true },
      }),
    );
    if (!integration) {
      const created = await integrations.connect(ctx, 'shopify', {
        storeId: store.id,
        displayName: 'Shopify',
        externalShopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
        credentials: {
          shopDomain: process.env.SHOPIFY_SHOP_DOMAIN ?? '',
          clientId: process.env.SHOPIFY_CLIENT_ID ?? '',
          clientSecret: process.env.SHOPIFY_CLIENT_SECRET ?? '',
          apiVersion: process.env.SHOPIFY_API_VERSION ?? '',
        },
      });
      integration = await prisma.withTenantContext(ctx, (tx) =>
        tx.tenantIntegration.findFirst({ where: { id: created.id }, include: { provider: true } }),
      );
      console.log(`✓ Connected Shopify integration ${created.id}`);
    } else {
      console.log(`✓ Using existing Shopify integration ${integration.id}`);
    }

    // Make sure the integration is bound to a store (sync requires it)
    if (integration && !integration.storeId) {
      await prisma.withTenantContext(ctx, (tx) =>
        tx.tenantIntegration.update({ where: { id: integration!.id }, data: { storeId: store!.id } }),
      );
      console.log(`✓ Linked integration to store`);
    }

    // ── Run sync per type ────────────────────────────────────────────────────
    // Each type gets its own transaction so slow Shopify HTTP + upserts don't
    // blow the 30s transaction budget (orders depend on customers existing first).
    for (const type of ['products', 'customers', 'orders'] as const) {
      console.log(`\n▶ Syncing ${type}…`);
      const result = await sync.runSync(ctx, integration!.id, type);
      console.log(`✓ ${type}:`, JSON.stringify(result));
    }

    // ── Backfill customer recency from real order dates ──────────────────────
    // Shopify's customer REST payload doesn't carry a last-order timestamp, so
    // derive it from synced orders to make RFM recency meaningful.
    const backfill = await prisma.withTenantContext(ctx, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE app.commerce_customers c
         SET last_order_at = sub.last_at
         FROM (
           SELECT customer_id, MAX(processed_at) AS last_at
           FROM app.orders
           WHERE tenant_id = $1::uuid AND customer_id IS NOT NULL
           GROUP BY customer_id
         ) sub
         WHERE c.id = sub.customer_id AND c.tenant_id = $1::uuid`,
        tenant.id,
      ),
    );
    console.log(`\n✓ Backfilled last_order_at for ${backfill} customers`);

    // ── Report final counts ──────────────────────────────────────────────────
    const counts = await prisma.withTenantContext(ctx, async (tx) => ({
      products: await tx.product.count({ where: { tenantId: tenant.id } }),
      variants: await tx.productVariant.count({ where: { tenantId: tenant.id } }),
      customers: await tx.commerceCustomer.count({ where: { tenantId: tenant.id } }),
      orders: await tx.order.count({ where: { tenantId: tenant.id } }),
      orderItems: await tx.orderItem.count({ where: { tenantId: tenant.id } }),
    }));
    console.log(`\n📊 DB counts after sync:`, JSON.stringify(counts, null, 2));
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n✖ Bootstrap failed:', err);
    process.exit(1);
  });
