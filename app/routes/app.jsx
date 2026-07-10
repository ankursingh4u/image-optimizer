import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// Import Polaris styles - THIS IS CRITICAL
import "@shopify/polaris/build/esm/styles.css";

// Import Polaris translations
import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { billing, session, admin, redirect } = await authenticate.admin(request);

  // --- Billing gate (managed pricing) -------------------------------------
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
    const { hasActivePayment } = await billing.check({ isTest });

    if (!hasActivePayment) {
      // Look up this app's handle to build the managed-pricing page URL.
      let appHandle;
      try {
        const resp = await admin.graphql(
          `#graphql
            query AppHandle { currentAppInstallation { app { handle } } }`
        );
        const body = await resp.json();
        appHandle = body?.data?.currentAppInstallation?.app?.handle;
      } catch (err) {
        console.error("[billing] failed to resolve app handle:", err);
      }

      if (appHandle) {
        const storeHandle = session.shop.replace(".myshopify.com", "");
        // target: "_top" breaks out of the embedded iframe to Shopify admin.
        throw redirect(
          `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`,
          { target: "_top" }
        );
      }
      // If we couldn't resolve the handle, fail OPEN rather than lock the
      // merchant out of the app. Billing is re-checked on the next load.
    }
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