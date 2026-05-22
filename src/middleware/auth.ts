/**
 * Auth middleware.
 *
 * - `authLoader` runs early and populates c.var.user_id and c.var.square_customer_id
 *   if a valid session cookie is present.
 * - `requireAuth` guards routes that demand a logged-in user; redirects to /login
 *   with `?return_to=<path>` for HTML requests, or 401 JSON for API requests.
 */
import type { Context, Next } from 'hono';
import { loadSession } from '../lib/auth';
import type { Env, HonoVars } from '../types';

type C = Context<{ Bindings: Env; Variables: HonoVars }>;

export async function authLoader(c: C, next: Next): Promise<void> {
  const session = await loadSession(c.env, c);
  if (session) {
    c.set('user_id', session.userId);
    if (session.squareCustomerId) c.set('square_customer_id', session.squareCustomerId);
  }
  await next();
}

export async function requireAuth(c: C, next: Next): Promise<Response | void> {
  if (c.get('user_id')) {
    await next();
    return;
  }
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json') && !accept.includes('text/html')) {
    return c.json({ error: 'auth_required' }, 401);
  }
  const path = c.req.path;
  const query = c.req.url.split('?')[1];
  const returnTo = encodeURIComponent(path + (query ? `?${query}` : ''));
  return c.redirect(`/login?return_to=${returnTo}`, 303);
}
