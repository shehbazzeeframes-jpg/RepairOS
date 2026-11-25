/**
 * Email templates: plain, "branded-lite" HTML (inline styles, one button, no images) plus a text alternative.
 * Every interpolated value is HTML-escaped.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = '#1f4fd1';

const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const WWW_HOST = /\bwww\.\S*/gi;
/** Bare host names such as `secure-login.com/reset` (common TLDs only, so "Fix.It Repairs" survives). */
const BARE_HOST =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|app|dev|link|xyz|top|site|online|shop|store|me|ly|ru|cn|uk|us|pk|in)\b\S*/gi;

/**
 * L4: user-controlled names (shop, inviter) in a subject line or preheader. Mail clients linkify URLs in subjects,
 * so a shop called "Verify at evil.com" would turn our email into a phishing link: strip URLs, host names and
 * angle brackets, collapse whitespace and cap the length. Falls back to `fallback` if nothing is left.
 */
export function subjectSafe(value: string, fallback: string, max = 80): string {
  const cleaned = value
    .replace(SCHEME_URL, ' ')
    .replace(WWW_HOST, ' ')
    .replace(BARE_HOST, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || fallback;
}

function layout(opts: { preheader: string; bodyHtml: string; button: { label: string; url: string }; footerHtml: string }): string {
  const url = escapeHtml(opts.button.url);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RepairOS</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d2433;">
<span style="display:none;max-height:0;overflow:hidden;">${escapeHtml(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;border:1px solid #e3e6eb;">
<tr><td style="padding:24px 32px 8px 32px;font-size:18px;font-weight:700;color:${BRAND};">RepairOS</td></tr>
<tr><td style="padding:8px 32px 0 32px;font-size:15px;line-height:1.5;">${opts.bodyHtml}</td></tr>
<tr><td style="padding:24px 32px;">
<a href="${url}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:6px;">${escapeHtml(opts.button.label)}</a>
</td></tr>
<tr><td style="padding:0 32px 8px 32px;font-size:13px;line-height:1.5;color:#5b6475;">Or copy this link into your browser:<br><a href="${url}" style="color:${BRAND};word-break:break-all;">${url}</a></td></tr>
<tr><td style="padding:16px 32px 24px 32px;font-size:13px;line-height:1.5;color:#5b6475;">${opts.footerHtml}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export interface InviteEmailInput {
  inviterName: string;
  inviterEmail: string;
  shopName: string;
  /** "Front desk" */
  roleLabel: string;
  /** One line, e.g. "Checks in devices, takes payments and talks to customers." */
  roleDescription: string;
  /** `${APP_URL}/invite/<token>` */
  url: string;
  /** Expiry already formatted in the shop's timezone and locale. */
  expiresText: string;
}

/**
 * Story §8 E1. Subject: "{Inviter name} invited you to join {Shop name} on RepairOS" (names made subject-safe, L4).
 * No Reply-To: the inviter's address is not verified, so replies go nowhere rather than to an unverified address.
 */
export function inviteEmail(i: InviteEmailInput): RenderedEmail {
  const subjectInviter = subjectSafe(i.inviterName, 'Someone');
  const subjectShop = subjectSafe(i.shopName, 'a shop');
  const subject = `${subjectInviter} invited you to join ${subjectShop} on RepairOS`;
  const e = escapeHtml;
  const bodyHtml = [
    `<p style="margin:0 0 12px 0;">Hello,</p>`,
    `<p style="margin:0 0 12px 0;">${e(i.inviterName)} (${e(i.inviterEmail)}) has invited you to join <strong>${e(i.shopName)}</strong> as <strong>${e(i.roleLabel)}</strong>.</p>`,
    `<p style="margin:0;color:#5b6475;">${e(i.roleLabel)}: ${e(i.roleDescription)}</p>`,
  ].join('\n');
  const footerHtml = `This invite expires on ${e(i.expiresText)}.<br>If you weren't expecting this, you can ignore this email.`;
  const html = layout({
    preheader: `Join ${subjectShop} on RepairOS`,
    bodyHtml,
    button: { label: 'Accept invite', url: i.url },
    footerHtml,
  });
  const text = [
    'Hello,',
    '',
    `${i.inviterName} (${i.inviterEmail}) has invited you to join ${i.shopName} as ${i.roleLabel}.`,
    `${i.roleLabel}: ${i.roleDescription}`,
    '',
    'Accept invite:',
    i.url,
    '',
    `This invite expires on ${i.expiresText}.`,
    "If you weren't expecting this, you can ignore this email.",
    '',
    '— RepairOS',
  ].join('\n');
  return { subject, html, text };
}

export interface PasswordResetEmailInput {
  name: string;
  /** Better Auth callback URL; redirects to `${APP_URL}/reset-password?token=…` */
  url: string;
  /** e.g. "1 hour" */
  expiresIn: string;
}

export function passwordResetEmail(i: PasswordResetEmailInput): RenderedEmail {
  const subject = 'Reset your RepairOS password';
  const e = escapeHtml;
  const bodyHtml = [
    `<p style="margin:0 0 12px 0;">Hello ${e(i.name)},</p>`,
    `<p style="margin:0;">We received a request to reset the password for your RepairOS account. Choose a new password with the button below.</p>`,
  ].join('\n');
  const footerHtml = `This link expires in ${e(i.expiresIn)} and can be used once.<br>If you didn't ask to reset your password, you can ignore this email; your password won't change.`;
  const html = layout({
    preheader: 'Reset your RepairOS password',
    bodyHtml,
    button: { label: 'Reset password', url: i.url },
    footerHtml,
  });
  const text = [
    `Hello ${i.name},`,
    '',
    'We received a request to reset the password for your RepairOS account. Choose a new password here:',
    i.url,
    '',
    `This link expires in ${i.expiresIn} and can be used once.`,
    "If you didn't ask to reset your password, you can ignore this email; your password won't change.",
    '',
    '— RepairOS',
  ].join('\n');
  return { subject, html, text };
}
