import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import type { AppEnv } from './shared/config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService) as ConfigService<AppEnv, true>;
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix(config.get('API_PREFIX', { infer: true }));
  app.use(helmet());
  app.use(cookieParser());

  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : true, credentials: true });

  // Validation is handled per-route via Zod (ZodValidationPipe), no class-validator needed.
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Nexora API')
      .setDescription('Nexora multi-tenant SaaS backend')
      .setVersion('1.0')
      .addCookieAuth('nexora_access')
      .build();
    const doc = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, doc);
  }

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`Nexora API listening on http://localhost:${port}/${config.get('API_PREFIX', { infer: true })}`);
}

bootstrap();
