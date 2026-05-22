/**
 * Square webhook signature verification + retry-safe dedup.
 *
 * Signature: HMAC-SHA256(notification_url + raw_body_text, signature_key) → base64
 * Compare against `x-square-hmacsha256-signature` header (constant-time).
 *
 * Dedup model (event_id PK + processing lock + error retryability):
 *   - Acquire row with INSERT ... ON CONFLICT DO UPDATE WHERE processed_at IS NULL
 *     AND (locked_at IS NULL OR locked_at < now-60).  RETURNING tells us if we own it.
 *   - On success: UPDATE processed_at=now, error=NULL.
 *   - On failure: UPDATE locked_at=NULL, error=msg.  Square retries will re-acquire.
 */
import { hmacSha256Base64, timingSafeEqual } from './crypto';
import type { Env } from '../types';

const LOCK_TTL_SEC = 60;

export interface SquareWebhookEvent {
  merchant_id?: string;
  type: string;
  event_id: string;
  created_at?: string;
  data?: {
    type?: string;
    id?: string;
    object?: unknown;
  };
}

export async function verifySquareSignature(env: Env, rawBody: string, headerSig: string | null): Promise<boolean> {
  if (!headerSig || !env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
  const expected = await hmacSha256Base64(env.SQUARE_WEBHOOK_SIGNATURE_KEY, env.WEBHOOK_NOTIFICATION_URL + rawBody);
  return timingSafeEqual(expected, headerSig);
}

/** Try to acquire processing on this event. Returns 'process' (we own it), 'skip' (already done), or 'busy' (another worker holds the lock). */
export async function acquireEvent(env: Env, event: SquareWebhookEvent, payloadJson: string): Promise<'process' | 'skip' | 'busy'> {
  const now = Math.floor(Date.now() / 1000);
  const squareCreatedAt = event.created_at ? Math.floor(new Date(event.created_at).getTime() / 1000) : null;

  // First check if row exists and is processed.
  const existing = await env.DB.prepare(
    `SELECT processed_at, error, locked_at, attempts FROM webhook_events WHERE event_id = ?`
  ).bind(event.event_id).first<{ processed_at: number | null; error: string | null; locked_at: number | null; attempts: number }>();

  if (existing) {
    if (existing.processed_at && !existing.error) return 'skip';
    // Failed/unfinished: attempt to take the lock.
    const claimed = await env.DB.prepare(
      `UPDATE webhook_events SET locked_at = ?, attempts = attempts + 1
         WHERE event_id = ?
           AND processed_at IS NULL
           AND (locked_at IS NULL OR locked_at < ?)
         RETURNING event_id`
    ).bind(now, event.event_id, now - LOCK_TTL_SEC).first();
    return claimed ? 'process' : 'busy';
  }

  // New event: insert + claim atomically.
  const inserted = await env.DB.prepare(
    `INSERT INTO webhook_events (event_id, type, square_created_at, payload_json, locked_at, attempts)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(event_id) DO NOTHING
       RETURNING event_id`
  ).bind(event.event_id, event.type, squareCreatedAt, payloadJson, now).first();
  return inserted ? 'process' : 'busy';
}

export async function markEventProcessed(env: Env, eventId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_events SET processed_at = unixepoch(), error = NULL, locked_at = NULL WHERE event_id = ?`
  ).bind(eventId).run();
}

export async function markEventFailed(env: Env, eventId: string, error: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_events SET error = ?, locked_at = NULL WHERE event_id = ?`
  ).bind(error.slice(0, 500), eventId).run();
}
