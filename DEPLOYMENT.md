# Deployment

This app is hosted on a self-managed **Coolify** server and deploys automatically.

## Push-to-deploy

Pushing to the `main` branch of `github.com/ankursingh4u/image-optimizer` triggers
an automatic build & deploy on Coolify (via a GitHub webhook → Coolify manual
webhook receiver). No manual step required.

```bash
git add -A
git commit -m "your change"
git push origin main   # Coolify builds and deploys automatically
```

## Manual deploy (fallback)

If you ever need to trigger a deploy by hand:

```bash
curl "http://<coolify-host>:8000/api/v1/deploy?uuid=<app-uuid>&force=true" \
  -H "Authorization: Bearer <coolify-api-token>"
```

## Configuration

- Runtime config lives in Coolify env vars (never committed): Shopify keys,
  `DATABASE_URL`, AI keys, etc.
- Database schema is created on boot via `prisma db push`.
- Live URL: https://imageoptimizer.onkra.online

## Billing (Shopify App Pricing)

Plans are **not** defined in this repo. They live in the Partner Dashboard
(App listing → Pricing → Pricing method: *Shopify App Pricing*), and Shopify
hosts the page merchants subscribe on. The app only *reads* subscription state.

Required Coolify env vars:

| Var | Value |
| --- | --- |
| `BILLING_ENFORCED` | `true` to gate every non-grandfathered shop |
| `BILLING_TEST_SHOPS` | `optimizer-testing.myshopify.com` |

`BILLING_TEST_MODE` is **obsolete** — remove it. App Pricing has no test flag:
Shopify gives development stores a $0 contract automatically and always charges
production stores for real.

### Optional: Partner API enrichment

Gating works with the app's own access token — an App Pricing contract creates
an `AppSubscription` that the Admin API can see, which is all a yes/no gate
needs. Setting the vars below additionally shows the plan handle, real trial end
date and cancel-at-period-end flag on the Plan page. If they're unset or the
request fails, the merchant still gets in.

| Var | Value |
| --- | --- |
| `SHOPIFY_PARTNER_ORG_ID` | `203802642` (LEED SPHERE TECHNOLOGIES LTD) |
| `SHOPIFY_PARTNER_API_ACCESS_TOKEN` | Partner API client token with the **Manage apps** permission — *not* an App Automation Token (`atkn_…`), which 401s on the Partner API |
| `SHOPIFY_APP_GID` | `gid://shopify/App/{numeric app id}` — the number in the app's Partner Dashboard URL |

The Admin API reports the contract's **price** but not its App Pricing handle,
which is enough to identify the tier (see `TIER_BY_PRICE` in
`app/usage.server.js`). The Partner API adds the handle itself, which only
matters if two plans ever share a price.

### Plan quotas

All three tiers ship the same five features and differ on volume only.
`app/usage.server.js` holds the limits and `UsageCounter` holds the tallies,
keyed by `(shop, metric, "YYYY-MM")` — quotas reset on the calendar month.

| Metric | Starter $30 | Growth $99 | Scale $350 |
| --- | --- | --- | --- |
| `images_optimized` | 500 | 2,500 | 15,000 |
| `ai_alt_text` | 250 | 1,500 | 10,000 |
| `pagespeed_reports` | 10 | 50 | 300 |

Grandfathered shops and $0 development-store contracts are **unlimited**. These
numbers must match the "Top features" copy on each plan in the Partner
Dashboard, or merchants are shown a limit that isn't enforced.

Counting is deliberately conservative — only billable work is charged:
already-optimized images, AI calls that fell back to `generateSmartFallback`,
and failed PageSpeed runs are all free. Reads and writes to `UsageCounter` fail
**open**: a database problem under-counts rather than blocking paid work.
