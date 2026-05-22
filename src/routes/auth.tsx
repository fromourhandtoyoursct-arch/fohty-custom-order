import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import {
  issueMagicLink,
  setMagicInitCookie,
  clearMagicInitCookie,
  resolveMagicLink,
  consumeMagicLink,
  createSession,
  destroySession,
} from '../lib/auth';
import { magicLinkEmail, sendEmail } from '../lib/email';
import { consume, RL_LOGIN_EMAIL, RL_LOGIN_IP, RL_MAGIC_IP } from '../lib/rate-limit';
import type { Env, HonoVars } from '../types';

const auth = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** Reject anything other than a same-origin relative path. Defeats `//evil.com`, `/\evil`, `https://...` etc. */
function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > 512) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  // Disallow embedded CR/LF/whitespace at start
  if (/[\s\\]/.test(value)) return null;
  return value;
}

/** GET /login — email entry form */
auth.get('/login', (c) => {
  const token = csrfToken(c);
  const returnTo = c.req.query('return_to') ?? '';
  const sent = c.req.query('sent') === '1';
  return c.html(
    Layout({
      c,
      title: 'Sign in',
      children: html`
        <section class="section">
          <div class="container narrow-col">
            <header class="page-header">
              <h1>Sign in</h1>
              <p>We'll email you a link to sign in. No password needed.</p>
            </header>
            ${sent
              ? html`<div class="auth-confirm">
                  <p><strong>Check your email.</strong></p>
                  <p>We've sent you a link to sign in. It will expire in 15 minutes.</p>
                  <p class="hint hint-muted">Didn't receive it? Check your spam folder or <a href="/login">try again</a>.</p>
                </div>`
              : html`<form method="post" action="/login" class="auth-form">
                  <input type="hidden" name="_csrf" value="${token}">
                  ${returnTo ? html`<input type="hidden" name="return_to" value="${returnTo}">` : ''}
                  <label class="form-field">
                    <span class="form-label">Email</span>
                    <input type="email" name="email" required autocomplete="email" inputmode="email" placeholder="you@example.com">
                  </label>
                  <button type="submit" class="btn btn-primary btn-large btn-block">Send sign-in link</button>
                </form>`}
          </div>
        </section>`,
    })
  );
});

/** POST /login — send magic link */
auth.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim().toLowerCase();
  const returnTo = safeReturnTo(form.return_to) ?? '/account';
  if (!EMAIL_RE.test(email)) {
    return c.redirect('/login?error=invalid_email', 303);
  }
  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';

  // Rate limits — quietly succeed on hit (don't leak limit state).
  const [ipLimit, emailLimit] = await Promise.all([
    consume(c.env, RL_LOGIN_IP, ip),
    consume(c.env, RL_LOGIN_EMAIL, email),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    console.warn('login.rate-limited', { ip_ok: ipLimit.allowed, email_ok: emailLimit.allowed });
    return c.redirect('/login?sent=1', 303);
  }

  // Suppress sends to addresses in our suppression list — but still appear successful.
  const suppressed = await c.env.DB.prepare(`SELECT 1 FROM suppression_list WHERE email = ? LIMIT 1`).bind(email).first();
  if (suppressed) return c.redirect('/login?sent=1', 303);

  const { url, initNonce } = await issueMagicLink(c.env, { email, redirectTo: returnTo, ip });
  setMagicInitCookie(c, initNonce);
  const tpl = magicLinkEmail(c.env, url);
  await sendEmail(c.env, { to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  return c.redirect('/login?sent=1', 303);
});

/** GET /auth/magic/:token — resolve the token; auto-login if same-browser, else interstitial */
auth.get('/auth/magic/:token', async (c) => {
  const token = c.req.param('token') ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return c.html(authErrorPage(c, 'Invalid or expired link.'));
  }
  // Per-IP rate limit on token resolution to slow brute-force enumeration.
  const ip = c.req.header('cf-connecting-ip') ?? '0.0.0.0';
  const rl = await consume(c.env, RL_MAGIC_IP, ip);
  if (!rl.allowed) {
    return c.html(authErrorPage(c, 'Too many attempts. Please wait a minute.'));
  }
  const resolved = await resolveMagicLink(c.env, c, token);
  if (!resolved) {
    return c.html(authErrorPage(c, 'This sign-in link has expired or already been used.'));
  }
  if (resolved.needsConfirmation) {
    return c.html(
      Layout({
        c,
        title: 'Confirm sign in',
        children: html`
          <section class="section">
            <div class="container narrow-col">
              <header class="page-header">
                <h1>Confirm sign in</h1>
                <p>You're signing in as <strong>${resolved.email}</strong>. Confirm to continue.</p>
              </header>
              <form method="post" action="/auth/magic/confirm" class="auth-form">
                <input type="hidden" name="_csrf" value="${csrfToken(c)}">
                <input type="hidden" name="token" value="${token}">
                <button type="submit" class="btn btn-primary btn-large btn-block">Confirm and sign in</button>
              </form>
              <p class="hint hint-muted">If you didn't request this, close this page — nothing will happen.</p>
            </div>
          </section>`,
      })
    );
  }
  // Same-browser path: consume + set session immediately.
  const consumed = await consumeMagicLink(c.env, token);
  if (!consumed) {
    return c.html(authErrorPage(c, 'This sign-in link has expired or already been used.'));
  }
  clearMagicInitCookie(c);
  await createSession(c.env, c, consumed.userId);
  const dest = safeReturnTo(consumed.redirectTo) ?? '/account';
  return c.redirect(dest, 303);
});

/** POST /auth/magic/confirm — interstitial confirmation submit */
auth.post('/auth/magic/confirm', async (c) => {
  const form = await c.req.parseBody();
  const token = String(form.token ?? '');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return c.html(authErrorPage(c, 'Invalid or expired link.'));
  }
  const consumed = await consumeMagicLink(c.env, token);
  if (!consumed) {
    return c.html(authErrorPage(c, 'This sign-in link has expired or already been used.'));
  }
  clearMagicInitCookie(c);
  await createSession(c.env, c, consumed.userId);
  const dest = safeReturnTo(consumed.redirectTo) ?? '/account';
  return c.redirect(dest, 303);
});

/** POST /logout */
auth.post('/logout', async (c) => {
  await destroySession(c.env, c);
  return c.redirect('/', 303);
});

function authErrorPage(c: any, message: string) {
  return Layout({
    c,
    title: 'Sign-in error',
    children: html`
      <section class="section">
        <div class="container narrow-col">
          <header class="page-header">
            <h1>We couldn't sign you in</h1>
            <p>${message}</p>
          </header>
          <a class="btn btn-primary" href="/login">Try again</a>
        </div>
      </section>`,
  });
}

export default auth;
