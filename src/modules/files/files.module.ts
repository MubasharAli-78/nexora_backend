import { Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../shared/database/prisma.service';
import { StorageService } from '../../shared/storage/storage.service';
import { RequestContext } from '../../common/context/request-context';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { paginationSchema, buildPage, skipTake, type PaginationQuery } from '../../common/pagination';
import type { AppEnv } from '../../shared/config/env.schema';

const uploadUrlSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().optional(),
  purpose: z.enum(['avatar', 'product', 'export', 'report']).default('export'),
  storeId: z.string().uuid().optional(),
});
const completeSchema = z.object({ fileId: z.string().uuid() });

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private bucketFor(purpose: string): string {
    if (purpose === 'product') return this.config.get('STORAGE_BUCKET_PRODUCT', { infer: true });
    return this.config.get('STORAGE_BUCKET_PRIVATE', { infer: true });
  }

  async createUploadUrl(ctx: RequestContext, dto: z.infer<typeof uploadUrlSchema>) {
    const fileId = randomUUID();
    const safeName = dto.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const bucket = this.bucketFor(dto.purpose);
    const objectKey = `tenants/${ctx.tenantId}/${dto.purpose}/${fileId}-${safeName}`;

    await this.prisma.withTenantContext(ctx, (tx) =>
      tx.file.create({
        data: {
          id: fileId,
          tenantId: ctx.tenantId,
          storeId: dto.storeId ?? null,
          bucket,
          objectKey,
          fileName: dto.fileName,
          mimeType: dto.mimeType ?? null,
          visibility: 'private',
          purpose: dto.purpose,
          uploadedByUserId: ctx.userId,
          status: 'pending',
        },
      }),
    );

    const uploadUrl = await this.storage.presignUpload(bucket, objectKey, dto.mimeType);
    return { fileId, uploadUrl, objectKey, bucket };
  }

  async completeUpload(ctx: RequestContext, fileId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const file = await tx.file.findFirst({ where: { id: fileId, tenantId: ctx.tenantId } });
      if (!file) throw new NotFoundException({ code: 'file_not_found', message: 'File not found' });
      const head = await this.storage.head(file.bucket, file.objectKey);
      if (!head.exists) throw new NotFoundException({ code: 'object_missing', message: 'Uploaded object not found in storage' });
      const updated = await tx.file.update({
        where: { id: fileId },
        data: { status: 'available', sizeBytes: head.size ? BigInt(head.size) : null, mimeType: head.contentType ?? file.mimeType },
      });
      return { id: updated.id, status: updated.status, sizeBytes: updated.sizeBytes ? Number(updated.sizeBytes) : null };
    });
  }

  async downloadUrl(ctx: RequestContext, fileId: string) {
    const file = await this.prisma.withTenantContext(ctx, (tx) =>
      tx.file.findFirst({ where: { id: fileId, tenantId: ctx.tenantId, status: 'available' } }),
    );
    if (!file) throw new NotFoundException({ code: 'file_not_found', message: 'File not found' });
    const url = await this.storage.presignDownload(file.bucket, file.objectKey);
    return { url, fileName: file.fileName };
  }

  async remove(ctx: RequestContext, fileId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const file = await tx.file.findFirst({ where: { id: fileId, tenantId: ctx.tenantId } });
      if (!file) throw new NotFoundException({ code: 'file_not_found', message: 'File not found' });
      try {
        await this.storage.remove(file.bucket, file.objectKey);
      } catch {
        /* ignore storage delete failure; metadata still flagged deleted */
      }
      await tx.file.update({ where: { id: fileId }, data: { status: 'deleted', deletedAt: new Date() } });
      return { id: fileId, deleted: true };
    });
  }

  async list(ctx: RequestContext, q: PaginationQuery) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId, status: 'available' };
      const [rows, total] = await Promise.all([
        tx.file.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q.page, q.pageSize) }),
        tx.file.count({ where }),
      ]);
      return buildPage(
        rows.map((f) => ({ id: f.id, fileName: f.fileName, purpose: f.purpose, mimeType: f.mimeType, sizeBytes: f.sizeBytes ? Number(f.sizeBytes) : null, createdAt: f.createdAt })),
        total,
        q.page,
        q.pageSize,
      );
    });
  }
}

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post('upload-url')
  @RequirePermissions('files.write')
  uploadUrl(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(uploadUrlSchema)) body: z.infer<typeof uploadUrlSchema>) {
    return this.files.createUploadUrl(ctx, body);
  }

  @Post('complete-upload')
  @RequirePermissions('files.write')
  complete(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(completeSchema)) body: { fileId: string }) {
    return this.files.completeUpload(ctx, body.fileId);
  }

  @Get(':fileId/download-url')
  @RequirePermissions('files.read')
  download(@CurrentContext() ctx: RequestContext, @Param('fileId') fileId: string) {
    return this.files.downloadUrl(ctx, fileId);
  }

  @Delete(':fileId')
  @RequirePermissions('files.delete')
  remove(@CurrentContext() ctx: RequestContext, @Param('fileId') fileId: string) {
    return this.files.remove(ctx, fileId);
  }

  @Get()
  @RequirePermissions('files.read')
  list(@CurrentContext() ctx: RequestContext, @Query(new ZodValidationPipe(paginationSchema)) q: PaginationQuery) {
    return this.files.list(ctx, q);
  }
}

@Module({ controllers: [FilesController], providers: [FilesService] })
export class FilesModule {}
