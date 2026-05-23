import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { consume } from '../lib/rate-limit';
import { sendEmail } from '../lib/email';
import type { Env, HonoVars } from '../types';

const customOrder = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const SHAPES = ['Round', 'Square', 'Squoval', 'Almond', 'Coffin', 'Stiletto', 'Not Sure'];
const LENGTHS = ['Short', 'Medium', 'Long', 'Extra Long', 'Not Sure'];
const STYLES = ['Solid Color', 'French Tip', 'Ombre / Gradient', 'Glitter / Shimmer', 'Nail Art', 'Line Art', 'Foil', 'Crystals', 'Charms', 'Themed / Character', 'Other', 'Not Sure Yet'];
const FINISHES = ['Glossy', 'Matte', 'Chrome', 'Shimmer', 'Mix of Finishes', 'Not Sure'];
const UNIFORMITY = ['Yes, uniform look', 'No, I want variety', 'Open to suggestions'];

customOrder.get('/', (c) => {
  const error = c.req.query('error');
  return c.html(
    Layout({
      c,
      title: 'Custom Order',
      description: 'Design a custom press-on set, handcrafted just for you.',
      children: html`
        <section class="co-page">
          <div class="co-hero">
            <div class="wrap">
              <h1 class="co-hero-title">From Our Hand To Yours</h1>
              <p class="co-hero-tag">Mix. Match. Make it <em>uniquely yours.</em></p>
            </div>
          </div>

          <div class="wrap">
            <div class="co-diffs">
              <div class="co-diff">
                <h3 class="co-diff-head">24 Nails. One Set.<br>Multiple Looks.</h3>
                <p class="co-diff-body">Mix, match, and make it uniquely yours. All sizes XS through XL included.</p>
              </div>
              <div class="co-diff">
                <h3 class="co-diff-head">Reusable &amp; Built to Last.</h3>
                <p class="co-diff-body">Remove, store, and re-apply. Your nails, your schedule.</p>
              </div>
              <div class="co-diff">
                <h3 class="co-diff-head">Handcrafted by a Licensed Nail Tech.</h3>
                <p class="co-diff-body">Every set is designed and built by hand. No machines, no kits, no shortcuts.</p>
              </div>
            </div>
          </div>

          <div class="wrap co-form-wrap">
            <h2 class="co-form-head">Design Your Custom Set</h2>
            <p class="co-form-sub">Tell us what you're dreaming up. We'll be in touch within 1 to 2 business days.</p>

            ${error
              ? html`<div class="alert alert-error">${errorMessage(error)}</div>`
              : ''}

            <form class="co-card" method="post" action="/custom-order/submit">
              <input type="hidden" name="_csrf" value="${csrfToken(c)}">

              <section class="co-step">
                <h3 class="co-step-head">Let's start with you</h3>
                <div class="co-row co-row-2">
                  <div class="co-fld">
                    <label for="co-firstName">First Name <span class="co-req">*</span></label>
                    <input id="co-firstName" name="firstName" required maxlength="80">
                  </div>
                  <div class="co-fld">
                    <label for="co-lastName">Last Name <span class="co-req">*</span></label>
                    <input id="co-lastName" name="lastName" required maxlength="80">
                  </div>
                </div>
                <div class="co-row">
                  <div class="co-fld">
                    <label for="co-email">Email <span class="co-req">*</span></label>
                    <input id="co-email" name="email" type="email" required maxlength="200" placeholder="you@example.com">
                  </div>
                </div>
                <div class="co-row">
                  <div class="co-fld">
                    <label for="co-phone">Phone</label>
                    <input id="co-phone" name="phone" type="tel" maxlength="40" placeholder="Optional">
                  </div>
                </div>
              </section>

              <section class="co-step">
                <h3 class="co-step-head">Pick your nail basics</h3>
                <div class="co-group">
                  <label class="co-group-label">Nail Shape <span class="co-req">*</span></label>
                  <div class="co-pills">
                    ${SHAPES.map(
                      (s, i) => html`<label class="co-pill">
                        <input type="radio" name="shape" value="${s}" ${i === 0 ? '' : ''} required>
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                </div>
                <div class="co-group">
                  <label class="co-group-label">Nail Length <span class="co-req">*</span></label>
                  <div class="co-pills">
                    ${LENGTHS.map(
                      (s) => html`<label class="co-pill">
                        <input type="radio" name="length" value="${s}" required>
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                </div>
                <div class="co-row co-row-2">
                  <div class="co-fld">
                    <label for="co-qty">How many sets?</label>
                    <select id="co-qty" name="quantity">
                      <option value="">Select…</option>
                      <option>1 set</option>
                      <option>2 sets</option>
                      <option>3 sets</option>
                      <option>4 sets</option>
                      <option>5+ sets</option>
                    </select>
                  </div>
                  <div class="co-fld">
                    <label for="co-deadline">Need them by?</label>
                    <input id="co-deadline" name="deadline" type="date">
                  </div>
                </div>
              </section>

              <section class="co-step">
                <h3 class="co-step-head">Tell us about your design</h3>
                <div class="co-group">
                  <label class="co-group-label">What style are you going for?</label>
                  <div class="co-pills">
                    ${STYLES.map(
                      (s) => html`<label class="co-pill">
                        <input type="checkbox" name="styles" value="${s}">
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                  <p class="co-hint">Select all that apply. If you chose "Other," you can describe or show us below.</p>
                </div>
                <div class="co-group">
                  <label class="co-group-label">Preferred finish</label>
                  <div class="co-pills">
                    ${FINISHES.map(
                      (s) => html`<label class="co-pill">
                        <input type="checkbox" name="finishes" value="${s}">
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                </div>
                <div class="co-group">
                  <label class="co-group-label">Same design on all fingers?</label>
                  <div class="co-pills">
                    ${UNIFORMITY.map(
                      (s) => html`<label class="co-pill">
                        <input type="radio" name="uniformity" value="${s}">
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                </div>
                <div class="co-finger-builder">
                  <label class="co-group-label">If you want variety, what goes on each finger?</label>
                  <p class="co-hint">Both hands match unless you tell us otherwise.</p>
                  <div class="co-fingers">
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_thumb" maxlength="160" placeholder="e.g. sage green"><div class="co-finger-label">Thumb</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_index" maxlength="160" placeholder="e.g. glitter accent"><div class="co-finger-label">Index</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_middle" maxlength="160" placeholder="e.g. French tip"><div class="co-finger-label">Middle</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_ring" maxlength="160" placeholder="e.g. crystals"><div class="co-finger-label">Ring</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_pinky" maxlength="160" placeholder="e.g. solid pink"><div class="co-finger-label">Pinky</div></div>
                  </div>
                </div>
              </section>

              <section class="co-step">
                <h3 class="co-step-head">Final touches</h3>
                <div class="co-row">
                  <div class="co-fld">
                    <label for="co-dream">Tell us about your dream design</label>
                    <textarea id="co-dream" name="dreamDesign" rows="5" maxlength="2000" placeholder="Colors you love, occasion, themes, vibes, or anything that helps us picture what you want. If you chose 'Other' for style, tell us more here. The more you share, the better we can make it yours."></textarea>
                  </div>
                </div>
                <p class="co-hint">Have inspiration photos? Reply to our confirmation email with images and we'll add them to your brief.</p>
              </section>

              <div class="co-nav">
                <a class="co-back" href="/catalog">Back to shop</a>
                <button type="submit" class="co-next">Submit My Custom Order</button>
              </div>
            </form>
          </div>
        </section>`,
    })
  );
});

customOrder.get('/thanks', (c) =>
  c.html(
    Layout({
      c,
      title: 'Order received',
      description: 'Your custom order brief has been received.',
      children: html`
        <section class="co-page">
          <div class="wrap co-form-wrap">
            <div class="co-confirm">
              <div class="co-confirm-check">
                <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="#F5F0E8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 16.5l6 6 12-12"></path>
                </svg>
              </div>
              <h2 class="co-confirm-head">You're All Set!</h2>
              <p class="co-confirm-text">
                We're so excited to create something special just for you. We'll be in touch within 1 to 2 business days to talk through your design and get things started.
              </p>
              <p class="co-confirm-text co-studio-line">
                A copy of your design brief has been sent to our studio and you should receive a confirmation email shortly.
              </p>
              <p class="co-confirm-text">
                In the meantime, check us out on
                <a class="co-confirm-link" href="https://www.instagram.com/fromourhandtoyours" target="_blank" rel="noopener noreferrer">Instagram</a>
                for inspiration.
              </p>
              <p class="co-signoff">With love,<br>From Our Hand To Yours</p>
            </div>
          </div>
        </section>`,
    })
  )
);

customOrder.post('/submit', async (c) => {
  // Rate limit by IP: 5 submissions per hour.
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const rl = await consume(c.env, { name: 'custom-order-ip', limit: 5, periodSec: 3600 }, ip).catch(() => null);
  if (rl && !rl.allowed) {
    return c.redirect('/custom-order?error=rate_limited', 303);
  }

  const form = await c.req.parseBody();
  const get = (k: string) => String(form[k] ?? '').trim().slice(0, 2000);
  const getList = (k: string): string[] => {
    const v = form[k];
    if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 80));
    if (typeof v === 'string') return [v.slice(0, 80)];
    return [];
  };

  const firstName = get('firstName');
  const lastName = get('lastName');
  const email = get('email');
  const phone = get('phone');
  const shape = get('shape');
  const length = get('length');
  const quantity = get('quantity');
  const deadline = get('deadline');
  const styles = getList('styles');
  const finishes = getList('finishes');
  const uniformity = get('uniformity');
  const dreamDesign = get('dreamDesign');
  const fingers = {
    thumb: get('finger_thumb'),
    index: get('finger_index'),
    middle: get('finger_middle'),
    ring: get('finger_ring'),
    pinky: get('finger_pinky'),
  };

  if (!firstName || !lastName || !email || !shape || !length) {
    return c.redirect('/custom-order?error=missing_fields', 303);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect('/custom-order?error=invalid_email', 303);
  }

  const ref = 'FOTHY-CO-' + Math.random().toString(36).toUpperCase().slice(-6);

  const studioHtml = buildStudioEmail({
    ref, firstName, lastName, email, phone,
    shape, length, quantity, deadline,
    styles, finishes, uniformity, fingers, dreamDesign,
  });
  const customerHtml = buildCustomerEmail({ firstName, ref });

  // Fire both, don't block on the second.
  c.executionCtx.waitUntil(
    Promise.all([
      sendEmail(c.env, {
        to: 'FromOurHandToYours.CT@gmail.com',
        subject: `New custom order brief — ${firstName} ${lastName} (${ref})`,
        html: studioHtml,
        replyTo: email,
      }),
      sendEmail(c.env, {
        to: email,
        subject: `We received your custom order brief — ${ref}`,
        html: customerHtml,
      }),
    ]).catch((err) => console.warn('custom-order.email.failed', err instanceof Error ? err.message : String(err)))
  );

  return c.redirect('/custom-order/thanks', 303);
});

function errorMessage(code: string): string {
  switch (code) {
    case 'missing_fields': return 'Please fill in the required fields (name, email, shape, length).';
    case 'invalid_email': return 'Please enter a valid email address.';
    case 'rate_limited': return 'Whoa — too many submissions. Please try again in an hour or email us directly at FromOurHandToYours.CT@gmail.com.';
    default: return 'Something went wrong. Please try again.';
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface StudioEmailParams {
  ref: string;
  firstName: string; lastName: string; email: string; phone: string;
  shape: string; length: string; quantity: string; deadline: string;
  styles: string[]; finishes: string[]; uniformity: string;
  fingers: { thumb: string; index: string; middle: string; ring: string; pinky: string };
  dreamDesign: string;
}

function buildStudioEmail(p: StudioEmailParams): string {
  const row = (label: string, value: string) =>
    value ? `<tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;width:140px;vertical-align:top;">${esc(label)}</td><td style="padding:6px 0;color:#2c4a38;font-size:14px;">${esc(value)}</td></tr>` : '';
  const listRow = (label: string, vals: string[]) =>
    vals.length > 0 ? row(label, vals.join(', ')) : '';
  const fingerRows = Object.entries(p.fingers)
    .filter(([, v]) => v)
    .map(([k, v]) => row(`Finger · ${k}`, v))
    .join('');

  return `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:24px;">
    <table style="max-width:640px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 8px;color:#2c4a38;">New custom order brief</h1>
        <p style="font-size:13px;color:#5a7a68;margin:0 0 20px;">Reference: <strong>${esc(p.ref)}</strong></p>
        <table style="width:100%;border-collapse:collapse;">
          ${row('Name', `${p.firstName} ${p.lastName}`)}
          ${row('Email', p.email)}
          ${row('Phone', p.phone)}
          ${row('Shape', p.shape)}
          ${row('Length', p.length)}
          ${row('Quantity', p.quantity)}
          ${row('Need by', p.deadline)}
          ${listRow('Styles', p.styles)}
          ${listRow('Finishes', p.finishes)}
          ${row('Uniformity', p.uniformity)}
          ${fingerRows}
        </table>
        ${p.dreamDesign ? `<div style="margin-top:20px;padding:14px;background:#F5F0E8;border-radius:8px;"><strong style="font-size:13px;color:#5a7a68;">Dream design</strong><p style="margin:8px 0 0;color:#2c4a38;white-space:pre-wrap;">${esc(p.dreamDesign)}</p></div>` : ''}
        <p style="margin-top:24px;font-size:13px;color:#5a7a68;">Reply directly to this email to reach ${esc(p.firstName)}.</p>
      </td></tr>
    </table>
  </body></html>`;
}

function buildCustomerEmail(p: { firstName: string; ref: string }): string {
  return `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:40px;">
    <table style="max-width:520px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;color:#2c4a38;">You're all set, ${esc(p.firstName)}!</h1>
        <p style="font-size:15px;line-height:1.55;">We've received your custom order brief (<strong>${esc(p.ref)}</strong>) and we're so excited to create something just for you.</p>
        <p style="font-size:15px;line-height:1.55;">We'll be in touch within 1 to 2 business days to talk through your design and get things started.</p>
        <p style="font-size:15px;line-height:1.55;">Have inspiration photos? Just reply to this email with images and we'll add them to your brief.</p>
        <p style="font-style:italic;color:#5C8B6E;margin-top:32px;font-family:Georgia,serif;">With love,<br>From Our Hand To Yours</p>
      </td></tr>
    </table>
  </body></html>`;
}

export default customOrder;
