import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth';
import { submitReview, ReviewError } from '../lib/reviews';
import { consume, RL_REVIEW_USER } from '../lib/rate-limit';
import type { Env, HonoVars } from '../types';

const reviews = new Hono<{ Bindings: Env; Variables: HonoVars }>();

reviews.post('/:id/review', requireAuth, async (c) => {
  const userId = c.get('user_id')!;
  const productId = c.req.param('id') ?? '';
  // Throttle per-user before doing any Square API work.
  const rl = await consume(c.env, RL_REVIEW_USER, `u${userId}`);
  if (!rl.allowed) {
    return c.redirect(`/product/${encodeURIComponent(productId)}?review_error=rate_limited`, 303);
  }
  const form = await c.req.parseBody();
  const rating = Number(form.rating ?? 0);
  const orderId = String(form.order_id ?? '');
  const title = typeof form.title === 'string' ? form.title : '';
  const body = typeof form.body === 'string' ? form.body : '';
  try {
    await submitReview(c.env, { userId, productId, orderId, rating, title, body });
  } catch (err) {
    if (err instanceof ReviewError) {
      return c.redirect(`/product/${encodeURIComponent(productId)}?review_error=${encodeURIComponent(err.code)}`, 303);
    }
    throw err;
  }
  return c.redirect(`/product/${encodeURIComponent(productId)}?review=submitted`, 303);
});

export default reviews;
