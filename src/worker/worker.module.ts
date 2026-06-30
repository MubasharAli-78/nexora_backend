import { Module } from '@nestjs/common';
import { ConfigModule } from '../shared/config/config.module';
import { PrismaModule } from '../shared/database/prisma.module';
import { SecurityModule } from '../shared/security/security.module';
import { RbacModule } from '../shared/rbac/rbac.module';
import { EmailModule } from '../shared/emails/email.module';
import { AuditModule } from '../shared/audit/audit.module';
import { StorageModule } from '../shared/storage/storage.module';
import { ConnectorsModule } from '../shared/connectors/connector-registry';
import { QueueModule } from '../shared/queue/queue.service';
import { AiModule } from '../shared/ai/ai.module';
import { AnalyticsModule } from '../modules/analytics/analytics.module';
import { PredictionsModule } from '../modules/predictions/predictions.module';
import { RecommendationsModule } from '../modules/recommendations/recommendations.module';
import { IntegrationsModule } from '../modules/integrations/integrations.module';

/** Module graph for the background worker process (no HTTP controllers). */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SecurityModule,
    RbacModule,
    EmailModule,
    AuditModule,
    StorageModule,
    ConnectorsModule,
    QueueModule,
    AiModule,
    AnalyticsModule,
    PredictionsModule,
    RecommendationsModule,
    IntegrationsModule,
  ],
})
export class WorkerModule {}
