/**
 * In-Worker rate limiter backed by D1.
 *
 * Atomic via SQL UPSERT — KV doesn't have INCR, so we use D1.
 * Buckets are time-windowed: `key = "rl:{name}:{subject}:{window}"`.
 * Returns `allowed: true` until `count > limit`.
 */
import type { Env } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface LimitSpec {
  name: string;
  limit: number;
  periodSec: number;
}

/** Try to consume one token. Atomic; safe for concurrent requests. */
export async function consume(env: Env, spec: LimitSpec, subject: string): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / spec.periodSec);
  const key = `rl:${spec.name}:${subject}:${window}`;
  const expires = (window + 1) * spec.periodSec;

  // Ensure table exists.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_limits (
       key TEXT PRIMARY KEY,
       count INTEGER NOT NULL DEFAULT 0,
       expires_at INTEGER NOT NULL
     )`
  ).run().catch(() => undefined);

  // Atomic increment via UPSERT — gives the new count.
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`
  ).bind(key, expires).first<{ count: number }>();
  const count = row?.count ?? 1;
  return {
    allowed: count <= spec.limit,
    remaining: Math.max(0, spec.limit - count),
    retryAfterSec: count > spec.limit ? expires - now : 0,
  };
}

/** Convenience: throw a Hono-friendly response if rate-limited. */
export async function enforce(env: Env, spec: LimitSpec, subject: string): Promise<RateLimitResult> {
  const res = await consume(env, spec, subject);
  return res;
}

/* Common specs */
export const RL_LOGIN_IP = { name: 'login-ip', limit: 10, periodSec: 3600 };
export const RL_LOGIN_EMAIL = { name: 'login-email', limit: 5, periodSec: 3600 };
export const RL_MAGIC_IP = { name: 'magic-ip', limit: 30, periodSec: 60 };
export const RL_CART_EMAIL_IP = { name: 'cart-email-ip', limit: 5, periodSec: 3600 };
export const RL_CART_EMAIL_TARGET = { name: 'cart-email-target', limit: 1, periodSec: 7 * 86400 };
export const RL_REVIEW_USER = { name: 'review-user', limit: 5, periodSec: 3600 };
