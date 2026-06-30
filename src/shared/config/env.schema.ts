import { z } from 'zod';

/** Parses env booleans correctly — z.coerce.boolean("false") is true, which we don't want. */
const zBool = (defaultValue: boolean) =>
  z.preprocess(
    (v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()) : v),
    z.boolean().default(defaultValue),
  );

/** Validated environment. The app fails fast at boot if required values are missing. */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default('api/v1'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL: z.coerce.number().default(900),
  JWT_ISSUER: z.string().default('nexora'),
  JWT_AUDIENCE: z.string().default('nexora-app'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  FIELD_ENCRYPTION_KEY: z.string().min(16, 'FIELD_ENCRYPTION_KEY is required'),
  COOKIE_DOMAIN: z.string().optional().default(''),
  COOKIE_SECURE: zBool(false),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
  SMTP_FROM_NAME: z.string().default('Nexora'),
  SMTP_USE_SSL: zBool(true),
  SMTP_USE_TLS: zBool(false),

  APP_PUBLIC_URL: z.string().default('http://localhost:3000'),
  INVITE_ACCEPT_PATH: z.string().default('/invite/accept'),
  PASSWORD_RESET_PATH: z.string().default('/reset-password'),

  REDIS_URL: z.string().optional().default(''),

  SUPABASE_S3_ENDPOINT: z.string().optional().default(''),
  SUPABASE_S3_REGION: z.string().optional().default('us-east-1'),
  SUPABASE_S3_ACCESS_KEY_ID: z.string().optional().default(''),
  SUPABASE_S3_SECRET_ACCESS_KEY: z.string().optional().default(''),
  STORAGE_BUCKET_PRIVATE: z.string().default('nexora-private'),
  STORAGE_BUCKET_PRODUCT: z.string().default('nexora-product-assets'),
  STORAGE_BUCKET_PUBLIC: z.string().default('nexora-public'),

  // AI providers — keys live ONLY server-side, never in the frontend.
  // Set AI_PROVIDER=none (default) to disable; "openai" or "gemini" to enable.
  AI_PROVIDER: z.enum(['openai', 'gemini', 'none']).default('none'),
  AI_TIMEOUT_MS: z.coerce.number().default(30_000),

  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),

  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
