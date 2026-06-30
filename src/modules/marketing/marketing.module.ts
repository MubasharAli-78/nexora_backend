import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createCampaignSchema = z.object({
  storeId: z.string().uuid().optional(),
  channelKey: z.string().min(1),
  name: z.string().min(1),
  objective: z.string().optional(),
  budgetAmount: z.number().nonnegative().default(0),
  currency: z.string().length(3).default('USD'),
});

@Injectable()
export class MarketingService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.campaign.findMany({ where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId) }, orderBy: { createdAt: 'desc' } }),
    );
  }

  create(ctx: RequestContext, dto: z.infer<typeof createCampaignSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.campaign.create({ data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, channelKey: dto.channelKey, name: dto.name, objective: dto.objective, budgetAmount: dto.budgetAmount, currency: dto.currency, status: 'active' } }),
    );
  }

  metrics(ctx: RequestContext, campaignId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.campaignMetricsDaily.findMany({ where: { tenantId: ctx.tenantId, campaignId }, orderBy: { metricDate: 'desc' }, take: 90 }),
    );
  }
}

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('campaigns')
  @RequirePermissions('marketing.read')
  list(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.marketing.list(ctx, storeId);
  }

  @Post('campaigns')
  @RequirePermissions('marketing.manage')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createCampaignSchema)) body: z.infer<typeof createCampaignSchema>) {
    return this.marketing.create(ctx, body);
  }

  @Get('campaigns/:campaignId/metrics')
  @RequirePermissions('marketing.read')
  metrics(@CurrentContext() ctx: RequestContext, @Param('campaignId') campaignId: string) {
    return this.marketing.metrics(ctx, campaignId);
  }
}

@Module({ controllers: [MarketingController], providers: [MarketingService] })
export class MarketingModule {}
