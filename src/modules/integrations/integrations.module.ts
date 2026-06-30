import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { FieldEncryptionService } from '../../shared/security/field-encryption.service';
import { ConnectorRegistry } from '../../shared/connectors/connector-registry';
import { AuditService } from '../../shared/audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SyncService } from './sync.service';
import { QueueService } from '../../shared/queue/queue.service';
import { QUEUES } from '../../shared/queue/queue.constants';

const connectSchema = z.object({
  storeId: z.string().uuid().optional(),
  displayName: z.string().optional(),
  externalShopDomain: z.string().optional(),
  credentials: z.record(z.string(), z.string()).default({}),
});
const syncSchema = z.object({ syncType: z.enum(['products', 'customers', 'orders', 'full']).default('full') });

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly registry: ConnectorRegistry,
    private readonly audit: AuditService,
  ) {}

  listProviders() {
    return this.prisma.integrationProvider.findMany({ orderBy: { name: 'asc' } });
  }

  list(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.tenantIntegration.findMany({ where: { tenantId: ctx.tenantId }, include: { provider: true }, orderBy: { createdAt: 'desc' } }),
    ).then((rows) =>
      rows.map((i) => ({
        id: i.id, provider: i.provider.key, providerName: i.provider.name, storeId: i.storeId,
        displayName: i.displayName, status: i.status, externalShopDomain: i.externalShopDomain, lastSyncAt: i.lastSyncAt, syncMode: i.syncMode,
      })),
    );
  }

  async connect(ctx: RequestContext, providerKey: string, dto: z.infer<typeof connectSchema>) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const provider = await tx.integrationProvider.findUnique({ where: { key: providerKey } });
      if (!provider) throw new NotFoundException({ code: 'provider_not_found', message: 'Provider not found' });
      if (!this.registry.has(providerKey)) throw new NotFoundException({ code: 'provider_unsupported', message: 'Provider not supported yet' });

      const integration = await tx.tenantIntegration.create({
        data: {
          tenantId: ctx.tenantId,
          storeId: dto.storeId ?? null,
          providerId: provider.id,
          displayName: dto.displayName ?? provider.name,
          status: 'connected',
          externalShopDomain: dto.externalShopDomain ?? dto.credentials.shopDomain ?? null,
          externalAccountId: dto.credentials.shopDomain ?? null,
          syncMode: 'manual',
        },
      });

      // Encrypt every credential field individually.
      const encrypted: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(dto.credentials)) encrypted[k] = this.encryption.encrypt(v);
      const token = dto.credentials.accessToken ?? dto.credentials.apiKey ?? '';
      await tx.integrationCredential.create({
        data: {
          tenantId: ctx.tenantId,
          integrationId: integration.id,
          secretProvider: 'app_encrypted',
          encryptedSecretJson: encrypted as object,
          tokenLast4: token ? token.slice(-4) : null,
        },
      });

      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'integrations.connected', resourceType: 'integration', resourceId: integration.id, after: { provider: providerKey } });
      return { id: integration.id, provider: providerKey, status: 'connected' };
    });
  }

  async disconnect(ctx: RequestContext, integrationId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const result = await tx.tenantIntegration.updateMany({ where: { id: integrationId, tenantId: ctx.tenantId }, data: { status: 'revoked' } });
      if (result.count === 0) throw new NotFoundException({ code: 'integration_not_found', message: 'Integration not found' });
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'integrations.disconnected', resourceType: 'integration', resourceId: integrationId });
      return { id: integrationId, status: 'revoked' };
    });
  }

  syncRuns(ctx: RequestContext, integrationId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.syncRun.findMany({ where: { tenantId: ctx.tenantId, integrationId }, orderBy: { startedAt: 'desc' }, take: 50 }),
    );
  }
}

@Controller()
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly sync: SyncService,
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly queue: QueueService,
  ) {}

  @Get('integrations/providers')
  @RequirePermissions('integrations.read')
  providers() {
    return this.integrations.listProviders();
  }

  @Get('integrations')
  @RequirePermissions('integrations.read')
  list(@CurrentContext() ctx: RequestContext) {
    return this.integrations.list(ctx);
  }

  @Post('integrations/:providerKey/connect')
  @RequirePermissions('integrations.manage')
  connect(@CurrentContext() ctx: RequestContext, @Param('providerKey') providerKey: string, @Body(new ZodValidationPipe(connectSchema)) body: z.infer<typeof connectSchema>) {
    return this.integrations.connect(ctx, providerKey, body);
  }

  @Post('integrations/:integrationId/disconnect')
  @RequirePermissions('integrations.manage')
  disconnect(@CurrentContext() ctx: RequestContext, @Param('integrationId') integrationId: string) {
    return this.integrations.disconnect(ctx, integrationId);
  }

  @Post('integrations/:integrationId/sync')
  @RequirePermissions('integrations.manage')
  async runSync(@CurrentContext() ctx: RequestContext, @Param('integrationId') integrationId: string, @Body(new ZodValidationPipe(syncSchema)) body: { syncType: 'products' | 'customers' | 'orders' | 'full' }) {
    // Connector sync makes external HTTP calls + many upserts — never hold the
    // request open for it. Enqueue to the worker when Redis is configured;
    // otherwise fall back to running inline (dev without Redis).
    const queued = await this.queue.enqueue(QUEUES.CONNECTOR_SYNC, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      membershipId: ctx.membershipId,
      payload: { integrationId, syncType: body.syncType },
    });
    if (queued) return { status: 'queued', queued: true };
    return this.sync.runSync(ctx, integrationId, body.syncType);
  }

  @Get('integrations/:integrationId/sync-runs')
  @RequirePermissions('integrations.read')
  syncRuns(@CurrentContext() ctx: RequestContext, @Param('integrationId') integrationId: string) {
    return this.integrations.syncRuns(ctx, integrationId);
  }

  /** Public webhook receiver. Stores raw event + HMAC verification result for async processing. */
  @Public()
  @Post('webhooks/:providerKey')
  async webhook(@Param('providerKey') providerKey: string, @Req() req: Request) {
    const connector = this.registry.has(providerKey) ? this.registry.get(providerKey) : null;
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;

    let result: { valid: boolean; topic?: string; externalEventId?: string } = {
      valid: false,
      topic: headers['x-shopify-topic'],
      externalEventId: headers['x-shopify-webhook-id'],
    };
    if (connector) {
      result = await connector.verifyWebhook({ rawBody, headers });
    }

    const externalEventId = result.externalEventId ?? `${providerKey}-${Date.now()}`;
    await this.prisma.webhookEvent.upsert({
      where: { providerKey_externalEventId: { providerKey, externalEventId } },
      update: { signatureValid: result.valid, status: 'received' },
      create: {
        providerKey,
        eventType: result.topic ?? 'unknown',
        externalEventId,
        headersJson: headers as object,
        payloadJson: (req.body as object) ?? {},
        signatureValid: result.valid,
        status: 'received',
      },
    });
    return { received: true };
  }
}

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, SyncService],
  exports: [SyncService],
})
export class IntegrationsModule {}
