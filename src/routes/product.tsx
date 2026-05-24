import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { getCatalog, getItemById, primaryImageUrl } from '../lib/catalog';
import { formatMoneyCents } from '../lib/money';
import { csrfToken } from '../lib/csrf';
import type { Env, HonoVars } from '../types';

const SHAPE_KEYWORDS = ['Almond', 'Coffin', 'Round', 'Square', 'Squoval', 'Stiletto', 'Holiday'];

function detectShape(name: string, description: string | null | undefined): string {
  const hay = `${name} ${description ?? ''}`.toLowerCase();
  for (const s of SHAPE_KEYWORDS) {
    if (hay.includes(s.toLowerCase())) return s;
  }
  return 'Almond';
}

const product = new Hono<{ Bindings: Env; Variables: HonoVars }>();

product.get('/:id', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const item = getItemById(snap, c.req.param('id') ?? '');
  if (!item) {
    c.status(404);
    return c.html(
      Layout({
        c,
        title: 'Product not found',
        children: html`<section class="section"><div class="container"><h1>Product not found</h1><p><a href="/catalog">← Back to shop</a></p></div></section>`,
      })
    );
  }

  const primary = primaryImageUrl(snap, item);
  const otherImages = item.imageIds
    .map((id) => snap.imageById[id])
    .filter((img): img is NonNullable<typeof img> => !!img && img.url !== primary);

  const priceLabel = item.variations.length === 1
    ? formatMoneyCents(item.variations[0]!.priceCents)
    : `From ${formatMoneyCents(Math.min(...item.variations.map((v) => v.priceCents)))}`;

  const categoryName = item.categoryIds
    .map((id) => snap.categories.find((cat) => cat.id === id)?.name)
    .find((n): n is string => !!n);
  const categoryLabel = (categoryName ?? 'Press-On Set').toUpperCase();
  const shapeLabel = detectShape(item.name, item.descriptionPlaintext ?? item.description ?? '');

  return c.html(
    Layout({
      c,
      title: item.name,
      description: item.descriptionPlaintext ?? item.description ?? `${item.name} — From Our Hand To Yours`,
      children: html`
        <section style="padding-bottom: 64px;">
          <div class="wrap">
            <nav class="pdp-breadcrumb">
              <a href="/catalog">Shop</a>
              <span>/</span>
              <span>${item.name}</span>
            </nav>

            <div class="pdp">
              <div class="pdp-gallery">
                ${otherImages.length > 0
                  ? html`<div class="pdp-thumbs pdp-thumbs-side">
                      <button type="button" data-pdp-thumb class="on" data-image-src="${primary}" aria-label="Primary image">
                        <img src="${primary}" alt="" loading="lazy" width="80" height="100">
                      </button>
                      ${otherImages.map(
                        (img) => html`<button type="button" data-pdp-thumb data-image-src="${img.url}" aria-label="${escapeAttr(img.caption ?? item.name)}">
                          <img src="${img.url}" alt="" loading="lazy" width="80" height="100">
                        </button>`
                      )}
                    </div>`
                  : ''}
                <div class="pdp-main">
                  ${primary
                    ? html`<img data-pdp-main src="${primary}" alt="${escapeAttr(item.name)}" width="800" height="800" decoding="async">`
                    : html`<div class="pdp-fallback">No image</div>`}
                </div>
              </div>

              <div class="pdp-info">
                <p class="pdp-category">${categoryLabel}</p>
                <h1>${item.name}</h1>
                <div class="pdp-price">${priceLabel}</div>
                ${item.descriptionPlaintext || item.description
                  ? html`<p class="pdp-desc">${item.descriptionPlaintext ?? item.description}</p>`
                  : ''}

                <div class="pdp-spec-line">
                  <span class="pdp-spec-label">Shape:</span>
                  <span class="pdp-spec-value">${shapeLabel}</span>
                </div>
                <p class="pdp-spec-help">
                  Want this design in a different shape?
                  <a class="pdp-spec-link" href="/custom-order">Design it custom.</a>
                </p>
                <p class="pdp-spec-included">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="#5C8B6E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 8.5l3 3 7-7"></path>
                  </svg>
                  <span>All sizes XS through XL included.</span>
                </p>

                <form class="pdp-addrow" method="post" action="/cart/add" data-cart-form>
                  <input type="hidden" name="_csrf" value="${csrfToken(c)}">
                  ${item.variations.length > 1
                    ? html`<label class="form-field">
                        <span class="form-label">Variation</span>
                        <select name="variation_id" required>
                          ${item.variations.map(
                            (v) => html`<option value="${v.id}">${v.name || 'Default'} — ${formatMoneyCents(v.priceCents)}</option>`
                          )}
                        </select>
                      </label>`
                    : html`<input type="hidden" name="variation_id" value="${item.variations[0]!.id}">`}
                  <div class="pdp-qty">
                    <label class="form-field form-field-qty">
                      <span class="form-label">Qty</span>
                      <input type="number" name="quantity" value="1" min="1" max="50" required inputmode="numeric">
                    </label>
                    <button type="submit" class="btn btn-primary btn-lg pdp-add-btn">Add to Bag</button>
                  </div>
                </form>

                <div class="acc">
                  <details class="acc-row" open>
                    <summary class="acc-head"><h4>How to Apply</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ol class="acc-list">
                      <li>Start with clean, dry nails.</li>
                      <li>Gently push back cuticles using a cuticle stick.</li>
                      <li>Lightly buff the surface of your natural nail to remove shine. This helps the press-on adhere better.</li>
                      <li>Select the correct nail size for each finger. If between sizes, go with the smaller one for a snug fit.</li>
                      <li>Apply nail glue or an adhesive tab to your natural nail.</li>
                      <li>Press the nail on firmly and hold for at least 30 seconds. Apply pressure from the center outward to remove air bubbles.</li>
                      <li>Repeat for all 10 fingers. Avoid water for at least one hour after application.</li>
                    </ol></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>How to Remove</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ol class="acc-list">
                      <li>Fill a bowl with warm, soapy water or use an acetone-free nail polish remover.</li>
                      <li>Soak your nails for 10 to 15 minutes to loosen the adhesive.</li>
                      <li>Use a cuticle stick to gently lift the edges of the press-on nail. Start from the sides, not the center.</li>
                      <li>Never force or pull a nail off. If it resists, soak for a few more minutes.</li>
                      <li>Once removed, gently buff away any remaining adhesive with a nail buffer or file.</li>
                      <li>Wash your hands thoroughly and apply cuticle oil to rehydrate.</li>
                    </ol></div>
                  </details>
                  <details class="acc-row">
                    <summary class="acc-head"><h4>Nail Care Tips</h4><span class="acc-plus" aria-hidden="true">+</span></summary>
                    <div class="acc-body"><ul class="acc-list acc-list-bullets">
                      <li>Apply cuticle oil daily to keep nails and cuticles healthy.</li>
                      <li>When washing hands, avoid prolonged contact with water when possible.</li>
                      <li>Wear gloves when cleaning or using harsh chemicals.</li>
                      <li>With proper application and care, your press-ons can last even longer. Results vary depending on activity level and adhesive used.</li>
                    </ul></div>
                  </details>
                </div>
              </div>
            </div>
          </div>
        </section>`,
    })
  );
});

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export default product;
