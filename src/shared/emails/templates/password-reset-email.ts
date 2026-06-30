interface ResetParams {
  resetUrl: string;
  tenantName?: string;
}

export function passwordResetEmail(p: ResetParams): { subject: string; html: string } {
  const subject = 'Reset your Nexora password';
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 12px">Reset your password</h2>
    <p>We received a request to reset your Nexora password${p.tenantName ? ` for ${p.tenantName}` : ''}.</p>
    <p style="margin:24px 0">
      <a href="${p.resetUrl}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">
        Reset password
      </a>
    </p>
    <p style="color:#94a3b8;font-size:12px">If you didn't request this, you can safely ignore this email.</p>
  </div>`;
  return { subject, html };
}
