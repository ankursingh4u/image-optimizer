import prisma from "./db.server";

/**
 * Single source of truth for code-managed billing decisions.
 *
 * Previously each route recomputed `isTest` from env inline, which meant the
 * gate, the subscribe action and the plan page could silently disagree about
 * whether a charge was test or live. They all go through here now.
 *
 * Env vars:
 *   BILLING_ENFORCED    "true" -> require a subscription from every non-
 *                       grandfathered shop. Anything else -> only test shops
 *                       are gated (the safe default).
 *   BILLING_TEST_MODE   "false" -> real charges. Anything else -> test charges.
 *   BILLING_TEST_SHOPS  comma-separated shop domains that are ALWAYS gated and
 *                       ALWAYS billed in test mode, so we keep a working
 *                       billing sandbox after the app goes live. (Shopify
 *                       rejects real charges on development stores, so a dev
 *                       store must stay on test charges.)
 */
export function resolveBillingMode(shop) {
  // eslint-disable-next-line no-undef
  const env = process.env;
  const testShops = (env.BILLING_TEST_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isTestShop = testShops.includes(shop);

  return {
    isTestShop,
    enforceAll: env.BILLING_ENFORCED === "true",
    // Test charges globally, or always for an explicitly listed test shop.
    isTest: env.BILLING_TEST_MODE !== "false" || isTestShop,
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
 * Pick the shop's active subscription, matching test/live to the current mode.
 * In test mode only test subscriptions count, and vice versa — otherwise a
 * leftover test subscription would grant free access once the app goes live.
 */
export function findActiveSubscription(subs, isTest) {
  return (
    (subs || []).find(
      (s) => s.status === "ACTIVE" && Boolean(s.test) === isTest
    ) || null
  );
}
