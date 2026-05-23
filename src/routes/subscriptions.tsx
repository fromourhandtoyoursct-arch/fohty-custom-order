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

function step(n: string, title: string, desc: string) {
  return html`<div class="subs-step">
    <div class="subs-step-num">${n}</div>
    <div class="subs-step-title">${title}</div>
    <div class="subs-step-desc">${desc}</div>
  </div>`;
}

const check = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#5C8B6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"></path></svg>`;

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
      title: 'Made For You, Monthly',
      description: 'Join the Press-On Club and have hand-crafted nail sets delivered on a schedule.',
      children: html`
        <section class="subs-section">
          <div class="wrap">
            <h2 class="subs-section-head">How It Works</h2>
            <div class="subs-steps">
              ${step('1', 'Pick your plan', 'Choose Classic for simple designs or Luxe for premium nail art.')}
              ${step('2', 'Choose your experience', 'Pick your own designs or let our nail tech curate sets based on your style.')}
              ${step('3', 'We make it by hand', 'Your set is handcrafted by a licensed nail technician, just for you.')}
              ${step('4', 'Fresh nails at your door', 'A new set delivered every month. Wear, remove, repeat.')}
            </div>
          </div>
        </section>

        <section class="subs-section subs-pricing">
          <div class="wrap">
            <h1 class="subs-pricing-head">A new set in your mailbox, every month.</h1>
            <p class="subs-pricing-sub">Pick a plan. Pause or cancel any time.</p>

            ${plans.length === 0
              ? html`<div class="empty-state-card">
                  <p>Subscriptions are coming soon — check back shortly!</p>
                  <a class="btn btn-primary" href="/catalog">Browse one-time purchases</a>
                </div>`
              : html`<div class="subs-cards">
                  ${plans.map((p, i) => renderPlanCard(p, i === 1, isAuth, token))}
                </div>`}

            ${!isAuth && plans.length > 0
              ? html`<p class="hint" style="text-align:center;margin-top:24px;">You'll need to <a href="/login?return_to=/subscriptions">sign in</a> to subscribe.</p>`
              : ''}
          </div>
        </section>

        <section class="subs-gift" id="gift">
          <div class="wrap" style="max-width: 920px;">
            <h2 class="subs-gift-head">Give the Gift of Great Nails</h2>
            <p class="subs-gift-sub">Know someone who deserves a little something special? Gift a single set or a full subscription. We'll send a branded digital gift card on the date you choose.</p>
            <div class="subs-gift-cards">
              <a class="subs-gift-card" href="/gift-cards">
                <h4>Gift a Set</h4>
                <p>One handcrafted set, their choice of design.</p>
                <span class="subs-gift-from">From $40</span>
              </a>
              <a class="subs-gift-card" href="/gift-cards">
                <h4>Gift a Subscription</h4>
                <p>3 or 6 months of fresh nails delivered monthly.</p>
                <span class="subs-gift-from">From $120</span>
              </a>
            </div>
          </div>
        </section>

        <section class="subs-info-block">
          <div class="wrap">

            <div class="subs-info" id="how-to-apply">
              <h2 class="subs-info-head">How to Apply Our Press-Ons</h2>
              <p class="subs-info-lead">A clean prep is everything. Take your time on steps 1 and 2 and your set will last.</p>
              <ol class="subs-info-steps">
                <li><span class="subs-info-num">1</span><div><h4>Prep your natural nails</h4><p>Wash hands, push back cuticles, gently file the surface to remove shine, and wipe each nail with alcohol. Dry completely.</p></div></li>
                <li><span class="subs-info-num">2</span><div><h4>Size each finger</h4><p>Hold each press-on against your nail before applying — the right size covers the entire nail bed without overlapping the skin. Sizes XS–XL are included in every set.</p></div></li>
                <li><span class="subs-info-num">3</span><div><h4>Apply your adhesive</h4><p>Adhesive tabs (2-week wear): peel and press one onto your natural nail. Nail glue (4+ week wear): a thin line on the natural nail and a small dot inside the press-on.</p></div></li>
                <li><span class="subs-info-num">4</span><div><h4>Press &amp; hold</h4><p>Place the press-on at the cuticle line, press straight down for 10–15 seconds. Avoid water for the first hour.</p></div></li>
              </ol>
              <p class="subs-info-note">Each set ships with a free prep kit (file, cuticle pusher, alcohol pad, adhesive tabs). Need to remove? Soak in warm soapy water for 10 minutes and gently lift from the edge — never pry.</p>
            </div>

            <div class="subs-info" id="shipping">
              <h2 class="subs-info-head">Shipping</h2>
              <div class="subs-info-grid">
                <div class="subs-info-card">
                  <h4>Standard Shipping</h4>
                  <p class="subs-info-price">$5.99</p>
                  <p>Delivered in <strong>3–7 business days</strong>. Free over $75.</p>
                </div>
                <div class="subs-info-card">
                  <h4>Rush Shipping</h4>
                  <p class="subs-info-price">$14.99</p>
                  <p>Ships next business day, <strong>priority delivery</strong>.</p>
                </div>
              </div>
              <p class="subs-info-note">Subscription sets ship on the first business day of each month. You'll receive a tracking link by email as soon as your order leaves the studio. We ship anywhere in the US; international shipping coming soon.</p>
            </div>

            <div class="subs-info" id="returns">
              <h2 class="subs-info-head">Returns</h2>
              <p class="subs-info-lead">We want you to love your set. Here's how it works.</p>
              <ul class="subs-info-list">
                <li><strong>Unopened, unused sets</strong> may be returned within 14 days of delivery. Return shipping is at the customer's expense.</li>
                <li><strong>Custom orders</strong> and <strong>Nail Tech's Pick subscription sets</strong> are made to order and are final sale.</li>
                <li>If anything arrives damaged or doesn't fit right, reach out within 7 days and we'll make it right — no questions asked.</li>
                <li>All orders receive tracking information via email once shipped.</li>
              </ul>
              <p class="subs-info-note">Questions before you buy? <a href="#contact">Drop us a line</a> — we'd rather get it right the first time.</p>
            </div>

            <div class="subs-info" id="contact">
              <h2 class="subs-info-head">Contact</h2>
              <p class="subs-info-lead">We're real people. Reach out — we usually respond within 1 to 2 business days.</p>
              <div class="subs-info-grid subs-info-grid-single">
                <div class="subs-info-card">
                  <h4>Email</h4>
                  <p><a href="mailto:FromOurHandToYours.CT@Gmail.com">FromOurHandToYours.CT@Gmail.com</a></p>
                  <p class="subs-info-small">Best for orders, custom briefs, and anything detailed.</p>
                </div>
              </div>
            </div>

          </div>
        </section>

        <section class="subs-signoff">
          <div class="wrap">
            <p class="subs-signoff-text">With love,<br>From Our Hand To Yours</p>
          </div>
        </section>`,
    })
  );
});

function renderPlanCard(plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number], featured: boolean, isAuth: boolean, token: string) {
  return html`<article class="subs-card${featured ? ' featured' : ''}">
    ${featured ? html`<span class="subs-badge">Most Popular</span>` : ''}
    <h3 class="subs-plan-name">${plan.name}</h3>
    ${plan.description ? html`<p class="subs-plan-desc">${plan.description}</p>` : ''}
    <ul class="subs-variations">
      ${plan.variations.map(
        (v: SubscriptionPlanVariation) => html`<li class="subs-variation">
          <div>
            <div class="subs-variation-name">${v.name || cadenceLabel(v.cadence)}</div>
            <div class="subs-variation-cadence">${cadenceLabel(v.cadence)}</div>
          </div>
          <div class="subs-variation-price">${formatMoneyCents(v.priceCents, v.currency)}</div>
          ${isAuth
            ? html`<form method="post" action="/subscriptions/subscribe">
                <input type="hidden" name="_csrf" value="${token}">
                <input type="hidden" name="plan_variation_id" value="${v.id}">
                <button type="submit" class="subs-cta-sm">Subscribe</button>
              </form>`
            : html`<a class="subs-cta-sm subs-cta-ghost" href="/login?return_to=/subscriptions">Sign in</a>`}
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

subs.post('/subscribe', requireAuth, async (c) => {
  const userId = c.get('user_id')!;
  const form = await c.req.parseBody();
  const planVariationId = String(form.plan_variation_id ?? '');
  if (!/^[A-Z0-9]{16,32}$/.test(planVariationId)) {
    return c.redirect('/subscriptions?error=invalid_plan', 303);
  }
  const visiblePlans = await listSubscriptionPlans(c.env).catch(() => []);
  const planFound = visiblePlans.some((p) => p.variations.some((v) => v.id === planVariationId));
  if (!planFound) {
    return c.redirect('/subscriptions?error=invalid_plan', 303);
  }
  let customerId: string | null = null;
  try {
    customerId = await ensureUserHasSquareCustomer(c.env, userId);
  } catch (err) {
    console.warn('subscribe.customer.link.failed', { error: err instanceof Error ? err.message : String(err) });
    return c.redirect('/subscriptions?error=customer_link', 303);
  }
  if (!customerId) return c.redirect('/subscriptions?error=customer_link', 303);

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
