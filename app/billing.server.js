import prisma from "./db.server";
import {
  fetchActiveSubscription,
  partnerApiConfigured,
} from "./partner-api.server";
import { planByHandle } from "./plans";

/**
 * Single source of truth for billing decisions.
 *
 * The app has moved from manual pricing (appSubscriptionCreate against the
 * Admin API) to Shopify App Pricing, where plans are configured in the Partner
 * Dashboard and Shopify hosts the plan selection page. The app no longer
 * creates or cancels charges; it only reads state.
 *
 * Gating reads that state from the Admin API, which sees an AppSubscription for
 * both billing systems, so shops that subscribed under the old flow keep their
 * access with no migration step. The Partner API is optional enrichment for the
 * Plan page. See resolveSubscription.
 *
 * Env vars:
 *   BILLING_ENFORCED    "true" -> require a subscription from every non-
 *                       grandfathered shop. Anything else -> only test shops
 *                       are gated (the safe default).
 *   BILLING_TEST_SHOPS  comma-separated shop domains that are ALWAYS gated, so
 *                       we keep a working billing sandbox after the app goes
 *                       live.
 *
 * BILLING_TEST_MODE is gone. Under App Pricing there is no `test` flag for us
 * to set — Shopify decides: a development store selecting a plan gets a $0
 * contract automatically, and production stores are always charged for real.
 */
export function resolveBillingMode(shop) {
  // eslint-disable-next-line no-undef
  const env = process.env;
  const testShops = (env.BILLING_TEST_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    isTestShop: testShops.includes(shop),
    enforceAll: env.BILLING_ENFORCED === "true",
  };
}

/**
 * Whether a shop installed before billing enforcement was switched on.
 *
 * Fails OPEN: if the lookup errors we treat the shop as grandfathered. A DB
 * blip must never paywall a paying-customer-facing app that previously worked;
 * the worst case is that one shop briefly isn't gated.
 */
export async function isGrandfathered(shop) {
  try {
    const row = await prisma.grandfatheredShop.findUnique({ where: { shop } });
    return Boolean(row);
  } catch (err) {
    console.error(
      "[billing] grandfather lookup failed for %s — failing open:",
      shop,
      err?.message
    );
    return true;
  }
}

/**
 * Whether this shop must have an active subscription to use the app.
 *
 * Test shops are always gated (that's the point of listing them). Otherwise a
 * shop is gated only when enforcement is on AND it isn't grandfathered.
 */
export async function shopIsGated(shop) {
  const { isTestShop, enforceAll } = resolveBillingMode(shop);
  if (isTestShop) return true;
  if (!enforceAll) return false;
  return !(await isGrandfathered(shop));
}

/**
 * The shop's active AppSubscription as seen by the Admin API.
 *
 * This is the gate's source of truth, and it covers BOTH billing systems:
 * a manual-pricing subscription is an AppSubscription by construction, and an
 * App Pricing contract also has one — that's what the Partner API exposes as
 * `ActiveSubscription.legacySubscriptionId`. So this single query answers
 * "is this shop paying?" without any Partner API credentials.
 *
 * What it can't tell us is WHICH tier, because the Admin API has no notion of
 * an App Pricing plan handle. That only matters for display, and only once the
 * tiers stop being feature-identical — see resolveSubscription.
 */
async function fetchAdminSubscription(admin) {
  const resp = await admin.graphql(
    `#graphql
      query ActiveSubs {
        currentAppInstallation {
          activeSubscriptions {
            id
            name
            status
            test
            createdAt
            currentPeriodEnd
            lineItems {
              plan {
                pricingDetails {
                  ... on AppRecurringPricing {
                    interval
                    price { amount currencyCode }
                  }
                }
              }
            }
          }
        }
      }`
  );
  const subs =
    (await resp.json())?.data?.currentAppInstallation?.activeSubscriptions || [];
  return subs.find((s) => s.status === "ACTIVE") || null;
}

/**
 * Resolve the shop's subscription.
 *
 * Returns a shape the UI can render directly:
 *   { source, name, handle, amount, currency, trialEndsAt, renewsOn,
 *     cancelAtEndOfCycle, startedOn }
 * ...or null when the shop genuinely has no subscription.
 *
 * `unavailable: true` comes back instead when we could not determine the state.
 * Callers MUST NOT treat that as "unsubscribed" — see the gate in app.jsx.
 *
 * The Admin API is the gate; the Partner API is optional enrichment. That split
 * is deliberate: gating only needs a yes/no, which the app's own access token
 * can answer, so billing keeps working without a Partner API client. The
 * Partner API adds the plan handle, real trial end and cancel-at-period-end
 * flag — nice to display, never load-bearing. If it's unconfigured or erroring,
 * the merchant still gets in.
 */
