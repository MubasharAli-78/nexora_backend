import { Body, Controller, Get, Injectable, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createCampaignSchema = z.object({
  storeId: z.string().uuid().optional(),
  name: z.string().min(1),
  subject: z.string().optional(),
});
const createFlowSchema = z.object({
  storeId: z.string().uuid().optional(),
  name: z.string().min(1),
  trigger: z.enum(['welcome', 'abandoned_cart', 'post_purchase', 'winback']),
});

@Injectable()
export class EmailMarketingService {
  constructor(private readonly prisma: PrismaService) {}

  campaigns(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.emailCampaign.findMany({ where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId) }, orderBy: { createdAt: 'desc' } }),
    );
  }
  createCampaign(ctx: RequestContext, dto: z.infer<typeof createCampaignSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.emailCampaign.create({ data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, name: dto.name, subject: dto.subject, status: 'draft' } }),
    );
  }
  flows(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.emailFlow.findMany({ where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId) }, orderBy: { createdAt: 'desc' } }),
    );
  }
  createFlow(ctx: RequestContext, dto: z.infer<typeof createFlowSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.emailFlow.create({ data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, name: dto.name, trigger: dto.trigger, status: 'active' } }),
    );
  }
  events(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.emailEvent.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { occurredAt: 'desc' }, take: 200 }),
    );
  }

  /**
   * Real email/retention insights derived from store data. No email platform
   * (Klaviyo/Mailchimp) is connected, so:
   *   - New subscribers   → real customer acquisitions (Shopify customer created_at)
   *   - Expected next order→ predicted per customer from purchase cadence
   *   - Revenue           → real order revenue (all attributed to the store, since
   *                         there is no email platform to attribute opens/clicks to)
   *   - Campaigns / Flows → read from the (empty) tables; honest empty state in UI.
   */
  async insights(ctx: RequestContext, days: number, storeId?: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const now = new Date();
      const start = new Date(now); start.setDate(start.getDate() - days);
      const scope = storeScopeFilter(ctx, storeId);

      const [customers, orders, campaigns, flows] = await Promise.all([
        tx.commerceCustomer.findMany({
          where: { tenantId: ctx.tenantId, ...scope, deletedAt: null },
          select: { id: true, displayName: true, firstName: true, lastName: true, numberOfOrders: true, amountSpent: true, currency: true, lastOrderAt: true, createdAt: true, rawPayloadJson: true },
        }),
        tx.order.findMany({
          where: { tenantId: ctx.tenantId, ...(storeId ? { storeId } : {}), customerId: { not: null }, processedAt: { not: null } },
          select: { customerId: true, processedAt: true, subtotalAmount: true, discountAmount: true, refundAmount: true, totalAmount: true },
          orderBy: { processedAt: 'asc' },
        }),
        tx.emailCampaign.findMany({ where: { tenantId: ctx.tenantId, ...scope }, orderBy: { createdAt: 'desc' } }),
        tx.emailFlow.findMany({ where: { tenantId: ctx.tenantId, ...scope }, orderBy: { createdAt: 'desc' } }),
      ]);

      // ── New subscribers (real Shopify customer signup dates) ────────────────
      const signupOf = (c: (typeof customers)[number]): Date => {
        const raw = c.rawPayloadJson as { created_at?: string } | null;
        const iso = raw?.created_at;
        const d = iso ? new Date(iso) : c.createdAt;
        return Number.isNaN(d.getTime()) ? c.createdAt : d;
      };
      const acceptsMarketing = (c: (typeof customers)[number]): boolean => {
        const raw = c.rawPayloadJson as { email_marketing_consent?: { state?: string }; accepts_marketing?: boolean } | null;
        return raw?.email_marketing_consent?.state === 'subscribed' || raw?.accepts_marketing === true;
      };

      const subDayMap = new Map<string, { date: string; count: number; subscribed: number }>();
      let subscribedTotal = 0;
      for (const c of customers) {
        const d = signupOf(c);
        if (d < start || d > now) continue;
        const key = d.toISOString().slice(0, 10);
        const b = subDayMap.get(key) ?? { date: key, count: 0, subscribed: 0 };
        b.count += 1;
        if (acceptsMarketing(c)) { b.subscribed += 1; subscribedTotal += 1; }
        subDayMap.set(key, b);
      }
      const subSeries = [...subDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map((b) => ({
        date: b.date, label: new Date(b.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        count: b.count, subscribed: b.subscribed,
      }));
      const subTotal = subSeries.reduce((s, b) => s + b.count, 0);
      const peak = subSeries.reduce<{ label: string; count: number }>((m, b) => (b.count > m.count ? { label: b.label, count: b.count } : m), { label: '—', count: 0 });
      const newSubscribers = {
        total: subTotal,
        subscribedTotal,
        dailyAvg: subSeries.length ? Math.round(subTotal / subSeries.length) : 0,
        peakDay: peak,
        activeDays: subSeries.length,
        series: subSeries,
      };

      // ── Expected next order (real purchase cadence) ─────────────────────────
      const byCustomer = new Map<string, Date[]>();
      for (const o of orders) {
        const cid = o.customerId as string;
        if (!byCustomer.has(cid)) byCustomer.set(cid, []);
        byCustomer.get(cid)!.push(o.processedAt as Date);
      }
      const custName = new Map(customers.map((c) => [c.id, c.displayName ?? ([c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown')]));
      const custSpend = new Map(customers.map((c) => [c.id, Number(c.amountSpent)]));

      type Pred = { customerId: string; name: string; lastOrderAt: string; ordersCount: number; avgGapDays: number; expectedDate: string; daysUntil: number; status: 'overdue' | 'due_soon' | 'upcoming'; spent: number };
      const predictions: Pred[] = [];
      for (const [cid, dates] of byCustomer) {
        dates.sort((a, b) => a.getTime() - b.getTime());
        const last = dates[dates.length - 1];
        let avgGap: number;
        if (dates.length >= 2) {
          let total = 0;
          for (let i = 1; i < dates.length; i++) total += (dates[i].getTime() - dates[i - 1].getTime()) / 86_400_000;
          avgGap = Math.max(1, Math.round(total / (dates.length - 1)));
        } else {
          avgGap = 45; // single-order customers: assume a 45-day repurchase window
        }
        const expected = new Date(last.getTime() + avgGap * 86_400_000);
        const daysUntil = Math.round((expected.getTime() - now.getTime()) / 86_400_000);
        const status: Pred['status'] = daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'upcoming';
        predictions.push({
          customerId: cid, name: custName.get(cid) ?? 'Unknown', lastOrderAt: last.toISOString(),
          ordersCount: dates.length, avgGapDays: avgGap, expectedDate: expected.toISOString(),
          daysUntil, status, spent: custSpend.get(cid) ?? 0,
        });
      }
      predictions.sort((a, b) => a.daysUntil - b.daysUntil);
      const expectedNextOrder = {
        total: predictions.length,
        overdue: predictions.filter((p) => p.status === 'overdue').length,
        dueSoon: predictions.filter((p) => p.status === 'due_soon').length,
        upcoming: predictions.filter((p) => p.status === 'upcoming').length,
        customers: predictions.slice(0, 100),
      };

      // ── Revenue attribution (real orders; no email platform = all "store") ──
      let revInPeriod = 0, ordersInPeriod = 0;
      const revDayMap = new Map<string, number>();
      for (const o of orders) {
        const d = o.processedAt as Date;
        if (d < start || d > now) continue;
        const net = Number(o.subtotalAmount) - Number(o.discountAmount) - Number(o.refundAmount);
        revInPeriod += net; ordersInPeriod += 1;
        const key = d.toISOString().slice(0, 10);
        revDayMap.set(key, (revDayMap.get(key) ?? 0) + net);
      }
      const revenueAttribution = {
        totalRevenue: Math.round(revInPeriod),
        orders: ordersInPeriod,
        byChannel: [
          { channel: 'Shopify Store (direct)', revenue: Math.round(revInPeriod), orders: ordersInPeriod, pct: 100 },
          { channel: 'Email Campaigns', revenue: 0, orders: 0, pct: 0 },
          { channel: 'Email Flows', revenue: 0, orders: 0, pct: 0 },
        ],
        series: [...revDayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, revenue]) => ({
          date, label: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), revenue: Math.round(revenue),
        })),
      };

      return {
        period: { days, from: start.toISOString(), to: now.toISOString() },
        hasEmailPlatform: campaigns.length > 0 || flows.length > 0,
        newSubscribers,
        expectedNextOrder,
        revenueAttribution,
        campaigns,
        flows,
      };
    });
  }
}

@Controller('email')
export class EmailMarketingController {
  constructor(private readonly email: EmailMarketingService) {}

  @Get('campaigns')
  @RequirePermissions('email.read')
  campaigns(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.email.campaigns(ctx, storeId);
  }
  @Post('campaigns')
  @RequirePermissions('email.manage')
  createCampaign(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createCampaignSchema)) body: z.infer<typeof createCampaignSchema>) {
    return this.email.createCampaign(ctx, body);
  }
  @Get('flows')
  @RequirePermissions('email.read')
  flows(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.email.flows(ctx, storeId);
  }
  @Post('flows')
  @RequirePermissions('email.manage')
  createFlow(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createFlowSchema)) body: z.infer<typeof createFlowSchema>) {
    return this.email.createFlow(ctx, body);
  }
  @Get('events')
  @RequirePermissions('email.read')
  events(@CurrentContext() ctx: RequestContext) {
    return this.email.events(ctx);
  }

  @Get('insights')
  @RequirePermissions('email.read')
  insights(@CurrentContext() ctx: RequestContext, @Query('days') days = '365', @Query('storeId') storeId?: string) {
    return this.email.insights(ctx, Number(days) || 365, storeId);
  }
}

@Module({ controllers: [EmailMarketingController], providers: [EmailMarketingService] })
export class EmailMarketingModule {}
