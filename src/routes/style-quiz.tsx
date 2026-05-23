import { Hono } from 'hono';
import { html } from 'hono/html';
import { Layout } from '../views/layout';
import { csrfToken } from '../lib/csrf';
import { consume } from '../lib/rate-limit';
import { sendEmail } from '../lib/email';
import type { Env, HonoVars } from '../types';

const styleQuiz = new Hono<{ Bindings: Env; Variables: HonoVars }>();

const VIBES = ['Casual + comfy', 'Polished + put-together', 'Bold + expressive', 'Classic + minimal'];
const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
const PERSONALITIES = ['Keep it simple', 'A little sparkle', 'Go all out', 'Surprise me'];
const COLORS = ['Neutrals + nudes', 'Pinks + reds', 'Earth tones', 'Pastels', 'Darks + moody', 'Bright + bold'];

function radioPills(name: string, options: string[], required = true) {
  return html`<div class="quiz-pills">
    ${options.map(
      (o) => html`<label class="quiz-pill">
        <input type="radio" name="${name}" value="${o}" ${required ? 'required' : ''}>
        <span>${o}</span>
      </label>`
    )}
  </div>`;
}
function checkPills(name: string, options: string[]) {
  return html`<div class="quiz-pills">
    ${options.map(
      (o) => html`<label class="quiz-pill">
        <input type="checkbox" name="${name}" value="${o}">
        <span>${o}</span>
      </label>`
    )}
  </div>`;
}

