import { useLoaderData } from "react-router";
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
import { authenticate } from "../shopify.server";
import {
  resolveSubscription,
  planSelectionUrl,
  fetchAppHandle,
  fetchShopGid,
} from "../billing.server";
import { PLANS, PLAN_FEATURES } from "../plans";
import { quotaContext, usageSummary } from "../usage.server";

/**
 * Plan page (/app/plan).
 *
 * Under Shopify App Pricing this page is read-only. Shopify hosts the plan
 * selection page, and it is the only place a merchant can subscribe, change
 * tier or cancel — so the old in-app subscribe action and the
 * appSubscriptionCancel mutation are both gone. What remains is a status
 * summary plus a link out to Shopify.
 *
 * This route has no `action` any more, deliberately: the app must not create or
 * mutate charges itself.
 */

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const [shopGid, appHandle] = await Promise.all([
    fetchShopGid(admin),
    fetchAppHandle(admin),
  ]);

  const subscription = await resolveSubscription(admin, shopGid);
  const store = session.shop.replace(".myshopify.com", "");

  // Usage is derived from the same quota context the metered routes use, so
  // what the merchant sees here is exactly what will be enforced.
  const quota = await quotaContext(admin, session);
  const usage = await usageSummary(quota);

  return {
    usage,
    tier: quota.tier,
    subscription: subscription?.unavailable ? null : subscription,
    loadError: subscription?.unavailable
      ? "We couldn't load your subscription details right now."
      : null,
    // Null when the handle lookup failed; the UI hides the CTA rather than
    // linking somewhere that 404s.
    plansUrl: appHandle ? planSelectionUrl(session.shop, appHandle) : null,
    billingUrl: `https://admin.shopify.com/store/${store}/settings/billing`,
    plans: PLANS,
    features: PLAN_FEATURES,
  };
};

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

function money(amount, currency) {
  if (amount == null) return null;
  return `${currency === "USD" ? "$" : `${currency} `}${Number(amount).toFixed(0)}`;
}

/** App Bridge turns a top-targeted anchor into a redirect of the TOP frame,
 *  which is what leaving the embedded iframe requires. */
function openTopLevel(url) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_top";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function Plan() {
  const {
    subscription,
    loadError,
    plansUrl,
    billingUrl,
    plans,
    features,
    usage,
    tier,
  } = useLoaderData();

  const price = money(subscription?.amount, subscription?.currency || "USD");
  const renewsOn = formatDate(subscription?.renewsOn);
  const startedOn = formatDate(subscription?.startedOn);
  const trialEndsOn = formatDate(subscription?.trialEndsAt);

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
                    {subscription?.name || "No active plan"}
                  </Text>
                  {subscription ? (
                    <Badge tone="success">Active</Badge>
                  ) : (
                    <Badge tone="attention">Not subscribed</Badge>
                  )}
                  {subscription?.test ? <Badge tone="info">Test</Badge> : null}
                </InlineStack>

                {price ? (
                  <InlineStack gap="100" blockAlign="baseline">
                    <Text variant="heading2xl" as="p">
                      {price}
                    </Text>
                    <Text variant="bodyMd" as="span" tone="subdued">
                      / month
                    </Text>
                  </InlineStack>
                ) : null}

                {subscription ? (
                  <BlockStack gap="100">
                    {trialEndsOn ? (
                      <Text variant="bodyMd" as="p" tone="subdued">
                        Free trial ends on {trialEndsOn}
                      </Text>
                    ) : null}
                    {startedOn ? (
                      <Text variant="bodyMd" as="p" tone="subdued">
                        Current billing period started {startedOn}
                      </Text>
                    ) : null}
                    {renewsOn ? (
                      <Text variant="bodyMd" as="p" tone="subdued">
                        {subscription.cancelAtEndOfCycle
                          ? `Ends on ${renewsOn} — will not renew`
                          : `Next renewal on ${renewsOn}`}
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : (
                  <Text variant="bodyMd" as="p" tone="subdued">
                    Choose a plan to unlock the full Image Optimizer &amp; SEO
                    suite.
                  </Text>
                )}
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingMd" as="h3">
                    This month&apos;s usage
                  </Text>
                  {/* Which quota set actually resolved. Without this a
                      mis-detected tier looks identical to a correct one. */}
                  <Badge tone={tier === "unlimited" ? "info" : undefined}>
                    {`${tier} limits`}
                  </Badge>
                </InlineStack>
                {usage.map((u) => (
                  <InlineStack
                    key={u.metric}
                    gap="200"
                    blockAlign="baseline"
                    align="space-between"
                  >
                    <Text as="span" variant="bodyMd">
                      {u.label}
                    </Text>
                    <Text
                      as="span"
                      variant="bodyMd"
                      tone={
                        u.limit !== null && u.used >= u.limit
                          ? "critical"
                          : "subdued"
                      }
                    >
                      {u.limit === null
                        ? "Unlimited"
                        : `${u.used} / ${u.limit}`}
                    </Text>
                  </InlineStack>
                ))}
                <Text variant="bodySm" as="p" tone="subdued">
                  Limits reset at the start of each calendar month.
                </Text>
              </BlockStack>

              <Divider />

              <BlockStack gap="300">
                <Text variant="headingMd" as="h3">
                  What&apos;s included
                </Text>
                {features.map((feature) => (
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

              <BlockStack gap="200">
                <InlineStack gap="200">
                  {plansUrl ? (
                    <Button
                      variant="primary"
                      size="large"
                      onClick={() => openTopLevel(plansUrl)}
                    >
                      {subscription ? "Change plan" : "Choose a plan"}
                    </Button>
                  ) : null}
                  <Button onClick={() => openTopLevel(billingUrl)}>
                    View billing in Shopify
                  </Button>
                </InlineStack>
                <Text variant="bodySm" as="p" tone="subdued">
                  Plans, upgrades and cancellation are handled on Shopify&apos;s
                  plan page. Charges appear on your regular Shopify invoice.
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {!subscription ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h3">
                  Available plans
                </Text>
                {plans.map((p) => (
                  <BlockStack key={p.handle} gap="100">
                    <InlineStack
                      gap="200"
                      blockAlign="baseline"
                      align="space-between"
                    >
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {p.name}
                      </Text>
                      <Text as="span" variant="bodyMd" tone="subdued">
                        {money(p.amount, p.currency)} / month
                      </Text>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {p.limits}
                    </Text>
                  </BlockStack>
                ))}
                <Divider />
                <List>
                  <List.Item>
                    Cancel any time from Shopify&apos;s plan page.
                  </List.Item>
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
