import prisma from "./db.server";
import {
  resolveSubscription,
  isGrandfathered,
  resolveBillingMode,
} from "./billing.server";
import { PLANS } from "./plans";

/**
 * Plan quotas, and the counters that enforce them.
 *
 * All three tiers ship the same features; they differ on volume. The metered
 * units are the ones with a real marginal cost:
 *
 *   ai_alt_text        OpenAI / Anthropic calls   (app.alttextsuggestions)
 *   images_optimized   sharp + staged upload      (app.Productoptimization)
 *   pagespeed_reports  Google PSI quota           (app.pagespeedimpactreports)
 *
 * Anything not in this list is unmetered on every plan.
 */

export const METRICS = {
  AI_ALT_TEXT: "ai_alt_text",
  IMAGES_OPTIMIZED: "images_optimized",
  PAGESPEED_REPORTS: "pagespeed_reports",
};

const UNLIMITED = Number.POSITIVE_INFINITY;

export const LIMITS = {
  starter: {
    [METRICS.AI_ALT_TEXT]: 250,
    [METRICS.IMAGES_OPTIMIZED]: 500,
    [METRICS.PAGESPEED_REPORTS]: 10,
  },
  growth: {
    [METRICS.AI_ALT_TEXT]: 1500,
    [METRICS.IMAGES_OPTIMIZED]: 2500,
    [METRICS.PAGESPEED_REPORTS]: 50,
  },
  scale: {
    [METRICS.AI_ALT_TEXT]: 10000,
    [METRICS.IMAGES_OPTIMIZED]: 15000,
    [METRICS.PAGESPEED_REPORTS]: 300,
  },
  unlimited: {
    [METRICS.AI_ALT_TEXT]: UNLIMITED,
    [METRICS.IMAGES_OPTIMIZED]: UNLIMITED,
    [METRICS.PAGESPEED_REPORTS]: UNLIMITED,
  },
};

export const METRIC_LABELS = {
  [METRICS.AI_ALT_TEXT]: "AI alt text generations",
  [METRICS.IMAGES_OPTIMIZED]: "image optimizations",
  [METRICS.PAGESPEED_REPORTS]: "PageSpeed reports",
};

/** Monthly price -> tier. Only consulted when the plan name doesn't resolve.
 *  Keep in sync with the plans configured in the Partner Dashboard. */
const TIER_BY_PRICE = { 30: "starter", 99: "growth", 350: "scale" };

/**
 * Plan name (or handle) -> tier.
 *
 * Checked BEFORE price, because price is not a reliable discriminator. Shopify
 * bills every plan at $0 on a development store, so a dev store on Growth and
 * one on Scale both report $0; a fully-discounted contract in production looks
 * the same. The plan's name survives both cases.
 */
function tierByName(name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  const hit = PLANS.find(
    (p) => p.name.toLowerCase() === n || p.handle.toLowerCase() === n
  );
  return hit ? hit.handle : null;
}

/**
 * Which quota set applies to this shop.
 *
 * Grandfathered shops are UNLIMITED on purpose: they installed under a free app
 * and were promised continued access, so retroactively metering them would
 * break that. They're a fixed, non-growing set.
 *
 * A subscription matching no known tier by either name or price falls back to
 * `starter` — the conservative choice, since the alternative is handing out the
 * most expensive tier to anything unrecognised.
 */
export function tierFor({ subscription, grandfathered }) {
  if (grandfathered) return "unlimited";
  if (!subscription) return "starter";

  const byName = tierByName(subscription.handle || subscription.name);
  if (byName) return byName;

  const byPrice = TIER_BY_PRICE[Math.round(Number(subscription.amount))];
  if (byPrice) return byPrice;

  // An UNNAMED $0 contract is Shopify's private test plan; metering that would
  // make the billing sandbox useless. A named plan never reaches here, so a dev
  // store on Growth still gets Growth's limits — which is what makes the quotas
  // testable at all.
  if (Number(subscription.amount) === 0) return "unlimited";

  console.warn(
    "[usage] unrecognised plan %j at price %s — defaulting to starter limits",
    subscription.name,
    subscription.amount
  );
  return "starter";
}

