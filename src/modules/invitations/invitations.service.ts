import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../shared/database/prisma.service';
import { PasswordService } from '../../shared/security/password.service';
import { SmtpService } from '../../shared/emails/smtp.service';
import { AuditService } from '../../shared/audit/audit.service';
import { RequestContext } from '../../common/context/request-context';
import type { AppEnv } from '../../shared/config/env.schema';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly smtp: SmtpService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async create(ctx: RequestContext, input: { email: string; roleId?: string; roleKey?: string }) {
    const emailNormalized = input.email.toLowerCase().trim();

    return this.prisma.withTenantContext(ctx, async (tx) => {
      // Resolve target role within the tenant.
      const role = input.roleId
        ? await tx.role.findFirst({ where: { id: input.roleId, tenantId: ctx.tenantId } })
        : await tx.role.findFirst({ where: { tenantId: ctx.tenantId, key: input.roleKey ?? 'light_user' } });
      if (!role) throw new NotFoundException({ code: 'role_not_found', message: 'Role not found in tenant' });

      // Block duplicate active membership.
      const existingUser = await tx.user.findUnique({ where: { emailNormalized } });
      if (existingUser) {
        const existingMember = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId: existingUser.id } },
        });
        if (existingMember && existingMember.status === 'active') {
          throw new BadRequestException({ code: 'already_member', message: 'User is already a member of this tenant' });
        }
      }

      // Revoke any prior pending invite for the same email.
      await tx.tenantInvitation.updateMany({
        where: { tenantId: ctx.tenantId, emailNormalized, status: 'pending' },
        data: { status: 'revoked' },
      });

      const rawToken = randomBytes(32).toString('base64url');
      const invitation = await tx.tenantInvitation.create({
        data: {
          tenantId: ctx.tenantId,
          emailNormalized,
          invitedByUserId: ctx.userId,
          assignedRoleId: role.id,
          status: 'pending',
          tokenHash: this.hashToken(rawToken),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });

      const tenant = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      const inviter = await tx.user.findUnique({ where: { id: ctx.userId } });
      const acceptUrl = `${this.config.get('APP_PUBLIC_URL', { infer: true })}${this.config.get('INVITE_ACCEPT_PATH', { infer: true })}?token=${rawToken}`;

      await this.smtp.sendInvitation(emailNormalized, {
        tenantName: tenant?.name ?? 'Nexora',
        roleName: role.name,
        inviterName: inviter?.fullName ?? undefined,
        acceptUrl,
      });

      await this.audit.record({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'users.invite',
        resourceType: 'invitation',
        resourceId: invitation.id,
        after: { email: emailNormalized, roleId: role.id },
        ipAddress: ctx.ipAddress,
        requestId: ctx.requestId,
      });

      return { id: invitation.id, email: emailNormalized, roleName: role.name, status: 'pending', expiresAt: invitation.expiresAt };
    });
  }

  /** Public: show invite details on the acceptance page. */
  async preview(rawToken: string) {
    const tokenHash = this.hashToken(rawToken);
    const invitation = await this.prisma.tenantInvitation.findFirst({ where: { tokenHash } });
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt.getTime() < Date.now()) {
      throw new NotFoundException({ code: 'invitation_invalid', message: 'Invitation is invalid or expired' });
    }
    const [tenant, role] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: invitation.tenantId } }),
      this.prisma.role.findUnique({ where: { id: invitation.assignedRoleId } }),
    ]);
    return {
      email: invitation.emailNormalized,
      tenantName: tenant?.name ?? '',
      tenantSlug: tenant?.slug ?? '',
      roleName: role?.name ?? '',
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Public: accept invitation. Creates the user (if new) + active membership +
   * role assignment, marks the invite accepted. Returns the ids needed to mint a
   * session (the controller issues cookies via AuthService).
   */
  async accept(rawToken: string, password: string, fullName?: string) {
    const tokenHash = this.hashToken(rawToken);

    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.tenantInvitation.findFirst({ where: { tokenHash } });
      if (!invitation || invitation.status !== 'pending' || invitation.expiresAt.getTime() < Date.now()) {
        throw new NotFoundException({ code: 'invitation_invalid', message: 'Invitation is invalid or expired' });
      }

      const email = invitation.emailNormalized;
      let user = await tx.user.findUnique({ where: { emailNormalized: email }, include: { credential: true } });

      if (!user) {
        user = await tx.user.create({
          data: { email, emailNormalized: email, fullName: fullName ?? null, status: 'active', emailVerifiedAt: new Date() },
          include: { credential: true },
        });
      }
      // Set/refresh password credential.
      const passwordHash = await this.passwords.hash(password);
      if (user.credential) {
        await tx.userCredential.update({ where: { userId: user.id }, data: { passwordHash, passwordUpdatedAt: new Date() } });
      } else {
        await tx.userCredential.create({ data: { userId: user.id, passwordHash } });
      }
      if (fullName && !user.fullName) {
        await tx.user.update({ where: { id: user.id }, data: { fullName } });
      }

      // Membership (active) — upsert by (tenant,user).
      const membership = await tx.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: user.id } },
        update: { status: 'active', joinedAt: new Date(), invitedByUserId: invitation.invitedByUserId },
        create: {
          tenantId: invitation.tenantId,
          userId: user.id,
          status: 'active',
          joinedAt: new Date(),
          invitedByUserId: invitation.invitedByUserId,
        },
      });

      // Role assignment (tenant scope).
      const existingAssignment = await tx.roleAssignment.findFirst({
        where: { tenantId: invitation.tenantId, membershipId: membership.id, roleId: invitation.assignedRoleId },
      });
      if (!existingAssignment) {
        await tx.roleAssignment.create({
          data: {
            tenantId: invitation.tenantId,
            membershipId: membership.id,
            roleId: invitation.assignedRoleId,
            scopeType: 'tenant',
            createdByUserId: invitation.invitedByUserId,
          },
        });
      }

      await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: { status: 'accepted', acceptedAt: new Date() },
      });

      const tenant = await tx.tenant.findUnique({ where: { id: invitation.tenantId } });

      return { userId: user.id, tenantId: invitation.tenantId, tenantSlug: tenant?.slug ?? '' };
    });
  }

  async resend(ctx: RequestContext, invitationId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const invitation = await tx.tenantInvitation.findFirst({ where: { id: invitationId, tenantId: ctx.tenantId } });
      if (!invitation || invitation.status !== 'pending') {
        throw new NotFoundException({ code: 'invitation_invalid', message: 'No pending invitation to resend' });
      }
      const rawToken = randomBytes(32).toString('base64url');
      await tx.tenantInvitation.update({
        where: { id: invitation.id },
        data: { tokenHash: this.hashToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      });
      const [tenant, role] = await Promise.all([
        tx.tenant.findUnique({ where: { id: ctx.tenantId } }),
        tx.role.findUnique({ where: { id: invitation.assignedRoleId } }),
      ]);
      const acceptUrl = `${this.config.get('APP_PUBLIC_URL', { infer: true })}${this.config.get('INVITE_ACCEPT_PATH', { infer: true })}?token=${rawToken}`;
      await this.smtp.sendInvitation(invitation.emailNormalized, {
        tenantName: tenant?.name ?? 'Nexora',
        roleName: role?.name ?? '',
        acceptUrl,
      });
      return { id: invitation.id, status: 'pending', resent: true };
    });
  }

  async revoke(ctx: RequestContext, invitationId: string) {
    return this.prisma.withTenantContext(ctx, async (tx) => {
      const result = await tx.tenantInvitation.updateMany({
        where: { id: invitationId, tenantId: ctx.tenantId, status: 'pending' },
        data: { status: 'revoked' },
      });
      if (result.count === 0) throw new NotFoundException({ code: 'invitation_invalid', message: 'No pending invitation to revoke' });
      await this.audit.record({ tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'users.invite_revoked', resourceType: 'invitation', resourceId: invitationId });
      return { id: invitationId, status: 'revoked' };
    });
  }
}
