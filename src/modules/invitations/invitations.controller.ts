import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { InvitationsService } from './invitations.service';
import { AuthService } from '../auth/auth.service';
import {
  createInvitationSchema,
  acceptInvitationSchema,
  previewQuerySchema,
  type CreateInvitationDto,
  type AcceptInvitationDto,
} from './invitations.schemas';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequestContext } from '../../common/context/request-context';
import { setAuthCookies } from '../../common/cookies';
import type { AppEnv } from '../../shared/config/env.schema';

@Controller()
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  @Post('team/invitations')
  @RequirePermissions('users.invite')
  create(@CurrentContext() ctx: RequestContext, @Body(new ZodValidationPipe(createInvitationSchema)) body: CreateInvitationDto) {
    return this.invitations.create(ctx, body);
  }

  @Public()
  @Get('invitations/preview')
  preview(@Query(new ZodValidationPipe(previewQuerySchema)) q: { token: string }) {
    return this.invitations.preview(q.token);
  }

  @Public()
  @Post('invitations/accept')
  async accept(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { userId, tenantId, tenantSlug } = await this.invitations.accept(body.token, body.password, body.fullName);
    const issued = await this.auth.issueSession(userId, tenantId, tenantSlug, {
      ipAddress: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
    setAuthCookies(
      res,
      {
        COOKIE_DOMAIN: this.config.get('COOKIE_DOMAIN', { infer: true }),
        COOKIE_SECURE: this.config.get('COOKIE_SECURE', { infer: true }),
        JWT_ACCESS_TTL: this.config.get('JWT_ACCESS_TTL', { infer: true }),
        REFRESH_TOKEN_TTL_DAYS: this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
      },
      issued.accessToken,
      issued.refreshToken,
    );
    return { accepted: true, tenantSlug, accessToken: issued.accessToken };
  }

  @Post('invitations/:id/resend')
  @RequirePermissions('users.invite')
  resend(@CurrentContext() ctx: RequestContext, @Param('id') id: string) {
    return this.invitations.resend(ctx, id);
  }

  @Post('invitations/:id/revoke')
  @RequirePermissions('users.invite')
  revoke(@CurrentContext() ctx: RequestContext, @Param('id') id: string) {
    return this.invitations.revoke(ctx, id);
  }
}
