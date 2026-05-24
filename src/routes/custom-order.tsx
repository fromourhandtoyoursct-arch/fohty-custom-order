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

            <div class="co-progress">
              <div class="co-progress-bar"><div class="co-progress-fill" data-co-fill style="width: 25%;"></div></div>
              <div class="co-progress-labels">
                <span class="co-progress-label co-state-on" data-co-label="1">You</span>
                <span class="co-progress-label co-state-off" data-co-label="2">Nails</span>
                <span class="co-progress-label co-state-off" data-co-label="3">Design</span>
                <span class="co-progress-label co-state-off" data-co-label="4">Finish</span>
              </div>
            </div>

            <form class="co-card" method="post" action="/custom-order/submit" enctype="multipart/form-data" data-co-form>
              <input type="hidden" name="_csrf" value="${csrfToken(c)}">

              <section class="co-step" data-co-pane="1">
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

              <section class="co-step" data-co-pane="2" hidden>
                <h3 class="co-step-head">Pick your nail basics</h3>
                <div class="co-group">
                  <label class="co-group-label">Nail Shape <span class="co-req">*</span></label>
                  <div class="co-pills">
                    ${SHAPES.map(
                      (s) => html`<label class="co-pill">
                        <input type="radio" name="shape" value="${s}" required>
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

              <section class="co-step" data-co-pane="3" hidden>
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
                  <p class="co-hint">Select all that apply. If you chose "Other," you can describe or show us in the next step.</p>
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
                  <p class="co-hint">Select all that apply.</p>
                </div>
                <div class="co-group">
                  <label class="co-group-label">Same design on all fingers?</label>
                  <div class="co-pills" data-uniformity-group>
                    ${UNIFORMITY.map(
                      (s) => html`<label class="co-pill">
                        <input type="radio" name="uniformity" value="${s}" data-uniformity="${s}">
                        <span>${s}</span>
                      </label>`
                    )}
                  </div>
                </div>
                <div class="co-finger-builder" data-co-finger hidden>
                  <label class="co-group-label">What do you want on each finger?</label>
                  <p class="co-hint">Describe the color or design for each finger. Both hands will match unless you tell us otherwise.</p>
                  <div class="co-fingers">
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_thumb" maxlength="160" placeholder="e.g. sage green"><div class="co-finger-label">Thumb</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_index" maxlength="160" placeholder="e.g. glitter accent"><div class="co-finger-label">Index</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_middle" maxlength="160" placeholder="e.g. French tip"><div class="co-finger-label">Middle</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_ring" maxlength="160" placeholder="e.g. crystals"><div class="co-finger-label">Ring</div></div>
                    <div class="co-finger"><div class="co-nail" aria-hidden="true"></div><input name="finger_pinky" maxlength="160" placeholder="e.g. solid pink"><div class="co-finger-label">Pinky</div></div>
                  </div>
                </div>
              </section>

              <section class="co-step" data-co-pane="4" hidden>
                <h3 class="co-step-head">Final touches</h3>
                <div class="co-row">
                  <div class="co-fld">
                    <label for="co-dream">Tell us about your dream design</label>
                    <textarea id="co-dream" name="dreamDesign" rows="4" maxlength="2000" placeholder="Colors you love, occasion, themes, vibes, or anything that helps us picture what you want. If you chose 'Other' for style, tell us more here. The more you share, the better we can make it yours."></textarea>
                  </div>
                </div>
                <div class="co-row">
                  <div class="co-fld">
                    <label>Inspiration photos (optional)</label>
                    <label class="co-upload" data-co-drop>
                      <span class="co-upload-text">Tap to add photos or <span class="co-upload-browse">browse</span></span>
                      <span class="co-upload-hint">PNG, JPG, HEIC up to 10MB each — names sent with your brief; reply to the confirmation email to attach the actual images.</span>
                      <input type="file" multiple accept="image/*" data-co-files style="display:none;">
                    </label>
                    <input type="hidden" name="photo_names" data-co-photo-names value="">
                    <div class="co-photo-tags" data-co-photo-tags></div>
                  </div>
                </div>
              </section>

              <div class="co-nav">
                <button type="button" class="co-back" data-co-prev hidden>Back</button>
                <a class="co-back" href="/catalog" data-co-back-shop>Back to shop</a>
                <button type="button" class="co-next" data-co-next>Next</button>
                <button type="submit" class="co-next" data-co-submit hidden>Submit My Custom Order</button>
              </div>
            </form>

            <script>
              (function () {
                var STEP = 1;
                var TOTAL = 4;
                var panes = document.querySelectorAll('[data-co-pane]');
                var labels = document.querySelectorAll('[data-co-label]');
                var fill = document.querySelector('[data-co-fill]');
                var nextBtn = document.querySelector('[data-co-next]');
                var submitBtn = document.querySelector('[data-co-submit]');
                var prevBtn = document.querySelector('[data-co-prev]');
                var shopLink = document.querySelector('[data-co-back-shop]');

                function show(n) {
                  STEP = n;
                  panes.forEach(function (p) {
                    var on = parseInt(p.dataset.coPane, 10) === n;
                    p.hidden = !on;
                  });
                  labels.forEach(function (l) {
                    var i = parseInt(l.dataset.coLabel, 10);
                    l.classList.toggle('co-state-on', i === n);
                    l.classList.toggle('co-state-done', i < n);
                    l.classList.toggle('co-state-off', i > n);
                  });
                  fill.style.width = Math.round(n / TOTAL * 100) + '%';
                  if (n === 1) { prevBtn.hidden = true; shopLink.hidden = false; }
                  else { prevBtn.hidden = false; shopLink.hidden = true; }
                  if (n === TOTAL) { nextBtn.hidden = true; submitBtn.hidden = false; }
                  else { nextBtn.hidden = false; submitBtn.hidden = true; }
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }
                function validateStep(n) {
                  var pane = document.querySelector('[data-co-pane="' + n + '"]');
                  if (!pane) return true;
                  var ok = true;
                  pane.querySelectorAll('input[required]').forEach(function (el) {
                    if (!el.reportValidity()) ok = false;
                  });
                  return ok;
                }
                nextBtn.addEventListener('click', function () {
                  if (!validateStep(STEP)) return;
                  if (STEP < TOTAL) show(STEP + 1);
                });
                prevBtn.addEventListener('click', function () {
                  if (STEP > 1) show(STEP - 1);
                });

                // Conditional finger builder
                document.querySelectorAll('[data-uniformity]').forEach(function (input) {
                  input.addEventListener('change', function () {
                    var show = input.value === 'No, I want variety' && input.checked;
                    var builder = document.querySelector('[data-co-finger]');
                    if (builder) builder.hidden = !show;
                  });
                });

                // File upload (client-side: capture names only)
                var fileInput = document.querySelector('[data-co-files]');
                var drop = document.querySelector('[data-co-drop]');
                var tags = document.querySelector('[data-co-photo-tags]');
                var hidden = document.querySelector('[data-co-photo-names]');
                var photoList = [];
                function renderPhotos() {
                  if (!tags) return;
                  tags.innerHTML = photoList.map(function (name, i) {
                    return '<span class="co-photo-tag">' + name.replace(/[&<>"]/g, function (c) {
                      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
                    }) + '<button type="button" class="co-photo-rm" data-co-rm="' + i + '" aria-label="Remove">×</button></span>';
                  }).join('');
                  hidden.value = photoList.join('|');
                }
                function addFiles(files) {
                  Array.from(files || []).forEach(function (f) { photoList.push(f.name); });
                  renderPhotos();
                }
                if (fileInput) fileInput.addEventListener('change', function (e) { addFiles(e.target.files); });
                if (drop) {
                  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('on'); });
                  drop.addEventListener('dragleave', function () { drop.classList.remove('on'); });
                  drop.addEventListener('drop', function (e) {
                    e.preventDefault();
                    drop.classList.remove('on');
                    addFiles(e.dataTransfer && e.dataTransfer.files);
                  });
                }
                if (tags) {
                  tags.addEventListener('click', function (e) {
                    var btn = e.target.closest('[data-co-rm]');
                    if (!btn) return;
                    var i = parseInt(btn.dataset.coRm, 10);
                    photoList.splice(i, 1);
                    renderPhotos();
                  });
                }

                show(1);
              })();
            </script>
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
  const photoNames = get('photo_names').split('|').filter(Boolean).slice(0, 12);

  if (!firstName || !lastName || !email || !shape || !length) {
    return c.redirect('/custom-order?error=missing_fields', 303);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect('/custom-order?error=invalid_email', 303);
  }

  const ref = 'FOTHY-CO-' + Math.random().toString(36).toUpperCase().slice(-6);

  // Persist the brief so it shows up in /account.
  try {
    await c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS custom_orders (
        id TEXT PRIMARY KEY, user_id INTEGER, email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting-review', brief_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`
    ).run().catch(() => undefined);
    const userId = c.get('user_id') ?? null;
    let linkedUserId: number | null = userId ?? null;
    if (!linkedUserId) {
      const u = await c.env.DB.prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`).bind(email.toLowerCase()).first<{ id: number }>().catch(() => null);
      if (u) linkedUserId = u.id;
    }
    const brief = { firstName, lastName, email, phone, shape, length, quantity, deadline, styles, finishes, uniformity, fingers, dreamDesign, photoNames };
    await c.env.DB.prepare(
      `INSERT INTO custom_orders (id, user_id, email, brief_json) VALUES (?, ?, ?, ?)`
    ).bind(ref, linkedUserId, email.toLowerCase(), JSON.stringify(brief)).run();
  } catch (err) {
    console.warn('custom-order.persist.failed', err instanceof Error ? err.message : String(err));
  }

  const studioHtml = buildStudioEmail({
    ref, firstName, lastName, email, phone,
    shape, length, quantity, deadline,
    styles, finishes, uniformity, fingers, dreamDesign, photoNames,
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
  photoNames?: string[];
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
        ${p.photoNames && p.photoNames.length > 0 ? `<div style="margin-top:14px;padding:14px;background:#F5F0E8;border-radius:8px;"><strong style="font-size:13px;color:#5a7a68;">Inspiration photos attached by name</strong><ul style="margin:8px 0 0;padding-left:18px;color:#2c4a38;font-size:14px;">${p.photoNames.map((n) => `<li>${esc(n)}</li>`).join('')}</ul><p style="margin:8px 0 0;font-size:12px;color:#5a7a68;font-style:italic;">Ask ${esc(p.firstName)} to reply with the images.</p></div>` : ''}
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
