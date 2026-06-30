import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';
import { storeScopeFilter } from '../../common/store-scope';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async levels(ctx: RequestContext, q: PaginationQuery & { storeId?: string }) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, q.storeId) };
      const [rows, total] = await Promise.all([
        tx.inventoryLevel.findMany({ where, include: { location: true }, orderBy: { availableQuantity: 'asc' }, ...skipTake(q.page, q.pageSize) }),
        tx.inventoryLevel.count({ where }),
      ]);
      const data = rows.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        location: l.location?.name,
        available: l.availableQuantity,
        reserved: l.reservedQuantity,
        incoming: l.incomingQuantity,
        reorderPoint: l.reorderPoint,
        safetyStock: l.safetyStock,
        lowStock: l.availableQuantity <= l.reorderPoint,
      }));
      return buildPage(data, total, q.page, q.pageSize);
    });
  }

  async movements(ctx: RequestContext, q: PaginationQuery & { storeId?: string }) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, q.storeId) };
      const [rows, total] = await Promise.all([
        tx.inventoryMovement.findMany({ where, orderBy: { occurredAt: 'desc' }, ...skipTake(q.page, q.pageSize) }),
        tx.inventoryMovement.count({ where }),
      ]);
      return buildPage(rows, total, q.page, q.pageSize);
    });
  }
}

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory.read')
  levels(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery, @Query('storeId') storeId?: string) {
    return this.inventory.levels(ctx, { ...q, storeId });
  }

  @Get('movements')
  @RequirePermissions('inventory.read')
  movements(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery, @Query('storeId') storeId?: string) {
    return this.inventory.movements(ctx, { ...q, storeId });
  }
}

@Module({ controllers: [InventoryController], providers: [InventoryService] })
export class InventoryModule {}
