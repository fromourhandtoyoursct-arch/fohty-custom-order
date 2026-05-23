import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { ProductCard } from '../views/components/product-card';
import { getCatalog } from '../lib/catalog';
import type { Env, HonoVars } from '../types';

const home = new Hono<{ Bindings: Env; Variables: HonoVars }>();

home.get('/', async (c) => {
  const snap = await getCatalog(c.env, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) });
  const featured = snap.items.slice(0, 8);

  return c.html(
    Layout({
      c,
      title: c.env.EMAIL_FROM_NAME,
      description: 'Hand-crafted press-on nail sets. Made in small batches by us.',
      children: html`
        <section class="hero">
          <div class="wrap">
            <div class="hero-title">
              <h1>Mix. Match. Make it <span class="serif-italic">uniquely yours.</span></h1>
              <div class="hero-tagline">
                <span>24 Nails. One Set.</span>
                <span class="sep" aria-hidden="true">|</span>
                <span>Multiple Looks</span>
                <span class="sep" aria-hidden="true">|</span>
                <span>Reusable &amp; Built to Last</span>
                <span class="sep" aria-hidden="true">|</span>
                <span>Handcrafted by a Licensed Nail Tech</span>
              </div>
              <div class="hero-cta-row">
                <a class="btn btn-primary btn-lg hero-cta" href="/catalog">
                  Fresh from our hands
                  <span class="hero-cta-arrow" aria-hidden="true">→</span>
                </a>
              </div>
            </div>
            <div class="hero-strip">
              <div class="ph ph-warm"><span class="ph-label">hero · peach lace</span></div>
              <div class="ph ph-mist"><span class="ph-label">detail · linen</span></div>
              <div class="ph ph-ink"><span class="ph-label">set · iris</span></div>
            </div>
          </div>
        </section>

        <section class="section-y">
          <div class="wrap">
            ${featured.length === 0
              ? html`<p class="empty-state">Our shop is being prepared. Please check back soon.</p>`
              : html`<div class="cgrid">
                  ${featured.map((it) => ProductCard({ item: it, snap }))}
                </div>`}
          </div>
        </section>`,
    })
  );
});

export default home;
