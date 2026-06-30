import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppEnv } from '../config/env.schema';

/** Thin wrapper over Supabase Storage's S3-compatible endpoint. */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  get enabled(): boolean {
    return Boolean(
      this.config.get('SUPABASE_S3_ENDPOINT', { infer: true }) &&
        this.config.get('SUPABASE_S3_ACCESS_KEY_ID', { infer: true }) &&
        this.config.get('SUPABASE_S3_SECRET_ACCESS_KEY', { infer: true }),
    );
  }

  private getClient(): S3Client {
    if (!this.enabled) {
      throw new ServiceUnavailableException({ code: 'storage_unconfigured', message: 'Storage (Supabase S3) is not configured' });
    }
    if (!this.client) {
      this.client = new S3Client({
        forcePathStyle: true,
        region: this.config.get('SUPABASE_S3_REGION', { infer: true }),
        endpoint: this.config.get('SUPABASE_S3_ENDPOINT', { infer: true }),
        credentials: {
          accessKeyId: this.config.get('SUPABASE_S3_ACCESS_KEY_ID', { infer: true }),
          secretAccessKey: this.config.get('SUPABASE_S3_SECRET_ACCESS_KEY', { infer: true }),
        },
      });
    }
    return this.client;
  }

  presignUpload(bucket: string, key: string, contentType?: string, expiresIn = 300): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.getClient(), cmd, { expiresIn });
  }

  presignDownload(bucket: string, key: string, expiresIn = 300): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.getClient(), cmd, { expiresIn });
  }

  async head(bucket: string, key: string): Promise<{ exists: boolean; size?: number; contentType?: string }> {
    try {
      const r = await this.getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { exists: true, size: r.ContentLength, contentType: r.ContentType };
    } catch {
      return { exists: false };
    }
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
}
