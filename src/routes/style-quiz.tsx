import { Hono } from 'hono';
import { html, raw } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { consume } from '../lib/rate-limit';
import { sendEmail } from '../lib/email';
import { getCatalog, primaryImageUrl, startingPriceCents } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const styleQuiz = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const TIER_DATA = {
  classic: { name: 'Classic', label: 'Classic Plan', p3: { perSet: 40, total: 120 }, p6: { perSet: 36, total: 216 } },
  luxe:    { name: 'Luxe',    label: 'Luxe Plan',    p3: { perSet: 50, total: 150 }, p6: { perSet: 45, total: 270 } },
};

const COLOR_OPTS = [
  { id: 'neutrals', label: 'Neutrals + nudes', dot: 'linear-gradient(135deg, #E8D8C0 0%, #C9A98A 100%)' },
  { id: 'pinks',    label: 'Pinks + reds',     dot: 'linear-gradient(135deg, #F4B5C2 0%, #B43F46 100%)' },
  { id: 'earth',    label: 'Earth tones',      dot: 'linear-gradient(135deg, #A88864 0%, #6B7A4A 100%)' },
  { id: 'pastels',  label: 'Pastels',          dot: 'linear-gradient(135deg, #D8C9E8 0%, #BFE3D2 100%)' },
  { id: 'moody',    label: 'Darks + moody',    dot: 'linear-gradient(135deg, #4A3B5C 0%, #1F2A44 100%)' },
  { id: 'bold',     label: 'Bright + bold',    dot: 'linear-gradient(135deg, #F08672 0%, #3CA9B8 100%)' },
];

const SHAPES = ['Round', 'Square', 'Squoval', 'Almond', 'Coffin', 'Stiletto', 'Not sure'];
const LENGTHS = ['Short', 'Medium', 'Long', 'Extra Long', 'Not sure'];

