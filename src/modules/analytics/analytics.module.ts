import { Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { storeScopeFilter } from '../../common/store-scope';

function rangeStart(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  sales(ctx: RequestContext, days: number, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.dailySalesMetric.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId), metricDate: { gte: rangeStart(days) } },
        orderBy: { metricDate: 'asc' },
      }),
    );
  }

  products(ctx: RequestContext, days: number, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.dailyProductMetric.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId), metricDate: { gte: rangeStart(days) } },
        orderBy: { metricDate: 'desc' },
        take: 500,
      }),
    );
  }

  customers(ctx: RequestContext, days: number, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.dailyCustomerMetric.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId), metricDate: { gte: rangeStart(days) } },
        orderBy: { metricDate: 'asc' },
      }),
    );
  }

  inventory(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId) };
      const [total, low] = await Promise.all([
        tx.inventoryLevel.count({ where }),
        tx.inventoryLevel.count({ where: { ...where, availableQuantity: { lte: 5 } } }),
      ]);
      return { totalSkus: total, lowStockSkus: low };
    });
  }

  /**
   * Phase 8 rollup: recompute daily_sales_metrics + a 30d KPI snapshot from the raw
   * orders for the last `days`. Idempotent (upsert by tenant+store+date). This is the
   * body of the analytics-rollup worker job; also exposed as a manual trigger.
   */
  async rollup(ctx: RequestContext, days = 90): Promise<{ daysProcessed: number; metricRows: number }> {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const since = rangeStart(days);
      const orders = await tx.order.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, processedAt: { gte: since } },
        select: { storeId: true, processedAt: true, totalAmount: true, subtotalAmount: true, discountAmount: true, refundAmount: true, taxAmount: true, shippingAmount: true, currency: true },
      });

      // Aggregate by store + UTC date.
      const buckets = new Map<string, { storeId: string; date: Date; orders: number; gross: number; discount: number; refund: number; tax: number; shipping: number; currency: string }>();
      for (const o of orders) {
        if (!o.processedAt) continue;
        const d = new Date(o.processedAt);
        d.setUTCHours(0, 0, 0, 0);
        const key = `${o.storeId}|${d.toISOString()}`;
        const b = buckets.get(key) ?? { storeId: o.storeId, date: d, orders: 0, gross: 0, discount: 0, refund: 0, tax: 0, shipping: 0, currency: o.currency };
        b.orders += 1;
        b.gross += Number(o.totalAmount);
        b.discount += Number(o.discountAmount);
        b.refund += Number(o.refundAmount);
        b.tax += Number(o.taxAmount);
        b.shipping += Number(o.shippingAmount);
        buckets.set(key, b);
      }

      for (const b of buckets.values()) {
        const net = b.gross - b.refund;
        const aov = b.orders ? b.gross / b.orders : 0;
        await tx.dailySalesMetric.upsert({
          where: { tenantId_storeId_metricDate: { tenantId: ctx.tenantId, storeId: b.storeId, metricDate: b.date } },
          update: { ordersCount: b.orders, grossSales: b.gross, netSales: net, discountAmount: b.discount, refundAmount: b.refund, taxAmount: b.tax, shippingAmount: b.shipping, avgOrderValue: aov, currency: b.currency },
          create: { tenantId: ctx.tenantId, storeId: b.storeId, metricDate: b.date, ordersCount: b.orders, grossSales: b.gross, netSales: net, discountAmount: b.discount, refundAmount: b.refund, taxAmount: b.tax, shippingAmount: b.shipping, avgOrderValue: aov, currency: b.currency },
        });
      }

      // 30-day KPI snapshot.
      const last30 = rangeStart(30);
      const recent = [...buckets.values()].filter((b) => b.date >= last30);
      const revenue = recent.reduce((a, b) => a + b.gross, 0);
      const ordersCount = recent.reduce((a, b) => a + b.orders, 0);
      const refunds = recent.reduce((a, b) => a + b.refund, 0);
      const customers = await tx.commerceCustomer.count({ where: { tenantId: ctx.tenantId, deletedAt: null } });
      await tx.kpiSnapshot.create({
        data: {
          tenantId: ctx.tenantId, periodKey: '30d', revenue, ordersCount, customersCount: customers,
          avgOrderValue: ordersCount ? revenue / ordersCount : 0,
          refundRate: revenue ? refunds / revenue : 0,
        },
      });

      return { daysProcessed: buckets.size, metricRows: buckets.size };
    });
  }

  /**
   * Real profit/financial summary computed directly from synced orders, for the
   * given window and the preceding window of equal length (for % deltas).
   *
   * Metrics we have real data for (orders): gross sales, discounts, returns,
   * tax, shipping, net sales, AOV, order count. Metrics that require a data
   * source not yet connected are returned as 0 (honest, not faked):
   *   - cogs: needs Shopify item cost (not in the products sync) → 0
   *   - adSpend: needs an ad integration (Meta/Google) → 0
   *   - expenses: manual operating expenses → 0
   * Derived metrics (gross profit/margin, CM1, POAS) are computed from the above.
   */
  async profit(ctx: RequestContext, days: number, storeId?: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const now = new Date();
      const start = new Date(now); start.setDate(start.getDate() - days);
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - days);
      const scope = storeScopeFilter(ctx, storeId);
      const select = {
        subtotalAmount: true, discountAmount: true, refundAmount: true,
        taxAmount: true, shippingAmount: true, totalAmount: true,
      } as const;

      const [current, previous] = await Promise.all([
        tx.order.findMany({ where: { tenantId: ctx.tenantId, deletedAt: null, ...scope, processedAt: { gte: start, lte: now } }, select }),
        tx.order.findMany({ where: { tenantId: ctx.tenantId, deletedAt: null, ...scope, processedAt: { gte: prevStart, lt: start } }, select }),
      ]);

      type Row = { subtotalAmount: unknown; discountAmount: unknown; refundAmount: unknown; taxAmount: unknown; shippingAmount: unknown; totalAmount: unknown };
      const agg = (orders: Row[]) => {
        const sum = (f: (o: Row) => unknown) => orders.reduce((a, o) => a + Number(f(o)), 0);
        const grossSales = sum((o) => o.subtotalAmount);
        const discounts = sum((o) => o.discountAmount);
        const returns = sum((o) => o.refundAmount);
        const tax = sum((o) => o.taxAmount);
        const shipping = sum((o) => o.shippingAmount);
        const totalSales = sum((o) => o.totalAmount);
        const netSales = grossSales - discounts - returns;
        const cogs = 0;            // not tracked — Shopify item cost not synced
        const adSpend = 0;         // no ad integration connected
        const expenses = 0;        // no manual expenses entered
        const grossProfit = netSales - cogs;
        const grossMargin = netSales ? grossProfit / netSales : 0;
        const cm1 = grossProfit - adSpend;
        const cm1Pct = netSales ? cm1 / netSales : 0;
        const poas = adSpend ? grossProfit / adSpend : null;
        const ordersCount = orders.length;
        const aov = ordersCount ? totalSales / ordersCount : 0;
        return { grossSales, netSales, discounts, returns, tax, shipping, totalSales, cogs, adSpend, expenses, grossProfit, grossMargin, cm1, cm1Pct, poas, ordersCount, aov };
      };

      return {
        period: { days, from: start.toISOString(), to: now.toISOString() },
        dataAvailable: { orders: current.length > 0, cogs: false, adSpend: false, expenses: false },
        current: agg(current),
        previous: agg(previous),
      };
    });
  }
}

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('sales')
  @RequirePermissions('analytics.read')
  sales(@CurrentContext() ctx: RequestContext, @Query('days') days = '30', @Query('storeId') storeId?: string) {
    return this.analytics.sales(ctx, Number(days) || 30, storeId);
  }

  @Get('products')
  @RequirePermissions('analytics.read')
  products(@CurrentContext() ctx: RequestContext, @Query('days') days = '30', @Query('storeId') storeId?: string) {
    return this.analytics.products(ctx, Number(days) || 30, storeId);
  }

  @Get('customers')
  @RequirePermissions('analytics.read')
  customers(@CurrentContext() ctx: RequestContext, @Query('days') days = '30', @Query('storeId') storeId?: string) {
    return this.analytics.customers(ctx, Number(days) || 30, storeId);
  }

  @Get('inventory')
  @RequirePermissions('analytics.read')
  inventory(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.analytics.inventory(ctx, storeId);
  }

  @Get('profit')
  @RequirePermissions('analytics.read')
  profit(@CurrentContext() ctx: RequestContext, @Query('days') days = '365', @Query('storeId') storeId?: string) {
    return this.analytics.profit(ctx, Number(days) || 365, storeId);
  }

  @Post('rollup')
  @RequirePermissions('analytics.read')
  rollup(@CurrentContext() ctx: RequestContext, @Query('days') days?: string) {
    return this.analytics.rollup(ctx, Number(days) || 90);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
