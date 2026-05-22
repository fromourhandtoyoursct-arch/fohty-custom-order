/**
 * Square Subscriptions API wrappers.
 *
 * Catalog model (Square's, not ours):
 *   SUBSCRIPTION_PLAN -> SUBSCRIPTION_PLAN_VARIATION -> linked ITEM_VARIATION ID
 *   When a buyer purchases via a Payment Link with a subscription_plan_id
 *   variation, Square auto-creates the subscription.
 *
 * Our DB mirror (`subscriptions` table) is populated via webhooks
 * (subscription.created / subscription.updated).
 *
 * Plans are queried at request-time from Square Catalog (cached via the same
 * KV catalog snapshot infrastructure, but with their own helper functions
 * since they're not in the regular item filter).
 */
import { squareFetch, listCatalog, type SquareCatalogObject } from './square';
import type { Env } from '../types';

export interface SubscriptionPlan {
  id: string;
  name: string;
  description?: string;
  eligibleItemIds: string[];
  variations: SubscriptionPlanVariation[];
}

export interface SubscriptionPlanVariation {
  id: string;
  name: string;
  cadence: string;        // DAILY, WEEKLY, MONTHLY, etc.
  priceCents: number;
  currency: string;
}

/**
 * Returns all subscription plans that have at least one variation.  Reads
 * directly from Square (we don't share storage with the item catalog snapshot
 * since plans change rarely and the dataset is small).
 */
export async function listSubscriptionPlans(env: Env): Promise<SubscriptionPlan[]> {
  const [planResp, varResp] = await Promise.all([
    fetchAllType(env, 'SUBSCRIPTION_PLAN'),
    fetchAllType(env, 'SUBSCRIPTION_PLAN_VARIATION'),
  ]);

  // Map variations by plan id (the variation references its parent plan).
  // In Square, SUBSCRIPTION_PLAN_VARIATION is a sibling object with subscription_plan_variation_data.{phases, name, subscription_plan_id}.
  const byPlan = new Map<string, SubscriptionPlanVariation[]>();
  for (const o of varResp) {
    if (o.is_deleted) continue;
    const d = (o as any).subscription_plan_variation_data ?? {};
    const planId = d.subscription_plan_id;
    if (!planId) continue;
    const phase = (d.phases ?? [])[0];
    if (!phase) continue;
    const price = phase.recurring_price_money?.amount;
    if (!price) continue;
    const arr = byPlan.get(planId) ?? [];
    arr.push({
      id: o.id,
      name: d.name ?? '',
      cadence: phase.cadence ?? '',
      priceCents: price,
      currency: phase.recurring_price_money?.currency ?? 'USD',
    });
    byPlan.set(planId, arr);
  }

  const plans: SubscriptionPlan[] = [];
  for (const o of planResp) {
    if (o.is_deleted) continue;
    const d = (o as any).subscription_plan_data ?? {};
    const vars = byPlan.get(o.id) ?? [];
    if (vars.length === 0) continue;
    plans.push({
      id: o.id,
      name: d.name ?? '',
      description: d.description ?? undefined,
      eligibleItemIds: (d.eligible_item_ids ?? []) as string[],
      variations: vars,
    });
  }
  return plans;
}

async function fetchAllType(env: Env, type: string): Promise<SquareCatalogObject[]> {
  const out: SquareCatalogObject[] = [];
  let cursor: string | undefined = undefined;
  let safety = 20;
  do {
    const resp = await listCatalog(env, type, cursor);
    for (const obj of resp.objects ?? []) out.push(obj);
    cursor = resp.cursor;
    safety -= 1;
  } while (cursor && safety > 0);
  return out;
}

/* ---------------- Lifecycle calls ---------------- */

export interface SquareSubscription {
  id: string;
  location_id: string;
  customer_id: string;
  plan_variation_id?: string;
  status: string; // ACTIVE, PAUSED, CANCELED, DEACTIVATED, INVOICES_GENERATED
  start_date?: string;
  charged_through_date?: string;
  card_id?: string;
}

export async function pauseSubscription(env: Env, id: string): Promise<SquareSubscription | null> {
  const resp = await squareFetch<{ subscription?: SquareSubscription }>(env, `/v2/subscriptions/${encodeURIComponent(id)}/pause`, {
    method: 'POST',
    body: {},
    idempotencyKey: `pause-${id}-${crypto.randomUUID()}`,
  });
  return resp.subscription ?? null;
}

export async function resumeSubscription(env: Env, id: string): Promise<SquareSubscription | null> {
  const resp = await squareFetch<{ subscription?: SquareSubscription }>(env, `/v2/subscriptions/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: {},
    idempotencyKey: `resume-${id}-${crypto.randomUUID()}`,
  });
  return resp.subscription ?? null;
}

export async function cancelSubscription(env: Env, id: string): Promise<SquareSubscription | null> {
  const resp = await squareFetch<{ subscription?: SquareSubscription }>(env, `/v2/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
  return resp.subscription ?? null;
}

export async function retrieveSubscription(env: Env, id: string): Promise<SquareSubscription | null> {
  const resp = await squareFetch<{ subscription?: SquareSubscription }>(env, `/v2/subscriptions/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return resp.subscription ?? null;
}