styleQuiz.get('/', async (c) => {
  const plan = String(c.req.query('plan') ?? '').toLowerCase();
  const tier = plan === 'luxe' ? TIER_DATA.luxe : TIER_DATA.classic;
  const tierKey = plan === 'luxe' ? 'luxe' : 'classic';
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  // Split inventory by simple rule: Luxe = $42+, Classic = under $42.
  const inventory = snap.items.filter((it) => {
    const cents = startingPriceCents(it);
    return tierKey === 'luxe' ? cents >= 4200 : cents < 4200;
  }).slice(0, 24);

  return c.html(
    Layout({
      c,
      title: 'Style Quiz',
      description: 'Tell us your style — our nail tech will curate sets just for you.',
      children: html`
        <section class="sq-page">
          <div class="sq-wrap" data-sq-wrap>

            <div class="sq-tier-banner">
              <span class="sq-tier-eyebrow">Made For You, Monthly</span>
              <span class="sq-tier-divider">·</span>
              <span class="sq-tier-pill" data-sq-tier-label>${tier.label}</span>
              <a class="sq-tier-link" href="/subscriptions">Change plan</a>
            </div>

            <div class="sq-progress"><div class="sq-progress-fill" data-sq-fill style="width: 0%;"></div></div>

            <form class="sq-form" method="post" action="/style-quiz/submit" data-sq-form>
              <input type="hidden" name="_csrf" value="${csrfToken(c)}">
              <input type="hidden" name="plan" value="${tierKey}">
              <input type="hidden" name="mode" value="" data-sq-mode>
              <input type="hidden" name="sku_id" value="" data-sq-sku>
              <input type="hidden" name="commitment" value="" data-sq-commit>
              <input type="hidden" name="shape" value="" data-sq-ans-shape>
              <input type="hidden" name="length" value="" data-sq-ans-length>
              <input type="hidden" name="type" value="" data-sq-ans-type>
              <input type="hidden" name="tone" value="" data-sq-ans-tone>
              <input type="hidden" name="design" value="" data-sq-ans-design>
              <input type="hidden" name="scope" value="" data-sq-ans-scope>
              <input type="hidden" name="colors" value="" data-sq-ans-colors>
              <input type="hidden" name="shipping" value="standard" data-sq-shipping>

              <!-- EXPERIENCE -->
              <div class="sq-pane on" data-sq-pane="experience">
                <div class="sq-head">
                  <h1 class="sq-title">How do you want your sets chosen?</h1>
                  <p class="sq-sub">Browse the studio inventory and pick exactly what you want, or let our nail tech curate a set built around your style profile.</p>
                </div>
                <div class="sq-cards-col">
                  <button type="button" class="sq-card" data-sq-pick-mode="inventory">
                    <div class="sq-card-body">
                      <div class="sq-card-title">Choose from our inventory</div>
                      <div class="sq-card-sub">Pick a ready-to-ship set from the studio. New designs added all the time.</div>
                    </div>
                    <span class="sq-radio" aria-hidden="true"></span>
                  </button>
                  <button type="button" class="sq-card" data-sq-pick-mode="techpick">
                    <div class="sq-card-body">
                      <div class="sq-card-title">Nail Tech's Pick</div>
                      <div class="sq-card-sub">Take a quick style quiz. Your nail tech curates each set based on your answers.</div>
                    </div>
                    <span class="sq-radio" aria-hidden="true"></span>
                  </button>
                </div>
                <div class="sq-nav">
                  <span></span>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Continue</button>
                </div>
              </div>

              <!-- INVENTORY -->
              <div class="sq-pane" data-sq-pane="inventory" hidden>
                <div class="sq-head">
                  <h1 class="sq-title">Choose your set</h1>
                  <p class="sq-sub">${tierKey === 'luxe' ? 'Luxe sets — nail art, multi-technique, premium finishes. Pulled live from the studio.' : 'Classic sets — solids, glazes, simple line work. Pulled live from the studio.'}</p>
                  <p class="sq-meta">${inventory.length} sets in stock · adding more weekly</p>
                </div>
                <div class="sq-inv-grid">
                  ${inventory.map((it) => {
                    const img = primaryImageUrl(snap, it);
                    return html`<button type="button" class="sq-inv-card" data-sq-pick-sku="${it.id}" data-sq-sku-name="${esc(it.name)}">
                      <div class="sq-inv-img">
                        ${img ? html`<img src="${img}" alt="" loading="lazy" width="240" height="300">` : html`<div class="sq-inv-fallback"></div>`}
                      </div>
                      <div class="sq-inv-meta">
                        <div class="sq-inv-name">${it.name}</div>
                      </div>
                      <span class="sq-inv-check" aria-hidden="true">✓</span>
                    </button>`;
                  })}
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Continue</button>
                </div>
              </div>

              <!-- INV-COMMIT -->
              <div class="sq-pane" data-sq-pane="inv-commit" hidden>
                <div class="sq-result">
                  <span class="sq-result-badge">Your First Set</span>
                  <h2 class="sq-result-name" data-sq-sku-show>—</h2>
                </div>
                ${commitBlock(tierKey, tier)}
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Add to Cart</button>
                </div>
              </div>

              <!-- Q1 SHAPE -->
              <div class="sq-pane" data-sq-pane="q1" hidden>
                <div class="sq-head"><h2 class="sq-q">Pick a nail shape</h2><p class="sq-sub">Any preference? "Not sure" is a perfectly fine answer.</p></div>
                <div class="sq-pills">${SHAPES.map((s) => html`<button type="button" class="sq-pill" data-sq-q="shape" data-sq-val="${s}">${s}</button>`)}</div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q2 LENGTH -->
              <div class="sq-pane" data-sq-pane="q2" hidden>
                <div class="sq-head"><h2 class="sq-q">And a length?</h2></div>
                <div class="sq-pills">${LENGTHS.map((s) => html`<button type="button" class="sq-pill" data-sq-q="length" data-sq-val="${s}">${s}</button>`)}</div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q3 TYPE -->
              <div class="sq-pane" data-sq-pane="q3" hidden>
                <div class="sq-head"><h2 class="sq-q">Solid color or designed sets?</h2></div>
                <div class="sq-cards-col">
                  <button type="button" class="sq-card" data-sq-q="type" data-sq-val="solid"><div class="sq-card-body"><div class="sq-card-title">Solid colors</div><div class="sq-card-sub">One color across the whole set, in different finishes.</div></div><span class="sq-radio"></span></button>
                  <button type="button" class="sq-card" data-sq-q="type" data-sq-val="design"><div class="sq-card-body"><div class="sq-card-title">Designs &amp; nail art</div><div class="sq-card-sub">French tips, line work, crystals, charms, and more.</div></div><span class="sq-radio"></span></button>
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q4a TONE (solid branch) -->
              <div class="sq-pane" data-sq-pane="q4a" hidden>
                <div class="sq-head"><h2 class="sq-q">Bright or neutral?</h2></div>
                <div class="sq-cards-col">
                  <button type="button" class="sq-card" data-sq-q="tone" data-sq-val="bright"><div class="sq-card-body"><div class="sq-card-title">Bright + bold</div><div class="sq-card-sub">Saturated colors that turn heads.</div></div><span class="sq-radio"></span></button>
                  <button type="button" class="sq-card" data-sq-q="tone" data-sq-val="neutral"><div class="sq-card-body"><div class="sq-card-title">Soft + neutral</div><div class="sq-card-sub">Milky nudes, dusty cream, quiet beauty.</div></div><span class="sq-radio"></span></button>
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q4b DESIGN (design branch) -->
              <div class="sq-pane" data-sq-pane="q4b" hidden>
                <div class="sq-head"><h2 class="sq-q">Simple or bold?</h2></div>
                <div class="sq-cards-col">
                  <button type="button" class="sq-card" data-sq-q="design" data-sq-val="simple"><div class="sq-card-body"><div class="sq-card-title">Simple + classy</div><div class="sq-card-sub">Modern french, thin line work, refined accents.</div></div><span class="sq-radio"></span></button>
                  <button type="button" class="sq-card" data-sq-q="design" data-sq-val="bold"><div class="sq-card-body"><div class="sq-card-title">Bold + expressive</div><div class="sq-card-sub">Nail art, multi-technique, crystals and charms.</div></div><span class="sq-radio"></span></button>
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q5 SCOPE (only design branch) -->
              <div class="sq-pane" data-sq-pane="q5" hidden>
                <div class="sq-head"><h2 class="sq-q">Across all nails — or accent nails only?</h2></div>
                <div class="sq-cards-col">
                  <button type="button" class="sq-card" data-sq-q="scope" data-sq-val="all"><div class="sq-card-body"><div class="sq-card-title">All nails</div><div class="sq-card-sub">Cohesive detail across every finger.</div></div><span class="sq-radio"></span></button>
                  <button type="button" class="sq-card" data-sq-q="scope" data-sq-val="accent"><div class="sq-card-body"><div class="sq-card-title">Accent nails</div><div class="sq-card-sub">Mostly solid, with a few statement nails.</div></div><span class="sq-radio"></span></button>
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Next</button>
                </div>
              </div>

              <!-- Q6 COLORS -->
              <div class="sq-pane" data-sq-pane="q6" hidden>
                <div class="sq-head"><h2 class="sq-q">Which color families pull you in?</h2><p class="sq-sub">Pick all that apply.</p></div>
                <div class="sq-color-grid">
                  ${COLOR_OPTS.map((co) => html`<button type="button" class="sq-cpill" data-sq-color="${co.id}">
                    <span class="sq-cdot" style="background: ${co.dot};"></span>
                    <span>${co.label}</span>
                  </button>`)}
                </div>
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>See My Style</button>
                </div>
              </div>

              <!-- PROFILE -->
              <div class="sq-pane" data-sq-pane="profile" hidden>
                <div class="sq-result">
                  <span class="sq-result-badge">Your Style Profile</span>
                  <h2 class="sq-result-name" data-sq-profile-name>Your Style</h2>
                  <div class="sq-tags" data-sq-profile-tags></div>
                  <div class="sq-swatches" data-sq-profile-swatches></div>
                  <div class="sq-meaning">
                    <div class="sq-meaning-title">What this means for your sets</div>
                    <p class="sq-meaning-text" data-sq-profile-text></p>
                  </div>
                </div>
                ${commitBlock(tierKey, tier)}
                <div class="sq-nav">
                  <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                  <button type="button" class="sq-next" data-sq-go="next" disabled>Add to Cart</button>
                </div>
              </div>

              <!-- CART -->
              <div class="sq-pane" data-sq-pane="cart" hidden>
                <div class="sq-cart">
                  <h2 class="sq-cart-head">Your Cart</h2>
                  <div class="sq-cart-item">
                    <div class="sq-cart-body">
                      <div class="sq-cart-name" data-sq-cart-name>—</div>
                      <div class="sq-cart-specs" data-sq-cart-specs>—</div>
                    </div>
                    <div class="sq-cart-price" data-sq-cart-price>—</div>
                  </div>
                  <hr class="sq-div">
                  <div class="sq-ship">
                    <div class="sq-ship-label">Shipping method</div>
                    <button type="button" class="sq-ship-row on" data-sq-ship="standard">
                      <span class="sq-radio on"></span>
                      <div class="sq-ship-body"><div class="sq-ship-name">Standard Shipping</div><div class="sq-ship-sub">Delivered in 3 to 7 business days</div></div>
                      <div class="sq-ship-cost">$5.99</div>
                    </button>
                    <button type="button" class="sq-ship-row" data-sq-ship="rush">
                      <span class="sq-radio"></span>
                      <div class="sq-ship-body"><div class="sq-ship-name">Rush Shipping</div><div class="sq-ship-sub">Ships next business day, priority delivery</div></div>
                      <div class="sq-ship-cost">$14.99</div>
                    </button>
                  </div>
                  <hr class="sq-div">
                  <div class="sq-sum">
                    <div class="sq-sum-row"><span>Subscription</span><span data-sq-sum-sub>—</span></div>
                    <div class="sq-sum-row"><span>Shipping</span><span data-sq-sum-ship>$5.99</span></div>
                    <div class="sq-sum-row"><span>Tax</span><span class="sq-sum-it">Calculated at checkout</span></div>
                    <div class="sq-sum-row sq-sum-total"><span>Subtotal (+ tax)</span><span data-sq-sum-total>—</span></div>
                  </div>
                  <div class="sq-nav">
                    <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                    <button type="button" class="sq-next" data-sq-go="next">Proceed to Checkout</button>
                  </div>
                </div>
              </div>

              <!-- CHECKOUT -->
              <div class="sq-pane" data-sq-pane="checkout" hidden>
                <div class="sq-cart">
                  <h2 class="sq-cart-head">Shipping &amp; Payment</h2>
                  <div class="sq-co-section">
                    <div class="sq-co-label">Contact Information</div>
                    <div class="sq-co-row sq-co-2">
                      <div class="sq-fld"><label>Email <span class="sq-req">*</span></label><input type="email" name="email" required maxlength="200" placeholder="you@example.com"></div>
                      <div class="sq-fld"><label>Phone</label><input type="tel" name="phone" maxlength="40" placeholder="Optional"></div>
                    </div>
                  </div>
                  <div class="sq-co-section">
                    <div class="sq-co-label">Shipping Address</div>
                    <div class="sq-co-row sq-co-2">
                      <div class="sq-fld"><label>First Name <span class="sq-req">*</span></label><input name="first" required maxlength="80"></div>
                      <div class="sq-fld"><label>Last Name <span class="sq-req">*</span></label><input name="last" required maxlength="80"></div>
                    </div>
                    <div class="sq-co-row"><div class="sq-fld"><label>Street Address <span class="sq-req">*</span></label><input name="street" required maxlength="160"></div></div>
                    <div class="sq-co-row"><div class="sq-fld"><label>Apt, Suite, Unit</label><input name="apt" maxlength="60"></div></div>
                    <div class="sq-co-row sq-co-3">
                      <div class="sq-fld"><label>City <span class="sq-req">*</span></label><input name="city" required maxlength="80"></div>
                      <div class="sq-fld"><label>State <span class="sq-req">*</span></label><input name="state" required maxlength="2"></div>
                      <div class="sq-fld"><label>ZIP <span class="sq-req">*</span></label><input name="zip" required maxlength="12"></div>
                    </div>
                  </div>
                  <div class="sq-co-section">
                    <div class="sq-co-label">Payment</div>
                    <p style="color: var(--ink-2); font-size: 13px; margin-bottom: 10px;">You'll complete payment on our secure Square page. We never see your card number.</p>
                  </div>
                  <div class="sq-nav">
                    <button type="button" class="sq-back" data-sq-go="back">← Back</button>
                    <button type="submit" class="sq-next" data-sq-submit>Place Order →</button>
                  </div>
                </div>
              </div>

            </form>
          </div>
        </section>

        <script>
          ${raw(quizScript())}
        </script>`,
    })
  );
});

