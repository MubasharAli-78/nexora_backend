import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

// shared (global) infrastructure
import { ConfigModule } from './shared/config/config.module';
import { PrismaModule } from './shared/database/prisma.module';
import { SecurityModule } from './shared/security/security.module';
import { RbacModule } from './shared/rbac/rbac.module';
import { EmailModule } from './shared/emails/email.module';
import { AuditModule } from './shared/audit/audit.module';
import { StorageModule } from './shared/storage/storage.module';
import { ConnectorsModule } from './shared/connectors/connector-registry';
import { QueueModule } from './shared/queue/queue.service';
import { AiModule } from './shared/ai/ai.module';

// feature modules
import { AuthModule } from './modules/auth/auth.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { IamModule } from './modules/iam/iam.module';
import { TeamModule } from './modules/team/team.module';
import { StoresModule } from './modules/stores/stores.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CustomersModule } from './modules/customers/customers.module';
import { OrdersModule } from './modules/orders/orders.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { PredictionsModule } from './modules/predictions/predictions.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { FilesModule } from './modules/files/files.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { FraudModule } from './modules/fraud/fraud.module';
import { EmailMarketingModule } from './modules/email-marketing/email-marketing.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { AuditReadModule } from './modules/audit/audit-read.module';
import { SegmentsModule } from './modules/segments/segments.module';

// cross-cutting
import { HealthController } from './health.controller';
import { AuthGuard } from './common/guards/auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    InvitationsModule,
    IamModule,
    TeamModule,
    StoresModule,
    CatalogModule,
    SegmentsModule,
    CustomersModule,
    OrdersModule,
    InventoryModule,
    DashboardModule,
    AnalyticsModule,
    PredictionsModule,
    RecommendationsModule,
    FilesModule,
    IntegrationsModule,
    MarketingModule,
    FraudModule,
    EmailMarketingModule,
    ReportsModule,
    SubscriptionsModule,
    AuditReadModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: throttle first (cheap, blocks abusive traffic before any DB
    // work), then authenticate, then check permissions.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
