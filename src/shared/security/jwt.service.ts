import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { AppEnv } from '../config/env.schema';

/** Claims embedded in the short-lived access token. */
export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // session id
  tenant_id: string;
  tenant_slug: string;
  membership_id: string;
  roles: string[];
  primary_role: string;
  permissions: string[];
  store_scope: string[];
  rbac_version: number;
  membership_permission_version: number;
}

@Injectable()
export class JwtService {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  signAccessToken(claims: AccessTokenClaims): string {
    const secret: jwt.Secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    const options: jwt.SignOptions = {
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      issuer: this.config.get('JWT_ISSUER', { infer: true }),
      audience: this.config.get('JWT_AUDIENCE', { infer: true }),
    };
    return jwt.sign(claims, secret, options);
  }

  verifyAccessToken(token: string): AccessTokenClaims & jwt.JwtPayload {
    const secret: jwt.Secret = this.config.get('JWT_ACCESS_SECRET', { infer: true });
    try {
      return jwt.verify(token, secret, {
        issuer: this.config.get('JWT_ISSUER', { infer: true }),
        audience: this.config.get('JWT_AUDIENCE', { infer: true }),
      }) as AccessTokenClaims & jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException({ code: 'invalid_token', message: 'Invalid or expired token' });
    }
  }
}
