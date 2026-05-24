import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { listSubscriptionPlans, type SubscriptionPlanVariation } from '../lib/subscriptions';
import { squareFetch } from '../lib/square';
import { ensureUserHasSquareCustomer } from '../lib/customers';
import { sha256Hex } from '../lib/crypto';
import { formatMoneyCents } from '../lib/money';
import { sendEmail } from '../lib/email';
import { consume } from '../lib/rate-limit';
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

function applyStep(n: string, title: string, body: string) {
  return html`<details class="subs-apply-step">
    <summary class="subs-apply-head">
      <span class="subs-apply-num">${n}</span>
      <span class="subs-apply-title">${title}</span>
      <span class="subs-apply-toggle" aria-hidden="true">+</span>
    </summary>
    <div class="subs-apply-body"><p>${body}</p></div>
  </details>`;
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
  const contactState = String(c.req.query('contact') ?? '').trim().slice(0, 20);
  const contactBanner = contactBannerFor(contactState);

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
            <p class="subs-pricing-sub">Choose your commitment length — the longer you commit, the more you save.</p>

            <div class="subs-toggle" role="tablist" aria-label="Commitment length">
              <button type="button" class="subs-toggle-btn on" data-commit="3" role="tab" aria-selected="true">3 Months</button>
              <button type="button" class="subs-toggle-btn" data-commit="6" role="tab" aria-selected="false">6 Months <span class="subs-toggle-save">(Save More)</span></button>
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
              <p class="subs-info-lead">4 steps to a salon-worthy look, no appointment needed.</p>
              <div class="subs-apply">
                ${applyStep('1', 'Start With Clean, Dry Nails', 'Wash your hands and dry thoroughly. Gently push back your cuticles, then lightly buff the surface of each natural nail to remove shine. Wipe each nail with the alcohol pad from your prep kit (included with every order) so the surface is clean, dry, and oil-free before you begin.')}
                ${applyStep('2', 'Size & Place', "Hold each press-on against your natural nail before applying — the correct size covers your entire nail bed without overlapping the skin. Once you've matched all ten, apply a thin line of nail glue (or peel an adhesive tab and press it on) and place the press-on right at the cuticle line. Press firmly for at least 30 seconds.")}
                ${applyStep('3', 'Smooth & Secure', 'Press from the center of the nail outward to push out any air bubbles. Hold each nail in place for the full 30 seconds before moving on. Once all ten are applied, avoid water for at least one hour so the adhesive can fully cure.')}
                ${applyStep('4', 'Style & Go', "You're ready to go. To extend wear, dry your hands well after washing, wear gloves for cleaning, and apply cuticle oil daily around (not under) the press-on. With glue, expect 4+ weeks of wear; with adhesive tabs, around 2 weeks.")}
              </div>
              <p class="subs-info-note">A free prep kit (file, cuticle pusher, alcohol pad, adhesive tabs) ships with every order so you have everything you need to apply your nails like a pro.</p>
            </div>

            <div class="subs-info" id="shipping">
              <h2 class="subs-info-head">Shipping</h2>
              <div class="subs-info-grid">
                <div class="subs-info-card">
                  <h4>Standard Shipping</h4>
                  <p class="subs-info-price">$5.99</p>
                  <p>Delivered in 3 to 7 business days.</p>
                </div>
                <div class="subs-info-card">
                  <h4>Rush Shipping</h4>
                  <p class="subs-info-price">$14.99</p>
                  <p>Ships next business day, priority delivery.</p>
                </div>
              </div>
              <p class="subs-info-note">Ready-made sets ship within 1 to 2 business days after your order is confirmed. Custom orders ship within 3 to 5 business days. All orders receive tracking information via email once shipped.</p>
            </div>

            <div class="subs-info" id="returns">
              <h2 class="subs-info-head">Returns</h2>
              <p class="subs-info-lead">We want you to love your nails.</p>
              <ul class="subs-info-list">
                <li>Unopened, unused sets may be returned within 14 days of delivery. Return shipping is at the customer's expense.</li>
                <li>Custom orders and Nail Tech's Pick subscription sets are final sale and cannot be returned.</li>
                <li>If a set arrives damaged or defective, contact us with photos and we will send a replacement at no cost.</li>
                <li>All subscription changes or cancellations must be made before your next billing cycle.</li>
                <li>If you have any concerns about your order, please contact us right away and we will be happy to work something out.</li>
              </ul>
            </div>

            <div class="subs-info" id="contact">
              <h2 class="subs-info-head">Contact</h2>
              <p class="subs-info-lead">Have a question? Send us a message and we'll be in touch soon.</p>
              ${contactBanner}
              <form class="subs-contact-form" method="post" action="/subscriptions/contact">
                <input type="hidden" name="_csrf" value="${token}">
                <label class="subs-contact-field">
                  <span class="subs-contact-label">Name</span>
                  <input type="text" name="name" required maxlength="120" autocomplete="name">
                </label>
                <label class="subs-contact-field">
                  <span class="subs-contact-label">Email</span>
                  <input type="email" name="email" required maxlength="200" autocomplete="email">
                </label>
                <label class="subs-contact-field">
                  <span class="subs-contact-label">Message</span>
                  <textarea name="message" required rows="5" maxlength="3000"></textarea>
                </label>
                <button type="submit" class="subs-contact-submit">Send Message</button>
              </form>
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

subs.post('/contact', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const rl = await consume(c.env, { name: 'subs-contact-ip', limit: 5, periodSec: 3600 }, ip).catch(() => null);
  if (rl && !rl.allowed) {
    return c.redirect('/subscriptions?contact=rate_limited#contact', 303);
  }

  const form = await c.req.parseBody();
  const name = String(form.name ?? '').trim().slice(0, 120);
  const email = String(form.email ?? '').trim().slice(0, 200);
  const message = String(form.message ?? '').trim().slice(0, 3000);

  if (!name || !email || !message) {
    return c.redirect('/subscriptions?contact=missing#contact', 303);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect('/subscriptions?contact=invalid_email#contact', 303);
  }

  const studioHtml = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
    <table style="max-width:560px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;color:#2c4a38;">New contact message</h1>
        <p style="font-size:14px;margin:0 0 8px;"><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
        <hr style="border:none;border-top:1px solid #b8d4c4;margin:16px 0;">
        <p style="font-size:14px;line-height:1.6;white-space:pre-wrap;color:#2c4a38;">${escapeHtml(message)}</p>
      </td></tr>
    </table>
  </body></html>`;

  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: 'FromOurHandToYours.CT@gmail.com',
      subject: `New contact message — ${name}`,
      html: studioHtml,
      replyTo: email,
    }).catch((err) => console.warn('subs.contact.email.failed', err instanceof Error ? err.message : String(err)))
  );

  return c.redirect('/subscriptions?contact=sent#contact', 303);
});

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

function contactBannerFor(state: string) {
  if (state === 'sent') {
    return html`<div class="subs-contact-banner subs-contact-banner-ok">Thanks — your message is on its way. We'll be in touch soon.</div>`;
  }
  if (state === 'missing') {
    return html`<div class="subs-contact-banner subs-contact-banner-err">Please fill in your name, email, and message.</div>`;
  }
  if (state === 'invalid_email') {
    return html`<div class="subs-contact-banner subs-contact-banner-err">That email address doesn't look right. Please double-check it.</div>`;
  }
  if (state === 'rate_limited') {
    return html`<div class="subs-contact-banner subs-contact-banner-err">You've sent a lot of messages recently. Please try again in an hour or email us directly.</div>`;
  }
  return '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default subs;
