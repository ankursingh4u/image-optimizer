import { useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Divider,
  Banner,
  List,
} from "@shopify/polaris";
import { authenticate, BASIC_PLAN } from "../shopify.server";

/**
 * Plan page (/app/plan).
 *
 * Read-only view of the merchant's current subscription, plus the same
 * "start trial" action used by the billing gate in app.jsx. This route exists
 * because the pricing UI previously only rendered as a *gate* — once a shop was
 * subscribed (or simply not gated) there was no way to reach it at all.
 *
 * Deliberately does NOT change any gating/enforcement behaviour: it only reads
 * activeSubscriptions and reuses the existing /app/subscribe action.
 */
export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  const env = process.env;
  const isTest = env.BILLING_TEST_MODE !== "false";
  const store = session.shop.replace(".myshopify.com", "");

  let subscription = null;
  let loadError = null;

  try {
    const resp = await admin.graphql(
      `#graphql
        query PlanStatus {
          currentAppInstallation {
            activeSubscriptions {
              id
              name
              status
              test
              trialDays
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
    const data = (await resp.json())?.data?.currentAppInstallation;
    const subs = data?.activeSubscriptions || [];
    // Match the gate in app.jsx: in test mode only test subs count, and vice versa.
    subscription =
      subs.find((s) => s.status === "ACTIVE" && Boolean(s.test) === isTest) || null;
  } catch (err) {
    console.error("[plan] subscription lookup failed:", err?.message);
    loadError = "We couldn't load your subscription details right now.";
  }

  // NOTE: do NOT link to /charges/<handle>/pricing_plans — that page only exists
  // for apps using Shopify *managed pricing*. This app uses code-managed billing
  // (appSubscriptionCreate), so Shopify hosts no per-app plan page and that URL
  // 404s. Settings > Billing is a core admin route and is where app charges and
  // subscriptions are listed for the merchant.
  const billingUrl = `https://admin.shopify.com/store/${store}/settings/billing`;

  return { subscription, billingUrl, isTest, planName: BASIC_PLAN, loadError };
};

const PLAN_FEATURES = [
  "AI Alt Text Suggestions",
  "Product Image Optimization",
  "Page Speed Impact Analysis",
  "Performance Score",
  "Core Web Vitals",
];

function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function Plan() {
  const { subscription, billingUrl, isTest, planName, loadError } =
    useLoaderData();
  const fetcher = useFetcher();
  const confirmationUrl = fetcher.data?.confirmationUrl;
  const error = fetcher.data?.error;
  const subscribing = fetcher.state !== "idle" || Boolean(confirmationUrl);

  useEffect(() => {
    if (!confirmationUrl) return;
    // App Bridge intercepts a top-targeted anchor and redirects the TOP frame
    // (out of the embedded iframe) to Shopify's approval page.
    const a = document.createElement("a");
    a.href = confirmationUrl;
    a.target = "_top";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [confirmationUrl]);

  const pricing =
    subscription?.lineItems?.[0]?.plan?.pricingDetails || null;
  const amount = pricing?.price?.amount ? Number(pricing.price.amount) : 30;
  const currency = pricing?.price?.currencyCode || "USD";
  const renewsOn = formatDate(subscription?.currentPeriodEnd);
  const startedOn = formatDate(subscription?.createdAt);

  const openBilling = () => {
    if (!billingUrl) return;
    const a = document.createElement("a");
    a.href = billingUrl;
    a.target = "_top";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Page title="Plan">
      <Layout>
        {loadError ? (
          <Layout.Section>
            <Banner tone="warning">{loadError}</Banner>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingLg" as="h2">
                    {subscription?.name || planName}
                  </Text>
                  {subscription ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="attention">No active plan</Badge>
                  )}
                  {subscription?.test ? <Badge tone="info">Test</Badge> : null}
                </InlineStack>

                <InlineStack gap="100" blockAlign="baseline">
                  <Text variant="heading2xl" as="p">
                    {currency === "USD" ? "$" : `${currency} `}
                    {amount.toFixed(0)}
                  </Text>
                  <Text variant="bodyMd" as="span" tone="subdued">
                    / month
                  </Text>
                </InlineStack>

                {subscription ? (
                  <BlockStack gap="100">
                    {startedOn ? (
                      <Text variant="bodyMd" as="p" tone="subdued">
                        Started on {startedOn}
                      </Text>
                    ) : null}
                    {renewsOn ? (
                      <Text variant="bodyMd" as="p" tone="subdued">
                        Next renewal on {renewsOn}
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : (
                  <Text variant="bodyMd" as="p" tone="subdued">
                    Unlock the full Image Optimizer &amp; SEO suite. Start with a
                    3-day free trial — cancel anytime.
                  </Text>
                )}
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text variant="headingMd" as="h3">
                  What&apos;s included
                </Text>
                {PLAN_FEATURES.map((feature) => (
                  <InlineStack key={feature} gap="200" blockAlign="center">
                    <Text
                      as="span"
                      tone="success"
                      variant="bodyMd"
                      fontWeight="bold"
                    >
                      ✓
                    </Text>
                    <Text as="span" variant="bodyMd">
                      {feature}
                    </Text>
                  </InlineStack>
                ))}
              </BlockStack>

              <Divider />

              {error ? <Banner tone="critical">{error}</Banner> : null}

              {subscription ? (
                <BlockStack gap="200">
                  <Button size="large" onClick={openBilling}>
                    View billing in Shopify
                  </Button>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Billing is handled by Shopify — this subscription appears on
                    your regular Shopify invoice under Settings &rsaquo; Billing.
                    To stop future charges, uninstall the app from your Shopify
                    admin.
                  </Text>
                </BlockStack>
              ) : (
                <BlockStack gap="200">
                  <Button
                    variant="primary"
                    size="large"
                    loading={subscribing}
                    disabled={subscribing}
                    onClick={() =>
                      fetcher.submit(
                        {},
                        { method: "post", action: "/app/subscribe" }
                      )
                    }
                  >
                    Start 3-day free trial
                  </Button>
                  <Text variant="bodySm" as="p" tone="subdued">
                    You&apos;ll be taken to Shopify to approve the subscription.
                  </Text>
                </BlockStack>
              )}

              {isTest ? (
                <Banner tone="info">
                  <Text as="p" variant="bodySm">
                    Billing is running in test mode — no real charges are made.
                  </Text>
                </Banner>
              ) : null}
            </BlockStack>
          </Card>
        </Layout.Section>

        {!subscription ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <Text variant="headingMd" as="h3">
                  Good to know
                </Text>
                <List>
                  <List.Item>Cancel any time from your Shopify admin.</List.Item>
                  <List.Item>
                    Charges appear on your regular Shopify invoice.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
  );
}
