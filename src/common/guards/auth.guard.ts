import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ACCESS_COOKIE } from '../cookies';
import { JwtService } from '../../shared/security/jwt.service';
import { PrismaService } from '../../shared/database/prisma.service';
import { RequestContext } from '../context/request-context';

/**
 * Verifies the access token AND re-validates the live security state on every
 * request (doc 02 §10): session active, tenant active, and JWT rbac/permission
 * versions still match the database. A stale token gets a 401 token_stale so the
 * client refreshes and picks up new permissions.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(execCtx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      execCtx.getHandler(),
      execCtx.getClass(),
    ]);
    if (isPublic) return true;

    const req = execCtx.switchToHttp().getRequest<Request>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({ code: 'no_token', message: 'Authentication required' });
    }

    const claims = this.jwt.verifyAccessToken(token);

    // 1) Session must exist, be active, and not expired (global table, no RLS).
    const session = await this.prisma.userSession.findUnique({ where: { id: claims.sid } });
    if (!session || session.status !== 'active' || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: 'session_invalid', message: 'Session is no longer valid' });
    }

    // 2) Tenant + membership must be active and RBAC versions must match.
    const { tenant, membership } = await this.prisma.withTenantContext(
      { tenantId: claims.tenant_id, userId: claims.sub, membershipId: claims.membership_id },
      async (tx) => ({
        tenant: await tx.tenant.findUnique({ where: { id: claims.tenant_id } }),
        membership: await tx.tenantMembership.findUnique({ where: { id: claims.membership_id } }),
      }),
    );

    if (!tenant || (tenant.status !== 'active' && tenant.status !== 'trialing')) {
      throw new ForbiddenException({ code: 'tenant_inactive', message: 'Tenant is not active' });
    }
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException({ code: 'membership_inactive', message: 'Membership is not active' });
    }
    if (
      tenant.rbacVersion !== claims.rbac_version ||
      membership.membershipPermissionVersion !== claims.membership_permission_version
    ) {
      throw new UnauthorizedException({
        code: 'token_stale',
        message: 'Permissions changed. Refresh required.',
      });
    }

    // 3) Optional defence-in-depth: tenant slug / role hints from the URL context.
    const headerSlug = req.header('x-tenant-slug');
    if (headerSlug && headerSlug !== claims.tenant_slug) {
      throw new ForbiddenException({ code: 'tenant_mismatch', message: 'Tenant slug mismatch' });
    }
    const headerRole = req.header('x-role-name');
    if (headerRole && !claims.roles.includes(headerRole)) {
      throw new ForbiddenException({ code: 'role_mismatch', message: 'Role not assigned to user' });
    }

    const ctx: RequestContext = {
      userId: claims.sub,
      sessionId: claims.sid,
      tenantId: claims.tenant_id,
      tenantSlug: claims.tenant_slug,
      membershipId: claims.membership_id,
      roles: claims.roles,
      primaryRole: claims.primary_role,
      permissions: claims.permissions,
      storeScope: claims.store_scope ?? [],
      rbacVersion: claims.rbac_version,
      membershipPermissionVersion: claims.membership_permission_version,
      requestId: req.header('x-request-id') ?? undefined,
      ipAddress: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    };
    (req as Request & { context: RequestContext }).context = ctx;
    return true;
  }

  private extractToken(req: Request): string | null {
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    if (cookieToken) return cookieToken;
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return null;
  }
}