styleQuiz.get('/thanks', (c) => {
  const plan = String(c.req.query('plan') ?? '').toLowerCase();
  const tier = plan === 'luxe' ? 'Luxe' : 'Classic';
  return c.html(
    Layout({
      c,
      title: 'Style saved',
      children: html`
        <section class="sq-page">
          <div class="wrap" style="max-width: 640px; text-align: center;">
            <div class="co-confirm">
              <div class="co-confirm-check">
                <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="#F5F0E8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 16.5l6 6 12-12"></path>
                </svg>
              </div>
              <h2 class="co-confirm-head">Order received!</h2>
              <p class="co-confirm-text">Your ${tier} subscription brief has been sent to our nail technician. You'll receive a confirmation email and we'll be in touch within 1-2 business days to finalize your first set.</p>
              <p class="co-confirm-text co-studio-line">We'll reach out by email to walk you through the next steps before any charges.</p>
              <div style="display:inline-flex;gap:12px;margin-top:18px;flex-wrap:wrap;justify-content:center;">
                <a class="btn btn-primary" href="/catalog">Keep shopping</a>
                <a class="btn btn-secondary" href="/account">My account</a>
              </div>
              <p class="co-signoff">With love,<br>From Our Hand To Yours</p>
            </div>
          </div>
        </section>`,
    })
  );
});

