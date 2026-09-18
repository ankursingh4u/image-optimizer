/**
 * Partner API client — the only way to read a Shopify App Pricing (formerly
 * "managed pricing") subscription.
 *
 * With App Pricing the plans live in the Partner Dashboard, not in code, and
 * the contract is NOT exposed through the Admin API's currentAppInstallation.
 * `activeSubscription(appId:, shopId:)` on the Partner API is the canonical
 * "what is this shop subscribed to right now?" query.
 *
 * Env vars (all required for App Pricing to work):
 *   SHOPIFY_PARTNER_ORG_ID            organisation id from the Partner
 *                                     Dashboard URL
 *   SHOPIFY_PARTNER_API_ACCESS_TOKEN  token for a Partner API client that has
 *                                     the "Manage apps" permission
 *   SHOPIFY_APP_GID                   gid://shopify/App/{numeric app id}
 */

const PARTNER_API_VERSION = "2026-07";

// The Partner API allows four requests per second per client, and the gate in
// app.jsx runs on every embedded page load. Cache CONFIRMED subscriptions only,
// briefly: a merchant who just approved a plan is checked immediately (nothing
// cached yet), while a cancellation or freeze is picked up within the TTL.
// A miss is never cached, so we never lock a paying merchant out of the app.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function readEnv() {
  // eslint-disable-next-line no-undef
  const env = process.env;
  return {
    orgId: env.SHOPIFY_PARTNER_ORG_ID,
    token: env.SHOPIFY_PARTNER_API_ACCESS_TOKEN,
    appGid: env.SHOPIFY_APP_GID,
  };
}

/**
 * Whether App Pricing is wired up at all. Until the three env vars are set
 * (i.e. until the Partner API client exists) the caller falls back to the
 * legacy Billing API check, so a half-finished rollout can't paywall anyone.
 */
export function partnerApiConfigured() {
  const { orgId, token, appGid } = readEnv();
  return Boolean(orgId && token && appGid);
}

const ACTIVE_SUBSCRIPTION_QUERY = `#graphql
  query ActiveSubscription($appId: ID!, $shopId: ID!) {
    activeSubscription(appId: $appId, shopId: $shopId) {
      billingPeriod
      cancelAtEndOfCycle
      trialEndsAt
      currentBillingCycle { startTime endTime }
      items {
        handle
        description
        price {
          __typename
          ... on FlatRatePrice { amount currency }
        }
      }
    }
  }`;

/**
 * Fetch the shop's active App Pricing contract, or null if it has none.
 *
 * Throws on a throttled or otherwise failed request. That is deliberate: the
 * caller must be able to tell "this shop has no subscription" apart from "we
 * couldn't ask", because treating the latter as the former would redirect a
 * paying merchant to the plan picker.
 *
 * @param {string} shopId shop GID, e.g. gid://shopify/Shop/5678
 */
export async function fetchActiveSubscription(shopId) {
  const { orgId, token, appGid } = readEnv();
  if (!orgId || !token || !appGid) {
    throw new Error(
      "Partner API is not configured (needs SHOPIFY_PARTNER_ORG_ID, " +
        "SHOPIFY_PARTNER_API_ACCESS_TOKEN and SHOPIFY_APP_GID)"
    );
  }

  const hit = cache.get(shopId);
  if (hit && hit.expiresAt > Date.now()) return hit.subscription;

  const res = await fetch(
    `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION_QUERY,
        variables: { appId: appGid, shopId },
      }),
    }
  );

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.errors) {
    throw new Error(
      `Partner API request failed: ${JSON.stringify(body?.errors ?? res.status)}`
    );
  }

  const subscription = body.data?.activeSubscription ?? null;
  // Only cache a confirmed subscription — see the note on CACHE_TTL_MS.
  if (subscription) {
    cache.set(shopId, { subscription, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return subscription;
}

/** Drop a shop's cached subscription, e.g. right after it returns from the
 *  hosted plan page so the new plan shows up immediately. */
export function invalidateSubscriptionCache(shopId) {
  cache.delete(shopId);
}