styleQuiz.get('/', (c) => {
  const plan = String(c.req.query('plan') ?? '').toLowerCase();
  const tier = plan === 'luxe' ? 'Luxe' : 'Classic';
  const error = c.req.query('error');
  const signedIn = !!c.get('user_id');

  return c.html(
    Layout({
      c,
      title: 'Style Quiz',
      description: 'Tell us your style — our nail tech will curate sets just for you.',
      children: html`
        <section class="quiz-section">
          <div class="wrap" style="max-width: 760px;">
            <span class="eyebrow">Style quiz · ${tier} plan</span>
            <h1 class="quiz-head">Tell us your style.</h1>
            <p class="quiz-sub">Four quick questions. Our nail technician uses these to curate a fresh set for you each month.</p>

            ${error
              ? html`<div class="alert alert-error">${errorMessage(error)}</div>`
              : ''}

            <form class="quiz-card" method="post" action="/style-quiz/submit">
              <input type="hidden" name="_csrf" value="${csrfToken(c)}">
              <input type="hidden" name="plan" value="${tier.toLowerCase()}">

              <fieldset class="quiz-q">
                <legend class="quiz-q-head">Your go-to outfit vibe?</legend>
                ${radioPills('vibe', VIBES)}
              </fieldset>

              <fieldset class="quiz-q">
                <legend class="quiz-q-head">Pick a season</legend>
                ${radioPills('season', SEASONS)}
              </fieldset>

              <fieldset class="quiz-q">
                <legend class="quiz-q-head">Your nail personality?</legend>
                ${radioPills('personality', PERSONALITIES)}
              </fieldset>

              <fieldset class="quiz-q">
                <legend class="quiz-q-head">Colors you gravitate toward?</legend>
                <p class="quiz-q-hint">Select all that apply.</p>
                ${checkPills('colors', COLORS)}
              </fieldset>

              ${signedIn
                ? ''
                : html`<fieldset class="quiz-q">
                    <legend class="quiz-q-head">Your email</legend>
                    <p class="quiz-q-hint">So we can send you a confirmation and any follow-up notes.</p>
                    <input type="email" name="email" required maxlength="200" placeholder="you@example.com" class="quiz-email">
                  </fieldset>`}

              <div class="quiz-nav">
                <a class="btn-link" href="/subscriptions">← Back to plans</a>
                <button type="submit" class="btn btn-primary btn-lg">Save my style</button>
              </div>
            </form>
          </div>
        </section>`,
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
        <section class="quiz-section">
          <div class="wrap" style="max-width: 640px; text-align: center;">
            <div class="co-confirm">
              <div class="co-confirm-check">
                <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="#F5F0E8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 16.5l6 6 12-12"></path>
                </svg>
              </div>
              <h2 class="co-confirm-head">Style saved!</h2>
              <p class="co-confirm-text">Your style answers have been sent to our nail technician. Next: pick up your ${tier} subscription and you'll get a fresh, curated set each month.</p>
              <div style="display:inline-flex;gap:12px;margin-top:18px;flex-wrap:wrap;justify-content:center;">
                <a class="btn btn-primary" href="/subscriptions">Start ${tier} subscription</a>
                <a class="btn btn-secondary" href="/catalog">Keep shopping</a>
              </div>
              <p class="co-signoff">With love,<br>From Our Hand To Yours</p>
            </div>
          </div>
        </section>`,
    })
  );
});

styleQuiz.post('/submit', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const rl = await consume(c.env, { name: 'style-quiz-ip', limit: 10, periodSec: 3600 }, ip).catch(() => null);
  if (rl && !rl.allowed) {
    return c.redirect('/style-quiz?error=rate_limited', 303);
  }
  const form = await c.req.parseBody();
  const get = (k: string) => String(form[k] ?? '').trim().slice(0, 200);
  const getList = (k: string): string[] => {
    const v = form[k];
    if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 80));
    if (typeof v === 'string') return [v.slice(0, 80)];
    return [];
  };

  const plan = get('plan') === 'luxe' ? 'Luxe' : 'Classic';
  const vibe = get('vibe');
  const season = get('season');
  const personality = get('personality');
  const colors = getList('colors');
  let email = get('email').toLowerCase();

  const userId = c.get('user_id');
  if (!email && userId) {
    const user = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(userId).first<{ email: string }>().catch(() => null);
    if (user?.email) email = user.email;
  }

  if (!vibe || !season || !personality || colors.length === 0) {
    return c.redirect(`/style-quiz?plan=${encodeURIComponent(plan.toLowerCase())}&error=missing_fields`, 303);
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.redirect(`/style-quiz?plan=${encodeURIComponent(plan.toLowerCase())}&error=invalid_email`, 303);
  }

  const studioHtml = `<!DOCTYPE html><html><body style="font-family:Helvetica,Arial,sans-serif;color:#2c4a38;background:#F5F0E8;padding:24px;">
    <table style="max-width:600px;margin:0 auto;background:#fefdfb;border-radius:12px;padding:32px;border:1px solid #b8d4c4;">
      <tr><td>
        <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 16px;color:#2c4a38;">New style quiz · ${esc(plan)}</h1>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;width:140px;">Email</td><td style="font-size:14px;">${esc(email || '(no email — signed in user)')}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;">Outfit vibe</td><td style="font-size:14px;">${esc(vibe)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;">Season</td><td style="font-size:14px;">${esc(season)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;">Nail personality</td><td style="font-size:14px;">${esc(personality)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0;color:#5a7a68;font-size:13px;">Colors</td><td style="font-size:14px;">${esc(colors.join(', '))}</td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;

  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: 'FromOurHandToYours.CT@gmail.com',
      subject: `New style quiz — ${plan} plan`,
      html: studioHtml,
      replyTo: email || undefined,
    }).catch((err) => console.warn('style-quiz.email.failed', err instanceof Error ? err.message : String(err)))
  );

  return c.redirect(`/style-quiz/thanks?plan=${encodeURIComponent(plan.toLowerCase())}`, 303);
});

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function errorMessage(code: string): string {
  switch (code) {
    case 'missing_fields': return 'Please answer all four questions.';
    case 'invalid_email': return 'Please enter a valid email address.';
    case 'rate_limited': return 'Too many submissions. Please try again in an hour.';
    default: return 'Something went wrong. Please try again.';
  }
}

export default styleQuiz;
