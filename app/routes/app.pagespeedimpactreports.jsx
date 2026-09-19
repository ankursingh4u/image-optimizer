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
  ProgressBar,
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
async function runPageSpeedTest(url) {
  try {
    // Use Google PageSpeed Insights API with API key for higher rate limits.
    // Key is provided via environment variable only (never hardcoded).
    const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY;
    const keyParam = apiKey ? `&key=${apiKey}` : '';
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&category=performance&strategy=mobile${keyParam}`;
    
    console.log('Running PageSpeed test for:', url);
    
    const response = await fetch(apiUrl);
    if (!response.ok) {
      // Include Google's own status and reason. The previous bare message hid
      // WHY every call failed, which let a malformed storefront URL look
      // identical to a rate limit in the logs.
      const body = await response.text().catch(() => '');
      throw new Error(`PageSpeed API ${response.status} for ${url}: ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const lighthouseResult = data.lighthouseResult;
    
    if (!lighthouseResult) {
      throw new Error('No Lighthouse data in response');
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

  } catch (error) {
    console.error('PageSpeed test error:', error);
    return null;
  }
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
    
    // Calculate realistic performance improvements based on research
    // Studies show that for every 1MB of image size reduction:
    // - LCP improves by ~0.2-0.3s on 3G/4G
    // - Load time improves by ~0.3-0.5s
    // - Performance score improves by ~2-5 points per 10% size reduction
    
    const lcpImprovement = Math.min((totalSizeSavedMB * 0.25), 3.0); // Max 3s improvement
    const loadTimeImprovement = Math.min((totalSizeSavedMB * 0.35), 4.0); // Max 4s improvement
    const scoreImprovement = Math.min((compressionRate * 0.5), 40); // Max 40 points
    
    return {
      lcpImprovement: parseFloat(lcpImprovement.toFixed(2)),
      loadTimeImprovement: parseFloat(loadTimeImprovement.toFixed(2)),
      scoreImprovement: Math.round(scoreImprovement),
      totalSizeSavedMB: parseFloat(totalSizeSavedMB.toFixed(2)),
      totalOriginalSizeMB: parseFloat(totalOriginalSizeMB.toFixed(2)),
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
 * Assumed "before" metrics for a typical e-commerce page.
 *
 * These are FIXED CONSTANTS, not measurements — the same numbers for every page
 * of every store. Nothing here was measured on the merchant's storefront, and
 * nothing derived from them may be presented as a measured result. Any UI built
 * on this must say "projected"/"estimated"; the only real numbers on this page
 * come from runPageSpeedTest(), which calls Google PageSpeed Insights.
 */
function getBaselineMetrics() {
  return {
    score: 55,
    lcp: 4.5,
    fid: 200,
    cls: 0.20,
    ttfb: 1.3,
    loadTime: 6.2,
    speedIndex: 5.8
  };
}

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
        const baseline = getBaselineMetrics();
        
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
          improvement,
          before: { ...baseline },
          after: {
            score: Math.min(baseline.score + improvement.scoreImprovement, 100),
            lcp: Math.max(baseline.lcp - improvement.lcpImprovement, 1.0),
            fid: Math.max(baseline.fid - Math.round(improvement.scoreImprovement * 2), 50),
            cls: Math.max(baseline.cls - (improvement.compressionRate * 0.001), 0.05),
            ttfb: Math.max(baseline.ttfb - (improvement.totalSizeSavedMB * 0.05), 0.4),
            loadTime: Math.max(baseline.loadTime - improvement.loadTimeImprovement, 2.0),
            speedIndex: Math.max(baseline.speedIndex - (improvement.loadTimeImprovement * 0.8), 2.5)
          }
        });
      }
    }

    // Calculate overall average metrics
    const baseline = getBaselineMetrics();
    let overall = {
      before: { ...baseline },
      after: { ...baseline }
    };

    if (pageAnalyses.length > 0) {
      // Calculate averages from optimized pages
      const avgScoreImprovement = pageAnalyses.reduce((sum, p) => sum + p.improvement.scoreImprovement, 0) / pageAnalyses.length;
      const avgLcpImprovement = pageAnalyses.reduce((sum, p) => sum + p.improvement.lcpImprovement, 0) / pageAnalyses.length;
      const avgLoadTimeImprovement = pageAnalyses.reduce((sum, p) => sum + p.improvement.loadTimeImprovement, 0) / pageAnalyses.length;
      const avgTotalSaved = pageAnalyses.reduce((sum, p) => sum + p.improvement.totalSizeSavedMB, 0) / pageAnalyses.length;
      
      overall.after = {
        score: Math.min(Math.round(baseline.score + avgScoreImprovement), 100),
        lcp: Math.max(parseFloat((baseline.lcp - avgLcpImprovement).toFixed(2)), 1.0),
        fid: Math.max(baseline.fid - Math.round(avgScoreImprovement * 2), 50),
        cls: Math.max(parseFloat((baseline.cls - (avgTotalSaved * 0.015)).toFixed(3)), 0.05),
        ttfb: Math.max(parseFloat((baseline.ttfb - (avgTotalSaved * 0.05)).toFixed(2)), 0.4),
        loadTime: Math.max(parseFloat((baseline.loadTime - avgLoadTimeImprovement).toFixed(2)), 2.0),
        speedIndex: Math.max(parseFloat((baseline.speedIndex - (avgLoadTimeImprovement * 0.8)).toFixed(2)), 2.5)
      };
    }

    // Build pages array with calculated metrics
    const pages = pageAnalyses.map(page => ({
      id: page.id,
      url: page.url,
      name: page.name,
      fullUrl: page.fullUrl,
      published: page.published,
      before: page.before,
      after: page.after,
      imagesOptimized: page.improvement.optimizedImages,
      savedMB: page.improvement.totalSizeSavedMB,
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
        title: 'Significant Image Optimization Achieved',
        description: `Successfully reduced total image payload by ${totalSaved.toFixed(1)} MB across ${pageAnalyses.length} product pages. This represents ${avgCompression.toFixed(0)}% average compression, with ${totalImages} images optimized.`,
        impact: 'high',
        status: 'completed'
      });
      
      const avgScoreIncrease = pageAnalyses.reduce((sum, p) => sum + p.improvement.scoreImprovement, 0) / pageAnalyses.length;
      insights.push({
        id: '2',
        type: 'info',
        title: 'Projected Performance Score Gain',
        description: `Against a typical e-commerce baseline of ${baseline.score}, this much compression projects to about ${avgScoreIncrease.toFixed(0)} points of Lighthouse improvement. This is a projection from published benchmarks, not a measurement of your storefront — run a live PageSpeed test on a page for its real score.`,
        impact: 'medium',
        status: 'pending'
      });
      
      const avgLoadTimeReduction = pageAnalyses.reduce((sum, p) => sum + p.improvement.loadTimeImprovement, 0) / pageAnalyses.length;
      insights.push({
        id: '3',
        type: 'info',
        title: 'Projected Faster Page Load Times',
        description: `The payload you removed projects to roughly ${avgLoadTimeReduction.toFixed(1)}s less load time per page on a typical mobile connection. Faster load times correlate with better conversion, but this figure is an estimate from the bytes saved rather than a measurement.`,
        impact: 'medium',
        status: 'pending'
      });
    }

    const unoptimizedCount = products.length - pageAnalyses.length;
    if (unoptimizedCount > 0) {
      insights.push({
        id: '4',
        type: 'warning',
        title: 'Additional Optimization Opportunities',
        description: `${unoptimizedCount} product pages have not been optimized yet. Running image optimization on these pages could yield an estimated ${(unoptimizedCount * 1.5).toFixed(1)} MB in additional savings.`,
        impact: 'medium',
        status: 'pending'
      });
    }

    insights.push({
      id: '5',
      type: 'info',
      title: 'Ongoing Performance Monitoring',
      description: 'Continue monitoring Core Web Vitals and run periodic optimizations as new products are added. Consider implementing lazy loading for below-the-fold images.',
      impact: 'low',
      status: 'pending'
    });

    // Add SEO insight if improvements are significant
    if (overall.after.score >= 80) {
      insights.push({
        id: '6',
        type: 'success',
        title: 'SEO Benefits from Performance Optimization',
        description: 'Your improved performance scores positively impact search engine rankings. Google uses Core Web Vitals as a ranking factor, and faster pages typically see better organic search visibility.',
        impact: 'medium',
        status: 'completed'
      });
    }

    return { 
      overall, 
      pages, 
      insights, 
      selectedPage,
      shopUrl,
      totalProducts: products.length,
      optimizedProducts: pageAnalyses.length,
      totalImagesSaved: totalSaved,
      totalImagesOptimized: totalImages,
      error: null 
    };
  } catch (error) {
    console.error('Error loading page speed data:', error);
    const baseline = getBaselineMetrics();
    return {
      overall: {
        before: { ...baseline },
        after: { ...baseline }
      },
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
      totalImagesOptimized: 0,
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
    overall, 
    pages, 
    insights, 
    selectedPage: initialSelectedPage,
    shopUrl,
    totalProducts,
    optimizedProducts,
    totalImagesSaved,
    totalImagesOptimized,
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

  const calculateImprovement = (before, after) => {
    if (before === 0) return 0;
    return Math.abs((((before - after) / before) * 100)).toFixed(0);
  };

  const currentData = selectedPage === 'all' ? overall : pages.find(p => p.id === selectedPage) || overall;

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

  const pageTableRows = pages.slice(0, 20).map((page) => [
    <BlockStack key={`${page.id}-name`} gap="100">
      <Text variant="bodyMd" as="p" fontWeight="semibold">{page.name}</Text>
      <Text variant="bodySm" as="p" tone="subdued">{page.url}</Text>
    </BlockStack>,
    <InlineStack key={`${page.id}-score`} gap="100" blockAlign="center">
      <Text variant="bodySm" as="span" tone="subdued">{page.before.score}</Text>
      <Text variant="bodySm" as="span">→</Text>
      <Text variant="bodyMd" as="span" tone="success" fontWeight="semibold">{page.after.score}</Text>
      <Badge tone="success">+{page.after.score - page.before.score}</Badge>
    </InlineStack>,
    <Text key={`${page.id}-lcp`} variant="bodySm" as="p">
      <Text as="span" tone="subdued">{page.before.lcp}s</Text> → <Text as="span" tone="success" fontWeight="semibold">{page.after.lcp}s</Text>
    </Text>,
    <Text key={`${page.id}-load`} variant="bodySm" as="p">
      <Text as="span" tone="subdued">{page.before.loadTime}s</Text> → <Text as="span" tone="success" fontWeight="semibold">{page.after.loadTime}s</Text>
    </Text>,
    <Text key={`${page.id}-images`} variant="bodyMd" as="p">{page.imagesOptimized}</Text>,
    <Text key={`${page.id}-saved`} variant="bodyMd" as="p" tone="success" fontWeight="semibold">{page.savedMB.toFixed(1)} MB</Text>
  ]);

  return (
    <Page
      title="Page Speed Impact Analysis"
      subtitle="Projected impact of your image optimization, plus live measurement from Google PageSpeed Insights"
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
                Total savings: <strong>{totalImagesSaved.toFixed(1)} MB</strong> across <strong>{totalImagesOptimized}</strong> images.
                These savings are measured from your store.
              </Text>
              <Text variant="bodyMd" as="p">
                The speed scores below are <strong>projections</strong> — they apply published
                industry benchmarks to your compression data against a typical e-commerce
                baseline, and are not measured on your storefront. For real numbers, pick a
                page and use <strong>Run Live PageSpeed Test</strong>.
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
              <InlineStack gap="400">
                <InlineStack gap="200" blockAlign="center">
                  <Box background="bg-fill-critical" padding="100" borderRadius="100" minWidth="12px" minHeight="12px" />
                  <Text variant="bodySm" as="p" tone="subdued">Before Optimization</Text>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center">
                  <Box background="bg-fill-success" padding="100" borderRadius="100" minWidth="12px" minHeight="12px" />
                  <Text variant="bodySm" as="p" tone="subdued">After Optimization</Text>
                </InlineStack>
              </InlineStack>
            </InlineStack>
          </Card>
        </Layout.Section>

        {currentPageMeta && !canRunLive && (
          <Layout.Section>
            <Banner title="Live testing isn't available for this page" tone="warning">
              <Text variant="bodyMd" as="p">
                "{currentPageMeta.name}" isn't published to the Online Store sales channel, so Google
                can't load it and a live PageSpeed test would fail. Publish the product, or pick a page
                that's live on your storefront. The projections below still apply — they're based on the
                images you've already optimized.
              </Text>
            </Banner>
          </Layout.Section>
        )}

        {/* Measured result — real Google data, above the projections on purpose */}
        {showLive && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" wrap={true}>
                  <Text variant="headingMd" as="h3">Measured Performance</Text>
                  <Badge tone="success">Live from Google PageSpeed Insights</Badge>
                </InlineStack>
                <Text variant="bodySm" as="p" tone="subdued">
                  Measured on this page as it is right now. These are real numbers, not projections.
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

        {/* Performance Score */}
        <Layout.Section>
          <InlineStack gap="400" wrap={true}>
            <Box minWidth="300px" width="50%">
              <Card>
                <BlockStack gap="500">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h3">Projected Performance Score</Text>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Estimated from compression data — not measured on your store.
                    </Text>
                  </BlockStack>
                  <InlineStack align="center" gap="600">
                    <BlockStack gap="200" inlineAlign="center">
                      <Text variant="bodySm" as="p" tone="subdued">Before</Text>
                      <Text variant="heading3xl" as="p" tone={getScoreTone(currentData.before.score)}>
                        {currentData.before.score}
                      </Text>
                      <Text variant="bodySm" as="p" tone="subdued">
                        {getScoreLabel(currentData.before.score)}
                      </Text>
                    </BlockStack>

                    <BlockStack gap="200" inlineAlign="center">
                      <Box background="bg-fill-success" padding="300" borderRadius="100">
                        <Text variant="heading2xl" as="p" tone="success">↑</Text>
                      </Box>
                      <Text variant="heading2xl" as="p" tone="success" fontWeight="bold">
                        +{currentData.after.score - currentData.before.score}
                      </Text>
                    </BlockStack>

                    <BlockStack gap="200" inlineAlign="center">
                      <Text variant="bodySm" as="p" tone="subdued">After</Text>
                      <Text variant="heading3xl" as="p" tone={getScoreTone(currentData.after.score)}>
                        {currentData.after.score}
                      </Text>
                      <Text variant="bodySm" as="p" tone="subdued">
                        {getScoreLabel(currentData.after.score)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Box>

            <Box minWidth="300px" width="50%">
              <Card>
                <BlockStack gap="500">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h3">Projected Core Web Vitals</Text>
                    <Text variant="bodySm" as="p" tone="subdued">
                      Estimated from compression data — not measured on your store.
                    </Text>
                  </BlockStack>
                  <BlockStack gap="400">
                    {metrics.map(metric => {
                      const improvement = calculateImprovement(currentData.before[metric.id], currentData.after[metric.id]);
                      return (
                        <BlockStack key={metric.id} gap="300">
                          <InlineStack align="space-between">
                            <Text variant="bodyMd" as="p">
                              <Text as="span" fontWeight="semibold">{metric.name}</Text>
                              <Text as="span" tone="subdued"> ({metric.label})</Text>
                            </Text>
                            <Badge tone="success">-{improvement}%</Badge>
                          </InlineStack>
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <Box width="45%">
                              <InlineStack gap="100" blockAlign="center" wrap={false}>
                                <Text variant="bodySm" as="p" tone="critical" alignment="end" minWidth="60px">
                                  {currentData.before[metric.id]}{metric.unit}
                                </Text>
                                <Box width="100%">
                                  <ProgressBar
                                    progress={Math.min((currentData.before[metric.id] / (metric.goodThreshold * 2)) * 100, 100)}
                                    size="small"
                                    tone="critical"
                                  />
                                </Box>
                              </InlineStack>
                            </Box>
                            <Box width="45%">
                              <InlineStack gap="100" blockAlign="center" wrap={false}>
                                <Box width="100%">
                                  <ProgressBar
                                    progress={Math.min((currentData.after[metric.id] / (metric.goodThreshold * 2)) * 100, 100)}
                                    size="small"
                                    tone="success"
                                  />
                                </Box>
                                <Text variant="bodySm" as="p" tone="success" minWidth="60px">
                                  {currentData.after[metric.id]}{metric.unit}
                                </Text>
                              </InlineStack>
                            </Box>
                          </InlineStack>
                        </BlockStack>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        {/* Page-by-Page Performance */}
        {pages.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h3">Optimized Pages — Projected Impact</Text>
                  {pages.length > 20 && (
                    <Badge tone="info">Showing first 20 of {pages.length} pages</Badge>
                  )}
                </InlineStack>
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'text', 'numeric', 'text']}
                  headings={['Page', 'Score (Before → After)', 'LCP', 'Load Time', 'Images', 'Saved']}
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
                  Google PageSpeed Insights. That result is real measured data for that page, and appears
                  above the projections. The test isn't available for "All Pages (Average)" — Google
                  measures one URL at a time.
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