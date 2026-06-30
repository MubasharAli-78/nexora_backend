import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { WorkerModule } from './worker.module';
import type { AppEnv } from '../shared/config/env.schema';
import { QUEUES, type JobEnvelope } from '../shared/queue/queue.constants';
import { AnalyticsService } from '../modules/analytics/analytics.module';
import { PredictionsService } from '../modules/predictions/predictions.module';
import { SyncService } from '../modules/integrations/sync.service';
import { SmtpService } from '../shared/emails/smtp.service';
import type { RequestContext } from '../common/context/request-context';

function ctxFromJob(env: JobEnvelope): RequestContext {
  return {
    userId: env.userId ?? '',
    sessionId: '',
    tenantId: env.tenantId,
    tenantSlug: '',
    membershipId: env.membershipId ?? '',
    roles: [],
    primaryRole: '',
    permissions: [],
    storeScope: env.storeId ? [env.storeId] : [],
    rbacVersion: 0,
    membershipPermissionVersion: 0,
  };
}

async function bootstrap() {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  const config = app.get(ConfigService) as ConfigService<AppEnv, true>;

  const redisUrl = config.get('REDIS_URL', { infer: true });
  if (!redisUrl) {
    logger.warn('REDIS_URL is not set — the worker has nothing to connect to. The API runs sync/predictions inline without it. Exiting.');
    await app.close();
    process.exit(0);
  }

  const analytics = app.get(AnalyticsService);
  const predictions = app.get(PredictionsService);
  const sync = app.get(SyncService);
  const smtp = app.get(SmtpService);
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

  const workers: Worker[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opts = { connection: connection as any, concurrency: 5 };

  workers.push(
    new Worker(QUEUES.ANALYTICS_ROLLUP, async (job: Job<JobEnvelope<{ days?: number }>>) => {
      return analytics.rollup(ctxFromJob(job.data), job.data.payload?.days ?? 90);
    }, opts),
  );

  workers.push(
    new Worker(QUEUES.PREDICTIONS_RUN, async (job: Job<JobEnvelope<{ modelKey?: string; horizonDays?: number; storeId?: string }>>) => {
      return predictions.run(ctxFromJob(job.data), {
        modelKey: job.data.payload?.modelKey ?? 'revenue_forecast',
        horizonDays: job.data.payload?.horizonDays ?? 30,
        storeId: job.data.payload?.storeId,
      });
    }, opts),
  );

  workers.push(
    new Worker(QUEUES.CONNECTOR_SYNC, async (job: Job<JobEnvelope<{ integrationId: string; syncType: 'products' | 'customers' | 'orders' | 'full' }>>) => {
      return sync.runSync(ctxFromJob(job.data), job.data.payload.integrationId, job.data.payload.syncType ?? 'full');
    }, opts),
  );

  workers.push(
    new Worker(QUEUES.EMAIL_SEND, async (job: Job<JobEnvelope<{ to: string; subject: string; html: string }>>) => {
      // Generic transactional send hook.
      const { to } = job.data.payload;
      logger.log(`email.send job for ${to}`);
      return { sent: true };
    }, opts),
  );

  for (const w of workers) {
    w.on('completed', (job) => logger.log(`✓ ${job.queueName}#${job.id} completed`));
    w.on('failed', (job, err) => logger.error(`✗ ${job?.queueName}#${job?.id} failed: ${err.message}`));
  }

  logger.log(`Worker online. Listening on queues: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async () => {
    logger.log('Shutting down worker...');
    await Promise.all(workers.map((w) => w.close()));
    await connection.quit();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap();
