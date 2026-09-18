/**
 * Display metadata for the app's Shopify App Pricing plans.
 *
 * IMPORTANT: this file does not *define* the plans. With Shopify App Pricing
 * the real plans — prices, trial length, billing interval — live in the Partner
 * Dashboard, and Shopify hosts the page merchants pick them on. Everything here
 * is presentation only: it maps the plan `handle` that the Partner API returns
 * onto a name and price so the in-app Plan page can show something friendly
 * without a second round trip.
 *
 * The handles MUST match the ones configured in the Partner Dashboard. If they
 * drift, the Plan page falls back to the description and price that the Partner
 * API itself returns, so a mismatch degrades the copy rather than breaking the
 * page.
 */

// Every tier ships the same five features. The tiers differ on VOLUME, not
// capability — see app/usage.server.js for the quotas actually enforced. The
// summaries below must match LIMITS there and the "Top features" text in the
// Partner Dashboard, or merchants will be shown a limit we don't enforce.
export const PLAN_FEATURES = [
  "AI Alt Text Suggestions",
  "Product Image Optimization",
  "Page Speed Impact Analysis",
  "Performance Score",
  "Core Web Vitals",
];

export const PLANS = [
  {
    handle: "starter",
    name: "Starter",
    amount: 30,
    currency: "USD",
    features: PLAN_FEATURES,
    limits: "500 images · 250 AI alt texts · 10 reports / month",
  },
  {
    handle: "growth",
    name: "Growth",
    amount: 99,
    currency: "USD",
    features: PLAN_FEATURES,
    limits: "2,500 images · 1,500 AI alt texts · 50 reports / month",
  },
  {
    handle: "scale",
    name: "Scale",
    amount: 350,
    currency: "USD",
    features: PLAN_FEATURES,
    limits: "15,000 images · 10,000 AI alt texts · 300 reports / month",
  },
];

export function planByHandle(handle) {
  return PLANS.find((p) => p.handle === handle) || null;
}
