interface OtpParams {
  code: string;
  fullName?: string;
  expiresMinutes: number;
}

export function otpEmail(p: OtpParams): { subject: string; html: string } {
  const subject = `${p.code} is your Nexora verification code`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 8px">Verify your email</h2>
    <p style="color:#475569">${p.fullName ? `Hi ${escapeHtml(p.fullName)}, ` : ''}use this code to finish creating your Nexora account.</p>
    <div style="margin:24px 0;text-align:center">
      <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:10px;background:#eef2ff;color:#4f46e5;padding:16px 24px;border-radius:12px">
        ${p.code}
      </span>
    </div>
    <p style="color:#64748b;font-size:13px">This code expires in ${p.expiresMinutes} minutes. If you didn't request it, you can ignore this email.</p>
  </div>`;
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