/** Current quota window, as a UTC "YYYY-MM" key. */
export function currentPeriod(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Everything a metered route needs to decide whether to proceed.
 * One call, so routes don't each re-derive the shop's plan.
 */
export async function quotaContext(admin, session) {
  const { isTestShop } = resolveBillingMode(session.shop);

  const [subscription, hasGrandfatherRow] = await Promise.all([
    resolveSubscription(admin, null),
    isGrandfathered(session.shop),
  ]);

  // A shop listed in BILLING_TEST_SHOPS exists to exercise the PAID path, and
  // the backfill grandfathered every shop that had a session when it ran —
  // which includes our own development store. Without this override that row
  // wins, the store resolves to `unlimited`, and the quotas are untestable.
  // shopIsGated already applies the same override to gating.
  const grandfathered = isTestShop ? false : hasGrandfatherRow;

  // `unavailable` means we couldn't read billing state. Treat it as "no
  // subscription" for quota purposes only — the gate in app.jsx has already
  // decided the merchant may be here, and starter limits are a softer failure
  // than blocking outright.
  const sub = subscription?.unavailable ? null : subscription;
  const tier = tierFor({ subscription: sub, grandfathered });

  return { shop: session.shop, tier, limits: LIMITS[tier] };
}

/** Usage for one metric in the current period. */
export async function usedSoFar(shop, metric) {
  try {
    const row = await prisma.usageCounter.findUnique({
      where: {
        shop_metric_period: { shop, metric, period: currentPeriod() },
      },
    });
    return row?.count ?? 0;
  } catch (err) {
    console.error("[usage] read failed for %s/%s:", shop, metric, err?.message);
    // Fail OPEN. A database blip must not block a paying merchant's work; the
    // cost of briefly under-counting is far lower than a broken app.
    return 0;
  }
}

/**
 * Whether `needed` more of `metric` fits inside the shop's quota.
 *
 * Returns { allowed, limit, used, remaining }. Callers should surface `message`
 * to the merchant rather than failing silently.
 */
export async function checkQuota(ctx, metric, needed = 1) {
  const limit = ctx.limits?.[metric] ?? UNLIMITED;
  if (limit === UNLIMITED) {
    return { allowed: true, limit, used: 0, remaining: UNLIMITED };
  }

  const used = await usedSoFar(ctx.shop, metric);
  const remaining = Math.max(0, limit - used);

  return {
    allowed: needed <= remaining,
    limit,
    used,
    remaining,
  };
}

/** Human-readable refusal for a failed checkQuota. */
export function quotaMessage(metric, check) {
  const label = METRIC_LABELS[metric] || metric;
  if (check.remaining === 0) {
    return `You've used all ${check.limit} ${label} included in your plan this month. Upgrade from the Plan page for a higher limit, or wait for the counter to reset next month.`;
  }
  return `That would exceed your monthly limit of ${check.limit} ${label} — you have ${check.remaining} left. Upgrade from the Plan page for a higher limit.`;
}

/**
 * Record consumption. Best-effort: a failure here is logged but never breaks
 * the operation the merchant just paid for, so an outage under-counts rather
 * than double-charging or erroring after the work is already done.
 */
export async function recordUsage(shop, metric, amount = 1) {
  if (!amount || amount < 1) return;
  const period = currentPeriod();
  try {
    await prisma.usageCounter.upsert({
      where: { shop_metric_period: { shop, metric, period } },
      create: { shop, metric, period, count: amount },
      update: { count: { increment: amount } },
    });
  } catch (err) {
    console.error(
      "[usage] failed to record %s x%s for %s:",
      metric,
      amount,
      shop,
      err?.message
    );
  }
}

/** Every metric's usage for the current period — for the Plan page. */
export async function usageSummary(ctx) {
  const entries = await Promise.all(
    Object.values(METRICS).map(async (metric) => {
      const limit = ctx.limits?.[metric] ?? UNLIMITED;
      const used = limit === UNLIMITED ? 0 : await usedSoFar(ctx.shop, metric);
      return {
        metric,
        label: METRIC_LABELS[metric],
        used,
        // Infinity doesn't survive JSON serialisation to the client.
        limit: limit === UNLIMITED ? null : limit,
      };
    })
  );
  return entries;
}
