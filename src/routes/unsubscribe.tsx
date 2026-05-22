import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { consumeUnsubscribeToken } from '../lib/abandoned-cart';
import type { Env, HonoVars } from '../types';

const unsub = new Hono<{ Bindings: Env; Variables: HonoVars }>();

unsub.get('/:token', async (c) => {
  const token = c.req.param('token') ?? '';
  const result = await consumeUnsubscribeToken(c.env, token);
  return c.html(
    Layout({
      c,
      title: 'Unsubscribed',
      children: html`
        <section class="section">
          <div class="container narrow-col">
            <header class="page-header">
              <h1>${result ? "You're unsubscribed" : 'Invalid link'}</h1>
              <p>${result ? `We've removed your email from future marketing reminders.` : "This unsubscribe link has already been used or expired."}</p>
            </header>
            <a class="btn btn-secondary" href="/">Back to home</a>
          </div>
        </section>`,
    })
  );
});

export default unsub;
