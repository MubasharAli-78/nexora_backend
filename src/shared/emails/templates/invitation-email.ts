interface InvitationParams {
  tenantName: string;
  roleName: string;
  inviterName?: string;
  acceptUrl: string;
}

export function invitationEmail(p: InvitationParams): { subject: string; html: string } {
  const subject = `You're invited to ${p.tenantName} on Nexora`;
  const html = `
  <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#0f172a">
    <h2 style="margin:0 0 12px">Join ${escapeHtml(p.tenantName)} on Nexora</h2>
    <p>${p.inviterName ? `${escapeHtml(p.inviterName)} has invited you` : 'You have been invited'} to join
       <strong>${escapeHtml(p.tenantName)}</strong> as <strong>${escapeHtml(p.roleName)}</strong>.</p>
    <p>Click below to set your password and accept the invitation.</p>
    <p style="margin:24px 0">
      <a href="${p.acceptUrl}" style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">
        Accept invitation
      </a>
    </p>
    <p style="color:#64748b;font-size:13px">If the button doesn't work, paste this link into your browser:<br>${p.acceptUrl}</p>
    <p style="color:#94a3b8;font-size:12px">This invitation expires in 7 days and can only be used once.</p>
  </div>`;
  return { subject, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
