import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from './views/layout';
import { securityHeaders } from './lib/security-headers';
import { csrf } from './lib/csrf';
import { authLoader } from './middleware/auth';
import { sweepAbandonedCarts } from './lib/abandoned-cart';
import { refreshCatalog } from './lib/catalog';
import home from './routes/home';
import about from './routes/about';
import customOrder from './routes/custom-order';
import styleQuiz from './routes/style-quiz';
import catalog from './routes/catalog';
import product from './routes/product';
import cart from './routes/cart';
import checkout from './routes/checkout';
import auth from './routes/auth';
import account from './routes/account';
import search from './routes/search';
import subscriptions from './routes/subscriptions';
import giftcards from './routes/giftcards';
import reviews from './routes/reviews';
import unsubscribe from './routes/unsubscribe';
import webhooks from './routes/webhooks-square';
import health from './routes/health';
import sitemap from './routes/sitemap';
import type { Env, HonoVars } from './types';

const app = new Hono<{ Bindings: Env; Variables: HonoVars }>();

app.use('*', securityHeaders);
app.use('*', csrf);
app.use('*', authLoader);

app.route('/health', health);
app.route('/catalog', catalog);
app.route('/product', product);   // GET /product/:id
app.route('/product', reviews);   // POST /product/:id/review
app.route('/cart', cart);
app.route('/checkout', checkout);
app.route('/account', account);
app.route('/search', search);
app.route('/subscriptions', subscriptions);
app.route('/gift-cards', giftcards);
app.route('/custom-order', customOrder);
app.route('/style-quiz', styleQuiz);
app.route('/unsubscribe', unsubscribe);
app.route('/', auth);
app.route('/', webhooks);
app.route('/', sitemap);
app.route('/', about);
app.route('/', home);

app.notFound((c) =>
  c.html(
    Layout({
      c,
      title: 'Not found',
      children: html`<section class="section"><div class="container">
        <h1>Page not found</h1>
        <p>The page you were looking for doesn't exist (or moved).</p>
        <p><a class="btn btn-secondary" href="/">← Back to home</a></p>
      </div></section>`,
    }),
    404
  )
);

app.onError((err, c) => {
  console.error('app.error', {
    route: c.req.path,
    method: c.req.method,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join('\n') : undefined,
  });
  return c.html(
    Layout({
      c,
      title: 'Something went wrong',
      children: html`<section class="section"><div class="container">
        <h1>Something went wrong</h1>
        <p>We hit an unexpected error. Please try again in a moment.</p>
        <p><a class="btn btn-secondary" href="/">← Back to home</a></p>
      </div></section>`,
    }),
    500
  );
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // wrangler.jsonc declares two cron expressions; cron name is in event.cron.
    if (event.cron === '0 * * * *') {
      ctx.waitUntil(sweepAbandonedCarts(env).then((res) => console.log('cron.abandoned-cart', res)).catch((err) => console.error('cron.abandoned-cart.failed', err instanceof Error ? err.message : String(err))));
    } else if (event.cron === '*/15 * * * *') {
      ctx.waitUntil(refreshCatalog(env).then(() => console.log('cron.catalog.refresh.ok')).catch((err) => console.warn('cron.catalog.refresh.failed', err instanceof Error ? err.message : String(err))));
    }
  },
} satisfies ExportedHandler<Env>;
