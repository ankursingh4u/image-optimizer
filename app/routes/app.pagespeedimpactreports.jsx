import { useState, useCallback, useEffect } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData } from 'react-router';
import { authenticate } from '../shopify.server';
import {
  quotaContext,
  checkQuota,
  recordUsage,
  quotaMessage,
  METRICS,
} from '../usage.server';
import {
  Page,
  Layout,
  Card,
  Select,
  Text,
  Box,
  InlineStack,
  BlockStack,
  Badge,
  DataTable,
  Banner,
  Button,
  Spinner
} from '@shopify/polaris';

/**
 * Fetch all products from Shopify with optimization data
 */
async function getAllProductHandles(admin) {
  const query = `#graphql
    query GetProducts($cursor: String) {
      products(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            onlineStoreUrl
            metafields(first: 10, namespace: "image_optimization") {
              edges {
                node {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const response = await admin.graphql(query, {
      variables: { cursor }
    });
    
    const data = await response.json();
    const products = data.data.products.edges.map(edge => edge.node);
    allProducts = [...allProducts, ...products];

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return allProducts;
}

/**
 * Run Lighthouse performance test using PageSpeed Insights API
 * This is more reliable than running Chrome headless on a server
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One PSI attempt. Throws { retryable } so the caller can decide to retry.
async function pageSpeedAttempt(apiUrl) {
  const controller = new AbortController();
  // A Lighthouse run takes 30-60s and the request has no deadline of its own,
  // so without this the action can hang until the platform kills it and the
  // merchant is left watching "Running Analysis..." forever.
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(apiUrl, { signal: controller.signal });
  } catch (e) {
    // Network error or our 45s abort — transient, worth retrying.
    const err = new Error(
      e?.name === 'AbortError'
        ? 'PageSpeed request timed out'
        : `PageSpeed network error: ${e?.message || e}`
    );
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Include Google's own status and reason. A bare message hides WHY every
    // call failed, which lets a malformed storefront URL look identical to a
    // rate limit in the logs.
    let detail = '';
    try { detail = (await response.json())?.error?.message || ''; } catch { /* non-JSON */ }
    const err = new Error(`PageSpeed API request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    // 429 (rate limit) and 5xx are transient; other 4xx (bad/unreachable URL) are not.
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const data = await response.json();
  const lighthouseResult = data.lighthouseResult;
  if (!lighthouseResult) {
    // Sometimes PSI returns 200 with a lighthouse runtime error (e.g. page slow
    // to load) — treat as retryable, a re-run often succeeds.
    const err = new Error('No Lighthouse data in response');
    err.retryable = true;
    throw err;
  }

  // Extract performance score
  const performanceScore = Math.round((lighthouseResult.categories.performance?.score || 0) * 100);

  // Extract Core Web Vitals from audits
  const audits = lighthouseResult.audits;

  // Get metrics
  const lcpAudit = audits['largest-contentful-paint'];
  // Total Blocking Time, not max-potential-FID: FID is retired as a Core Web
  // Vital and max-potential-FID measures a different thing (the single worst
  // input delay), so it was never comparable to the 100ms FID threshold the
  // UI rated it against.
  const tbtAudit = audits['total-blocking-time'];
  const clsAudit = audits['cumulative-layout-shift'];
  const ttfbAudit = audits['server-response-time'];
  const speedIndexAudit = audits['speed-index'];
  const interactiveAudit = audits['interactive'];

  return {
    score: performanceScore,
    lcp: lcpAudit?.numericValue ? parseFloat((lcpAudit.numericValue / 1000).toFixed(2)) : 0,
    tbt: tbtAudit?.numericValue ? Math.round(tbtAudit.numericValue) : 0,
    cls: clsAudit?.numericValue ? parseFloat(clsAudit.numericValue.toFixed(3)) : 0,
    ttfb: ttfbAudit?.numericValue ? parseFloat((ttfbAudit.numericValue / 1000).toFixed(2)) : 0,
    loadTime: interactiveAudit?.numericValue ? parseFloat((interactiveAudit.numericValue / 1000).toFixed(2)) : 0,
    speedIndex: speedIndexAudit?.numericValue ? parseFloat((speedIndexAudit.numericValue / 1000).toFixed(2)) : 0,
    timestamp: new Date().toISOString()
  };
}

