import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createRuleSchema = z.object({
  storeId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  ruleType: z.enum(['velocity', 'amount', 'geo', 'blocklist', 'custom']),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  configJson: z.record(z.string(), z.any()).default({}),
});
const updateAlertSchema = z.object({ status: z.enum(['open', 'reviewing', 'confirmed', 'dismissed']) });

@Injectable()
export class FraudService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  alerts(ctx: RequestContext, status?: string, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.fraudAlert.findMany({
        where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId), ...(status ? { status } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
  }

  rules(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.fraudRule.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' } }),
    );
  }

  createRule(ctx: RequestContext, dto: z.infer<typeof createRuleSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.fraudRule.create({ data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, name: dto.name, description: dto.description, ruleType: dto.ruleType, severity: dto.severity, configJson: dto.configJson } }),
    );
  }

  async updateAlert(ctx: RequestContext, alertId: string, status: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const res = await tx.fraudAlert.updateMany({
        where: { id: alertId, tenantId: ctx.tenantId },
        data: { status, resolvedAt: status === 'confirmed' || status === 'dismissed' ? new Date() : null },
      });
      if (res.count === 0) throw new NotFoundException({ code: 'alert_not_found', message: 'Alert not found' });
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'fraud.alert_updated', resourceType: 'fraud_alert', resourceId: alertId, after: { status } });
      return { id: alertId, status };
    });
  }
}

@Controller('fraud')
export class FraudController {
  constructor(private readonly fraud: FraudService) {}

  @Get('alerts')
  @RequirePermissions('fraud.read')
  alerts(@CurrentContext() ctx: RequestContext, @Query('status') status?: string, @Query('storeId') storeId?: string) {
    return this.fraud.alerts(ctx, status, storeId);
  }

  @Get('rules')
  @RequirePermissions('fraud.read')
  rules(@CurrentContext() ctx: RequestContext) {
    return this.fraud.rules(ctx);
  }

  @Post('rules')
  @RequirePermissions('fraud.manage')
  createRule(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createRuleSchema)) body: z.infer<typeof createRuleSchema>) {
    return this.fraud.createRule(ctx, body);
  }

  @Patch('alerts/:alertId')
  @RequirePermissions('fraud.manage')
  updateAlert(@CurrentContext() ctx: RequestContext, @Param('alertId') alertId: string, @Body(new ZodValidationPipe(updateAlertSchema)) body: { status: string }) {
    return this.fraud.updateAlert(ctx, alertId, body.status);
  }
}

@Module({ controllers: [FraudController], providers: [FraudService] })
export class FraudModule {}
