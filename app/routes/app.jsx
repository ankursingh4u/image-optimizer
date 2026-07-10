import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate, BASIC_PLAN } from "../shopify.server";

// Import Polaris styles - THIS IS CRITICAL
import "@shopify/polaris/build/esm/styles.css";

// Import Polaris translations
import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);

  // --- Billing gate (code-managed billing) --------------------------------
  // Controlled entirely by env vars so we can test billing safely before
  // charging real merchants. Defaults are deliberately non-disruptive:
  //   BILLING_ENFORCED   "true" -> require a subscription for EVERY shop.
  //                      anything else (default) -> only gate BILLING_TEST_SHOPS.
  //   BILLING_TEST_SHOPS comma-separated shop domains to gate while testing,
  //                      e.g. "optimizer-testing.myshopify.com".
  //   BILLING_TEST_MODE  "false" -> real charges. Anything else (default) ->
  //                      test charges (no real money; works on dev/test stores).
  // With the defaults, existing live merchants are NOT affected.
  // eslint-disable-next-line no-undef
  const env = process.env;
  const enforceAll = env.BILLING_ENFORCED === "true";
  const testShops = (env.BILLING_TEST_SHOPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isTest = env.BILLING_TEST_MODE !== "false";
  const shopIsGated = enforceAll || testShops.includes(session.shop);

  if (shopIsGated) {
    // Require an active Basic subscription. If the shop has none, `require`
    // calls `onFailure`, which redirects the merchant to Shopify's billing
    // confirmation page (a TEST charge when isTest=true — no real money).
    await billing.require({
      plans: [BASIC_PLAN],
      isTest,
      onFailure: async () =>
        // No returnUrl: the library defaults to the correct embedded admin URL
        // for embedded apps, so after approval the merchant re-enters the app
        // inside Shopify admin (not the standalone shop-domain login page).
        billing.request({
          plan: BASIC_PLAN,
          isTest,
        }),
    });
  }
  // ------------------------------------------------------------------------

  return { apiKey: env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <ui-nav-menu>
          <a href="/app" rel="home">Home</a>
          <a href="/app/alttextsuggestions">Alt Text Suggestions</a>
          {/* <a href="/app/imageoptimizationdashboard">Image Optimization Dashboard</a> */}
          <a href="/app/productoptimization">Image Optimization Dashboard</a>
          <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
          
        </ui-nav-menu>
        <Outlet />
      </PolarisAppProvider>
    </ShopifyAppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};