import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';
import { storeScopeFilter } from '../../common/store-scope';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(ctx: RequestContext, q: PaginationQuery & { storeId?: string }) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = {
        tenantId: ctx.tenantId,
        deletedAt: null,
        ...storeScopeFilter(ctx, q.storeId),
        ...(q.search ? { title: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.product.findMany({
          where,
          // Skip the large Shopify raw payload JSON — list/detail responses never use it.
          omit: { rawPayloadJson: true },
          include: { variants: { omit: { rawPayloadJson: true } }, images: { orderBy: { position: 'asc' } } },
          orderBy: { createdAt: 'desc' },
          ...skipTake(q.page, q.pageSize),
        }),
        tx.product.count({ where }),
      ]);
      return buildPage(rows.map(mapProduct), total, q.page, q.pageSize);
    });
  }

  async getProduct(ctx: RequestContext, productId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const p = await tx.product.findFirst({
        where: { id: productId, tenantId: ctx.tenantId },
        omit: { rawPayloadJson: true },
        include: { variants: { omit: { rawPayloadJson: true } }, images: { orderBy: { position: 'asc' } } },
      });
      if (!p) throw new NotFoundException({ code: 'product_not_found', message: 'Product not found' });
      return mapProduct(p);
    });
  }

  async listVariants(ctx: RequestContext, productId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.productVariant.findMany({ where: { productId, tenantId: ctx.tenantId }, orderBy: { position: 'asc' } }),
    ).then((rows) => rows.map(mapVariant));
  }

  async productMetrics(ctx: RequestContext, productId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.dailyProductMetric.findMany({
        where: { productId, tenantId: ctx.tenantId },
        orderBy: { metricDate: 'desc' },
        take: 90,
      }),
    );
  }
}

function mapVariant(v: any) {
  return {
    id: v.id,
    title: v.title,
    sku: v.sku,
    barcode: v.barcode,
    price: Number(v.priceAmount),
    compareAtPrice: v.compareAtPriceAmount ? Number(v.compareAtPriceAmount) : null,
    currency: v.currency,
    position: v.position,
  };
}

function mapProduct(p: any) {
  return {
    id: p.id,
    storeId: p.storeId,
    title: p.title,
    handle: p.handle,
    description: p.description,
    vendor: p.vendor,
    productType: p.productType,
    status: p.status,
    featuredImageUrl: p.featuredImageUrl,
    tags: p.tagsJson ?? [],
    images: (p.images ?? []).map((img: any) => ({ id: img.id, url: img.externalUrl, alt: img.altText, position: img.position })),
    variants: (p.variants ?? []).map(mapVariant),
    priceFrom: p.variants?.length ? Math.min(...p.variants.map((v: any) => Number(v.priceAmount))) : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

const listQuerySchema = paginationSchema.extend({});

@Controller('products')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  @RequirePermissions('products.read')
  list(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(listQuerySchema)) q: PaginationQuery, @Query('storeId') storeId?: string) {
    return this.catalog.listProducts(ctx, { ...q, storeId });
  }

  @Get(':productId')
  @RequirePermissions('products.read')
  get(@CurrentContext() ctx: RequestContext, @Param('productId') productId: string) {
    return this.catalog.getProduct(ctx, productId);
  }

  @Get(':productId/variants')
  @RequirePermissions('products.read')
  variants(@CurrentContext() ctx: RequestContext, @Param('productId') productId: string) {
    return this.catalog.listVariants(ctx, productId);
  }

  @Get(':productId/metrics')
  @RequirePermissions('products.read')
  metrics(@CurrentContext() ctx: RequestContext, @Param('productId') productId: string) {
    return this.catalog.productMetrics(ctx, productId);
  }
}

@Module({ controllers: [CatalogController], providers: [CatalogService] })
export class CatalogModule {}
