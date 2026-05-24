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

            <div class="subs-toggle" role="tablist" aria-label="Commitment length">
              <button type="button" class="subs-toggle-btn on" data-commit="3" role="tab" aria-selected="true">3 Months</button>
              <button type="button" class="subs-toggle-btn" data-commit="6" role="tab" aria-selected="false">6 Months <span class="subs-toggle-save">Save More</span></button>
            </div>

            <div class="subs-cards">
              ${pricingCard('classic', 'Classic', 'Solid colors, French tips, ombre, line art, and simple designs.', [
                '1 handcrafted set per month',
                '24 nails, all sizes XS to XL',
                'Reusable, salon-quality',
                'Prep kit included',
              ], { p3: 40, t3: 120, p6: 36, t6: 216 }, false)}
              ${pricingCard('luxe', 'Luxe', 'Nail art, crystals, charms, foil, glitter, and multi-technique sets.', [
                'Everything in Classic, plus',
                'Premium materials and techniques',
                'Priority custom requests',
                'Prep kit included',
              ], { p3: 50, t3: 150, p6: 45, t6: 270 }, true)}
            </div>

            ${plans.length === 0
              ? html`<p class="hint" style="text-align:center;margin-top:24px;">Subscriptions are activating soon. Take the style quiz now and we'll have your first set ready.</p>`
              : !isAuth
                ? html`<p class="hint" style="text-align:center;margin-top:24px;">You'll need to <a href="/login?return_to=/subscriptions">sign in</a> to subscribe.</p>`
                : ''}

            ${plans.length > 0
              ? html`<details class="subs-direct">
                  <summary><span class="eyebrow">Skip the quiz?</span> Subscribe directly</summary>
                  <div class="subs-direct-body">
                    <p>Already know what you want? Subscribe to a plan directly without the style quiz.</p>
                    <div class="plan-grid">
                      ${plans.map((p) => renderDirectPlanCard(p, isAuth, token))}
                    </div>
                  </div>
                </details>`
              : ''}
          </div>
        </section>

        <script>
          (function () {
            var btns = document.querySelectorAll('.subs-toggle-btn');
            function setCommit(months) {
              btns.forEach(function (b) {
                var on = b.dataset.commit === String(months);
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
              });
              document.querySelectorAll('[data-pricing]').forEach(function (card) {
                card.querySelectorAll('[data-price-' + months + ']').forEach(function (el) { el.hidden = false; });
                var other = months === '3' ? '6' : '3';
                card.querySelectorAll('[data-price-' + other + ']').forEach(function (el) { el.hidden = true; });
              });
            }
            btns.forEach(function (b) { b.addEventListener('click', function () { setCommit(b.dataset.commit); }); });
            setCommit('3');
          })();
        </script>

        <section class="subs-gift" id="gift">
          <div class="wrap" style="max-width: 920px;">
            <h2 class="subs-gift-head">Give the Gift of Great Nails</h2>
            <p class="subs-gift-sub">Know someone who deserves a little something special? Gift a single set or a full subscription. We'll send a branded digital gift card on the date you choose.</p>
            <div class="subs-gift-cards">
              ${renderGiftDetails('set', token)}
              ${renderGiftDetails('subscription', token)}
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

function pricingCard(id: string, name: string, desc: string, perks: string[], price: { p3: number; t3: number; p6: number; t6: number }, featured: boolean) {
  return html`<article class="subs-card${featured ? ' featured' : ''}" data-pricing="${id}">
    ${featured ? html`<span class="subs-badge">Most Popular</span>` : ''}
    <h3 class="subs-plan-name">${name}</h3>
    <p class="subs-plan-desc">${desc}</p>
    <div class="subs-price-stack">
      <div class="subs-price-tier" data-price-3>
        <div class="subs-price-row">
          <span class="subs-price">$${price.p3}</span>
          <span class="subs-price-unit">/set</span>
        </div>
        <div class="subs-billed">$${price.t3} billed every 3 months</div>
      </div>
      <div class="subs-price-tier" data-price-6 hidden>
        <div class="subs-price-row">
          <span class="subs-price">$${price.p6}</span>
          <span class="subs-price-unit">/set</span>
        </div>
        <div class="subs-billed">$${price.t6} billed every 6 months</div>
      </div>
    </div>
    <ul class="subs-perks">
      ${perks.map((p) => html`<li>${check}<span>${p}</span></li>`)}
    </ul>
    <a class="subs-cta" href="/style-quiz?plan=${id}">Choose ${name}</a>
  </article>`;
}

