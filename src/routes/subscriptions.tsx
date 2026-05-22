import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { listSubscriptionPlans, type SubscriptionPlanVariation } from '../lib/subscriptions';
import { squareFetch } from '../lib/square';
import { ensureUserHasSquareCustomer } from '../lib/customers';
import { sha256Hex } from '../lib/crypto';
import { formatMoneyCents } from '../lib/money';
import { requireAuth } from '../middleware/auth';
import type { Env, HonoVars } from '../types';

const subs = new Hono<{ Bindings: Env; Variables: HonoVars }>();

/** GET /subscriptions — browse plans (graceful "coming soon" if none) */
subs.get('/', async (c) => {
  let plans: Awaited<ReturnType<typeof listSubscriptionPlans>> = [];
  try {
    plans = await listSubscriptionPlans(c.env);
  } catch (err) {
    console.warn('subs.list.failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const isAuth = Boolean(c.get('user_id'));
  const token = csrfToken(c);

  return c.html(
    Layout({
      c,
      title: 'Subscriptions',
      description: 'Join the Press-On Club and have hand-crafted nail sets delivered on a schedule.',
      children: html`
        <section class="section">
          <div class="container">
            <header class="page-header">
              <h1>Subscriptions</h1>
              <p>Fresh nails, automatically. Pause or cancel any time.</p>
            </header>
            ${plans.length === 0
              ? html`<div class="empty-state-card">
                  <p>Subscriptions are coming soon — check back shortly!</p>
                  <a class="btn btn-primary" href="/catalog">Browse one-time purchases</a>
                </div>`
              : html`<div class="plan-grid">
                  ${plans.map((p) => renderPlanCard(p, isAuth, token))}
                </div>`}
            ${!isAuth && plans.length > 0
              ? html`<p class="hint">You'll need to <a href="/login?return_to=/subscriptions">sign in</a> to subscribe.</p>`
              : ''}
          </div>
        </section>`,
    })
  );
});

function renderPlanCard(plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number], isAuth: boolean, token: string) {
  return html`<article class="plan-card">
    <h2 class="plan-card-name">${plan.name}</h2>
    ${plan.description ? html`<p class="plan-card-desc">${plan.description}</p>` : ''}
    <ul class="plan-variations">
      ${plan.variations.map(
        (v: SubscriptionPlanVariation) => html`<li class="plan-variation">
          <div>
            <div class="plan-variation-name">${v.name || cadenceLabel(v.cadence)}</div>
            <div class="plan-variation-cadence">${cadenceLabel(v.cadence)}</div>
          </div>
          <div class="plan-variation-price">${formatMoneyCents(v.priceCents, v.currency)}</div>
          ${isAuth
            ? html`<form method="post" action="/subscriptions/subscribe">
                <input type="hidden" name="_csrf" value="${token}">
                <input type="hidden" name="plan_variation_id" value="${v.id}">
                <button type="submit" class="btn btn-primary btn-sm">Subscribe</button>
              </form>`
            : html`<a class="btn btn-secondary btn-sm" href="/login?return_to=/subscriptions">Sign in</a>`}
        </li>`
      )}
    </ul>
  </article>`;
}

function cadenceLabel(cad: string): string {
  switch (cad.toUpperCase()) {
    case 'DAILY': return 'Daily';
    case 'WEEKLY': return 'Weekly';
    case 'EVERY_TWO_WEEKS': return 'Every 2 weeks';
    case 'THIRTY_DAYS': return 'Every 30 days';
    case 'SIXTY_DAYS': return 'Every 60 days';
    case 'NINETY_DAYS': return 'Every 90 days';
    case 'MONTHLY': return 'Monthly';
    case 'EVERY_TWO_MONTHS': return 'Every 2 months';
    case 'QUARTERLY': return 'Quarterly';
    case 'EVERY_FOUR_MONTHS': return 'Every 4 months';
    case 'EVERY_SIX_MONTHS': return 'Every 6 months';
    case 'ANNUAL': return 'Annual';
    case 'EVERY_TWO_YEARS': return 'Every 2 years';
    default: return cad;
  }
}

/** POST /subscriptions/subscribe — requires auth; creates Payment Link with subscription plan variation as catalog object. */
subs.post('/subscribe', requireAuth, async (c) => {
  const userId = c.get('user_id')!;
  const form = await c.req.parseBody();
  const planVariationId = String(form.plan_variation_id ?? '');
  if (!/^[A-Z0-9]{16,32}$/.test(planVariationId)) {
    return c.redirect('/subscriptions?error=invalid_plan', 303);
  }
  // Validate the submitted plan_variation_id against our visible plans —
  // never trust client-submitted catalog IDs verbatim (defeats hidden-plan access).
  const visiblePlans = await listSubscriptionPlans(c.env).catch(() => []);
  const planFound = visiblePlans.some((p) => p.variations.some((v) => v.id === planVariationId));
  if (!planFound) {
    return c.redirect('/subscriptions?error=invalid_plan', 303);
  }
  // Ensure Square customer linkage so the subscription is attached to a customer.
  let customerId: string | null = null;
  try {
    customerId = await ensureUserHasSquareCustomer(c.env, userId);
  } catch (err) {
    console.warn('subscribe.customer.link.failed', { error: err instanceof Error ? err.message : String(err) });
    return c.redirect('/subscriptions?error=customer_link', 303);
  }
  if (!customerId) return c.redirect('/subscriptions?error=customer_link', 303);

  // Idempotency key = random nonce per attempt (UUID); avoids ms-collision.
  const idempotencyKey = (await sha256Hex(`sub|${userId}|${planVariationId}|${crypto.randomUUID()}`)).slice(0, 40);
  const redirectUrl = `${c.env.SITE_ORIGIN}/checkout/return`;

  let url: string;
  try {
    const resp = await squareFetch<{ payment_link?: { url: string } }>(c.env, '/v2/online-checkout/payment-links', {
      method: 'POST',
      idempotencyKey,
      body: {
        order: {
          location_id: c.env.SQUARE_LOCATION_ID,
          customer_id: customerId,
          reference_id: idempotencyKey,
          line_items: [
            { catalog_object_id: planVariationId, quantity: '1' },
          ],
          metadata: {
            fothy_kind: 'subscription',
            fothy_user_id: String(userId),
          },
        },
        checkout_options: {
          redirect_url: redirectUrl,
          ask_for_shipping_address: true,
          allow_tipping: false,
          enable_coupon: false,
          enable_loyalty: false,
        },
      },
    });
    url = resp.payment_link?.url ?? '';
  } catch (err) {
    console.warn('subscribe.checkout.failed', { error: err instanceof Error ? err.message : String(err) });
    return c.redirect('/subscriptions?error=checkout', 303);
  }
  if (!url) return c.redirect('/subscriptions?error=checkout', 303);
  return c.redirect(url, 303);
});

export default subs;
