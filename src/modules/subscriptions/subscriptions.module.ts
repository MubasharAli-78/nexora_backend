import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { storeScopeFilter } from '../../common/store-scope';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: RequestContext, status?: string, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.subscriptionContract.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId), ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  get(ctx: RequestContext, id: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const c = await tx.subscriptionContract.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!c) throw new NotFoundException({ code: 'subscription_not_found', message: 'Subscription not found' });
      return c;
    });
  }

  events(ctx: RequestContext, id: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.subscriptionEvent.findMany({ where: { tenantId: ctx.tenantId, contractId: id }, orderBy: { occurredAt: 'desc' } }),
    );
  }

  async summary(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId };
      const [active, paused, cancelled, mrrAgg] = await Promise.all([
        tx.subscriptionContract.count({ where: { ...where, status: 'active' } }),
        tx.subscriptionContract.count({ where: { ...where, status: 'paused' } }),
        tx.subscriptionContract.count({ where: { ...where, status: 'cancelled' } }),
        tx.subscriptionContract.aggregate({ where: { ...where, status: 'active' }, _sum: { amount: true } }),
      ]);
      return { active, paused, cancelled, mrr: Number(mrrAgg._sum.amount ?? 0) };
    });
  }

  /**
   * Real customer-retention analytics derived from orders. This store has no
   * Shopify subscription contracts, so "recurring / churn" is computed from
   * repeat-purchase behaviour (the meaningful real signal): a customer's first
   * order is "new", later orders are "recurring", and a customer is "churned"
   * once their last order is older than the churn window (default 90 days).
   * Returns the current window + the preceding equal window (for % deltas),
   * a daily new/recurring series, and the churned-customer list.
   */
  async retention(ctx: RequestContext, days: number, storeId?: string, churnDays = 90) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const now = new Date();
      const end = new Date(now.getTime() + 1);
      const start = new Date(now); start.setDate(start.getDate() - days);
      const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - days);
      const churnCutoff = new Date(now); churnCutoff.setDate(churnCutoff.getDate() - churnDays);
      const scope = storeScopeFilter(ctx, storeId);

      // Full order history is needed to classify first-vs-repeat correctly.
      const orders = await tx.order.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, ...scope, customerId: { not: null }, processedAt: { not: null } },
        select: { customerId: true, processedAt: true, subtotalAmount: true, discountAmount: true, refundAmount: true },
        orderBy: { processedAt: 'asc' },
      });

      type Enriched = { customerId: string; date: Date; net: number; seq: number };
      const seqByCustomer = new Map<string, number>();
      const lastOrderByCustomer = new Map<string, Date>();
      const countByCustomer = new Map<string, number>();
      const enriched: Enriched[] = [];
      for (const o of orders) {
        const cid = o.customerId as string;
        const date = o.processedAt as Date;
        const seq = (seqByCustomer.get(cid) ?? 0) + 1;
        seqByCustomer.set(cid, seq);
        countByCustomer.set(cid, seq);
        const prevDate = lastOrderByCustomer.get(cid);
        if (!prevDate || date > prevDate) lastOrderByCustomer.set(cid, date);
        const net = Number(o.subtotalAmount) - Number(o.discountAmount) - Number(o.refundAmount);
        enriched.push({ customerId: cid, date, net, seq });
      }

      const aggWindow = (from: Date, to: Date) => {
        let newSales = 0, recurringSales = 0, newOrders = 0, recurringOrders = 0;
        const active = new Set<string>(), fresh = new Set<string>();
        for (const o of enriched) {
          if (o.date < from || o.date >= to) continue;
          active.add(o.customerId);
          if (o.seq === 1) { newSales += o.net; newOrders++; fresh.add(o.customerId); }
          else { recurringSales += o.net; recurringOrders++; }
        }
        return {
          totalSales: newSales + recurringSales, newSales, recurringSales,
          newOrders, recurringOrders, activeCustomers: active.size, newCustomers: fresh.size,
        };
      };

      const cur = aggWindow(start, end);
      const prev = aggWindow(prevStart, start);

      // Lifetime repeat + churn classification.
      let repeatCustomers = 0;
      const churnedIds: string[] = [];
      let prevChurned = 0;
      for (const [cid, cnt] of countByCustomer) {
        if (cnt > 1) repeatCustomers++;
        const last = lastOrderByCustomer.get(cid) as Date;
        if (last < churnCutoff) churnedIds.push(cid);
        // churned as-of the previous window end (for delta)
        const prevCutoff = new Date(start); prevCutoff.setDate(prevCutoff.getDate() - churnDays);
        if (last < prevCutoff && last < start) prevChurned++;
      }
      const totalBuyers = countByCustomer.size;

      // Daily new/recurring series across the current window.
      const dayMap = new Map<string, { date: string; newSales: number; recurringSales: number }>();
      for (const o of enriched) {
        if (o.date < start || o.date >= end) continue;
        const d = new Date(o.date); d.setUTCHours(0, 0, 0, 0);
        const key = d.toISOString().slice(0, 10);
        const b = dayMap.get(key) ?? { date: key, newSales: 0, recurringSales: 0 };
        if (o.seq === 1) b.newSales += o.net; else b.recurringSales += o.net;
        dayMap.set(key, b);
      }
      const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

      // Churned customer list (lapsed past the churn window).
      const churnedRows = churnedIds.length
        ? await tx.commerceCustomer.findMany({
            where: { id: { in: churnedIds }, tenantId: ctx.tenantId },
            select: { id: true, displayName: true, firstName: true, lastName: true, numberOfOrders: true, amountSpent: true, currency: true, lastOrderAt: true },
            orderBy: { lastOrderAt: 'asc' }, take: 200,
          })
        : [];
      const churnedRevenue = churnedRows.reduce((a, c) => a + Number(c.amountSpent), 0);
      const churnedList = churnedRows.map((c) => ({
        id: c.id,
        name: c.displayName ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown'),
        orders: c.numberOfOrders,
        spent: Number(c.amountSpent),
        currency: c.currency,
        lastOrderAt: c.lastOrderAt,
      }));

      const churnedCustomers = churnedIds.length;
      return {
        period: { days, churnDays, from: start.toISOString(), to: now.toISOString() },
        hasSubscriptions: false,
        totals: {
          ...cur,
          netSales: cur.totalSales - 0,
          totalBuyers,
          repeatCustomers,
          oneTimeCustomers: totalBuyers - repeatCustomers,
          churnedCustomers,
          churnedRevenue,
          repeatRate: totalBuyers ? repeatCustomers / totalBuyers : 0,
          churnRate: totalBuyers ? churnedCustomers / totalBuyers : 0,
        },
        previous: { ...prev, churnedCustomers: prevChurned },
        daily,
        churnedList,
      };
    });
  }
}

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @RequirePermissions('analytics.read')
  list(@CurrentContext() ctx: RequestContext, @Query('status') status?: string, @Query('storeId') storeId?: string) {
    return this.subscriptions.list(ctx, status, storeId);
  }

  @Get('summary')
  @RequirePermissions('analytics.read')
  summary(@CurrentContext() ctx: RequestContext) {
    return this.subscriptions.summary(ctx);
  }

  @Get('retention')
  @RequirePermissions('analytics.read')
  retention(@CurrentContext() ctx: RequestContext, @Query('days') days = '365', @Query('storeId') storeId?: string) {
    return this.subscriptions.retention(ctx, Number(days) || 365, storeId);
  }

  @Get(':subscriptionId')
  @RequirePermissions('analytics.read')
  get(@CurrentContext() ctx: RequestContext, @Param('subscriptionId') subscriptionId: string) {
    return this.subscriptions.get(ctx, subscriptionId);
  }

  @Get(':subscriptionId/events')
  @RequirePermissions('analytics.read')
  events(@CurrentContext() ctx: RequestContext, @Param('subscriptionId') subscriptionId: string) {
    return this.subscriptions.events(ctx, subscriptionId);
  }
}

@Module({ controllers: [SubscriptionsController], providers: [SubscriptionsService] })
export class SubscriptionsModule {}
