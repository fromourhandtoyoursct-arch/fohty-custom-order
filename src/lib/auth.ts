/**
 * Magic-link auth + session management.
 *
 * D1 is the authoritative single-use marker for magic links.  KV mirrors active
 * sessions only as a low-latency cache; D1 is source of truth for revocation.
 *
 * Magic link tokens are bound to a same-browser init_nonce cookie to prevent
 * login CSRF / session fixation: a clicked link from a different browser surfaces
 * an interstitial CSRF-protected confirmation page rather than auto-logging.
 */
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { randomToken, sha256Base64Url } from './crypto';
import type { Env, HonoVars } from '../types';

const MAGIC_LINK_TTL_SEC = 15 * 60;
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;
const MAGIC_INIT_COOKIE = '__Host-mlinit';
const SESSION_COOKIE = '__Host-session';

export interface MagicLinkContext {
  email: string;
  redirectTo?: string;
  ip?: string;
}

export interface IssuedMagicLink {
  token: string;
  url: string;
  initNonce: string;
}

/** Issue a magic-link token. Stores hashed token + init nonce in D1; returns plain values for the email and cookie. */
export async function issueMagicLink(env: Env, ctx: MagicLinkContext): Promise<IssuedMagicLink> {
  const token = randomToken(32);
  const initNonce = randomToken(24);
  const tokenHash = await sha256Base64Url(token);
  const initHash = await sha256Base64Url(initNonce);
  const expires = Math.floor(Date.now() / 1000) + MAGIC_LINK_TTL_SEC;
  await env.DB.prepare(
    `INSERT INTO magic_links (token_hash, init_nonce_hash, email, redirect_to, ip, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(tokenHash, initHash, ctx.email.toLowerCase(), ctx.redirectTo ?? null, ctx.ip ?? null, expires).run();
  const url = `${env.SITE_ORIGIN}/auth/magic/${token}`;
  return { token, url, initNonce };
}

export function setMagicInitCookie(c: Context<{ Bindings: Env; Variables: HonoVars }>, value: string) {
  setCookie(c, MAGIC_INIT_COOKIE, value, {
    path: '/',
    sameSite: 'Strict',
    secure: true,
    httpOnly: true,
    maxAge: MAGIC_LINK_TTL_SEC,
  });
}

export function clearMagicInitCookie(c: Context<{ Bindings: Env; Variables: HonoVars }>) {
  deleteCookie(c, MAGIC_INIT_COOKIE, { path: '/', secure: true });
}

export interface ResolvedMagicLink {
  email: string;
  redirectTo: string | null;
  needsConfirmation: boolean;
}

/** Look up a magic-link token without consuming it; check init-nonce match. */
export async function resolveMagicLink(env: Env, c: Context<{ Bindings: Env; Variables: HonoVars }>, token: string): Promise<ResolvedMagicLink | null> {
  const now = Math.floor(Date.now() / 1000);
  const tokenHash = await sha256Base64Url(token);
  const row = await env.DB.prepare(
    `SELECT email, redirect_to, init_nonce_hash, expires_at
       FROM magic_links
       WHERE token_hash = ?`
  ).bind(tokenHash).first<{ email: string; redirect_to: string | null; init_nonce_hash: string; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < now) {
    await env.DB.prepare(`DELETE FROM magic_links WHERE token_hash = ?`).bind(tokenHash).run().catch(() => undefined);
    return null;
  }
  const cookie = getCookie(c, MAGIC_INIT_COOKIE);
  let needsConfirmation = true;
  if (cookie) {
    const cookieHash = await sha256Base64Url(cookie);
    needsConfirmation = cookieHash !== row.init_nonce_hash;
  }
  return { email: row.email, redirectTo: row.redirect_to, needsConfirmation };
}

/** Atomically consume the magic-link token. Returns user_id (creating user if needed). */
export async function consumeMagicLink(env: Env, token: string): Promise<{ email: string; userId: number; redirectTo: string | null } | null> {
  const tokenHash = await sha256Base64Url(token);
  // Atomic single-use: DELETE ... RETURNING
  const row = await env.DB.prepare(
    `DELETE FROM magic_links WHERE token_hash = ? RETURNING email, redirect_to, expires_at`
  ).bind(tokenHash).first<{ email: string; redirect_to: string | null; expires_at: number }>();
  if (!row) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null;

  // Find or create the user.
  const email = row.email.toLowerCase();
  let userRow = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first<{ id: number }>();
  if (!userRow) {
    const ins = await env.DB.prepare(`INSERT INTO users (email) VALUES (?) RETURNING id`).bind(email).first<{ id: number }>();
    if (!ins) return null;
    userRow = ins;
  }
  return { email, userId: userRow.id, redirectTo: row.redirect_to };
}

/** Create a new session for the given user; sets cookie. */
export async function createSession(
  env: Env,
  c: Context<{ Bindings: Env; Variables: HonoVars }>,
  userId: number
): Promise<string> {
  const sessionToken = randomToken(32);
  const idHash = await sha256Base64Url(sessionToken);
  const now = Math.floor(Date.now() / 1000);
  const expires = now + SESSION_TTL_SEC;
  const ip = c.req.header('cf-connecting-ip') ?? null;
  const ua = (c.req.header('user-agent') ?? '').slice(0, 200);
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user_id, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?)`
  ).bind(idHash, userId, expires, ip, ua).run();
  setCookie(c, SESSION_COOKIE, sessionToken, {
    path: '/',
    sameSite: 'Lax',
    secure: true,
    httpOnly: true,
    maxAge: SESSION_TTL_SEC,
  });
  return sessionToken;
}

/** Load the current session, if any. Returns null if missing/expired/revoked. */
export async function loadSession(
  env: Env,
  c: Context<{ Bindings: Env; Variables: HonoVars }>
): Promise<{ userId: number; email: string; squareCustomerId: string | null } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const idHash = await sha256Base64Url(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.square_customer_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ?`
  ).bind(idHash).first<{ user_id: number; expires_at: number; email: string; square_customer_id: string | null }>();
  if (!row) {
    // Clear stale cookie
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return null;
  }
  if (row.expires_at < now) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(idHash).run().catch(() => undefined);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return null;
  }
  // Rolling: bump last_seen_at (debounced — only update if last update > 5 min old).
  await env.DB.prepare(
    `UPDATE sessions SET last_seen_at = ? WHERE id_hash = ? AND last_seen_at < ?`
  ).bind(now, idHash, now - 300).run().catch(() => undefined);
  return {
    userId: row.user_id,
    email: row.email,
    squareCustomerId: row.square_customer_id,
  };
}

/** Destroy the current session (logout). */
export async function destroySession(env: Env, c: Context<{ Bindings: Env; Variables: HonoVars }>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const idHash = await sha256Base64Url(token);
    await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(idHash).run().catch(() => undefined);
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}
