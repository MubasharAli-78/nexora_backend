import { PrismaClient } from '@prisma/client';

const PROVIDERS = [
  { key: 'shopify', name: 'Shopify', category: 'commerce', status: 'active', requiredScopesJson: ['read_products', 'read_orders', 'read_customers', 'read_inventory'] },
  { key: 'woocommerce', name: 'WooCommerce', category: 'commerce', status: 'active', requiredScopesJson: ['read'] },
  { key: 'amazon', name: 'Amazon', category: 'commerce', status: 'coming_soon', requiredScopesJson: [] },
  { key: 'klaviyo', name: 'Klaviyo', category: 'email', status: 'coming_soon', requiredScopesJson: [] },
  { key: 'meta_ads', name: 'Meta Ads', category: 'ads', status: 'coming_soon', requiredScopesJson: [] },
  { key: 'google_ads', name: 'Google Ads', category: 'ads', status: 'coming_soon', requiredScopesJson: [] },
];

export async function seedProviders(prisma: PrismaClient): Promise<void> {
  for (const p of PROVIDERS) {
    await prisma.integrationProvider.upsert({
      where: { key: p.key },
      update: { name: p.name, category: p.category, status: p.status, requiredScopesJson: p.requiredScopesJson },
      create: p,
    });
  }
  console.log(`  • providers: ${PROVIDERS.length} integration providers ensured`);
}