styleQuiz.post('/submit', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const rl = await consume(c.env, { name: 'style-quiz-ip', limit: 10, periodSec: 3600 }, ip).catch(() => null);
  if (rl && !rl.allowed) {
    return c.redirect('/style-quiz?error=rate_limited', 303);
  }
  const form = await c.req.parseBody();
  const get = (k: string) => String(form[k] ?? '').trim().slice(0, 200);

  const plan = get('plan') === 'luxe' ? 'Luxe' : 'Classic';
  const mode = get('mode'); // 'inventory' or 'techpick'
  const skuId = get('sku_id');
  const commitment = get('commitment');
  const shape = get('shape');
  const length = get('length');
  const type = get('type');
  const tone = get('tone');
  const design = get('design');
  const scope = get('scope');
  const colors = get('colors');
  const shipping = get('shipping');
  let email = get('email').toLowerCase();
  const phone = get('phone');
  const first = get('first');
  const last = get('last');
  const street = get('street');
  const apt = get('apt');
  const city = get('city');
  const state = get('state').toUpperCase();
  const zip = get('zip');

  const userId = c.get('user_id');
  if (!email && userId) {
    const user = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>().catch(() => null);
    if (user?.email) email = user.email;
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect(`/style-quiz?plan=${encodeURIComponent(plan.toLowerCase())}&error=invalid_email`, 303);
  }

  const studioHtml = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:24px;">
    <table style="max-width:640px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;color:#2c4a38;">New ${esc(plan)} subscription · ${esc(mode === 'inventory' ? 'Inventory pick' : "Nail Tech's Pick")}</h1>
        <table style="width:100%;border-collapse:collapse;">
          ${row('Plan', `${plan} · ${commitment} months`)}
          ${row('Customer', `${first} ${last} · ${email}${phone ? ` · ${phone}` : ''}`)}
          ${row('Ship to', `${street}${apt ? ', ' + apt : ''}, ${city}, ${state} ${zip}`)}
          ${row('Shipping', shipping === 'rush' ? 'Rush ($14.99)' : 'Standard ($5.99)')}
          ${mode === 'inventory' ? row('First set SKU', skuId) : ''}
          ${mode === 'techpick' ? `
            ${row('Shape', shape)}
            ${row('Length', length)}
            ${row('Type', type)}
            ${tone ? row('Tone', tone) : ''}
            ${design ? row('Design', design) : ''}
            ${scope ? row('Scope', scope) : ''}
            ${row('Colors', colors)}
          ` : ''}
        </table>
      </td></tr>
    </table>
  </body></html>`;

  c.executionCtx.waitUntil(
    Promise.all([
      sendEmail(c.env, {
        to: 'FromOurHandToYours.CT@gmail.com',
        subject: `New ${plan} subscription brief — ${first} ${last}`,
        html: studioHtml,
        replyTo: email,
      }),
      sendEmail(c.env, {
        to: email,
        subject: `We received your ${plan} subscription brief`,
        html: `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
          <table style="max-width:520px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
            <tr><td>
              <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;color:#2c4a38;">You're all set, ${esc(first)}!</h1>
              <p style="font-size:15px;line-height:1.55;">We've received your ${esc(plan)} subscription brief and we'll have your first set ready soon.</p>
              <p style="font-size:15px;line-height:1.55;">We'll reach out within 1-2 business days to walk you through the next steps before any charges.</p>
              <p style="font-style:italic;color:#5C8B6E;margin-top:32px;font-family:Georgia,serif;">With love,<br>From Our Hand To Yours</p>
            </td></tr>
          </table>
        </body></html>`,
      }),
    ]).catch((err) => console.warn('style-quiz.email.failed', err instanceof Error ? err.message : String(err)))
  );

  return c.redirect(`/style-quiz/thanks?plan=${encodeURIComponent(plan.toLowerCase())}`, 303);
});

function commitBlock(tierKey: string, tier: { name: string; label: string; p3: { perSet: number; total: number }; p6: { perSet: number; total: number } }) {
  return html`<div class="sq-commit">
    <div class="sq-commit-label">Choose your commitment:</div>
    <div class="sq-commit-cards">
      <button type="button" class="sq-commit-card" data-sq-commit-pick="3">
        <div class="sq-commit-term">3 months</div>
        <div class="sq-commit-price">$${tier.p3.perSet}<span>/set</span></div>
        <div class="sq-commit-total">$${tier.p3.total} billed every 3 months</div>
      </button>
      <button type="button" class="sq-commit-card" data-sq-commit-pick="6">
        <span class="sq-commit-best">Best value</span>
        <div class="sq-commit-term">6 months</div>
        <div class="sq-commit-price">$${tier.p6.perSet}<span>/set</span></div>
        <div class="sq-commit-total">$${tier.p6.total} billed every 6 months</div>
      </button>
    </div>
  </div>`;
}

function row(label: string, value: string): string {
  if (!value) return '';
  return `<tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;width:140px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;color:#2c4a38;font-size:14px;">${esc(value)}</td></tr>`;
}
function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function quizScript(): string {
  // Vanilla JS to drive the state machine. Kept inline so we don't ship a separate file.
  return `(function () {
    var state = { mode: '', sku: '', skuName: '', commit: '', shape: '', length: '', type: '', tone: '', design: '', scope: '', colors: [] };
    var STEP = 'experience';
    var TIER = ${JSON.stringify(TIER_DATA)};
    var plan = (document.querySelector('input[name="plan"]') || {}).value || 'classic';
    var tier = TIER[plan];

    function setHidden(n, v) { var el = document.querySelector('[data-sq-' + n + ']'); if (el) el.value = v; }
    function setAns(n, v) { var el = document.querySelector('[data-sq-ans-' + n + ']'); if (el) el.value = v; }

    function paneFor(s) { return document.querySelector('[data-sq-pane="' + s + '"]'); }
    function nextOf(s) {
      if (s === 'experience') return state.mode === 'inventory' ? 'inventory' : 'q1';
      if (s === 'inventory') return 'inv-commit';
      if (s === 'inv-commit') return 'cart';
      if (s === 'q1') return 'q2';
      if (s === 'q2') return 'q3';
      if (s === 'q3') return state.type === 'solid' ? 'q4a' : 'q4b';
      if (s === 'q4a') return 'q6';
      if (s === 'q4b') return 'q5';
      if (s === 'q5') return 'q6';
      if (s === 'q6') return 'profile';
      if (s === 'profile') return 'cart';
      if (s === 'cart') return 'checkout';
      return s;
    }
    function prevOf(s) {
      if (s === 'inventory') return 'experience';
      if (s === 'inv-commit') return 'inventory';
      if (s === 'q1') return 'experience';
      if (s === 'q2') return 'q1';
      if (s === 'q3') return 'q2';
      if (s === 'q4a') return 'q3';
      if (s === 'q4b') return 'q3';
      if (s === 'q5') return 'q4b';
      if (s === 'q6') return state.type === 'solid' ? 'q4a' : 'q5';
      if (s === 'profile') return 'q6';
      if (s === 'cart') return state.mode === 'inventory' ? 'inv-commit' : 'profile';
      if (s === 'checkout') return 'cart';
      return s;
    }
    function totalSteps() { return state.mode === 'inventory' ? 4 : (state.type === 'design' ? 9 : 8); }
    function stepIndex(s) {
      var inv = ['experience','inventory','inv-commit','cart','checkout'];
      var qp = ['experience','q1','q2','q3','q4a','q4b','q5','q6','profile','cart','checkout'];
      if (state.mode === 'inventory') return inv.indexOf(s);
      return qp.indexOf(s);
    }
    function updateProgress() {
      var fill = document.querySelector('[data-sq-fill]');
      var t = state.mode === 'inventory' ? 5 : 11;
      var i = Math.max(0, stepIndex(STEP));
      fill.style.width = Math.round(i / t * 100) + '%';
    }
    function show(s) {
      STEP = s;
      document.querySelectorAll('[data-sq-pane]').forEach(function (p) {
        var on = p.dataset.sqPane === s;
        p.hidden = !on;
        p.classList.toggle('on', on);
      });
      updateProgress();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (s === 'profile') renderProfile();
      if (s === 'cart') renderCart();
    }
    function canNext() {
      if (STEP === 'experience') return !!state.mode;
      if (STEP === 'inventory') return !!state.sku;
      if (STEP === 'inv-commit') return !!state.commit;
      if (STEP === 'q1') return !!state.shape;
      if (STEP === 'q2') return !!state.length;
      if (STEP === 'q3') return !!state.type;
      if (STEP === 'q4a') return !!state.tone;
      if (STEP === 'q4b') return !!state.design;
      if (STEP === 'q5') return !!state.scope;
      if (STEP === 'q6') return state.colors.length > 0;
      if (STEP === 'profile') return !!state.commit;
      return true;
    }
    function refreshNext() {
      var pane = paneFor(STEP);
      if (!pane) return;
      var btn = pane.querySelector('[data-sq-go="next"]');
      if (btn) btn.disabled = !canNext();
    }

    // Mode picker
    document.querySelectorAll('[data-sq-pick-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.mode = b.dataset.sqPickMode;
        setHidden('mode', state.mode);
        b.closest('.sq-cards-col').querySelectorAll('.sq-card').forEach(function (c) { c.classList.remove('on'); c.querySelector('.sq-radio').classList.remove('on'); });
        b.classList.add('on'); b.querySelector('.sq-radio').classList.add('on');
        refreshNext();
      });
    });

    // SKU picker
    document.querySelectorAll('[data-sq-pick-sku]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.sku = b.dataset.sqPickSku;
        state.skuName = b.dataset.sqSkuName;
        setHidden('sku', state.sku);
        document.querySelectorAll('[data-sq-pick-sku]').forEach(function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        var label = document.querySelector('[data-sq-sku-show]');
        if (label) label.textContent = state.skuName;
        refreshNext();
      });
    });

    // Commit picker (handles both inv-commit and profile panes)
    document.querySelectorAll('[data-sq-commit-pick]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.commit = b.dataset.sqCommitPick;
        setHidden('commit', state.commit);
        var pane = b.closest('[data-sq-pane]');
        pane.querySelectorAll('[data-sq-commit-pick]').forEach(function (c) { c.classList.remove('on'); });
        b.classList.add('on');
        refreshNext();
      });
    });

    // Quiz pills (single-select)
    document.querySelectorAll('[data-sq-q]').forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.dataset.sqQ;
        var val = b.dataset.sqVal;
        state[key] = val;
        setAns(key, val);
        var pane = b.closest('[data-sq-pane]');
        pane.querySelectorAll('[data-sq-q="' + key + '"]').forEach(function (c) { c.classList.remove('on'); var r = c.querySelector('.sq-radio'); if (r) r.classList.remove('on'); });
        b.classList.add('on');
        var r = b.querySelector('.sq-radio'); if (r) r.classList.add('on');
        refreshNext();
      });
    });

    // Color multi-select
    document.querySelectorAll('[data-sq-color]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.sqColor;
        var i = state.colors.indexOf(id);
        if (i >= 0) { state.colors.splice(i, 1); b.classList.remove('on'); }
        else { state.colors.push(id); b.classList.add('on'); }
        setAns('colors', state.colors.join(','));
        refreshNext();
      });
    });

    // Shipping
    document.querySelectorAll('[data-sq-ship]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-sq-ship]').forEach(function (c) { c.classList.remove('on'); var r = c.querySelector('.sq-radio'); if (r) r.classList.remove('on'); });
        b.classList.add('on'); var r = b.querySelector('.sq-radio'); if (r) r.classList.add('on');
        setHidden('shipping', b.dataset.sqShip);
        renderCart();
      });
    });

    // Nav
    document.querySelectorAll('[data-sq-go]').forEach(function (b) {
      b.addEventListener('click', function () {
        var dir = b.dataset.sqGo;
        if (dir === 'next' && canNext()) {
          var next = nextOf(STEP);
          show(next);
        } else if (dir === 'back') {
          var prev = prevOf(STEP);
          show(prev);
        }
      });
    });

    function profileName() {
      if (state.type === 'solid' && state.tone === 'bright') return 'Bold Solids';
      if (state.type === 'solid' && state.tone === 'neutral') return 'Soft Solids';
      if (state.type === 'design' && state.design === 'simple' && state.scope === 'all') return 'Simply Designed';
      if (state.type === 'design' && state.design === 'simple' && state.scope === 'accent') return 'Subtle Accents';
      if (state.type === 'design' && state.design === 'bold' && state.scope === 'all') return 'Full Expression';
      if (state.type === 'design' && state.design === 'bold' && state.scope === 'accent') return 'Statement Accents';
      return 'Your Style';
    }
    function renderProfile() {
      var nameEl = document.querySelector('[data-sq-profile-name]');
      var tagsEl = document.querySelector('[data-sq-profile-tags]');
      var swEl = document.querySelector('[data-sq-profile-swatches]');
      var textEl = document.querySelector('[data-sq-profile-text]');
      if (nameEl) nameEl.textContent = profileName();
      var tags = [];
      tags.push('Shape · ' + state.shape);
      tags.push('Length · ' + state.length);
      if (state.type === 'solid') tags.push(state.tone === 'bright' ? 'Bright + bold' : 'Soft + neutral');
      else tags.push(state.design === 'simple' ? 'Simple + classy' : 'Bold + expressive');
      if (state.type === 'design') tags.push(state.scope === 'all' ? 'All nails' : 'Accent nails');
      if (tagsEl) tagsEl.innerHTML = tags.map(function (t) { return '<span class="sq-tag">' + t + '</span>'; }).join('');
      var swMap = {
        neutrals: ['#F1E4D2','#D7B998','#B89070'], pinks: ['#F8D2DA','#E59AA9','#C45260'],
        earth: ['#B89C70','#8C7A56','#6B6A3F'], pastels: ['#E2D6EE','#CFE7D6','#F4E1CB'],
        moody: ['#3B2C4C','#202B44','#1A1F1A'], bold: ['#F08672','#F2C84B','#3CA9B8']
      };
      var sw = [];
      state.colors.forEach(function (c) { (swMap[c] || []).forEach(function (h) { if (sw.indexOf(h) === -1) sw.push(h); }); });
      sw = sw.slice(0, 6);
      if (swEl) swEl.innerHTML = sw.map(function (h) { return '<span class="sq-swatch" style="background:' + h + ';"></span>'; }).join('');
      if (textEl) {
        var shape = state.shape === 'Not sure' ? 'a shape that flatters your hand' : state.shape.toLowerCase();
        var length = state.length === 'Not sure' ? 'your ideal length' : state.length.toLowerCase();
        var msg = 'Sets tailored to your shape, length, and color preferences.';
        if (state.type === 'solid' && state.tone === 'bright') msg = 'Your nail technician will pair ' + shape + ', ' + length + ' sets with vivid, saturated colors.';
        else if (state.type === 'solid' && state.tone === 'neutral') msg = 'Expect ' + shape + ', ' + length + ' sets in soft, understated colors — quiet, beautiful, easy to wear.';
        else if (state.type === 'design' && state.design === 'simple' && state.scope === 'all') msg = shape.charAt(0).toUpperCase() + shape.slice(1) + ' sets at ' + length + ' length with cohesive details across every nail.';
        else if (state.type === 'design' && state.design === 'simple' && state.scope === 'accent') msg = shape.charAt(0).toUpperCase() + shape.slice(1) + ' sets at ' + length + ' length, mostly solid, with a handful of accent nails carrying delicate detail.';
        else if (state.type === 'design' && state.design === 'bold' && state.scope === 'all') msg = shape.charAt(0).toUpperCase() + shape.slice(1) + ' sets at ' + length + ' length, fully decorated — nail art across every finger.';
        else if (state.type === 'design' && state.design === 'bold' && state.scope === 'accent') msg = shape.charAt(0).toUpperCase() + shape.slice(1) + ' sets at ' + length + ' length with a few statement nails.';
        textEl.textContent = msg;
      }
    }
    function renderCart() {
      var nameEl = document.querySelector('[data-sq-cart-name]');
      var specsEl = document.querySelector('[data-sq-cart-specs]');
      var priceEl = document.querySelector('[data-sq-cart-price]');
      var subEl = document.querySelector('[data-sq-sum-sub]');
      var shipEl = document.querySelector('[data-sq-sum-ship]');
      var totalEl = document.querySelector('[data-sq-sum-total]');
      var period = state.commit === '3' ? '3 months' : '6 months';
      var p = tier[state.commit === '6' ? 'p6' : 'p3'];
      var ship = document.querySelector('input[name="shipping"]').value === 'rush' ? 14.99 : 5.99;
      if (nameEl) nameEl.textContent = state.mode === 'inventory'
        ? ('First set: ' + state.skuName + ' — ' + tier.name + ' (' + period + ')')
        : ("Nail Tech's Pick — " + tier.name + ' (' + period + ')');
      if (specsEl) specsEl.textContent = state.mode === 'inventory'
        ? '24 nails · sizes XS to XL'
        : (state.shape + ' · ' + state.length + ' · ' + profileName() + ' · ' + state.colors.length + ' color preference' + (state.colors.length === 1 ? '' : 's'));
      if (priceEl) priceEl.innerHTML = '$' + p.perSet + '<span>/set</span>';
      if (subEl) subEl.textContent = '$' + p.total.toFixed(2);
      if (shipEl) shipEl.textContent = '$' + ship.toFixed(2);
      if (totalEl) totalEl.textContent = '$' + (p.total + ship).toFixed(2);
    }
    show('experience');
  })();`;
}

export default styleQuiz;
