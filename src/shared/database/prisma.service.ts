import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient, Prisma } from '@prisma/client';
import { RequestContext } from '../../common/context/request-context';

/** A Prisma transaction client (subset of PrismaClient available inside $transaction). */
export type TxClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Interactive transactions run against the remote Supabase pooler, so a single
    // multi-write flow (e.g. signup → tenant + RBAC provisioning, ~45 round-trips)
    // can exceed Prisma's default 5s limit. Give transactions room to complete.
    // Overridable via PRISMA_TX_TIMEOUT_MS for long batch jobs (e.g. commerce sync).
    const txTimeout = Number(process.env.PRISMA_TX_TIMEOUT_MS) || 30_000;
    super({
      transactionOptions: { timeout: txTimeout, maxWait: 10_000 },
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Connected to PostgreSQL');
    } catch (err) {
      this.logger.error(
        'Failed to connect to the database. Check DATABASE_URL / DB password in .env',
        err as Error,
      );
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `work` inside a transaction with the request-context GUCs set so native
   * RLS policies (app.current_tenant_id(), etc.) apply. Every tenant-scoped query
   * MUST go through this helper.
   */
  async withTenantContext<T>(
    ctx: Pick<RequestContext, 'tenantId' | 'userId' | 'membershipId'>,
    work: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      // Set all three RLS GUCs in a single round trip (remote pooler latency adds up).
      await tx.$executeRaw`select
        set_config('app.current_tenant_id', ${ctx.tenantId}, true),
        set_config('app.current_user_id', ${ctx.userId ?? ''}, true),
        set_config('app.current_membership_id', ${ctx.membershipId ?? ''}, true)`;
      return work(tx);
    });
  }

  /**
   * Sets only the current user id (no tenant) for cross-tenant identity reads,
   * e.g. listing a user's memberships during login/bootstrap.
   */
  async withUserContext<T>(
    userId: string,
    work: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`select set_config('app.current_user_id', ${userId}, true)`;
      return work(tx);
    });
  }
}
