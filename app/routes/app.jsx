import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  shopIsGated,
  resolveSubscription,
  planSelectionUrl,
  fetchAppHandle,
  fetchShopGid,
} from "../billing.server";

// Import Polaris styles - THIS IS CRITICAL
import "@shopify/polaris/build/esm/styles.css";

// Import Polaris translations
import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  // --- Billing gate (Shopify App Pricing) ---------------------------------
  // Shops that installed before enforcement was switched on are grandfathered
  // and never gated. A gated shop with no subscription is sent to Shopify's
  // hosted plan selection page — the app no longer renders pricing itself.
  const gated = await shopIsGated(session.shop);

  if (gated) {
    const shopGid = await fetchShopGid(admin);
    const subscription = await resolveSubscription(admin, shopGid);

    // resolveSubscription returns `unavailable` when the Partner API could not
    // be reached. Do NOT redirect on that — a throttled request would bounce a
    // paying merchant to the plan picker. Let them through and re-check on the
    // next page load instead.
    if (subscription?.unavailable) {
      console.error(
        "[billing] subscription state unavailable for %s — allowing through",
        session.shop
      );
    } else if (!subscription) {
      const appHandle = await fetchAppHandle(admin);
      if (appHandle) {
        // target: "_top" is required — the plan page lives outside this app's
        // iframe, so an in-frame redirect would be blocked.
        return redirect(planSelectionUrl(session.shop, appHandle), {
          target: "_top",
        });
      }
      console.error(
        "[billing] no app handle for %s — cannot reach the plan page",
        session.shop
      );
    }
  }
  // ------------------------------------------------------------------------

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  // No pricing branch here any more: an unsubscribed gated shop never reaches
  // this component, because the loader redirects it to Shopify's hosted plan
  // selection page.
  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <ui-nav-menu>
          <a href="/app" rel="home">Home</a>
          <a href="/app/alttextsuggestions">Alt Text Suggestions</a>
          {/* <a href="/app/imageoptimizationdashboard">Image Optimization Dashboard</a> */}
          <a href="/app/productoptimization">Image Optimization Dashboard</a>
          <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
          <a href="/app/plan">Plan</a>
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