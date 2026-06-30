import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';
import { QueueService } from '../../shared/queue/queue.service';
import { QUEUES } from '../../shared/queue/queue.constants';

const runSchema = z.object({
  storeId: z.string().uuid().optional(),
  modelKey: z.string().default('revenue_forecast'),
  horizonDays: z.coerce.number().int().min(1).max(180).default(30),
});
type RunDto = z.infer<typeof runSchema>;

const patchInsightSchema = z.object({ status: z.enum(['open', 'accepted', 'dismissed']) });

@Injectable()
export class PredictionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Synchronous baseline forecast: linear trend + moving-average over historical
   * daily gross sales. Persists a run, its series points, and a headline insight.
   * (In production this is enqueued to the prediction worker; here it runs inline
   * so the endpoint is functional without Redis.)
   */
  async run(ctx: RequestContext, dto: RunDto) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const since = new Date();
      since.setDate(since.getDate() - 90);
      const history = await tx.dailySalesMetric.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, dto.storeId), metricDate: { gte: since } },
        orderBy: { metricDate: 'asc' },
      });

      const values = history.map((h) => Number(h.grossSales));
      const { slope, intercept } = linearFit(values);
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

      const run = await tx.predictionRun.create({
        data: {
          tenantId: ctx.tenantId,
          storeId: dto.storeId ?? null,
          modelKey: dto.modelKey,
          modelVersion: 'baseline-v1',
          status: 'success',
          forecastHorizonDays: dto.horizonDays,
          confidenceLevel: values.length >= 14 ? 'medium' : 'low',
          generatedAt: new Date(),
          createdByUserId: ctx.userId,
          metadataJson: { method: 'linear_trend+moving_average', historyPoints: values.length },
        },
      });

      const baseDate = new Date();
      const points = [];
      for (let i = 1; i <= dto.horizonDays; i++) {
        const trend = intercept + slope * (values.length + i);
        const forecast = Math.max(0, 0.6 * trend + 0.4 * avg);
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        points.push({
          tenantId: ctx.tenantId,
          predictionRunId: run.id,
          seriesKey: 'revenue',
          pointDate: d,
          forecastValue: Number(forecast.toFixed(2)),
          ciLow: Number((forecast * 0.8).toFixed(2)),
          ciHigh: Number((forecast * 1.2).toFixed(2)),
        });
      }
      if (points.length) await tx.predictionSeriesPoint.createMany({ data: points });

      const projected = points.reduce((a, p) => a + (p.forecastValue ?? 0), 0);
      await tx.predictionInsight.create({
        data: {
          tenantId: ctx.tenantId,
          storeId: dto.storeId ?? null,
          predictionRunId: run.id,
          insightType: slope >= 0 ? 'opportunity' : 'warning',
          title: slope >= 0 ? 'Revenue trending up' : 'Revenue trending down',
          description: `Projected ${dto.horizonDays}-day revenue ≈ ${projected.toFixed(0)} based on the last ${values.length} days.`,
          priority: slope < 0 ? 'high' : 'medium',
          confidenceScore: values.length >= 14 ? 0.7 : 0.4,
          recommendedAction: slope < 0 ? 'Review marketing spend and at-risk customers.' : 'Maintain momentum; ensure inventory cover.',
          status: 'open',
        },
      });

      return { runId: run.id, status: run.status, horizonDays: dto.horizonDays, projectedRevenue: Number(projected.toFixed(2)) };
    });
  }

  latest(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const run = await tx.predictionRun.findFirst({
        where: { tenantId: ctx.tenantId, status: 'success', ...storeScopeFilter(ctx, storeId) },
        orderBy: { generatedAt: 'desc' },
        include: { points: { orderBy: { pointDate: 'asc' } } },
      });
      if (!run) return null;
      return {
        runId: run.id,
        modelKey: run.modelKey,
        modelVersion: run.modelVersion,
        generatedAt: run.generatedAt,
        confidenceLevel: run.confidenceLevel,
        series: run.points.map((p) => ({
          date: p.pointDate,
          forecast: p.forecastValue ? Number(p.forecastValue) : null,
          ciLow: p.ciLow ? Number(p.ciLow) : null,
          ciHigh: p.ciHigh ? Number(p.ciHigh) : null,
        })),
      };
    });
  }

  runs(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.predictionRun.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    );
  }

  insights(ctx: RequestContext, status?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.predictionInsight.findMany({
        where: { tenantId: ctx.tenantId, ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  async patchInsight(ctx: RequestContext, insightId: string, status: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const updated = await tx.predictionInsight.updateMany({ where: { id: insightId, tenantId: ctx.tenantId }, data: { status } });
      if (updated.count === 0) throw new NotFoundException({ code: 'insight_not_found', message: 'Insight not found' });
      return { id: insightId, status };
    });
  }
}

function linearFit(values: number[]): { slope: number; intercept: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };
  const xs = values.map((_, i) => i + 1);
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = values.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * values[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

@Controller('predictions')
export class PredictionsController {
  constructor(
    private readonly predictions: PredictionsService,
    private readonly queue: QueueService,
  ) {}

  @Get('latest')
  @RequirePermissions('predictions.read')
  latest(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.predictions.latest(ctx, storeId);
  }

  @Get('runs')
  @RequirePermissions('predictions.read')
  runs(@CurrentContext() ctx: RequestContext) {
    return this.predictions.runs(ctx);
  }

  @Post('run')
  @RequirePermissions('predictions.run')
  async run(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(runSchema)) body: RunDto) {
    // Async via the worker when Redis is configured; otherwise compute inline.
    const queued = await this.queue.enqueue(QUEUES.PREDICTIONS_RUN, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      membershipId: ctx.membershipId,
      storeId: body.storeId,
      payload: { modelKey: body.modelKey, horizonDays: body.horizonDays, storeId: body.storeId },
    });
    if (queued) return { status: 'queued', queued: true };
    return this.predictions.run(ctx, body);
  }

  @Get('insights')
  @RequirePermissions('predictions.read')
  insights(@CurrentContext() ctx: RequestContext, @Query('status') status?: string) {
    return this.predictions.insights(ctx, status);
  }

  @Patch('insights/:insightId')
  @RequirePermissions('predictions.read')
  patch(@CurrentContext() ctx: RequestContext, @Param('insightId') insightId: string, @Body(new ZodValidationPipe(patchInsightSchema)) body: { status: string }) {
    return this.predictions.patchInsight(ctx, insightId, body.status);
  }
}

@Module({ controllers: [PredictionsController], providers: [PredictionsService], exports: [PredictionsService] })
export class PredictionsModule {}
