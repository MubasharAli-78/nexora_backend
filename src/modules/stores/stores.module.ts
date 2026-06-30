import { Body, Controller, Delete, Get, Injectable, Module, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createStoreSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  platform: z.enum(['shopify', 'woocommerce', 'amazon', 'manual']).default('manual'),
  currency: z.string().length(3).default('USD'),
  timezone: z.string().default('UTC'),
});
const updateStoreSchema = createStoreSchema.partial();

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: RequestContext) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.store.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null, ...storeScopeFilter(ctx) },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  create(ctx: RequestContext, dto: z.infer<typeof createStoreSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.store.create({ data: { tenantId: ctx.tenantId, ...dto } }),
    );
  }

  get(ctx: RequestContext, storeId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.store.findFirst({ where: { id: storeId, tenantId: ctx.tenantId } }),
    );
  }

  update(ctx: RequestContext, storeId: string, dto: z.infer<typeof updateStoreSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.store.updateMany({ where: { id: storeId, tenantId: ctx.tenantId }, data: dto }).then(() =>
        tx.store.findFirst({ where: { id: storeId, tenantId: ctx.tenantId } }),
      ),
    );
  }

  remove(ctx: RequestContext, storeId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.store.updateMany({ where: { id: storeId, tenantId: ctx.tenantId }, data: { deletedAt: new Date(), status: 'disconnected' } }),
    );
  }
}

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @RequirePermissions('dashboard.read')
  list(@CurrentContext() ctx: RequestContext) {
    return this.stores.list(ctx);
  }

  @Post()
  @RequirePermissions('integrations.manage')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createStoreSchema)) body: z.infer<typeof createStoreSchema>) {
    return this.stores.create(ctx, body);
  }

  @Get(':storeId')
  @RequirePermissions('dashboard.read')
  get(@CurrentContext() ctx: RequestContext, @Param('storeId') storeId: string) {
    return this.stores.get(ctx, storeId);
  }

  @Patch(':storeId')
  @RequirePermissions('integrations.manage')
  update(@CurrentContext() ctx: RequestContext, @Param('storeId') storeId: string, @Body(new ZodValidationPipe(updateStoreSchema)) body: z.infer<typeof updateStoreSchema>) {
    return this.stores.update(ctx, storeId, body);
  }

  @Delete(':storeId')
  @RequirePermissions('integrations.manage')
  remove(@CurrentContext() ctx: RequestContext, @Param('storeId') storeId: string) {
    return this.stores.remove(ctx, storeId);
  }
}

@Module({ controllers: [StoresController], providers: [StoresService], exports: [StoresService] })
export class StoresModule {}
