import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, randomUUID } from 'crypto';
import { PrismaService } from '../../shared/database/prisma.service';
import { JwtService } from '../../shared/security/jwt.service';
import { PasswordService } from '../../shared/security/password.service';
import { RefreshTokenService } from '../../shared/security/refresh-token.service';
import { MembershipContextService } from '../../shared/rbac/membership-context.service';
import { SmtpService } from '../../shared/emails/smtp.service';
import { provisionTenantRbac } from '../../shared/rbac/rbac-provisioning';
import { buildNavigation, buildFeatureFlags } from '../../shared/rbac/navigation';
import type { AppEnv } from '../../shared/config/env.schema';
import { RequestContext } from '../../common/context/request-context';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
const OTP_TTL_MIN = 10;
const MAX_OTP_ATTEMPTS = 5;
const MAX_RESENDS = 5;
const RESEND_COOLDOWN_SEC = 30;

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  sessionId: string;
  // Embedded bootstrap so the frontend skips a second round-trip after login.
  bootstrapPayload?: BootstrapPayload;
}

export interface BootstrapPayload {
  user: { id: string; email: string; fullName: string | null; avatarFileId: string | null } | null;
  tenant: { id: string; slug: string; name: string; status: string; planKey: string } | null;
  membership: { id: string; status: string } | null;
  roles: string[];
  primaryRole: string;
  permissions: string[];
  storeScope: string[];
  tenants: { id: string; slug: string; name: string }[];
  navigation: import('../../shared/rbac/navigation').NavItem[];
  features: Record<string, boolean>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly membershipCtx: MembershipContextService,
    private readonly smtp: SmtpService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  async login(
    email: string,
    password: string,
    meta: RequestMeta,
    tenantSlug?: string,
  ): Promise<IssuedSession> {
    const emailNormalized = email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized },
      include: { credential: true },
    });
    if (!user || user.status === 'deleted' || !user.credential) {
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Invalid email or password' });
    }
    if (user.status === 'suspended') {
      throw new UnauthorizedException({ code: 'account_suspended', message: 'Account is suspended' });
    }

    const cred = user.credential;
    if (cred.lockedUntil && cred.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException({ code: 'account_locked', message: 'Account temporarily locked. Try again later.' });
    }

    const ok = await this.passwords.verify(cred.passwordHash, password);
    if (!ok) {
      const failed = cred.failedLoginCount + 1;
      await this.prisma.userCredential.update({
        where: { id: cred.id },
        data: {
          failedLoginCount: failed,
          lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      throw new UnauthorizedException({ code: 'invalid_credentials', message: 'Invalid email or password' });
    }

    // Parallelize bookkeeping writes AND tenant lookup — all independent of each other.
    const [, tenant] = await Promise.all([
      Promise.all([
        this.prisma.userCredential.update({ where: { id: cred.id }, data: { failedLoginCount: 0, lockedUntil: null } }),
        this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
      ]),
      this.pickTenant(user.id, tenantSlug),
    ]);

    const session = await this.issueSession(user.id, tenant.id, tenant.slug, meta);

    // Build bootstrap payload using the membership context already resolved above — no extra DB call.
    session.bootstrapPayload = await this.buildBootstrapPayload(user, tenant, session._resolvedCtx);

    return session;
  }

  // -------------------------------------------------------------------------
  // Signup step 1 — start: store a pending signup + email a one-time code.
  // No user/tenant rows are created until the OTP is verified. Fully custom.
  // -------------------------------------------------------------------------
  async startSignup(
    input: { fullName: string; email: string; password: string; companyName: string; tenantSlug?: string },
  ): Promise<{ email: string; otpSent: true; expiresMinutes: number }> {
    const emailNormalized = input.email.toLowerCase().trim();

    const existing = await this.prisma.user.findUnique({ where: { emailNormalized } });
    if (existing) {
      throw new ConflictException({ code: 'email_taken', message: 'An account with this email already exists. Please sign in.' });
    }

    const otp = this.generateOtp();
    const passwordHash = await this.passwords.hash(input.password);
    const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60_000);

    await this.prisma.signupVerification.upsert({
      where: { emailNormalized },
      update: {
        email: input.email,
        fullName: input.fullName,
        companyName: input.companyName,
        tenantSlug: input.tenantSlug ?? null,
        passwordHash,
        otpHash: this.hashOtp(emailNormalized, otp),
        attempts: 0,
        resendCount: 0,
        expiresAt,
        lastSentAt: new Date(),
      },
      create: {
        emailNormalized,
        email: input.email,
        fullName: input.fullName,
        companyName: input.companyName,
        tenantSlug: input.tenantSlug ?? null,
        passwordHash,
        otpHash: this.hashOtp(emailNormalized, otp),
        expiresAt,
      },
    });

    await this.smtp.sendOtp(emailNormalized, { code: otp, fullName: input.fullName, expiresMinutes: OTP_TTL_MIN });
    this.logger.log(`Signup OTP issued for ${emailNormalized}`);
    return { email: emailNormalized, otpSent: true, expiresMinutes: OTP_TTL_MIN };
  }

  /** Resend the signup OTP (rate-limited). */
  async resendSignupOtp(email: string): Promise<{ otpSent: true }> {
    const emailNormalized = email.toLowerCase().trim();
    const pending = await this.prisma.signupVerification.findUnique({ where: { emailNormalized } });
    if (!pending) throw new BadRequestException({ code: 'no_pending_signup', message: 'No pending signup for this email. Start again.' });
    if (pending.resendCount >= MAX_RESENDS) throw new BadRequestException({ code: 'resend_limit', message: 'Too many code requests. Please start signup again.' });
    if (Date.now() - pending.lastSentAt.getTime() < RESEND_COOLDOWN_SEC * 1000) {
      throw new BadRequestException({ code: 'resend_cooldown', message: `Please wait before requesting another code.` });
    }
    const otp = this.generateOtp();
    await this.prisma.signupVerification.update({
      where: { emailNormalized },
      data: { otpHash: this.hashOtp(emailNormalized, otp), expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000), attempts: 0, resendCount: { increment: 1 }, lastSentAt: new Date() },
    });
    await this.smtp.sendOtp(emailNormalized, { code: otp, fullName: pending.fullName, expiresMinutes: OTP_TTL_MIN });
    return { otpSent: true };
  }

  // -------------------------------------------------------------------------
  // Signup step 2 — verify: check the OTP, then materialize user + tenant + owner.
  // -------------------------------------------------------------------------
  async verifySignup(email: string, otp: string, meta: RequestMeta): Promise<IssuedSession> {
    const emailNormalized = email.toLowerCase().trim();
    const pending = await this.prisma.signupVerification.findUnique({ where: { emailNormalized } });
    if (!pending) throw new BadRequestException({ code: 'no_pending_signup', message: 'No pending signup found. Please sign up again.' });

    if (pending.expiresAt.getTime() < Date.now()) {
      await this.prisma.signupVerification.delete({ where: { emailNormalized } }).catch(() => undefined);
      throw new BadRequestException({ code: 'otp_expired', message: 'The code has expired. Please request a new one.' });
    }
    if (pending.attempts >= MAX_OTP_ATTEMPTS) {
      await this.prisma.signupVerification.delete({ where: { emailNormalized } }).catch(() => undefined);
      throw new BadRequestException({ code: 'otp_attempts', message: 'Too many incorrect attempts. Please sign up again.' });
    }

    if (this.hashOtp(emailNormalized, otp.trim()) !== pending.otpHash) {
      await this.prisma.signupVerification.update({ where: { emailNormalized }, data: { attempts: { increment: 1 } } });
      throw new BadRequestException({ code: 'otp_invalid', message: 'Incorrect verification code.' });
    }

    // Guard against a race where the email got registered meanwhile.
    if (await this.prisma.user.findUnique({ where: { emailNormalized } })) {
      await this.prisma.signupVerification.delete({ where: { emailNormalized } }).catch(() => undefined);
      throw new ConflictException({ code: 'email_taken', message: 'An account with this email already exists. Please sign in.' });
    }

    const slug = await this.uniqueTenantSlug(pending.tenantSlug ?? pending.companyName);

    // OTP verified → create identity + tenant + RBAC + owner membership atomically.
    const { userId, tenantId, createdUser, createdTenant } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: pending.email, emailNormalized, fullName: pending.fullName, status: 'active', emailVerifiedAt: new Date() },
      });
      await tx.userCredential.create({ data: { userId: user.id, passwordHash: pending.passwordHash } });

      const tenant = await tx.tenant.create({
        data: { name: pending.companyName, slug, status: 'active', planKey: 'free', ownerUserId: user.id },
      });
      await tx.tenantDomain.create({
        data: { tenantId: tenant.id, domain: `${slug}.nexora.com`, domainType: 'system', isPrimary: true, verifiedAt: new Date() },
      });

      const { ownerRoleId } = await provisionTenantRbac(tx, tenant.id);
      const membership = await tx.tenantMembership.create({
        data: { tenantId: tenant.id, userId: user.id, status: 'active', joinedAt: new Date() },
      });
      await tx.roleAssignment.create({
        data: { tenantId: tenant.id, membershipId: membership.id, roleId: ownerRoleId, scopeType: 'tenant', createdByUserId: user.id },
      });

      await tx.signupVerification.delete({ where: { emailNormalized } });
      return { userId: user.id, tenantId: tenant.id, createdUser: user, createdTenant: tenant };
    });

    // Run lastLoginAt update in parallel with issueSession — they are independent.
    const [session] = await Promise.all([
      this.issueSession(userId, tenantId, slug, meta),
      this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }),
    ]);

    // Embed bootstrap payload so the frontend can skip the extra /me/bootstrap round-trip (mirrors login).
    session.bootstrapPayload = await this.buildBootstrapPayload(createdUser, createdTenant, session._resolvedCtx);
    return session;
  }

  /** Builds bootstrap payload — reuses the already-resolved membership context from issueSession. */
  private async buildBootstrapPayload(
    user: { id: string; email: string; fullName: string | null; avatarFileId: string | null },
    tenant: { id: string; slug: string; name: string; status: string; planKey: string },
    resolvedCtx: Awaited<ReturnType<MembershipContextService['resolve']>>,
  ): Promise<BootstrapPayload> {
    // These two are independent — fetch in parallel.
    const [membership, tenants] = await Promise.all([
      this.prisma.withTenantContext({ tenantId: tenant.id, userId: user.id, membershipId: resolvedCtx.membershipId }, (tx) =>
        tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } } }),
      ),
      this.prisma.withUserContext(user.id, (tx) =>
        tx.tenantMembership.findMany({ where: { userId: user.id, status: 'active' }, include: { tenant: true } }),
      ),
    ]);

    return {
      user: { id: user.id, email: user.email, fullName: user.fullName, avatarFileId: user.avatarFileId },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, planKey: tenant.planKey },
      membership: membership ? { id: membership.id, status: membership.status } : null,
      roles: resolvedCtx.roles,
      primaryRole: resolvedCtx.primaryRole,
      permissions: resolvedCtx.permissions,
      storeScope: resolvedCtx.storeScope,
      tenants: tenants.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name })),
      navigation: buildNavigation(resolvedCtx.primaryRole, resolvedCtx.permissions),
      features: buildFeatureFlags(resolvedCtx.permissions),
    };
  }

  private generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private hashOtp(emailNormalized: string, otp: string): string {
    return createHash('sha256').update(`${emailNormalized}:${otp}`).digest('hex');
  }

  /** Slugifies a name and guarantees uniqueness against existing tenants. */
  private async uniqueTenantSlug(source: string): Promise<string> {
    const base =
      source
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'tenant';
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await this.prisma.tenant.findUnique({ where: { slug: candidate } })) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

  /** Selects the tenant to log into: explicit slug, else the user's primary/first active tenant. */
  private async pickTenant(userId: string, tenantSlug?: string): Promise<{ id: string; slug: string; name: string; status: string; planKey: string }> {
    return this.prisma.withUserContext(userId, async (tx) => {
      const memberships = await tx.tenantMembership.findMany({
        where: { userId, status: 'active' },
        include: { tenant: true },
        orderBy: { createdAt: 'asc' },
      });
      const active = memberships.filter((m) => m.tenant && m.tenant.deletedAt === null);
      if (active.length === 0) {
        throw new UnauthorizedException({ code: 'no_tenant', message: 'User has no active tenant membership' });
      }
      if (tenantSlug) {
        const match = active.find((m) => m.tenant.slug === tenantSlug);
        if (!match) {
          throw new UnauthorizedException({ code: 'no_tenant_access', message: 'No access to the requested tenant' });
        }
        return { id: match.tenant.id, slug: match.tenant.slug, name: match.tenant.name, status: match.tenant.status, planKey: match.tenant.planKey };
      }
      const owned = active.find((m) => m.tenant.ownerUserId === userId) ?? active[0];
      return { id: owned.tenant.id, slug: owned.tenant.slug, name: owned.tenant.name, status: owned.tenant.status, planKey: owned.tenant.planKey };
    });
  }

  // -------------------------------------------------------------------------
  // Session + token issuance (shared by login, refresh, invitation accept)
  // -------------------------------------------------------------------------
  async issueSession(
    userId: string,
    tenantId: string,
    tenantSlug: string,
    meta: RequestMeta,
  ): Promise<IssuedSession & { _resolvedCtx: Awaited<ReturnType<MembershipContextService['resolve']>> }> {
    const sessionTtlMs = this.config.get('SESSION_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000;

    // membershipCtx.resolve and userSession.create are fully independent — run in parallel.
    const [membershipResolved, session] = await Promise.all([
      this.membershipCtx.resolve(userId, tenantId),
      this.prisma.userSession.create({
        data: {
          userId,
          currentTenantId: tenantId,
          status: 'active',
          ipAddress: meta.ipAddress ?? null,
          userAgentHash: meta.userAgent ? createHash('sha256').update(meta.userAgent).digest('hex') : null,
          expiresAt: new Date(Date.now() + sessionTtlMs),
        },
      }),
    ]);

    const refreshRaw = await this.mintRefreshToken(session.id, randomUUID());
    const accessToken = this.signAccess(userId, session.id, tenantId, tenantSlug, membershipResolved);

    return {
      accessToken,
      refreshToken: refreshRaw,
      tenantId,
      tenantSlug,
      userId,
      sessionId: session.id,
      _resolvedCtx: membershipResolved,
    };
  }

  private async mintRefreshToken(sessionId: string, familyId: string): Promise<string> {
    const raw = this.refreshTokens.generate();
    const ttlMs = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) * 24 * 60 * 60 * 1000;
    await this.prisma.refreshToken.create({
      data: {
        sessionId,
        tokenHash: this.refreshTokens.hash(raw),
        familyId,
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return raw;
  }

  private signAccess(
    userId: string,
    sessionId: string,
    tenantId: string,
    tenantSlug: string,
    membership: Awaited<ReturnType<MembershipContextService['resolve']>>,
  ): string {
    return this.jwt.signAccessToken({
      sub: userId,
      sid: sessionId,
      tenant_id: tenantId,
      tenant_slug: tenantSlug,
      membership_id: membership.membershipId,
      roles: membership.roles,
      primary_role: membership.primaryRole,
      permissions: membership.permissions,
      store_scope: membership.storeScope,
      rbac_version: membership.rbacVersion,
      membership_permission_version: membership.membershipPermissionVersion,
    });
  }

  // -------------------------------------------------------------------------
  // Refresh (rotation + reuse detection)
  // -------------------------------------------------------------------------
  async refresh(refreshTokenRaw: string, meta: RequestMeta): Promise<IssuedSession> {
    const tokenHash = this.refreshTokens.hash(refreshTokenRaw);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { session: true },
    });
    if (!existing) {
      throw new UnauthorizedException({ code: 'invalid_refresh', message: 'Invalid refresh token' });
    }

    // Reuse detection: a token that was already rotated is being replayed → kill the family.
    if (existing.revokedAt || existing.replacedByTokenId) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.userSession.update({
        where: { id: existing.sessionId },
        data: { status: 'revoked', revokedAt: new Date() },
      });
      throw new UnauthorizedException({ code: 'refresh_reuse', message: 'Refresh token reuse detected' });
    }
    if (existing.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: 'refresh_expired', message: 'Refresh token expired' });
    }

    const session = existing.session;
    if (!session || session.status !== 'active' || session.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: 'session_invalid', message: 'Session is no longer valid' });
    }
    if (!session.currentTenantId) {
      throw new UnauthorizedException({ code: 'no_tenant', message: 'Session has no active tenant' });
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: session.currentTenantId } });
    if (!tenant) {
      throw new UnauthorizedException({ code: 'tenant_not_found', message: 'Tenant not found' });
    }

    // Rotate: new token in the same family, mark the old one replaced.
    const newRaw = await this.mintRefreshToken(session.id, existing.familyId);
    const newRow = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.refreshTokens.hash(newRaw) },
    });
    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenId: newRow?.id },
    });
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date(), ipAddress: meta.ipAddress ?? session.ipAddress },
    });

    const membership = await this.membershipCtx.resolve(session.userId, tenant.id);
    const accessToken = this.signAccess(session.userId, session.id, tenant.id, tenant.slug, membership);

    return {
      accessToken,
      refreshToken: newRaw,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      userId: session.userId,
      sessionId: session.id,
    };
  }

  // -------------------------------------------------------------------------
  // Logout + sessions
  // -------------------------------------------------------------------------
  async logout(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    await this.prisma.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listSessions(userId: string, currentSessionId: string) {
    const sessions = await this.prisma.userSession.findMany({
      where: { userId, status: 'active' },
      orderBy: { lastSeenAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      current: s.id === currentSessionId,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    await this.prisma.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Bootstrap (drives the frontend UI)
  // -------------------------------------------------------------------------
  async bootstrap(ctx: RequestContext) {
    const [user, tenant, membership] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ctx.userId } }),
      this.prisma.tenant.findUnique({ where: { id: ctx.tenantId } }),
      this.prisma.withTenantContext(ctx, (tx) =>
        tx.tenantMembership.findUnique({ where: { id: ctx.membershipId } }),
      ),
    ]);

    const tenants = await this.prisma.withUserContext(ctx.userId, (tx) =>
      tx.tenantMembership.findMany({
        where: { userId: ctx.userId, status: 'active' },
        include: { tenant: true },
      }),
    );

    return {
      user: user ? { id: user.id, email: user.email, fullName: user.fullName, avatarFileId: user.avatarFileId } : null,
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, planKey: tenant.planKey } : null,
      membership: membership ? { id: membership.id, status: membership.status } : null,
      roles: ctx.roles,
      primaryRole: ctx.primaryRole,
      permissions: ctx.permissions,
      storeScope: ctx.storeScope,
      tenants: tenants.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name })),
      navigation: buildNavigation(ctx.primaryRole, ctx.permissions),
      features: buildFeatureFlags(ctx.permissions),
    };
  }
}
