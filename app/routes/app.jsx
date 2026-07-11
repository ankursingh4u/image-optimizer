import { Outlet, useLoaderData, useRouteError, Form, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider as ShopifyAppProvider } from "@shopify/shopify-app-react-router/react";
import {
  AppProvider as PolarisAppProvider,
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Divider,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

// Import Polaris styles - THIS IS CRITICAL
import "@shopify/polaris/build/esm/styles.css";

// Import Polaris translations
import enTranslations from "@shopify/polaris/locales/en.json";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

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

  let needsSubscription = false;
  if (shopIsGated) {
    // Check active subscriptions via the admin GraphQL client (same auth path as
    // the subscribe action — avoids the offline-token 401 seen with billing.*).
    // We do NOT redirect here; if there's no active subscription we render our
    // own in-app pricing page and only send the merchant to Shopify on click.
    const resp = await admin.graphql(
      `#graphql
        query ActiveSubs {
          currentAppInstallation {
            activeSubscriptions { id name status test }
          }
        }`
    );
    const subs =
      (await resp.json())?.data?.currentAppInstallation?.activeSubscriptions || [];
    // In test mode only test subscriptions count; in live mode only live ones.
    const active = subs.filter(
      (s) => s.status === "ACTIVE" && Boolean(s.test) === isTest
    );
    needsSubscription = active.length === 0;
    console.log(
      "[billing][debug] shop=%s isTest=%s subs=%s",
      session.shop,
      isTest,
      JSON.stringify(subs)
    );
  } else {
    console.log("[billing][debug] shop=%s NOT gated", session.shop);
  }
  // ------------------------------------------------------------------------

  return { apiKey: env.SHOPIFY_API_KEY || "", needsSubscription };
};

const PLAN_FEATURES = [
  "AI Alt Text Suggestions",
  "Product Image Optimization",
  "Page Speed Impact Analysis",
  "Performance Score",
  "Core Web Vitals",
];

function PricingScreen() {
  const navigation = useNavigation();
  const subscribing = navigation.state !== "idle";

  return (
    <Page title="Choose your plan">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingLg" as="h2">Basic</Text>
                  <Badge tone="info">3-day free trial</Badge>
                </InlineStack>
                <InlineStack gap="100" blockAlign="baseline">
                  <Text variant="heading2xl" as="p">$30</Text>
                  <Text variant="bodyMd" as="span" tone="subdued">/ month</Text>
                </InlineStack>
                <Text variant="bodyMd" as="p" tone="subdued">
                  Unlock the full Image Optimizer &amp; SEO suite. Start with a
                  3-day free trial — cancel anytime.
                </Text>
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                {PLAN_FEATURES.map((feature) => (
                  <InlineStack key={feature} gap="200" blockAlign="center">
                    <Text as="span" tone="success" variant="bodyMd" fontWeight="bold">✓</Text>
                    <Text as="span" variant="bodyMd">{feature}</Text>
                  </InlineStack>
                ))}
              </BlockStack>

              <Divider />

              <Form method="post" action="/app/subscribe">
                <Button submit variant="primary" size="large" loading={subscribing} disabled={subscribing}>
                  Start 3-day free trial
                </Button>
              </Form>
              <Text variant="bodySm" as="p" tone="subdued">
                You&apos;ll be taken to Shopify to approve the subscription.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default function App() {
  const { apiKey, needsSubscription } = useLoaderData();

  return (
    <ShopifyAppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        {needsSubscription ? (
          // Unsubscribed: show the in-app pricing page instead of the app. The
          // nav menu is hidden so the merchant can't reach gated pages until
          // they subscribe.
          <PricingScreen />
        ) : (
          <>
            <ui-nav-menu>
              <a href="/app" rel="home">Home</a>
              <a href="/app/alttextsuggestions">Alt Text Suggestions</a>
              {/* <a href="/app/imageoptimizationdashboard">Image Optimization Dashboard</a> */}
              <a href="/app/productoptimization">Image Optimization Dashboard</a>
              <a href="/app/pagespeedimpactreports">Page Speed Reports</a>
            </ui-nav-menu>
            <Outlet />
          </>
        )}
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