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
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
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