/**
 * Run a real Lighthouse performance test via Google PageSpeed Insights.
 * The keyless endpoint is rate-limited to roughly 1-2 requests a minute, so a
 * single attempt fails far more often than the storefront is actually broken —
 * we retry with backoff (up to 3 attempts) on 429/5xx/timeout. A bad or
 * unreachable URL is not retried, because re-running it cannot help. Returns
 * null only after every attempt has failed.
 */
async function runPageSpeedTest(url) {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
  const keyParam = apiKey ? `&key=${apiKey}` : '';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&strategy=mobile${keyParam}`;

  console.log('Running PageSpeed test for:', url);

  const backoffs = [0, 2000, 5000]; // before attempts 1, 2, 3
  let lastErr;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]) await sleep(backoffs[attempt]);
    try {
      return await pageSpeedAttempt(apiUrl);
    } catch (e) {
      lastErr = e;
      console.error(`PageSpeed attempt ${attempt + 1} failed for ${url}:`, e?.message || e);
      if (!e?.retryable) break; // bad/unreachable URL — retrying won't help
    }
  }
  console.error('PageSpeed test failed after retries:', lastErr?.message || lastErr);
  return null;
}

/**
 * Calculate performance improvement based on actual image optimization data
 */
function calculatePerformanceImprovement(product) {
  const metafields = product.metafields?.edges || [];
  const optimizationSummary = metafields.find(
    mf => mf.node.key === 'optimization_summary'
  );

  if (!optimizationSummary) {
    return null;
  }

  try {
    const data = JSON.parse(optimizationSummary.node.value);
    
    const totalSizeSavedMB = data.totalSizeSavedMB || 0;
    const totalOriginalSizeMB = data.totalOriginalSizeMB || 0;
    const totalOptimizedSizeMB = data.totalOptimizedSizeMB || 0;
    const compressionRate = data.avgCompressionRate || 0;
    const optimizedImages = data.optimizedImages || 0;
    
    // Only what was actually measured during the optimization run. The
    // LCP/load-time/score "improvements" that used to be derived here were
    // guesses from published benchmarks, and the page presented them as if
    // they were this store's numbers.
    return {
      totalSizeSavedMB: parseFloat(totalSizeSavedMB.toFixed(2)),
      totalOriginalSizeMB: parseFloat(totalOriginalSizeMB.toFixed(2)),
      // Written by the optimizer alongside the original; fall back to the
      // subtraction for summaries saved before that field existed.
      totalOptimizedSizeMB: parseFloat(
        (totalOptimizedSizeMB || Math.max(totalOriginalSizeMB - totalSizeSavedMB, 0)).toFixed(2)
      ),
      compressionRate,
      optimizedImages
    };
  } catch (e) {
    console.error('Error parsing optimization summary:', e);
    return null;
  }
}

/**
 * The storefront origin Google should test.
 *
 * Prefer the shop's primary domain: a merchant on a custom domain serves
 * customers from there, often through a different redirect chain than the
 * .myshopify.com address, so testing the myshopify one can measure a page no
 * customer actually loads. Falls back to the shop domain itself, which is
 * always a real host — never to a reconstructed string.
 */
async function getStorefrontOrigin(admin, shop) {
  try {
    const response = await admin.graphql(
      `#graphql
        query ShopPrimaryDomain {
          shop {
            primaryDomain { url }
          }
        }
      `
    );
    const data = await response.json();
    const url = data?.data?.shop?.primaryDomain?.url;
    if (url) return url.replace(/\/$/, '');
  } catch (error) {
    console.error('Could not read primary domain, falling back to shop domain:', error?.message);
  }
  return `https://${shop}`;
}

