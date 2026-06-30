import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { storeScopeFilter } from '../../common/store-scope';
import { buildNavigation } from '../../shared/rbac/navigation';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const scope = storeScopeFilter(ctx, storeId);
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const [salesAgg, orderCount, customerCount, recentMetrics, insights] = await Promise.all([
        tx.dailySalesMetric.aggregate({
          where: { tenantId: ctx.tenantId, ...scope, metricDate: { gte: since } },
          _sum: { grossSales: true, netSales: true, ordersCount: true, refundAmount: true },
        }),
        tx.order.count({ where: { tenantId: ctx.tenantId, deletedAt: null, ...scope } }),
        tx.commerceCustomer.count({ where: { tenantId: ctx.tenantId, deletedAt: null, ...scope } }),
        tx.dailySalesMetric.findMany({
          where: { tenantId: ctx.tenantId, ...scope, metricDate: { gte: since } },
          orderBy: { metricDate: 'asc' },
        }),
        tx.predictionInsight.findMany({
          where: { tenantId: ctx.tenantId, status: 'open' },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ]);

      const revenue = Number(salesAgg._sum.grossSales ?? 0);
      const orders30d = salesAgg._sum.ordersCount ?? 0;
      const aov = orders30d > 0 ? revenue / orders30d : 0;

      return {
        kpis: {
          revenue30d: revenue,
          netSales30d: Number(salesAgg._sum.netSales ?? 0),
          orders30d,
          ordersTotal: orderCount,
          customersTotal: customerCount,
          avgOrderValue: Number(aov.toFixed(2)),
          refunds30d: Number(salesAgg._sum.refundAmount ?? 0),
        },
        salesSeries: recentMetrics.map((m) => ({
          date: m.metricDate,
          grossSales: Number(m.grossSales),
          orders: m.ordersCount,
        })),
        insights: insights.map((i) => ({
          id: i.id,
          type: i.insightType,
          title: i.title,
          description: i.description,
          priority: i.priority,
          recommendedAction: i.recommendedAction,
        })),
      };
    });
  }

  navigation(ctx: RequestContext) {
    return {
      navigation: buildNavigation(ctx.primaryRole, ctx.permissions),
      primaryRole: ctx.primaryRole,
      roles: ctx.roles,
    };
  }
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  @RequirePermissions('dashboard.read')
  overview(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.dashboard.overview(ctx, storeId);
  }

  @Get('navigation')
  navigation(@CurrentContext() ctx: RequestContext) {
    return this.dashboard.navigation(ctx);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
