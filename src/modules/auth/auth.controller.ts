import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import {
  loginSchema,
  signupSchema,
  verifySignupSchema,
  resendSignupSchema,
  type LoginDto,
  type SignupDto,
  type VerifySignupDto,
  type ResendSignupDto,
} from './auth.schemas';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentContext } from '../../common/decorators/current-context.decorator';
import { RequestContext } from '../../common/context/request-context';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '../../common/cookies';
import type { AppEnv } from '../../shared/config/env.schema';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private meta(req: Request) {
    return { ipAddress: req.ip, userAgent: req.header('user-agent') ?? undefined };
  }

  private cookieEnv() {
    return {
      COOKIE_DOMAIN: this.config.get('COOKIE_DOMAIN', { infer: true }),
      COOKIE_SECURE: this.config.get('COOKIE_SECURE', { infer: true }),
      JWT_ACCESS_TTL: this.config.get('JWT_ACCESS_TTL', { infer: true }),
      REFRESH_TOKEN_TTL_DAYS: this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }),
    };
  }

  @Public()
  @Post('auth/login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.auth.login(body.email, body.password, this.meta(req), body.tenantSlug);
    setAuthCookies(res, this.cookieEnv(), issued.accessToken, issued.refreshToken);
    return { tenantSlug: issued.tenantSlug, accessToken: issued.accessToken, bootstrap: issued.bootstrapPayload ?? null };
  }

  // Step 1: start signup — emails a 6-digit OTP, creates no account yet.
  @Public()
  @Post('auth/signup')
  signup(@Body(new ZodValidationPipe(signupSchema)) body: SignupDto) {
    return this.auth.startSignup(body);
  }

  // Step 2: verify OTP — on success creates the account and logs the user in.
  @Public()
  @Post('auth/signup/verify')
  async verifySignup(
    @Body(new ZodValidationPipe(verifySignupSchema)) body: VerifySignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const issued = await this.auth.verifySignup(body.email, body.otp, this.meta(req));
    setAuthCookies(res, this.cookieEnv(), issued.accessToken, issued.refreshToken);
    return { verified: true, tenantSlug: issued.tenantSlug, accessToken: issued.accessToken, bootstrap: issued.bootstrapPayload ?? null };
  }

  @Public()
  @Post('auth/signup/resend')
  resendSignup(@Body(new ZodValidationPipe(resendSignupSchema)) body: ResendSignupDto) {
    return this.auth.resendSignupOtp(body.email);
  }

  @Public()
  @Post('auth/refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw =
      (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ??
      (req.body as { refreshToken?: string })?.refreshToken;
    if (!raw) {
      clearAuthCookies(res, this.cookieEnv());
      return { refreshed: false };
    }
    const issued = await this.auth.refresh(raw, this.meta(req));
    setAuthCookies(res, this.cookieEnv(), issued.accessToken, issued.refreshToken);
    return { refreshed: true, accessToken: issued.accessToken, tenantSlug: issued.tenantSlug };
  }

  @Post('auth/logout')
  async logout(@CurrentContext() ctx: RequestContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx.sessionId);
    clearAuthCookies(res, this.cookieEnv());
    return { loggedOut: true };
  }

  @Get('me/bootstrap')
  bootstrap(@CurrentContext() ctx: RequestContext) {
    return this.auth.bootstrap(ctx);
  }

  @Get('me/sessions')
  sessions(@CurrentContext() ctx: RequestContext) {
    return this.auth.listSessions(ctx.userId, ctx.sessionId);
  }

  @Delete('me/sessions/:sessionId')
  async revokeSession(@CurrentContext() ctx: RequestContext, @Param('sessionId') sessionId: string) {
    await this.auth.revokeSession(ctx.userId, sessionId);
    return { revoked: true };
  }
}