/**
 * This page reports only numbers the app actually has.
 *
 * It used to invent them: a fixed baseline (score 55, LCP 4.5s, load 6.2s —
 * the same constants for every page of every store) with a formula-derived
 * "after" laid over it. Because the score formula capped at +40 and most
 * products clear the cap, every row read "55 → 95 +40" with near-identical
 * timings, which is exactly what fabricated data looks like. Bytes saved and
 * compression are measured from real file sizes and stay; Lighthouse scores
 * and Core Web Vitals now come only from runPageSpeedTest(), which asks
 * Google to load the page.
 */

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const selectedPage = url.searchParams.get('page') || 'all';

  try {
    const products = await getAllProductHandles(admin);
    
    // Get shop domain. NOTE: this used to be built by stripping ".myshopify.com"
    // off the shop domain, which produced "https://optimizer-testing" — not a
    // resolvable host, so every live PageSpeed test on an unpublished product
    // failed with a generic API error.
    const shop = session.shop;
    const shopUrl = await getStorefrontOrigin(admin, shop);

    // Analyze pages based on optimized products
    const pageAnalyses = [];
    
    for (const product of products) {
      const improvement = calculatePerformanceImprovement(product);
      
      if (improvement && improvement.totalSizeSavedMB > 0) {
        pageAnalyses.push({
          id: product.handle,
          url: `/products/${product.handle}`,
          fullUrl: product.onlineStoreUrl || `${shopUrl}/products/${product.handle}`,
          // onlineStoreUrl is null when the product isn't published to the
          // Online Store channel. Google can't load such a page, so a live test
          // is guaranteed to fail — better to say so than to spend the attempt.
          published: Boolean(product.onlineStoreUrl),
          name: product.title,
          productId: product.id,
          improvement
        });
      }
    }

    /**
     * What the live test can be pointed at: every product published to the
     * Online Store, optimized or not.
     *
     * The selector used to offer only optimized products, which made the
     * card's own advice — run a test before and after optimizing, to see the
     * difference — impossible to follow, because a page did not appear in the
     * list until after it had been optimized. An unpublished product stays out
     * either way: Google fetches the public URL, so there would be nothing to
     * load.
     */
    const testablePages = products
      .filter(product => Boolean(product.onlineStoreUrl))
      .map(product => ({
        id: product.handle,
        name: product.title,
        url: `/products/${product.handle}`,
        fullUrl: product.onlineStoreUrl,
        optimized: (() => {
          const i = calculatePerformanceImprovement(product);
          return Boolean(i && i.totalSizeSavedMB > 0);
        })(),
      }));

    // Build the pages array from measured compression data only.
    const pages = pageAnalyses.map(page => ({
      id: page.id,
      url: page.url,
      name: page.name,
      fullUrl: page.fullUrl,
      published: page.published,
      imagesOptimized: page.improvement.optimizedImages,
      originalMB: page.improvement.totalOriginalSizeMB,
      optimizedMB: page.improvement.totalOptimizedSizeMB,
      savedMB: page.improvement.totalSizeSavedMB,
      compressionRate: page.improvement.compressionRate,
      improvement: page.improvement
    }));

    // Generate insights based on actual optimization data
    const insights = [];
    
    const totalSaved = pageAnalyses.reduce((sum, p) => sum + p.improvement.totalSizeSavedMB, 0);
    const totalImages = pageAnalyses.reduce((sum, p) => sum + p.improvement.optimizedImages, 0);
    const avgCompression = pageAnalyses.length > 0 
      ? pageAnalyses.reduce((sum, p) => sum + p.improvement.compressionRate, 0) / pageAnalyses.length 
      : 0;
    
    if (totalSaved > 0) {
      insights.push({
        id: '1',
        type: 'success',
        title: 'Image Payload Reduced',
        description: `Total image payload reduced by ${totalSaved.toFixed(1)} MB across ${pageAnalyses.length} product pages (${avgCompression.toFixed(0)}% average compression, ${totalImages} images optimized). These figures are measured from the actual file sizes before and after compression.`,
        impact: 'high',
        status: 'completed'
      });

      insights.push({
        id: '2',
        type: 'info',
        title: 'Smaller Images Generally Improve Core Web Vitals',
        description: 'Reducing image transfer size typically improves load time and Largest Contentful Paint, especially on mobile connections. To see the measured impact on your store, run a live PageSpeed test below — results vary by theme, hosting, and other page content.',
        impact: 'medium',
        status: 'pending'
      });
    }

    const unoptimizedCount = products.length - pageAnalyses.length;
    if (unoptimizedCount > 0) {
      insights.push({
        id: '3',
        type: 'warning',
        title: 'Additional Optimization Opportunities',
        description: `${unoptimizedCount} product pages have not been optimized yet. Run image optimization on these pages to reduce their image payload as well.`,
        impact: 'medium',
        status: 'pending'
      });
    }

    insights.push({
      id: '4',
      type: 'info',
      title: 'Ongoing Performance Monitoring',
      description: 'Continue monitoring Core Web Vitals and run periodic optimizations as new products are added. Consider implementing lazy loading for below-the-fold images.',
      impact: 'low',
      status: 'pending'
    });

    return {
      pages,
      testablePages,
      unpublishedCount: products.length - testablePages.length,
      insights,
      selectedPage,
      shopUrl,
      totalProducts: products.length,
      optimizedProducts: pageAnalyses.length,
      totalImagesSaved: totalSaved,
      totalOriginalMB: pageAnalyses.reduce((sum, p) => sum + p.improvement.totalOriginalSizeMB, 0),
      totalImagesOptimized: totalImages,
      avgCompression,
      error: null
    };
  } catch (error) {
    console.error('Error loading page speed data:', error);
    return {
      pages: [],
      testablePages: [],
      unpublishedCount: 0,
      insights: [{
        id: 'error',
        type: 'critical',
        title: 'Error Loading Data',
        description: error.message || 'Failed to load page speed data. Please try refreshing the page.',
        impact: 'high',
        status: 'error'
      }],
      selectedPage,
      shopUrl: '',
      totalProducts: 0,
      optimizedProducts: 0,
      totalImagesSaved: 0,
      totalOriginalMB: 0,
      totalImagesOptimized: 0,
      avgCompression: 0,
      error: 'Failed to load page speed data'
    };
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'runLighthouseAnalysis') {
    const pageUrl = formData.get('pageUrl');
    const pageName = formData.get('pageName');

    const quota = await quotaContext(admin, session);
    const check = await checkQuota(quota, METRICS.PAGESPEED_REPORTS, 1);
    if (!check.allowed) {
      return {
        success: false,
        error: quotaMessage(METRICS.PAGESPEED_REPORTS, check),
      };
    }

    try {
      console.log('Running PageSpeed analysis for:', pageUrl);
      const result = await runPageSpeedTest(pageUrl);

      if (!result) {
        throw new Error('Failed to run PageSpeed test');
      }

      console.log('PageSpeed result:', result);

      // Recorded only on success — a failed or rate-limited PSI call doesn't
      // consume Google quota, so it shouldn't consume the merchant's either.
      await recordUsage(session.shop, METRICS.PAGESPEED_REPORTS, 1);

      return {
        success: true,
        message: `PageSpeed test completed for ${pageName || pageUrl}. Performance Score: ${result.score}/100`,
        pageUrl,
        pageName,
        result
      };
    } catch (error) {
      console.error('Error running PageSpeed analysis:', error);
      return {
        success: false,
        error: "Couldn't run the PageSpeed test. Google has to be able to load the page publicly, so this fails if your storefront is password-protected or the product isn't published to the Online Store. It can also be a rate limit — Google allows roughly 1-2 requests a minute. Check the page opens in a private browser window, then try again in a few minutes.",
      };
    }
  }

  return { success: false, error: 'Invalid action type' };
}

