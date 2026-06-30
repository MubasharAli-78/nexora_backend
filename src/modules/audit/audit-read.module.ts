import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';

@Injectable()
export class AuditReadService {
  constructor(private readonly prisma: PrismaService) {}

  async logs(ctx: RequestContext, q: PaginationQuery) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId };
      const [rows, total] = await Promise.all([
        tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q.page, q.pageSize) }),
        tx.auditLog.count({ where }),
      ]);
      return buildPage(
        rows.map((r) => ({ id: r.id, action: r.action, resourceType: r.resourceType, resourceId: r.resourceId, actorUserId: r.actorUserId, after: r.afterJson, createdAt: r.createdAt })),
        total,
        q.page,
        q.pageSize,
      );
    });
  }
}

@Controller('audit')
export class AuditReadController {
  constructor(private readonly audit: AuditReadService) {}

  @Get('logs')
  @RequirePermissions('audit.read')
  logs(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery) {
    return this.audit.logs(ctx, q);
  }
}

@Module({ controllers: [AuditReadController], providers: [AuditReadService] })
export class AuditReadModule {}
