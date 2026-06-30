import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { AppEnv } from '../config/env.schema';
import { invitationEmail } from './templates/invitation-email';
import { passwordResetEmail } from './templates/password-reset-email';
import { otpEmail } from './templates/otp-email';

@Injectable()
export class SmtpService {
  private readonly logger = new Logger(SmtpService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  private getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter;
    const host = this.config.get('SMTP_HOST', { infer: true });
    const port = this.config.get('SMTP_PORT', { infer: true });
    const user = this.config.get('SMTP_USERNAME', { infer: true });
    const pass = this.config.get('SMTP_PASSWORD', { infer: true });
    if (!host || !port || !user || !pass) {
      this.logger.warn('SMTP not fully configured; emails will be logged instead of sent.');
      return null;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: this.config.get('SMTP_USE_SSL', { infer: true }),
      auth: { user, pass },
    });
    return this.transporter;
  }

  private from(): string {
    const name = this.config.get('SMTP_FROM_NAME', { infer: true });
    const email = this.config.get('SMTP_FROM_EMAIL', { infer: true }) ?? 'no-reply@nexora.local';
    return `"${name}" <${email}>`;
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const transporter = this.getTransporter();
    if (!transporter) {
      this.logger.log(`[email:dev] to=${to} subject="${subject}"`);
      return;
    }
    await transporter.sendMail({ from: this.from(), to, subject, html });
    this.logger.log(`Email sent to ${to}: ${subject}`);
  }

  async sendInvitation(to: string, params: { tenantName: string; roleName: string; inviterName?: string; acceptUrl: string }) {
    const { subject, html } = invitationEmail(params);
    await this.send(to, subject, html);
  }

  async sendPasswordReset(to: string, params: { resetUrl: string; tenantName?: string }) {
    const { subject, html } = passwordResetEmail(params);
    await this.send(to, subject, html);
  }

  async sendOtp(to: string, params: { code: string; fullName?: string; expiresMinutes: number }) {
    const { subject, html } = otpEmail(params);
    await this.send(to, subject, html);
  }
}