function renderDirectPlanCard(plan: Awaited<ReturnType<typeof listSubscriptionPlans>>[number], isAuth: boolean, token: string) {
  return html`<article class="plan-card">
    <h4 class="plan-card-name">${plan.name}</h4>
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

function renderGiftDetails(kind: 'set' | 'subscription', token: string) {
  const title = kind === 'set' ? 'Gift a Set' : 'Gift a Subscription';
  const desc = kind === 'set'
    ? 'One handcrafted set, their choice of design.'
    : '3 or 6 months of fresh nails delivered monthly.';
  const priceLabel = kind === 'set' ? 'From $40' : 'From $120';

  return html`<details class="subs-gift-card">
    <summary>
      <span class="subs-gift-card-head">
        <span class="subs-gift-card-title">${title}</span>
        <span class="subs-gift-card-desc">${desc}</span>
        <span class="subs-gift-from">${priceLabel}</span>
      </span>
      <span class="subs-gift-card-toggle" aria-hidden="true">+</span>
    </summary>
    <form class="gift-inline-form" method="post" action="/gift-cards/gift">
      <input type="hidden" name="_csrf" value="${token}">
      <input type="hidden" name="kind" value="${kind}">

      <div class="gift-section">
        <div class="gift-section-label">Gift options</div>
        <div class="gift-tier-row">
          <label class="gift-tier"><input type="radio" name="tier" value="classic" required checked><span><span class="gift-tier-name">Classic</span><span class="gift-tier-price">${kind === 'set' ? '$40' : '$120'}</span></span></label>
          <label class="gift-tier"><input type="radio" name="tier" value="luxe"><span><span class="gift-tier-name">Luxe</span><span class="gift-tier-price">${kind === 'set' ? '$50' : '$150'}</span></span></label>
        </div>
        ${kind === 'subscription'
          ? html`<div class="gift-tier-row" style="margin-top:10px;">
              <label class="gift-tier gift-tier-sm"><input type="radio" name="commitment" value="3" required checked><span><span class="gift-tier-name">3 months</span></span></label>
              <label class="gift-tier gift-tier-sm"><input type="radio" name="commitment" value="6"><span><span class="gift-tier-name">6 months · Save more</span></span></label>
            </div>`
          : ''}
      </div>

      <div class="gift-section">
        <div class="gift-section-label">From</div>
        <div class="fld-row">
          <div class="fld"><label>Your name</label><input name="sender_name" required maxlength="120" placeholder="Your full name"></div>
          <div class="fld"><label>Your email</label><input name="sender_email" type="email" required maxlength="200" placeholder="you@example.com"></div>
        </div>
      </div>

      <div class="gift-section">
        <div class="gift-section-label">To</div>
        <div class="fld-row">
          <div class="fld"><label>Recipient's name</label><input name="recipient_name" required maxlength="120" placeholder="Their name"></div>
          <div class="fld"><label>Recipient's email</label><input name="recipient_email" type="email" required maxlength="200" placeholder="them@there.com"></div>
        </div>
        <div class="fld"><label>Send gift notification on</label><input name="delivery_date" type="date"></div>
        <div class="fld"><label>Personal message (optional)</label><textarea name="message" rows="3" maxlength="500" placeholder="A short note…"></textarea></div>
      </div>

      ${kind === 'set'
        ? html`<div class="gift-section">
            <div class="gift-section-label">Ship to recipient</div>
            <div class="fld"><label>Street address</label><input name="ship_street" maxlength="160" placeholder="123 Main St"></div>
            <div class="fld-row">
              <div class="fld"><label>Apt, suite, unit</label><input name="ship_apt" maxlength="60" placeholder="Optional"></div>
              <div class="fld"><label>City</label><input name="ship_city" maxlength="80"></div>
            </div>
            <div class="fld-row">
              <div class="fld"><label>State</label><input name="ship_state" maxlength="2"></div>
              <div class="fld"><label>ZIP</label><input name="ship_zip" maxlength="12"></div>
            </div>
          </div>`
        : html`<p class="gift-note">No shipping needed — your recipient gets a branded digital gift card by email, and they choose where to ship each set when they redeem it.</p>`}

      <button type="submit" class="subs-cta-sm gift-submit">Continue to payment →</button>
      <p class="gift-dual-note">A gift notification and a receipt will be emailed to <strong>both you and your recipient</strong> on the date you choose.</p>
    </form>
  </details>`;
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
