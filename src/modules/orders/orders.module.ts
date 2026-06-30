import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';
import { storeScopeFilter } from '../../common/store-scope';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext, q: PaginationQuery & { storeId?: string; status?: string }) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = {
        tenantId: ctx.tenantId,
        deletedAt: null,
        ...storeScopeFilter(ctx, q.storeId),
        ...(q.status ? { orderStatus: q.status } : {}),
        ...(q.search ? { orderNumber: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.order.findMany({ where, omit: { rawPayloadJson: true }, orderBy: { processedAt: 'desc' }, ...skipTake(q.page, q.pageSize) }),
        tx.order.count({ where }),
      ]);
      return buildPage(rows.map(mapOrder), total, q.page, q.pageSize);
    });
  }

  async get(ctx: RequestContext, orderId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const o = await tx.order.findFirst({ where: { id: orderId, tenantId: ctx.tenantId }, include: { items: true } });
      if (!o) throw new NotFoundException({ code: 'order_not_found', message: 'Order not found' });
      return { ...mapOrder(o), items: o.items.map(mapItem) };
    });
  }

  async items(ctx: RequestContext, orderId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.orderItem.findMany({ where: { orderId, tenantId: ctx.tenantId } }),
    ).then((rows) => rows.map(mapItem));
  }
}

function mapItem(i: any) {
  return {
    id: i.id,
    title: i.title,
    sku: i.sku,
    quantity: i.quantity,
    unitPrice: Number(i.unitPriceAmount),
    total: Number(i.totalAmount),
    productId: i.productId,
    variantId: i.variantId,
  };
}

function mapOrder(o: any) {
  return {
    id: o.id,
    storeId: o.storeId,
    customerId: o.customerId,
    orderNumber: o.orderNumber ?? o.externalName,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    orderStatus: o.orderStatus,
    currency: o.currency,
    subtotal: Number(o.subtotalAmount),
    shipping: Number(o.shippingAmount),
    tax: Number(o.taxAmount),
    discount: Number(o.discountAmount),
    refund: Number(o.refundAmount),
    total: Number(o.totalAmount),
    paymentMethod: o.paymentMethod,
    processedAt: o.processedAt,
    createdAt: o.createdAt,
  };
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('orders.read')
  list(
    @CurrentContext() ctx: RequestContext,
    @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery,
    @Query('storeId') storeId?: string,
    @Query('status') status?: string,
  ) {
    return this.orders.list(ctx, { ...q, storeId, status });
  }

  @Get(':orderId')
  @RequirePermissions('orders.read')
  get(@CurrentContext() ctx: RequestContext, @Param('orderId') orderId: string) {
    return this.orders.get(ctx, orderId);
  }

  @Get(':orderId/items')
  @RequirePermissions('orders.read')
  items(@CurrentContext() ctx: RequestContext, @Param('orderId') orderId: string) {
    return this.orders.items(ctx, orderId);
  }
}

@Module({ controllers: [OrdersController], providers: [OrdersService] })
export class OrdersModule {}