export default function PageSpeedImpactReports() {
  const { 
    pages,
    testablePages,
    unpublishedCount,
    insights,
    selectedPage: initialSelectedPage,
    shopUrl,
    totalProducts,
    optimizedProducts,
    totalImagesSaved,
    totalOriginalMB,
    totalImagesOptimized,
    avgCompression,
    error: loadError
  } = useLoaderData();
  
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();
  
  // Prefer a page that has already been optimized — its measured savings are
  // on this screen, so a score for it is the most useful first measurement.
  const [selectedPage, setSelectedPage] = useState(
    testablePages.some(p => p.id === initialSelectedPage)
      ? initialSelectedPage
      : (testablePages.find(p => p.optimized)?.id || testablePages[0]?.id || '')
  );
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const isRunningAnalysis = navigation.state === 'submitting';

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccessBanner(true);
    }
  }, [actionData]);

  // Changing the selector is a local choice, not a navigation: the loader has
  // every page already, so re-submitting a GET only threw away the result the
  // merchant just waited 30-60s for.
  const handlePageChange = useCallback((value) => {
    setSelectedPage(value);
  }, []);

  const handleRunLighthouse = useCallback(() => {
    const currentPage = testablePages.find(p => p.id === selectedPage);
    if (!currentPage) return;

    const formData = new FormData();
    formData.append('actionType', 'runLighthouseAnalysis');
    formData.append('pageUrl', currentPage.fullUrl);
    formData.append('pageName', currentPage.name);
    submit(formData, { method: 'post' });
  }, [selectedPage, testablePages, submit]);

  const getScoreTone = (score) => {
    if (score >= 90) return 'success';
    if (score >= 50) return 'warning';
    return 'critical';
  };

  const getScoreLabel = (score) => {
    if (score >= 90) return 'Good';
    if (score >= 50) return 'Needs Improvement';
    return 'Poor';
  };

  // Everything in the list is published, so everything in it is testable.
  const currentPageMeta = testablePages.find(p => p.id === selectedPage) || null;
  const canRunLive = Boolean(currentPageMeta);

  // Optimized pages are marked, so it's clear which scores can be read
  // alongside measured savings and which are a before-optimization baseline.
  const pageOptions = testablePages.map(page => ({
    label: `${page.name || page.url}${page.optimized ? ' — optimized' : ''}`,
    value: page.id,
  }));

  // The measurement comes straight from the action result, so it belongs to the
  // page that was tested by construction — it cannot end up displayed under a
  // different page's name.
  const liveResult = actionData?.success ? actionData.result : null;

  const liveMetricRows = liveResult ? [
    ['Performance Score', `${liveResult.score}/100`, getScoreLabel(liveResult.score)],
    ['Largest Contentful Paint (LCP)', `${liveResult.lcp}s`, liveResult.lcp <= 2.5 ? 'Good' : liveResult.lcp <= 4 ? 'Needs Improvement' : 'Poor'],
    ['Total Blocking Time (TBT)', `${liveResult.tbt}ms`, liveResult.tbt <= 200 ? 'Good' : liveResult.tbt <= 600 ? 'Needs Improvement' : 'Poor'],
    ['Cumulative Layout Shift (CLS)', `${liveResult.cls}`, liveResult.cls <= 0.1 ? 'Good' : liveResult.cls <= 0.25 ? 'Needs Improvement' : 'Poor'],
    ['Time to First Byte (TTFB)', `${liveResult.ttfb}s`, liveResult.ttfb <= 0.8 ? 'Good' : 'Needs Improvement'],
    ['Speed Index', `${liveResult.speedIndex}s`, liveResult.speedIndex <= 3.4 ? 'Good' : liveResult.speedIndex <= 5.8 ? 'Needs Improvement' : 'Poor'],
    ['Time to Interactive', `${liveResult.loadTime}s`, liveResult.loadTime <= 3.8 ? 'Good' : liveResult.loadTime <= 7.3 ? 'Needs Improvement' : 'Poor']
  ] : [];

  const getInsightBadge = (impact, status) => {
    if (status === 'completed') return <Badge tone="success">Completed</Badge>;
    if (status === 'error') return <Badge tone="critical">Error</Badge>;
    switch (impact?.toLowerCase()) {
      case 'high': return <Badge tone="critical-strong">High Impact</Badge>;
      case 'medium': return <Badge tone="attention">Medium Impact</Badge>;
      case 'low': return <Badge tone="info">Low Impact</Badge>;
      default: return <Badge>Unknown</Badge>;
    }
  };

  const getInsightTone = (type) => {
    switch (type?.toLowerCase()) {
      case 'success': return 'success';
      case 'warning': return 'warning';
      case 'critical': return 'critical';
      case 'info': return 'info';
      default: return 'info';
    }
  };

  // Every column here is a measured file size from the optimization run. No
  // Lighthouse number appears in this table — a score for a page only exists
  // once Google has actually loaded it, and that result is shown on its own.
  const pageTableRows = pages.slice(0, 20).map((page) => [
    <BlockStack key={`${page.id}-name`} gap="100">
      <Text variant="bodyMd" as="p" fontWeight="semibold">{page.name}</Text>
      <Text variant="bodySm" as="p" tone="subdued">{page.url}</Text>
    </BlockStack>,
    <Text key={`${page.id}-images`} variant="bodyMd" as="p">{page.imagesOptimized}</Text>,
    <Text key={`${page.id}-before`} variant="bodyMd" as="p">{page.originalMB.toFixed(2)} MB</Text>,
    <Text key={`${page.id}-after`} variant="bodyMd" as="p">{page.optimizedMB.toFixed(2)} MB</Text>,
    <Text key={`${page.id}-saved`} variant="bodyMd" as="p" tone="success" fontWeight="semibold">{page.savedMB.toFixed(2)} MB</Text>,
    <Badge key={`${page.id}-rate`} tone="success">{`${Math.round(page.compressionRate)}%`}</Badge>
  ]);

  return (
    <Page
      title="Page Speed Impact Analysis"
      subtitle="Measured image savings from your optimization runs, plus live PageSpeed tests"
    >
      <Layout>
        <Layout.Section>
          <div className="pb-page-header">
            <span className="pb-page-header-icon">📊</span>
            <div>
              <p className="pb-page-header-title">Page Speed Reports</p>
              <p className="pb-page-header-sub">Measured image savings & live Core Web Vitals testing</p>
            </div>
          </div>
        </Layout.Section>
        {loadError && (
          <Layout.Section>
            <Banner title="Error" tone="critical">
              {loadError}
            </Banner>
          </Layout.Section>
        )}

        {actionData?.error && (
          <Layout.Section>
            <Banner title="Live test couldn't complete" tone="warning">
              {actionData.error}
            </Banner>
          </Layout.Section>
        )}

        {/* Stats Banner */}
        <Layout.Section>
          <Banner tone="info">
            <BlockStack gap="200">
              <Text variant="bodyMd" as="p">
                <strong>{optimizedProducts}</strong> out of <strong>{totalProducts}</strong> product pages have been optimized.
              </Text>
              <Text variant="bodyMd" as="p">
                Measured savings: <strong>{totalImagesSaved.toFixed(1)} MB</strong> across{' '}
                <strong>{totalImagesOptimized}</strong> images
                {totalOriginalMB > 0 && ` — ${totalOriginalMB.toFixed(1)} MB down to ${Math.max(totalOriginalMB - totalImagesSaved, 0).toFixed(1)} MB, ${Math.round(avgCompression)}% average compression`}.
              </Text>
              <Text variant="bodyMd" as="p">
                Lighthouse scores and Core Web Vitals are only shown when they have actually been
                measured: pick a page and use <strong>Run Live PageSpeed Test</strong>, which asks
                Google to load that page as it is right now.
              </Text>
            </BlockStack>
          </Banner>
        </Layout.Section>

        {/* Live PageSpeed Test */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Live PageSpeed Test</Text>
              <Text variant="bodyMd" as="p">
                Run a real Lighthouse test via Google PageSpeed Insights to measure the current performance of a product page.
                This is actual measured data for your store, not an estimate.
              </Text>
              {testablePages.length > 0 ? (
                <BlockStack gap="200">
                  <InlineStack gap="400" blockAlign="end" wrap={true}>
                    <Box minWidth="320px">
                      <Select
                        label="Select Page"
                        options={pageOptions}
                        value={selectedPage}
                        onChange={handlePageChange}
                      />
                    </Box>
                    <Button
                      variant="primary"
                      onClick={handleRunLighthouse}
                      loading={isRunningAnalysis}
                      disabled={isRunningAnalysis || !canRunLive}
                    >
                      {isRunningAnalysis ? 'Running test…' : 'Run Live PageSpeed Test'}
                    </Button>
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    {`Any of your ${testablePages.length} published product pages can be tested, optimized or not`}
                    {unpublishedCount > 0 && ` — ${unpublishedCount} more aren't published to the Online Store, so Google can't load them`}.
                  </Text>
                </BlockStack>
              ) : (
                <Banner tone="warning">
                  <Text variant="bodyMd" as="p">
                    None of your products are published to the Online Store sales channel, so Google has no
                    page it can load. Publish one and the live test becomes available — the measured savings
                    below don't depend on it.
                  </Text>
                </Banner>
              )}
              <Text variant="bodySm" as="p" tone="subdued">
                Tests run against the live page on Google's servers and may take 30–60 seconds, and count against
                your plan's monthly PageSpeed reports. Rate limits apply. Tip: run a test before and after
                optimizing a page to see the measured difference.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Live test results — the only Lighthouse numbers on this page */}
        {showSuccessBanner && liveResult && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap={true}>
                  <Text variant="headingMd" as="h3">
                    {`Measured Results — ${actionData.pageName || actionData.pageUrl}`}
                  </Text>
                  <Badge tone={getScoreTone(liveResult.score)}>
                    {`Score: ${liveResult.score}/100 (${getScoreLabel(liveResult.score)})`}
                  </Badge>
                </InlineStack>
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Metric', 'Measured Value', 'Rating']}
                  rows={liveMetricRows}
                />
                <Text variant="bodySm" as="p" tone="subdued">
                  {`Source: Google PageSpeed Insights (Lighthouse, mobile). Tested at ${new Date(liveResult.timestamp).toLocaleString()}.`}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Page-by-Page Performance */}
        {pages.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h3">Measured Image Savings by Page</Text>
                    {pages.length > 20 && (
                      <Badge tone="info">{`Showing first 20 of ${pages.length} pages`}</Badge>
                    )}
                  </InlineStack>
                  <Text variant="bodySm" as="p" tone="subdued">
                    Before and After are the total image weight of each page, measured during
                    optimization.
                  </Text>
                </BlockStack>
                <DataTable
                  columnContentTypes={['text', 'numeric', 'text', 'text', 'text', 'text']}
                  headings={['Page', 'Images', 'Before', 'After', 'Saved', 'Compression']}
                  rows={pageTableRows}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Insights */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h3">Performance Insights & Recommendations</Text>
              {insights.map((insight) => (
                <Banner key={insight.id} tone={getInsightTone(insight.type)}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="start">
                      <Text variant="bodyMd" as="p" fontWeight="semibold">{insight.title}</Text>
                      {getInsightBadge(insight.impact, insight.status)}
                    </InlineStack>
                    <Text variant="bodyMd" as="p">{insight.description}</Text>
                  </BlockStack>
                </Banner>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  );
}