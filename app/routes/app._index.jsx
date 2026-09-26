import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { quotaContext, usageSummary, METRICS } from "../usage.server";
import {
  Page,
  Layout,
  Card,
  Button,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Box,
  ProgressBar,
  Divider,
} from "@shopify/polaris";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Everything here has to be fast — the browser cannot finish the navigation
  // until this returns. quotaContext is a cached read; usageSummary is local DB.
  let tier = "starter";
  let usage = [];
  try {
    const ctx = await quotaContext(admin, session);
    tier = ctx.tier || "starter";
    usage = await usageSummary(ctx);
  } catch (e) {
    if (e instanceof Response) throw e; // let re-auth propagate
  }

  const byMetric = Object.fromEntries(usage.map((u) => [u.metric, u]));

  return {
    tier,
    images: byMetric[METRICS.IMAGES_OPTIMIZED] || { used: 0, limit: null },
    altText: byMetric[METRICS.AI_ALT_TEXT] || { used: 0, limit: null },
    reports: byMetric[METRICS.PAGESPEED_REPORTS] || { used: 0, limit: null },
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { tier, images, altText, reports } = useLoaderData();

  const fmt = (n) => Number(n || 0).toLocaleString();
  const planName = tier.charAt(0).toUpperCase() + tier.slice(1);

  const quota = images.limit;
  const used = images.used || 0;
  const remaining = quota == null ? null : Math.max(0, quota - used);
  const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;

  // Numeric stats get the figure treatment; word values get a chip so a long
  // label can't wrap into an overlapping headline.
  const stats = [
    { label: "Current plan", value: planName, chip: "brand" },
    { label: "Images optimized", value: fmt(used) },
    { label: "Images left", value: remaining == null ? "Unlimited" : fmt(remaining), chip: remaining == null ? "success" : undefined },
    { label: "Alt texts left", value: altText.limit == null ? "Unlimited" : fmt(Math.max(0, altText.limit - altText.used)), chip: altText.limit == null ? "success" : undefined },
  ];

  const tools = [
    {
      icon: "⚡",
      title: "Image Optimizer",
      desc: "Compress & convert product images to WebP — up to 70% smaller, originals replaced safely.",
      cta: "Open optimizer",
      onClick: () => navigate("/app/productoptimization"),
    },
    {
      icon: "✨",
      title: "AI Alt Text",
      desc: "Generate SEO alt text for every image with AI vision, then bulk-apply in one click.",
      cta: "Generate alt text",
      onClick: () => navigate("/app/alttextsuggestions"),
      badge: altText.limit == null
        ? undefined
        : { label: `${fmt(Math.max(0, altText.limit - altText.used))} left`, tone: "info" },
    },
    {
      icon: "📊",
      title: "Page Speed Reports",
      desc: "Measured image savings per page, plus live Core Web Vitals from Google PageSpeed Insights.",
      cta: "View reports",
      onClick: () => navigate("/app/pagespeedimpactreports"),
      badge: reports.limit == null
        ? undefined
        : { label: `${fmt(Math.max(0, reports.limit - reports.used))} left`, tone: "info" },
    },
    {
      icon: "📈",
      title: "Optimization Dashboard",
      desc: "Every optimization run at a glance — what was compressed, how much was saved, and when.",
      cta: "Open dashboard",
      onClick: () => navigate("/app/imageoptimizationdashboard"),
    },
  ];

  return (
    <Page>
      {/* Hero */}
      <div className="pb-hero">
        <InlineStack align="space-between" blockAlign="center" wrap={false} gap="600">
          <BlockStack gap="300">
            <span className="pb-hero-eyebrow">Image Optimizer</span>
            <div className="pb-hero-copy">
              <h1>Faster images, better rankings.</h1>
              <p>Compress and convert your catalog, auto-generate SEO alt text, and measure the page-speed gains — all in one place.</p>
            </div>
          </BlockStack>
          <Button variant="primary" size="large" onClick={() => navigate("/app/productoptimization")}>
            Optimize images
          </Button>
        </InlineStack>
      </div>

      <Layout>
        {/* Stat strip */}
        <Layout.Section>
          <div className="pb-stat-grid">
            {stats.map((s) => (
              <div key={s.label} className="pb-stat-card">
                {s.chip ? (
                  <span className={`pb-stat-chip pb-stat-chip--${s.chip}`} title={s.value}>
                    {s.value}
                  </span>
                ) : (
                  <p className="pb-stat-value">{s.value}</p>
                )}
                <p className="pb-stat-label">{s.label}</p>
              </div>
            ))}
          </div>
        </Layout.Section>

        {/* Monthly usage */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Text variant="headingSm" as="h2">Monthly image usage</Text>
                  <Badge tone={tier === "starter" ? undefined : "success"}>{`${planName} plan`}</Badge>
                </InlineStack>
                <Button variant="plain" onClick={() => navigate("/app/plan")}>Manage plan</Button>
              </InlineStack>
              <ProgressBar progress={pct} size="small" tone={pct >= 100 ? "critical" : "primary"} />
              <Text variant="bodySm" as="p" tone="subdued">
                {quota == null
                  ? `${fmt(used)} images optimized this month · unlimited on your plan`
                  : `${fmt(used)} of ${fmt(quota)} images this month · ${fmt(remaining)} remaining`}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Tools — horizontal rows */}
        <Layout.Section>
          <Card padding="0">
            <BlockStack gap="0">
              {tools.map((t, i) => (
                <div key={t.title}>
                  {i > 0 && <Divider />}
                  <Box padding="400">
                    <InlineStack align="space-between" blockAlign="center" wrap={false} gap="400">
                      <InlineStack gap="400" blockAlign="center" wrap={false}>
                        <div className="pb-feature-icon">{t.icon}</div>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Text variant="headingSm" as="h3">{t.title}</Text>
                            {t.badge && <Badge tone={t.badge.tone}>{t.badge.label}</Badge>}
                          </InlineStack>
                          <Text variant="bodySm" as="p" tone="subdued">{t.desc}</Text>
                        </BlockStack>
                      </InlineStack>
                      <Box minWidth="160px">
                        <Button variant="primary" onClick={t.onClick} fullWidth>
                          {t.cta}
                        </Button>
                      </Box>
                    </InlineStack>
                  </Box>
                </div>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
