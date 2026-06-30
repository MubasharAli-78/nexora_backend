import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import express, { type Express } from 'express';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import type { AppEnv } from '../src/shared/config/env.schema';

let cachedApp: Express | null = null;

async function bootstrap(): Promise<Express> {
  const server = express();
  const nestApp = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ['error', 'warn'],
  });
  const config = nestApp.get(ConfigService) as ConfigService<AppEnv, true>;

  nestApp.setGlobalPrefix(config.get('API_PREFIX', { infer: true }));
  nestApp.use(helmet());
  nestApp.use(cookieParser());

  const origins = config
    .get('CORS_ORIGINS', { infer: true })
    .split(',')
    .map((o: string) => o.trim())
    .filter(Boolean);
  nestApp.enableCors({ origin: origins.length ? origins : true, credentials: true });

  await nestApp.init();
  return server;
}

export default async function handler(req: express.Request, res: express.Response) {
  if (!cachedApp) cachedApp = await bootstrap();
  cachedApp(req, res);
}
