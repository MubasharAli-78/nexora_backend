import type { Response } from 'express';
import type { AppEnv } from '../shared/config/env.schema';

export const ACCESS_COOKIE = 'nexora_access';
export const REFRESH_COOKIE = 'nexora_refresh';

interface CookieEnv {
  COOKIE_DOMAIN?: string;
  COOKIE_SECURE?: boolean;
}

function baseOptions(env: CookieEnv) {
  return {
    httpOnly: true,
    secure: Boolean(env.COOKIE_SECURE),
    sameSite: 'lax' as const,
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  };
}

export function setAuthCookies(
  res: Response,
  env: Pick<AppEnv, 'COOKIE_DOMAIN' | 'COOKIE_SECURE' | 'JWT_ACCESS_TTL' | 'REFRESH_TOKEN_TTL_DAYS'>,
  accessToken: string,
  refreshToken: string,
): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(env),
    maxAge: env.JWT_ACCESS_TTL * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(env),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response, env: CookieEnv): void {
  res.clearCookie(ACCESS_COOKIE, baseOptions(env));
  res.clearCookie(REFRESH_COOKIE, baseOptions(env));
}
