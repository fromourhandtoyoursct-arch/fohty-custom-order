import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import type { Env, HonoVars } from '../types';

const about = new Hono<{ Bindings: Env; Variables: HonoVars }>();

about.get('/about', (c) =>
  c.html(
    Layout({
      c,
      title: 'Our Story',
      description: 'Two best friends turned a shared passion into a handcrafted press-on nail studio.',
      children: html`
        <section class="section-y">
          <div class="wrap" style="max-width: 880px;">
            <span class="story-eyebrow">Our Story</span>
            <h1 class="story-head">
              <span class="story-head-line">Two best friends. One shared passion.</span>
              <span class="story-head-line">Made by hand, uniquely yours.</span>
            </h1>
            <div class="story-body">
              <p>Beautiful nails shouldn't mean hours at a salon. At From Our Hand To Yours, we create custom, handcrafted press-on nails made just for you, designed with care, built to last, and made to be reused again and again.</p>
              <p>We're two best friends and proud small business owners who turned a shared passion into something truly special. One of us is a licensed Nail Technician who believes beauty should feel empowering, personal, and effortless. Every single set is crafted completely by hand, from start to finish, with care and intention built into every step.</p>
              <p>What makes our sets different? Versatility. Each set includes 24 nails, giving you more than one way to wear them. Mix, match, and create multiple looks from a single set.</p>
              <p>Whether you're treating yourself or gifting someone special, our nails are the perfect blend of beauty, confidence, and convenience, handcrafted and made uniquely for you.</p>
            </div>
          </div>
        </section>
        <section class="story-cta">
          <h2 class="story-cta-head">Ready to find your set?</h2>
          <div class="story-cta-actions">
            <a class="story-btn story-btn-primary" href="/catalog">Shop Our Sets</a>
            <a class="story-btn story-btn-ghost" href="/custom-order">Design a Custom Set</a>
          </div>
        </section>`,
    })
  )
);

export default about;
