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
  const fidAudit = audits['max-potential-fid'] || audits['total-blocking-time'];
  const clsAudit = audits['cumulative-layout-shift'];
  const ttfbAudit = audits['server-response-time'];
  const speedIndexAudit = audits['speed-index'];
  const interactiveAudit = audits['interactive'];

  return {
    score: performanceScore,
    lcp: lcpAudit?.numericValue ? parseFloat((lcpAudit.numericValue / 1000).toFixed(2)) : 0,
    fid: fidAudit?.numericValue ? Math.round(fidAudit.numericValue) : 0,
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
        message: `PageSpeed analysis completed. Performance Score: ${result.score}/100`,
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
  
  const [selectedPage, setSelectedPage] = useState(initialSelectedPage);
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // A live run measures ONE page as it is right now. Track which page it belongs
  // to so changing the selector can't display one page's real measurement under
  // another page's name.
  const [liveResult, setLiveResult] = useState(null);
  const [liveResultPage, setLiveResultPage] = useState(null);

  const isRunningAnalysis = navigation.state === 'submitting';

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccessBanner(true);
      setSuccessMessage(actionData.message);
      if (actionData.result) {
        setLiveResult(actionData.result);
      }
      setTimeout(() => setShowSuccessBanner(false), 5000);
    }
  }, [actionData]);

  const metrics = [
    { id: 'lcp', name: 'LCP', label: 'Largest Contentful Paint', unit: 's', goodThreshold: 2.5 },
    { id: 'fid', name: 'FID', label: 'First Input Delay', unit: 'ms', goodThreshold: 100 },
    { id: 'cls', name: 'CLS', label: 'Cumulative Layout Shift', unit: '', goodThreshold: 0.1 },
    { id: 'ttfb', name: 'TTFB', label: 'Time to First Byte', unit: 's', goodThreshold: 0.8 }
  ];

  const handlePageChange = useCallback((value) => {
    setSelectedPage(value);
    // A measurement belongs to the page it was run against — drop it rather than
    // let it linger over a different page's numbers.
    setLiveResult(null);
    setLiveResultPage(null);
    submit({ page: value }, { method: 'get' });
  }, [submit]);

  const handleRunLighthouse = useCallback(() => {
    if (selectedPage === 'all') {
      return; // Can't run test on "all pages"
    }

    const currentPage = pages.find(p => p.id === selectedPage);
    if (!currentPage || !currentPage.published) return;

    // Stamp the target before submitting, so the result that comes back is
    // attributed to the page that was actually tested.
    setLiveResult(null);
    setLiveResultPage(selectedPage);

    const formData = new FormData();
    formData.append('actionType', 'runLighthouseAnalysis');
    formData.append('pageUrl', currentPage.fullUrl);
    submit(formData, { method: 'post' });
  }, [selectedPage, pages, submit]);

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

  // Only show a measurement against the page it was taken on.
  const showLive = Boolean(liveResult) && liveResultPage === selectedPage;

  const currentPageMeta = selectedPage === 'all' ? null : pages.find(p => p.id === selectedPage);
  // Google can only load a page that's actually published to the Online Store.
  const canRunLive = Boolean(currentPageMeta?.published);

  const pageOptions = [
    { label: 'All Pages (Average)', value: 'all' },
    ...pages.map(page => ({ label: page.name || page.url, value: page.id }))
  ];

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
      primaryAction={
        selectedPage !== 'all' && pages.length > 0
          ? {
              content: isRunningAnalysis ? 'Running Analysis...' : 'Run Live PageSpeed Test',
              onAction: handleRunLighthouse,
              loading: isRunningAnalysis,
              // Disabled rather than hidden when the product isn't published —
              // the banner below explains why, which beats a button that
              // silently burns one of the plan's monthly reports on a 404.
              disabled: isRunningAnalysis || !canRunLive
            }
          : undefined
      }
    >
      <Layout>
        {loadError && (
          <Layout.Section>
            <Banner title="Error" tone="critical">
              {loadError}
            </Banner>
          </Layout.Section>
        )}

        {showSuccessBanner && actionData?.success && (
          <Layout.Section>
            <Banner title="Analysis Complete" tone="success" onDismiss={() => setShowSuccessBanner(false)}>
              {successMessage}
            </Banner>
          </Layout.Section>
        )}

        {actionData?.error && (
          <Layout.Section>
            <Banner title="Error" tone="critical">
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

        {/* Page Selector */}
        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center" wrap={true}>
              <Box minWidth="300px">
                <Select 
                  label="Select Page" 
                  options={pageOptions} 
                  value={selectedPage} 
                  onChange={handlePageChange} 
                />
              </Box>
              <Text variant="bodySm" as="p" tone="subdued">
                Pick a page to run a live test on it
              </Text>
            </InlineStack>
          </Card>
        </Layout.Section>

        {currentPageMeta && !canRunLive && (
          <Layout.Section>
            <Banner title="Live testing isn't available for this page" tone="warning">
              <Text variant="bodyMd" as="p">
                "{currentPageMeta.name}" isn't published to the Online Store sales channel, so Google
                can't load it and a live PageSpeed test would fail. Publish the product, or pick a page
                that's live on your storefront. The measured savings below still apply — they come from
                the images you've already optimized.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Measured result — the only Lighthouse numbers on this page */}
        {showLive && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap={true}>
                  <Text variant="headingMd" as="h3">Measured Performance</Text>
                  <Badge tone="success">Live from Google PageSpeed Insights</Badge>
                </InlineStack>
                <Text variant="bodySm" as="p" tone="subdued">
                  Measured on this page as it is right now, by Google.
                </Text>
                <InlineStack gap="600" wrap={true} blockAlign="start">
                  <BlockStack gap="100" inlineAlign="center">
                    <Text variant="bodySm" as="p" tone="subdued">Performance score</Text>
                    <Text variant="heading3xl" as="p" tone={getScoreTone(liveResult.score)}>
                      {liveResult.score}
                    </Text>
                    <Text variant="bodySm" as="p" tone="subdued">{getScoreLabel(liveResult.score)}</Text>
                  </BlockStack>
                  {metrics.map(metric => (
                    <BlockStack key={`live-${metric.id}`} gap="100" inlineAlign="center">
                      <Text variant="bodySm" as="p" tone="subdued">{metric.name}</Text>
                      <Text variant="headingLg" as="p">
                        {liveResult[metric.id]}{metric.unit}
                      </Text>
                      <Text
                        variant="bodySm"
                        as="p"
                        tone={liveResult[metric.id] <= metric.goodThreshold ? 'success' : 'subdued'}
                      >
                        {liveResult[metric.id] <= metric.goodThreshold ? 'Good' : 'Needs work'}
                      </Text>
                    </BlockStack>
                  ))}
                </InlineStack>
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
                    <Text variant="headingMd" as="h3">Optimized Pages — Measured Savings</Text>
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

        {/* Live Testing Info */}
        {pages.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h3">Live Performance Testing</Text>
                <Text variant="bodyMd" as="p">
                  Select a specific page above and click "Run Live PageSpeed Test" to measure it with
                  Google PageSpeed Insights. The result appears at the top of this page and is the only
                  place a performance score is shown. The test isn't available for "All Pages (Average)"
                  — Google measures one URL at a time.
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  A test takes 30-60 seconds and counts against your plan's monthly PageSpeed reports.
                  Google must be able to reach the page publicly, so a password-protected storefront or an
                  unpublished product will fail. Rate limits apply (roughly 1-2 requests per minute).
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}