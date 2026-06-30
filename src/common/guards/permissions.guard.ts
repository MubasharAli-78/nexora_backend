import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RequestContext } from '../context/request-context';

/** Enforces @RequirePermissions(...) against the resolved RequestContext. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(execCtx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      execCtx.getHandler(),
      execCtx.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      execCtx.getHandler(),
      execCtx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = execCtx.switchToHttp().getRequest<Request & { context?: RequestContext }>();
    const ctx = req.context;
    if (!ctx) {
      throw new ForbiddenException({ code: 'no_context', message: 'Missing security context' });
    }

    const granted = new Set(ctx.permissions);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException({
        code: 'permission_denied',
        message: `Missing required permission(s): ${missing.join(', ')}`,
      });
    }
    return true;
  }
}
