import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { AppEnv } from '../config/env.schema';
import { QUEUES, type JobEnvelope, type QueueName } from './queue.constants';

/**
 * Thin enqueue layer over BullMQ. When REDIS_URL is unset the queue is disabled
 * and `enqueue` returns false — callers then run the work inline (dev-friendly).
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: Redis | null = null;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  get enabled(): boolean {
    return Boolean(this.config.get('REDIS_URL', { infer: true }));
  }

  private getQueue(name: QueueName): Queue | null {
    if (!this.enabled) return null;
    if (!this.connection) {
      this.connection = new IORedis(this.config.get('REDIS_URL', { infer: true }), { maxRetriesPerRequest: null });
    }
    let q = this.queues.get(name);
    if (!q) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q = new Queue(name, { connection: this.connection as any });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<T extends Record<string, unknown>>(name: QueueName, data: JobEnvelope<T>): Promise<boolean> {
    const q = this.getQueue(name);
    if (!q) return false;
    await q.add(name, data, { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    this.logger.log(`Enqueued ${name} for tenant ${data.tenantId}`);
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    for (const q of this.queues.values()) await q.close();
    await this.connection?.quit();
  }
}

export { QUEUES };

@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
