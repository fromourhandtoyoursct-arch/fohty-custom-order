/**
 * Abandoned-cart capture + recovery.
 *
 * Lifecycle:
 *   1. User checks "Email me reminders" on the cart page; we POST /cart/email
 *      with email + consent.  Persist (cart_id, email, consent_at) to D1 `carts`.
 *   2. Cron sweep (hourly) finds rows with:
 *        - email IS NOT NULL
 *        - consent_at IS NOT NULL
 *        - email NOT IN suppression_list
 *        - updated_at < unixepoch()-3600 (1h idle)
 *        - abandoned_email_sent_at IS NULL
 *        - recovered_at IS NULL
 *        - checked_out_at IS NULL
 *      Send Resend reminder with /cart/recover/:token link; mark email_sent_at.
 *   3. Recovery: GET /cart/recover/:token sets `__Host-cart` cookie to the abandoned
 *      cart_id and 303 redirects to /cart; marks recovered_at.
 */
import { randomToken, sha256Base64Url } from './crypto';
import { sendEmail } from './email';
import { hydrateCartForDisplay, loadCart } from './cart';
import { formatMoneyCents } from './money';
import type { Env } from '../types';

const ABANDON_AFTER_SEC = 3600;          // 1h idle
const RECOVERY_TOKEN_TTL_SEC = 7 * 86400; // 7 days

/** Capture email + consent for the current cart. */
export async function captureCartEmail(env: Env, cartId: string, email: string, consent: boolean): Promise<void> {
  const e = email.toLowerCase().trim();
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e)) return;

  // Mirror cart minimal data into D1 so the cron can find it without touching KV.
  const cart = await loadCart(env, cartId);
  const subtotal = await computeSubtotalCents(env, cart);

  await env.DB.prepare(
    `INSERT INTO carts (id, email, consent_at, items_json, subtotal_cents, updated_at)
       VALUES (?, ?, CASE WHEN ? = 1 THEN unixepoch() ELSE NULL END, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         consent_at = CASE WHEN ? = 1 THEN unixepoch() ELSE carts.consent_at END,
         items_json = excluded.items_json,
         subtotal_cents = excluded.subtotal_cents,
         updated_at = unixepoch()`
  ).bind(cartId, e, consent ? 1 : 0, JSON.stringify(cart.items), subtotal, consent ? 1 : 0).run();
}

async function computeSubtotalCents(env: Env, cart: Awaited<ReturnType<typeof loadCart>>): Promise<number> {
  if (cart.items.length === 0) return 0;
  const hydrated = await hydrateCartForDisplay(env, cart).catch(() => null);
  return hydrated?.subtotal_cents ?? 0;
}

interface AbandonedRow {
  id: string;
  email: string;
  subtotal_cents: number;
  items_json: string;
}

/** Cron: run hourly. Sends one reminder per qualifying cart. */
export async function sweepAbandonedCarts(env: Env): Promise<{ scanned: number; sent: number; suppressed: number }> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = now - ABANDON_AFTER_SEC;
  const rows = await env.DB.prepare(
    `SELECT c.id, c.email, c.subtotal_cents, c.items_json
       FROM carts c
       WHERE c.email IS NOT NULL
         AND c.consent_at IS NOT NULL
         AND c.updated_at < ?
         AND c.abandoned_email_sent_at IS NULL
         AND c.recovered_at IS NULL
         AND c.checked_out_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email = c.email)
       ORDER BY c.updated_at ASC
       LIMIT 50`
  ).bind(threshold).all<AbandonedRow>();
  const list = rows.results ?? [];
  let sent = 0;
  for (const cart of list) {
    // Mark sent FIRST to prevent duplicate sends on cron overlap.
    const claim = await env.DB.prepare(
      `UPDATE carts SET abandoned_email_sent_at = unixepoch()
         WHERE id = ? AND abandoned_email_sent_at IS NULL
         RETURNING id`
    ).bind(cart.id).first();
    if (!claim) continue;

    const token = await issueRecoveryToken(env, cart.id);
    const recoveryUrl = `${env.SITE_ORIGIN}/cart/recover/${token}`;
    const subj = 'Did you forget something?';
    const total = formatMoneyCents(cart.subtotal_cents);
    const html = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
      <table style="max-width:520px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
        <tr><td>
          <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;color:#2c4a38;">You left something behind</h1>
          <p style="font-size:15px;line-height:1.55;">We saved your cart so you can finish whenever you're ready.</p>
          <p style="font-size:15px;"><strong>Subtotal:</strong> ${total}</p>
          <p style="text-align:center;margin:28px 0;">
            <a href="${recoveryUrl}" style="display:inline-block;background:#5C8B6E;color:#fefdfb;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:500;">Return to my cart</a>
          </p>
          <p style="font-size:12px;color:#8aa898;margin-top:32px;">Don't want these emails? <a href="${env.SITE_ORIGIN}/unsubscribe/${token}" style="color:#5C8B6E;">Unsubscribe</a>.</p>
        </td></tr>
      </table>
    </body></html>`;
    const text = `You left something in your cart. Subtotal: ${total}. Return: ${recoveryUrl}`;
    await sendEmail(env, { to: cart.email, subject: subj, html, text });
    sent += 1;
  }
  return { scanned: list.length, sent, suppressed: 0 };
}

/**
 * Recovery token: random nonce, hashed and stored in KV cache with the cart_id.
 * Single-use, 7 day TTL.
 */
async function issueRecoveryToken(env: Env, cartId: string): Promise<string> {
  const token = randomToken(24);
  const tokenHash = await sha256Base64Url(token);
  await env.CACHE.put(`recover:${tokenHash}`, JSON.stringify({ cart_id: cartId, issued_at: Date.now() }), {
    expirationTtl: RECOVERY_TOKEN_TTL_SEC,
  });
  return token;
}

export async function consumeRecoveryToken(env: Env, token: string): Promise<{ cartId: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const tokenHash = await sha256Base64Url(token);
  const raw = await env.CACHE.get(`recover:${tokenHash}`, { type: 'json' });
  if (!raw) return null;
  const data = raw as { cart_id?: string };
  if (typeof data.cart_id !== 'string') return null;
  await env.CACHE.delete(`recover:${tokenHash}`);
  await env.DB.prepare(`UPDATE carts SET recovered_at = unixepoch() WHERE id = ?`).bind(data.cart_id).run().catch(() => undefined);
  return { cartId: data.cart_id };
}

/** Add email to suppression list and consume the unsub token. */
export async function consumeUnsubscribeToken(env: Env, token: string): Promise<{ email: string } | null> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  const tokenHash = await sha256Base64Url(token);
  const raw = await env.CACHE.get(`recover:${tokenHash}`, { type: 'json' });
  if (!raw) return null;
  const data = raw as { cart_id?: string };
  if (typeof data.cart_id !== 'string') return null;
  const cart = await env.DB.prepare(`SELECT email FROM carts WHERE id = ?`).bind(data.cart_id).first<{ email: string | null }>();
  if (!cart?.email) return null;
  await env.DB.prepare(
    `INSERT INTO suppression_list (email, reason) VALUES (?, 'unsubscribe')
       ON CONFLICT(email) DO NOTHING`
  ).bind(cart.email).run();
  return { email: cart.email };
}
