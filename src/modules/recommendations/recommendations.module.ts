import {
  Body, Controller, Get, Injectable, Logger, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';
import { AiService } from '../../shared/ai/ai.service';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const embedSchema = z.object({ storeId: z.string().uuid().optional() });

const runSchema = z.object({
  storeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── RFM ─────────────────────────────────────────────────────────────────────

type SegmentId = 'vip' | 'loyal' | 'at-risk' | 'new' | 'high-intent' | 'discount-driven' | 'window-shopper';

function rfmScores(recencyDays: number, frequency: number, spend: number, p20: number, p40: number, p60: number, p80: number) {
  let r = 1;
  if (recencyDays <= 7) r = 5;
  else if (recencyDays <= 30) r = 4;
  else if (recencyDays <= 60) r = 3;
  else if (recencyDays <= 90) r = 2;

  let f = 1;
  if (frequency > 10) f = 5;
  else if (frequency >= 7) f = 4;
  else if (frequency >= 4) f = 3;
  else if (frequency >= 2) f = 2;

  let m = 1;
  if (spend > p80) m = 5;
  else if (spend > p60) m = 4;
  else if (spend > p40) m = 3;
  else if (spend > p20) m = 2;

  return { r, f, m };
}

function classifySegment(r: number, f: number, m: number, aov: number, globalAov: number): SegmentId {
  if (r >= 4 && f >= 4 && m >= 4) return 'vip';
  if (r >= 3 && f >= 3 && m >= 3) return 'loyal';
  if (r <= 2 && (f >= 3 || m >= 3)) return 'at-risk';
  if (f <= 2 && r >= 4) return 'new';
  if (r >= 3 && f >= 2 && m >= 2) return 'high-intent';
  if (f >= 3 && aov < globalAov * 0.6) return 'discount-driven';
  return 'window-shopper';
}

function pctile(sorted: number[], p: number): number {
  return sorted[Math.floor((sorted.length * p) / 100)] ?? 0;
}

// ─── Product embed text ───────────────────────────────────────────────────────

function productEmbedText(p: {
  title: string; productType: string | null; vendor: string | null;
  description: string | null; tagsJson: unknown; priceAmount: number; currency: string;
}): string {
  const tags = Array.isArray(p.tagsJson) ? (p.tagsJson as string[]).join(', ') : '';
  return [
    `Product: ${p.title}`,
    p.productType ? `Category: ${p.productType}` : null,
    p.vendor ? `Vendor: ${p.vendor}` : null,
    p.description ? `Description: ${p.description.slice(0, 200)}` : null,
    tags ? `Tags: ${tags}` : null,
    `Price: ${p.priceAmount} ${p.currency}`,
  ].filter(Boolean).join('\n');
}

// ─── Raw query row types ──────────────────────────────────────────────────────

interface TopProductRow {
  id: string; title: string; product_type: string | null; featured_image_url: string | null;
  revenue: string | number; order_count: string | number; quantity: string | number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  private get embeddingModel(): string {
    const p = this.ai.providerName;
    if (p === 'openai') return process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
    if (p === 'gemini') return process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-001';
    return 'none';
  }

  async storeStats(ctx: RequestContext, storeId?: string) {
    const scope = storeScopeFilter(ctx, storeId);
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const provider = this.ai.providerName;
    const model = this.embeddingModel;
    const storeFilter = storeId ? Prisma.sql`AND oi.store_id = ${storeId}::uuid` : Prisma.empty;

    // ── All DB reads run in PARALLEL ──────────────────────────────────────────
    // Each read is its own short transaction; firing them concurrently means total
    // latency ≈ the slowest single query instead of the sum of all of them. This is
    // the key fix for the slow/ECONNRESET dashboard on the remote Supabase pooler.
    // Products are few, so we fetch them all (covers meta + total count) rather than
    // a second dependent query.
    const where = { tenantId: ctx.tenantId, ...(storeId ? { storeId } : {}) } as const;
    const [customers, topProductRows, orderItems, custOrders, embeddings, productsAll] = await Promise.all([
      this.prisma.withTenantContext(ctx, (tx) => tx.commerceCustomer.findMany({
        where: { tenantId: ctx.tenantId, ...scope, deletedAt: null },
        select: { numberOfOrders: true, amountSpent: true, lastOrderAt: true },
      })),
      this.prisma.withTenantContext(ctx, (tx) => tx.$queryRaw<TopProductRow[]>`
        SELECT p.id, p.title, p.product_type, p.featured_image_url,
               SUM(oi.total_amount)::float      AS revenue,
               COUNT(DISTINCT oi.order_id)::int AS order_count,
               SUM(oi.quantity)::int            AS quantity
        FROM app.order_items oi
        JOIN app.products    p ON oi.product_id = p.id
        JOIN app.orders      o ON oi.order_id   = o.id
        WHERE oi.tenant_id = ${ctx.tenantId}::uuid
          ${storeFilter}
          AND o.processed_at >= ${since}
          AND p.deleted_at IS NULL
        GROUP BY p.id, p.title, p.product_type, p.featured_image_url
        ORDER BY revenue DESC
        LIMIT 10`),
      this.prisma.withTenantContext(ctx, (tx) => tx.orderItem.findMany({
        where: { ...where, productId: { not: null } },
        select: { orderId: true, productId: true },
        take: 5000,
      })),
      this.prisma.withTenantContext(ctx, (tx) => tx.order.findMany({
        where: { ...where, customerId: { not: null }, processedAt: { gte: since } },
        select: { id: true, customerId: true },
        take: 5000,
      })),
      provider
        ? this.prisma.withTenantContext(ctx, (tx) => tx.productEmbedding.findMany({
            where: { ...where, provider, modelKey: model },
            select: { productId: true, embedding: true },
          }))
        : Promise.resolve([] as { productId: string; embedding: unknown }[]),
      this.prisma.withTenantContext(ctx, (tx) => tx.product.findMany({
        where: { ...where, deletedAt: null },
        select: { id: true, title: true, productType: true, featuredImageUrl: true, variants: { take: 1, select: { priceAmount: true, currency: true } } },
      })),
    ]);
    const totalProducts = productsAll.length;

    // Shared product-meta map (title, image, type, price) for all sections.
    type ProdMeta = { id: string; title: string; type: string | null; imageUrl: string | null; price: number; currency: string };
    const productMeta = new Map<string, ProdMeta>(productsAll.map((p) => [p.id, {
      id: p.id, title: p.title, type: p.productType, imageUrl: p.featuredImageUrl,
      price: Number(p.variants[0]?.priceAmount ?? 0), currency: p.variants[0]?.currency ?? 'USD',
    }]));

    // ── RFM segments ──────────────────────────────────────────────────────────
    const spendsSorted = customers.map((c) => Number(c.amountSpent)).sort((a, b) => a - b);
    const [p20, p40, p60, p80] = [20, 40, 60, 80].map((p) => pctile(spendsSorted, p));
    const totalSpend = spendsSorted.reduce((a, b) => a + b, 0);
    const globalAov = customers.length > 0 ? totalSpend / customers.length : 0;
    const now = Date.now();

    const buckets: Record<SegmentId, { count: number; revenue: number }> = {
      vip: { count: 0, revenue: 0 }, loyal: { count: 0, revenue: 0 },
      'at-risk': { count: 0, revenue: 0 }, new: { count: 0, revenue: 0 },
      'high-intent': { count: 0, revenue: 0 }, 'discount-driven': { count: 0, revenue: 0 },
      'window-shopper': { count: 0, revenue: 0 },
    };

    for (const c of customers) {
      const recencyDays = c.lastOrderAt ? Math.floor((now - c.lastOrderAt.getTime()) / 86_400_000) : 999;
      const spend = Number(c.amountSpent);
      const aov = c.numberOfOrders > 0 ? spend / c.numberOfOrders : 0;
      const { r, f, m } = rfmScores(recencyDays, c.numberOfOrders, spend, p20, p40, p60, p80);
      const seg = classifySegment(r, f, m, aov, globalAov);
      buckets[seg].count += 1;
      buckets[seg].revenue += spend;
    }

    const totalRevenue = Object.values(buckets).reduce((s, b) => s + b.revenue, 0);
    const seg = (id: SegmentId) => ({
      count: buckets[id].count, revenue: Math.round(buckets[id].revenue),
      pct: customers.length > 0 ? Math.round((buckets[id].count / customers.length) * 100) : 0,
      revenuePct: totalRevenue > 0 ? Math.round((buckets[id].revenue / totalRevenue) * 100) : 0,
    });

    // ── Top products (from the single read above) ─────────────────────────────
    const topProducts = topProductRows.map((r) => ({
      id: r.id, title: r.title, type: r.product_type ?? '',
      imageUrl: r.featured_image_url,
      revenue: Math.round(Number(r.revenue)),
      orderCount: Number(r.order_count), quantity: Number(r.quantity),
    }));

    // ── Co-purchase + reorder (in-memory over pre-fetched order items) ────────
    const orderProducts = new Map<string, string[]>();
    for (const item of orderItems) {
      if (!item.productId) continue;
      if (!orderProducts.has(item.orderId)) orderProducts.set(item.orderId, []);
      orderProducts.get(item.orderId)!.push(item.productId);
    }

    const coPurchase = new Map<string, Map<string, number>>();
    for (const prods of orderProducts.values()) {
      for (let i = 0; i < prods.length; i++) {
        for (let j = i + 1; j < prods.length; j++) {
          const [a, b] = [prods[i], prods[j]];
          if (!coPurchase.has(a)) coPurchase.set(a, new Map());
          if (!coPurchase.has(b)) coPurchase.set(b, new Map());
          coPurchase.get(a)!.set(b, (coPurchase.get(a)!.get(b) ?? 0) + 1);
          coPurchase.get(b)!.set(a, (coPurchase.get(b)!.get(a) ?? 0) + 1);
        }
      }
    }

    const seen = new Set<string>();
    type CoPair = { productA: { id: string; title: string; imageUrl: string | null }; productB: { id: string; title: string; imageUrl: string | null }; count: number };
    const coPairs: CoPair[] = [];
    for (const [aId, bMap] of coPurchase.entries()) {
      for (const [bId, count] of bMap.entries()) {
        const key = [aId, bId].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const metaA = productMeta.get(aId);
        const metaB = productMeta.get(bId);
        if (metaA && metaB) coPairs.push({
          productA: { id: aId, title: metaA.title, imageUrl: metaA.imageUrl },
          productB: { id: bId, title: metaB.title, imageUrl: metaB.imageUrl },
          count,
        });
      }
    }
    const frequentlyBoughtTogether = coPairs.sort((a, b) => b.count - a.count).slice(0, 6);

    const orderToCustomer = new Map(custOrders.map((o) => [o.id, o.customerId!]));

    const custProductCount = new Map<string, Map<string, number>>();
    for (const item of orderItems) {
      if (!item.productId) continue;
      const custId = orderToCustomer.get(item.orderId);
      if (!custId) continue;
      if (!custProductCount.has(custId)) custProductCount.set(custId, new Map());
      const m = custProductCount.get(custId)!;
      m.set(item.productId, (m.get(item.productId) ?? 0) + 1);
    }

    const reorderStats = new Map<string, { repeatCustomers: number; totalCustomers: number }>();
    for (const prodMap of custProductCount.values()) {
      for (const [productId, count] of prodMap.entries()) {
        const s = reorderStats.get(productId) ?? { repeatCustomers: 0, totalCustomers: 0 };
        s.totalCustomers += 1;
        if (count >= 2) s.repeatCustomers += 1;
        reorderStats.set(productId, s);
      }
    }

    type ReorderItem = { id: string; title: string; imageUrl: string | null; repeatCustomers: number; totalCustomers: number; repeatRate: number };
    const reorderCandidates: ReorderItem[] = [...reorderStats.entries()]
      .filter(([, s]) => s.repeatCustomers > 0)
      .map(([productId, s]) => {
        const meta = productMeta.get(productId);
        if (!meta) return null;
        return { id: productId, title: meta.title, imageUrl: meta.imageUrl,
          repeatCustomers: s.repeatCustomers, totalCustomers: s.totalCustomers,
          repeatRate: Math.round((s.repeatCustomers / s.totalCustomers) * 100) };
      })
      .filter((x): x is ReorderItem => x !== null)
      .sort((a, b) => b.repeatRate - a.repeatRate || b.repeatCustomers - a.repeatCustomers)
      .slice(0, 6);

    // ── Content-based AI recommendations (cosine over pre-fetched embeddings) ──
    const vecs = embeddings
      .filter((e) => productMeta.has(e.productId))
      .map((e) => ({ id: e.productId, v: e.embedding as number[] }));
    type Related = { product: ProdMeta; similar: (ProdMeta & { score: number })[] };
    const relatedProducts: Related[] = vecs
      .map((a) => {
        const product = productMeta.get(a.id)!;
        const similar = vecs
          .filter((b) => b.id !== a.id)
          .map((b) => ({ ...productMeta.get(b.id)!, score: Number(cosine(a.v, b.v).toFixed(3)) }))
          .sort((x, y) => y.score - x.score)
          .slice(0, 4);
        return { product, similar };
      })
      .sort((x, y) => (y.similar[0]?.score ?? 0) - (x.similar[0]?.score ?? 0));

    const embeddedCount = embeddings.length;

    return {
      meta: { totalOrders: orderProducts.size, totalCustomers: customers.length, totalRevenue: Math.round(totalRevenue), generatedAt: new Date().toISOString(), source: 'nexora-db' },
      segments: { vip: seg('vip'), loyal: seg('loyal'), atRisk: seg('at-risk'), new: seg('new'), highIntent: seg('high-intent'), discountDriven: seg('discount-driven'), windowShopper: seg('window-shopper') },
      topProducts,
      frequentlyBoughtTogether,
      reorderCandidates,
      relatedProducts,
      ai: { enabled: this.ai.enabled, provider, embeddedProducts: embeddedCount, totalProducts },
    };
  }

  /** Embed every product for the tenant (idempotent — skips unchanged products). */
  async embedProducts(ctx: RequestContext, storeId?: string): Promise<{ embedded: number; skipped: number; total: number }> {
    if (!this.ai.enabled) return { embedded: 0, skipped: 0, total: 0 };
    const provider = this.ai.providerName!;
    const model = this.embeddingModel;

    const products = await this.prisma.withTenantContext(ctx, (tx) =>
      tx.product.findMany({
        where: { tenantId: ctx.tenantId, ...(storeId ? { storeId } : {}), deletedAt: null },
        include: { variants: { take: 1 } },
        take: 500,
      }),
    );

    let embedded = 0, skipped = 0;

    for (const p of products) {
      const variant = p.variants[0];
      const text = productEmbedText({
        title: p.title, productType: p.productType, vendor: p.vendor, description: p.description,
        tagsJson: p.tagsJson, priceAmount: Number(variant?.priceAmount ?? 0), currency: variant?.currency ?? 'USD',
      });
      const hash = sha256(text);

      const existing = await this.prisma.productEmbedding.findUnique({
        where: { tenantId_productId_provider_modelKey: { tenantId: ctx.tenantId, productId: p.id, provider, modelKey: model } },
        select: { contentHash: true },
      });

      if (existing?.contentHash === hash) { skipped++; continue; }

      const vectors = await this.ai.embed([text]);
      if (!vectors?.[0]) continue;

      await this.prisma.productEmbedding.upsert({
        where: { tenantId_productId_provider_modelKey: { tenantId: ctx.tenantId, productId: p.id, provider, modelKey: model } },
        create: { tenantId: ctx.tenantId, storeId: p.storeId, productId: p.id, provider, modelKey: model, contentHash: hash, embedding: vectors[0] },
        update: { contentHash: hash, embedding: vectors[0], updatedAt: new Date() },
      });
      embedded++;
    }

    this.logger.log(`Embedding done for tenant ${ctx.tenantId}: ${embedded} new, ${skipped} skipped`);
    return { embedded, skipped, total: products.length };
  }

  /** Generate AI recommendations for a customer via cosine similarity on embeddings. */
  async runCustomerRecommendations(ctx: RequestContext, customerId: string, storeId?: string, limit = 10) {
    if (!this.ai.enabled) throw new Error('AI provider not configured — set AI_PROVIDER in .env');
    const provider = this.ai.providerName!;
    const model = this.embeddingModel;

    const customer = await this.prisma.withTenantContext(ctx, (tx) =>
      tx.commerceCustomer.findFirst({
        where: { id: customerId, tenantId: ctx.tenantId },
        include: {
          orders: {
            where: { deletedAt: null },
            orderBy: { processedAt: 'desc' },
            take: 20,
            include: { items: { select: { title: true, productType: true, productId: true } } },
          },
        },
      }),
    );
    if (!customer) throw new NotFoundException({ code: 'customer_not_found' });

    const purchasedProductIds = new Set<string>();
    const productTitles: string[] = [];
    const productTypes = new Set<string>();

    for (const order of customer.orders) {
      for (const item of order.items) {
        if (item.productId) purchasedProductIds.add(item.productId);
        if (item.title) productTitles.push(item.title);
        if (item.productType) productTypes.add(item.productType);
      }
    }

    const customerText = [
      'Customer purchase history:',
      ...productTitles.slice(0, 15).map((t) => `- ${t}`),
      '',
      'Customer preferences:',
      [...productTypes].slice(0, 8).join(', ') || 'general products',
      `Total spend: ${Number(customer.amountSpent).toFixed(2)} ${customer.currency}`,
      `Purchase frequency: ${customer.numberOfOrders} orders`,
    ].join('\n');

    const customerVectors = await this.ai.embed([customerText]);
    if (!customerVectors?.[0]) throw new Error('Failed to embed customer profile');

    // Direct prisma call (not in transaction) with explicit tenantId filter
    const productEmbeddings = await this.prisma.productEmbedding.findMany({
      where: { tenantId: ctx.tenantId, ...(storeId ? { storeId } : {}), provider, modelKey: model },
      select: { productId: true, embedding: true },
    });

    type ScoredProduct = { productId: string; score: number };
    const scored: ScoredProduct[] = productEmbeddings
      .filter((e) => !purchasedProductIds.has(e.productId))
      .map((e) => ({ productId: e.productId, score: cosine(customerVectors[0], e.embedding as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) return { customerId, recommendations: [] };

    const products = await this.prisma.withTenantContext(ctx, (tx) =>
      tx.product.findMany({
        where: { id: { in: scored.map((s) => s.productId) }, tenantId: ctx.tenantId, deletedAt: null },
        include: { variants: { take: 1 } },
      }),
    );

    const productById = new Map(products.map((p) => [p.id, p]));
    const now = new Date();

    await this.prisma.productRecommendation.deleteMany({ where: { tenantId: ctx.tenantId, customerId } });
    await this.prisma.productRecommendation.createMany({
      data: scored.map((s, rank) => {
        const p = productById.get(s.productId);
        return {
          tenantId: ctx.tenantId,
          storeId: p?.storeId ?? storeId ?? '',
          customerId,
          productId: s.productId,
          rank: rank + 1,
          score: s.score,
          strategy: 'embedding_similarity',
          generatedAt: now,
        };
      }),
    });

    type Rec = { rank: number; score: number; product: { id: string; title: string; type: string | null; imageUrl: string | null; price: number; currency: string } };
    const recommendations: Rec[] = [];
    scored.forEach((s, i) => {
      const p = productById.get(s.productId);
      if (!p) return;
      recommendations.push({
        rank: i + 1,
        score: Number(s.score.toFixed(4)),
        product: {
          id: p.id, title: p.title, type: p.productType, imageUrl: p.featuredImageUrl,
          price: Number(p.variants[0]?.priceAmount ?? 0), currency: p.variants[0]?.currency ?? 'USD',
        },
      });
    });

    return { customerId, generatedAt: now.toISOString(), recommendations };
  }

  /** Return saved AI recommendations for a customer. */
  async getCustomerRecommendations(ctx: RequestContext, customerId: string) {
    const rows = await this.prisma.productRecommendation.findMany({
      where: { tenantId: ctx.tenantId, customerId },
      orderBy: { rank: 'asc' },
      take: 20,
    });

    if (rows.length === 0) return { customerId, recommendations: [] };

    const productIds = rows.map((r) => r.productId);
    const products = await this.prisma.withTenantContext(ctx, (tx) =>
      tx.product.findMany({
        where: { id: { in: productIds }, tenantId: ctx.tenantId },
        select: { id: true, title: true, productType: true, featuredImageUrl: true },
      }),
    );
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      customerId,
      recommendations: rows.map((r) => ({
        rank: r.rank, score: Number(r.score), strategy: r.strategy,
        reason: r.reason, generatedAt: r.generatedAt,
        product: productById.get(r.productId) ?? null,
      })),
    };
  }
}

// ─── Controller ──────────────────────────────────────────────────────────────

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly svc: RecommendationsService) {}

  @Get('store')
  @RequirePermissions('predictions.read')
  storeStats(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.svc.storeStats(ctx, storeId);
  }

  @Post('embed')
  @RequirePermissions('predictions.run')
  embedProducts(
    @CurrentContext() ctx: RequestContext,
    @Body(new ZodValidationPipe(embedSchema)) body: { storeId?: string },
  ) {
    return this.svc.embedProducts(ctx, body.storeId);
  }

  @Post('customer/:customerId/run')
  @RequirePermissions('predictions.run')
  runRecommendations(
    @CurrentContext() ctx: RequestContext,
    @Param('customerId') customerId: string,
    @Body(new ZodValidationPipe(runSchema)) body: { storeId?: string; limit?: number },
  ) {
    return this.svc.runCustomerRecommendations(ctx, customerId, body.storeId, body.limit);
  }

  @Get('customer/:customerId')
  @RequirePermissions('predictions.read')
  getRecommendations(@CurrentContext() ctx: RequestContext, @Param('customerId') customerId: string) {
    return this.svc.getCustomerRecommendations(ctx, customerId);
  }
}

// ─── Module ──────────────────────────────────────────────────────────────────

@Module({ controllers: [RecommendationsController], providers: [RecommendationsService], exports: [RecommendationsService] })
export class RecommendationsModule {}