export async function resolveSubscription(admin, shopGid) {
  // 1. The gate. Covers manual-pricing and App Pricing subscriptions alike.
  let sub;
  try {
    sub = await fetchAdminSubscription(admin);
  } catch (err) {
    console.error("[billing] subscription lookup failed:", err?.message);
    return { unavailable: true };
  }

  if (!sub) return null;

  const pricing = sub.lineItems?.[0]?.plan?.pricingDetails || null;
  const resolved = {
    source: "admin-api",
    handle: null,
    name: sub.name || "Current plan",
    amount: pricing?.price?.amount ? Number(pricing.price.amount) : null,
    currency: pricing?.price?.currencyCode || "USD",
    trialEndsAt: null,
    cancelAtEndOfCycle: false,
    renewsOn: sub.currentPeriodEnd || null,
    startedOn: sub.createdAt || null,
    test: Boolean(sub.test),
  };

  // 2. Optional enrichment. Never changes whether the merchant gets in, so a
  //    failure here is logged and swallowed rather than surfaced.
  if (partnerApiConfigured() && shopGid) {
    try {
      const contract = await fetchActiveSubscription(shopGid);
      if (contract) {
        const item = contract.items?.[0] || null;
        const known = item ? planByHandle(item.handle) : null;
        const flatRate =
          item?.price?.__typename === "FlatRatePrice" ? item.price : null;

        resolved.source = "app-pricing";
        resolved.handle = item?.handle || null;
        resolved.name = known?.name || item?.description || resolved.name;
        resolved.amount =
          known?.amount ??
          (flatRate ? Number(flatRate.amount) : resolved.amount);
        resolved.currency = known?.currency || flatRate?.currency || resolved.currency;
        resolved.trialEndsAt = contract.trialEndsAt || null;
        resolved.cancelAtEndOfCycle = Boolean(contract.cancelAtEndOfCycle);
        resolved.renewsOn =
          contract.currentBillingCycle?.endTime || resolved.renewsOn;
        resolved.startedOn =
          contract.currentBillingCycle?.startTime || resolved.startedOn;
      }
    } catch (err) {
      console.error(
        "[billing] Partner API enrichment failed (ignored):",
        err?.message
      );
    }
  }

  return resolved;
}

/**
 * URL of the Shopify-hosted plan selection page.
 *
 * This replaces the app's own pricing screen and the /app/subscribe action:
 * Shopify renders the plans, takes the approval, applies the trial and handles
 * upgrades, downgrades and cancellation. Note this path only exists for apps on
 * App Pricing — under manual pricing it 404s, which is why the old code linked
 * to Settings > Billing instead.
 */
export function planSelectionUrl(shopDomain, appHandle) {
  const store = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}/charges/${appHandle}/pricing_plans`;
}

/**
 * The app's handle, read from the Admin API rather than hardcoded.
 *
 * shopify.app.toml has no `handle` key, and the handle is what the plan
 * selection URL is keyed on, so getting it wrong sends merchants to a 404.
 * Asking Shopify keeps the two in sync by construction.
 */
export async function fetchAppHandle(admin) {
  try {
    const resp = await admin.graphql(
      `#graphql
        query AppHandle { currentAppInstallation { app { handle } } }`
    );
    return (await resp.json())?.data?.currentAppInstallation?.app?.handle || null;
  } catch (err) {
    console.error("[billing] app handle lookup failed:", err?.message);
    return null;
  }
}

/**
 * The shop's GID, which the Partner API requires instead of the domain.
 *
 * Returns null rather than throwing: the gate runs on every page load, and a
 * transient Admin API failure here would otherwise blow up the whole route.
 * A null GID just means the Plan page skips Partner API enrichment; gating is
 * unaffected because it doesn't use the GID at all.
 */
export async function fetchShopGid(admin) {
  try {
    const resp = await admin.graphql(`#graphql
      query ShopId { shop { id } }`);
    return (await resp.json())?.data?.shop?.id || null;
  } catch (err) {
    console.error("[billing] shop GID lookup failed:", err?.message);
    return null;
  }
}
