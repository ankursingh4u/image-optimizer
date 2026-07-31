import { useEffect, useState } from "react";
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
  Modal,
} from "@shopify/polaris";
import { authenticate, BASIC_PLAN } from "../shopify.server";
import { resolveBillingMode, findActiveSubscription } from "../billing.server";

/**
 * Plan page (/app/plan).
 *
 * Shows the merchant's current subscription, the "start trial" action used by
 * the billing gate in app.jsx, and an in-app cancel. This route exists because
 * the pricing UI previously only rendered as a *gate* — once a shop was
 * subscribed (or simply not gated) there was no way to reach it at all.
 *
 * Does NOT change any gating/enforcement behaviour: it reads activeSubscriptions
 * and reuses the existing /app/subscribe action. The only write it performs is
 * the merchant-initiated cancel below.
 */

/**
 * Cancel the merchant's active subscription.
 *
 * Shopify offers no hosted plan page for code-managed billing, so cancellation
 * has to live in the app. Deliberately called WITHOUT prorate: prorating issues
 * the merchant a credit and deducts the same amount from the Partner account,
 * which is a revenue decision we shouldn't make silently. Without it the
 * subscription simply stops renewing.
 *
 * The subscription id is re-read from activeSubscriptions server-side rather
 * than taken from the form, so a crafted request can't cancel an arbitrary id.
 */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { isTest } = resolveBillingMode(session.shop);

  const lookup = await admin.graphql(
    `#graphql
      query ActiveSubForCancel {
        currentAppInstallation {
          activeSubscriptions { id status test }
        }
      }`
  );
  const subs =
    (await lookup.json())?.data?.currentAppInstallation?.activeSubscriptions ||
    [];
  const target = findActiveSubscription(subs, isTest);

  if (!target) {
    return { cancelError: "There's no active subscription to cancel." };
  }

  const resp = await admin.graphql(
    `#graphql
      mutation CancelSubscription($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription { id status }
          userErrors { field message }
        }
      }`,
    { variables: { id: target.id } }
  );

  const json = await resp.json();
  const result = json?.data?.appSubscriptionCancel;
  const userErrors = result?.userErrors || [];

  if (userErrors.length || !result?.appSubscription) {
    console.error("[plan] cancel failed:", JSON.stringify(json));
    return {
      cancelError:
        "Could not cancel the subscription: " +
        (userErrors.map((e) => e.message).join("; ") || "unexpected response"),
    };
  }

  console.log(
    "[plan] cancelled subscription %s -> %s",
    result.appSubscription.id,
    result.appSubscription.status
  );
  return { cancelled: true };
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const { isTest } = resolveBillingMode(session.shop);
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
    subscription = findActiveSubscription(data?.activeSubscriptions, isTest);
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

  // Separate fetcher so the cancel flow can't be confused with the subscribe
  // flow's state (and so a failed cancel doesn't blank the subscribe button).
  const cancelFetcher = useFetcher();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelling = cancelFetcher.state !== "idle";
  const cancelError = cancelFetcher.data?.cancelError;
  const cancelled = cancelFetcher.data?.cancelled;

  // Close the confirmation dialog once the cancel round-trips. The route's
  // loader revalidates automatically, so `subscription` becomes null and the
  // page falls back to the subscribe CTA on its own.
  useEffect(() => {
    if (cancelFetcher.state === "idle" && cancelFetcher.data) {
      setConfirmOpen(false);
    }
  }, [cancelFetcher.state, cancelFetcher.data]);

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
              {cancelError ? (
                <Banner tone="critical">{cancelError}</Banner>
              ) : null}
              {cancelled && !subscription ? (
                <Banner tone="success">
                  Your subscription has been cancelled.
                </Banner>
              ) : null}

              {subscription ? (
                <BlockStack gap="200">
                  <InlineStack gap="200">
                    <Button onClick={openBilling}>View billing in Shopify</Button>
                    <Button
                      tone="critical"
                      loading={cancelling}
                      disabled={cancelling}
                      onClick={() => setConfirmOpen(true)}
                    >
                      Cancel subscription
                    </Button>
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Billing is handled by Shopify — this subscription appears on
                    your regular Shopify invoice under Settings &rsaquo; Billing.
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
                  <List.Item>Cancel any time from this page.</List.Item>
                  <List.Item>
                    Charges appear on your regular Shopify invoice.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Modal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Cancel subscription?"
          primaryAction={{
            content: "Cancel subscription",
            destructive: true,
            loading: cancelling,
            onAction: () =>
              cancelFetcher.submit({}, { method: "post", action: "/app/plan" }),
          }}
          secondaryActions={[
            {
              content: "Keep subscription",
              disabled: cancelling,
              onAction: () => setConfirmOpen(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                This stops future billing for the {subscription?.name || planName}{" "}
                plan. No refund or prorated credit is issued for the current
                billing period.
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                You can resubscribe from this page at any time, though the 3-day
                free trial only applies to a first subscription.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      </Layout>
    </Page>
  );
}
