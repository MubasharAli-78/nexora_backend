import { Controller, Get, Injectable, Module, NotFoundException, Param, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { FieldEncryptionService } from '../../shared/security/field-encryption.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';
import { storeScopeFilter } from '../../common/store-scope';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async list(ctx: RequestContext, q: PaginationQuery & { storeId?: string }) {
    const canSeePii = ctx.permissions.includes('customers.export');
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = {
        tenantId: ctx.tenantId,
        deletedAt: null,
        ...storeScopeFilter(ctx, q.storeId),
        ...(q.search ? { displayName: { contains: q.search, mode: 'insensitive' as const } } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.commerceCustomer.findMany({ where, omit: { rawPayloadJson: true }, orderBy: { lastOrderAt: 'desc' }, ...skipTake(q.page, q.pageSize) }),
        tx.commerceCustomer.count({ where }),
      ]);
      return buildPage(rows.map((c) => this.map(c, canSeePii)), total, q.page, q.pageSize);
    });
  }

  async get(ctx: RequestContext, customerId: string) {
    const canSeePii = ctx.permissions.includes('customers.export');
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const c = await tx.commerceCustomer.findFirst({ where: { id: customerId, tenantId: ctx.tenantId }, include: { addresses: true } });
      if (!c) throw new NotFoundException({ code: 'customer_not_found', message: 'Customer not found' });
      return { ...this.map(c, canSeePii), addresses: c.addresses.map((a) => this.mapAddress(a, canSeePii)) };
    });
  }

  async orders(ctx: RequestContext, customerId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.order.findMany({ where: { customerId, tenantId: ctx.tenantId }, omit: { rawPayloadJson: true }, orderBy: { processedAt: 'desc' }, take: 100 }),
    );
  }

  private map(c: any, canSeePii: boolean) {
    const email = canSeePii ? this.encryption.decrypt(c.emailEncrypted) : null;
    return {
      id: c.id,
      storeId: c.storeId,
      displayName: c.displayName ?? [c.firstName, c.lastName].filter(Boolean).join(' '),
      firstName: c.firstName,
      lastName: c.lastName,
      email: canSeePii ? email : maskEmailFromName(c.displayName),
      state: c.state,
      numberOfOrders: c.numberOfOrders,
      amountSpent: Number(c.amountSpent),
      currency: c.currency,
      tags: c.tagsJson ?? [],
      lastOrderAt: c.lastOrderAt,
    };
  }

  private mapAddress(a: any, canSeePii: boolean) {
    return {
      id: a.id,
      name: a.name,
      company: a.company,
      city: a.city,
      province: a.province,
      country: a.country,
      countryCode: a.countryCode,
      address1: canSeePii ? this.encryption.decrypt(a.address1Encrypted) : null,
      zip: canSeePii ? this.encryption.decrypt(a.zipEncrypted) : null,
      isDefault: a.isDefault,
    };
  }
}

function maskEmailFromName(_name?: string): string {
  return '••••@••••';
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customers.read')
  list(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery, @Query('storeId') storeId?: string) {
    return this.customers.list(ctx, { ...q, storeId });
  }

  @Get(':customerId')
  @RequirePermissions('customers.read')
  get(@CurrentContext() ctx: RequestContext, @Param('customerId') customerId: string) {
    return this.customers.get(ctx, customerId);
  }

  @Get(':customerId/orders')
  @RequirePermissions('customers.read')
  orders(@CurrentContext() ctx: RequestContext, @Param('customerId') customerId: string) {
    return this.customers.orders(ctx, customerId);
  }
}

@Module({ controllers: [CustomersController], providers: [CustomersService] })
export class CustomersModule {}
