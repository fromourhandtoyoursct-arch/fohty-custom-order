/**
 * Resend transactional email wrapper.
 * If RESEND_API_KEY is unset the call no-ops with a console.warn — useful for
 * local dev where we don't want to send live email.
 */
import { safeLog } from './redact';
import type { Env } from '../types';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  skipped?: boolean;
}

export async function sendEmail(env: Env, params: SendEmailParams): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    console.warn('email.skipped', { to_domain: params.to.split('@')[1], subject: params.subject, reason: 'no RESEND_API_KEY' });
    return { ok: true, skipped: true };
  }

  const body = {
    from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`,
    to: [params.to],
    subject: params.subject,
    html: params.html,
    ...(params.text ? { text: params.text } : {}),
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
  };

  const start = Date.now();
  let resp: Response;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    safeLog('email.fetch.failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'send_failed' };
  }
  const latency = Date.now() - start;

  if (!resp.ok) {
    let detail = '';
    try { detail = await resp.text(); } catch { /* ignore */ }
    safeLog('email.error', { status: resp.status, latency_ms: latency, detail: detail.slice(0, 200) });
    return { ok: false, error: `resend_${resp.status}` };
  }
  const json = (await resp.json().catch(() => ({}))) as { id?: string };
  safeLog('email.sent', { id: json.id, latency_ms: latency, to_domain: params.to.split('@')[1] });
  return { ok: true, id: json.id };
}

/** Render the magic-link email body. */
export function magicLinkEmail(env: Env, magicUrl: string): { subject: string; html: string; text: string } {
  const subject = `Sign in to ${env.EMAIL_FROM_NAME}`;
  const text = `Hi,\n\nClick the link below to sign in (valid for 15 minutes):\n\n${magicUrl}\n\nIf you didn't request this, you can safely ignore it.\n\n— ${env.EMAIL_FROM_NAME}`;
  const html = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
    <table style="max-width:520px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;color:#2c4a38;">Sign in to ${escapeHtml(env.EMAIL_FROM_NAME)}</h1>
        <p style="font-size:15px;line-height:1.55;">Click the button below to sign in. This link is valid for 15 minutes and can only be used once.</p>
        <p style="text-align:center;margin:28px 0;">
          <a href="${escapeAttr(magicUrl)}" style="display:inline-block;background:#5C8B6E;color:#fefdfb;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:500;">Sign in</a>
        </p>
        <p style="font-size:13px;color:#5a7a68;">Or copy and paste this URL into your browser:<br><span style="word-break:break-all;color:#5C8B6E;">${escapeHtml(magicUrl)}</span></p>
        <p style="font-size:13px;color:#8aa898;margin-top:24px;">If you didn't request this email, you can safely ignore it.</p>
      </td></tr>
    </table>
  </body></html>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
