/**
 * CSRF middleware — double-submit cookie pattern.
 *
 * - Issues a `csrf` cookie (NOT HttpOnly so client JS can read & include in headers)
 *   on any safe-method request that doesn't already have one.
 * - On state-changing methods (POST/PUT/PATCH/DELETE), requires the cookie value
 *   to match either `X-CSRF-Token` header or `_csrf` form field.
 * - Mismatch / missing → 403.
 * - Exempts: routes with `c.set('csrf_skip', true)` (e.g. webhook receiver,
 *   which authenticates via Square signature).
 *
 * Cookie attributes:
 *   - `Secure`, `SameSite=Lax`, `Path=/`, 12h max-age.
 *   - NOT `__Host-` prefixed (would forbid `domain=` and we may need it later,
 *     and `__Host-` prefix requires HttpOnly which we deliberately don't set).
 *   - In production we should also gate `Secure` to HTTPS only — Cloudflare
 *     terminates TLS at edge so every request is HTTPS in prod.
 */
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomToken, timingSafeEqual } from './crypto';
import type { Env, HonoVars } from '../types';

type C = Context<{ Bindings: Env; Variables: HonoVars }>;

// Use `__Host-` prefix: forbids `domain=`, requires `secure` + `path=/`,
// so subdomain cookie injection cannot satisfy the form-token check.
const CSRF_COOKIE = '__Host-csrf';
const HEADER_NAME = 'x-csrf-token';
const FORM_FIELD = '_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function csrf(c: C, next: Next): Promise<Response | void> {
  // Webhook endpoints authenticate via signature, not CSRF token.
  if (c.req.path.startsWith('/api/webhooks/') || c.get('csrf_skip')) {
    await next();
    return;
  }
  let token = getCookie(c, CSRF_COOKIE);
  if (!token) {
    token = randomToken(24);
    setCookie(c, CSRF_COOKIE, token, {
      path: '/',
      sameSite: 'Lax',
      secure: true,
      maxAge: 60 * 60 * 12,
    });
  }
  c.set('csrf_token', token);

  if (!SAFE_METHODS.has(c.req.method.toUpperCase())) {
    let submitted = c.req.header(HEADER_NAME) ?? null;
    if (!submitted) {
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
        try {
          const form = await c.req.parseBody();
          const v = form[FORM_FIELD];
          if (typeof v === 'string') submitted = v;
        } catch {
          /* ignore */
        }
      }
    }
    if (!submitted || !timingSafeEqual(submitted, token)) {
      return c.json({ error: 'CSRF token missing or invalid' }, 403);
    }
  }
  await next();
}

/** Convenience helper for views: read the CSRF token from context. */
export function csrfToken(c: C): string {
  return c.get('csrf_token') ?? '';
}
