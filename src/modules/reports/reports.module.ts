import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createReportSchema = z.object({
  reportKey: z.enum(['sales', 'inventory', 'customers', 'orders', 'custom']),
  format: z.enum(['csv', 'pdf', 'xlsx']).default('csv'),
  storeId: z.string().uuid().optional(),
  paramsJson: z.record(z.string(), z.any()).default({}),
});

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.reportRun.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    );
  }

  get(ctx: RequestContext, id: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const run = await tx.reportRun.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!run) throw new NotFoundException({ code: 'report_not_found', message: 'Report not found' });
      return run;
    });
  }

  /**
   * Creates a report run. The heavy generation is designed for the report worker;
   * here we compute a quick row count synchronously so the run resolves immediately.
   * (Enqueue to BullMQ when REDIS_URL is set.)
   */
  async create(ctx: RequestContext, dto: z.infer<typeof createReportSchema>) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const run = await tx.reportRun.create({
        data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, reportKey: dto.reportKey, format: dto.format, paramsJson: dto.paramsJson, status: 'running', startedAt: new Date(), requestedByUserId: ctx.userId },
      });
      const scope = storeScopeFilter(ctx, dto.storeId);
      const rowCount =
        dto.reportKey === 'orders' ? await tx.order.count({ where: { tenantId: ctx.tenantId, ...scope } })
        : dto.reportKey === 'customers' ? await tx.commerceCustomer.count({ where: { tenantId: ctx.tenantId, ...scope } })
        : dto.reportKey === 'inventory' ? await tx.inventoryLevel.count({ where: { tenantId: ctx.tenantId, ...scope } })
        : await tx.dailySalesMetric.count({ where: { tenantId: ctx.tenantId, ...scope } });
      return tx.reportRun.update({ where: { id: run.id }, data: { status: 'success', finishedAt: new Date(), rowCount } });
    });
  }
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermissions('reports.read')
  list(@CurrentContext() ctx: RequestContext) {
    return this.reports.list(ctx);
  }

  @Post()
  @RequirePermissions('reports.export')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createReportSchema)) body: z.infer<typeof createReportSchema>) {
    return this.reports.create(ctx, body);
  }

  @Get(':reportId')
  @RequirePermissions('reports.read')
  get(@CurrentContext() ctx: RequestContext, @Param('reportId') reportId: string) {
    return this.reports.get(ctx, reportId);
  }
}

@Module({ controllers: [ReportsController], providers: [ReportsService] })
export class ReportsModule {}
