import { Body, Controller, Get, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { storeScopeFilter } from '../../common/store-scope';

const createSegmentSchema = z.object({
  storeId: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  definitionJson: z.record(z.string(), z.any()).default({}),
  isDynamic: z.boolean().default(true),
});

@Injectable()
export class SegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: RequestContext, storeId?: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.customerSegment.findMany({ where: { tenantId: ctx.tenantId, ...storeScopeFilter(ctx, storeId) }, orderBy: { createdAt: 'desc' } }),
    );
  }

  create(ctx: RequestContext, dto: z.infer<typeof createSegmentSchema>) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.customerSegment.create({ data: { tenantId: ctx.tenantId, storeId: dto.storeId ?? null, name: dto.name, description: dto.description, definitionJson: dto.definitionJson, isDynamic: dto.isDynamic } }),
    );
  }

  members(ctx: RequestContext, segmentId: string) {
    return this.prisma.withTenantContext(ctx, (tx) =>
      tx.customerSegmentMembership.findMany({ where: { tenantId: ctx.tenantId, segmentId }, take: 500 }),
    );
  }
}

@Controller('customers/segments')
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @Get()
  @RequirePermissions('customers.read')
  list(@CurrentContext() ctx: RequestContext, @Query('storeId') storeId?: string) {
    return this.segments.list(ctx, storeId);
  }

  @Post()
  @RequirePermissions('customers.manage_segments')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createSegmentSchema)) body: z.infer<typeof createSegmentSchema>) {
    return this.segments.create(ctx, body);
  }

  @Get(':segmentId/members')
  @RequirePermissions('customers.read')
  members(@CurrentContext() ctx: RequestContext, @Param('segmentId') segmentId: string) {
    return this.segments.members(ctx, segmentId);
  }
}

@Module({ controllers: [SegmentsController], providers: [SegmentsService] })
export class SegmentsModule {}
