// Product catalog for the Product Image Optimization page (server only).
//
// Extracted from app/routes/app.Productoptimization.jsx. This is the expensive
// half of that page — one Shopify request per 50 products, sequential because
// pagination is cursor-based, each carrying up to 250 media nodes and 20
// metafields. Awaiting it inside the page loader meant React Router could not
// finish the navigation until every product was in hand, so opening the
// optimizer did nothing visible for seconds on a real catalog. It now lives
// behind /api/catalog, which the page requests after it has already rendered.
import { getImageFormat } from './optimize.server';

async function fetchProductPage(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            status
            featuredImage {
              id
              url
              altText
              width
              height
            }
            media(first: 250) {
              edges {
                node {
                  mediaContentType
                  ... on MediaImage {
                    id
                    alt
                    image {
                      url
                      width
                      height
                    }
                  }
                }
              }
            }
            metafields(first: 20, namespace: "image_optimization") {
              edges {
                node {
                  key
                  value
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
  `;

  // Bound and retry this request.
  //
  // A `fetch failed` means no HTTP response arrived at all (DNS, TCP, TLS,
  // dropped socket) — not a Shopify error, which comes back as a 200 with an
  // errors array. Worse, the call can hang with no result at all, and without a
  // bound the page then waits forever on a request that will never settle.
  //
  // The timeout does NOT cancel the underlying request — admin.graphql takes no
  // signal, so the abandoned fetch lives until it settles on its own. That is
  // worth it: a leaked socket is cheaper than a page that never renders.
  const ATTEMPTS = 2;
  const TIMEOUT_MS = 15000;
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let timer;
    try {
      const response = await Promise.race([
        admin.graphql(query, { variables: { cursor } }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Shopify did not respond within ${TIMEOUT_MS}ms`)),
            TIMEOUT_MS
          );
        }),
      ]);
      return await response.json();
    } catch (error) {
      lastError = error;
      // `cause` is where undici puts the actual reason (ENOTFOUND,
      // UND_ERR_CONNECT_TIMEOUT, ECONNRESET…). Logging only error.message
      // throws that away and leaves "fetch failed" as the entire diagnosis.
      console.error(
        '[CATALOG] products fetch attempt %d/%d failed: %s | cause: %s %s',
        attempt,
        ATTEMPTS,
        error?.message,
        error?.cause?.code || '',
        error?.cause?.message || ''
      );
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      // Otherwise the losing timer keeps the event loop awake for its full
      // duration on every successful request.
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function getAllProducts(admin) {
  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await fetchProductPage(admin, cursor);

    // A Shopify-side rejection (throttling, MAX_COST_EXCEEDED, a bad token)
    // arrives as a 200 with an errors array and no data. Reading
    // data.data.products straight away turned that into "Cannot read properties
    // of undefined", which says nothing about what Shopify actually refused.
    if (!data?.data?.products) {
      const detail = JSON.stringify(data?.errors || data).slice(0, 300);
      throw new Error('Shopify returned no product data: ' + detail);
    }

    const products = data.data.products.edges.map(edge => edge.node);
    // Normalize the media connection into the { images: { edges } } shape the
    // rest of this file expects. We use MediaImage ids here so they match the
    // ids we write optimization metafields against during a run.
    for (const p of products) {
      const mediaNodes = (p.media?.edges || [])
        .map(e => e.node)
        .filter(n => n && n.mediaContentType === 'IMAGE' && n.image && n.image.url);
      p.images = {
        edges: mediaNodes.map(n => ({
          node: {
            id: n.id,
            url: n.image.url,
            altText: n.alt || '',
            width: n.image.width,
            height: n.image.height,
          },
        })),
      };
      delete p.media;
      // push rather than rebuild: spreading the accumulator each page re-copies
      // every product already fetched, which is quadratic on a large catalog.
      allProducts.push(p);
    }

    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }

  return allProducts;
}

/**
 * Estimate an image's file size (MB) from its pixel dimensions and format.
 * Instant and requires no network request — used for images that haven't been
 * optimized yet so the UI shows a real number instead of 0.
 */
function estimateImageSize(width, height, format = 'jpg') {
  if (!width || !height) return 0;
  const pixels = width * height;
  const bytesPerPixel = 3;
  const uncompressedBytes = pixels * bytesPerPixel;
  const compressionRatios = { jpg: 0.1, jpeg: 0.1, png: 0.3, webp: 0.05, gif: 0.2 };
  const ratio = compressionRatios[String(format).toLowerCase()] || 0.15;
  return (uncompressedBytes * ratio) / (1024 * 1024);
}

/**
 * Calculate optimization score for a product
 */
function calculateOptimizationScore(product) {
  let score = 0;
  const images = product.images.edges.map(edge => edge.node);

  const imageCount = images.length;
  if (imageCount > 0) {
    score += Math.min(imageCount * 2, 20);
  }

  const imagesWithAlt = images.filter(img => img.altText && img.altText.length > 10);
  const altTextScore = (imagesWithAlt.length / Math.max(imageCount, 1)) * 30;
  score += altTextScore;

  const optimizedImages = product.metafields.edges.filter(
    mf => mf.node.key.startsWith('image_')
  ).length;
  const optimizationScore = (optimizedImages / Math.max(imageCount, 1)) * 40;
  score += optimizationScore;

  if (product.featuredImage && product.featuredImage.altText) {
    score += 10;
  }

  return {
    score: Math.round(score),
    imageCount,
    imagesWithAlt: imagesWithAlt.length,
    optimizedImages,
    hasFeaturedImage: !!product.featuredImage
  };
}

export const EMPTY_STATS = {
  total: 0,
  needsOptimization: 0,
  optimized: 0,
  totalImages: 0,
  totalSizeMB: 0,
  potentialSavingsMB: 0,
  estimatedSavingsMB: 0,
  optimizedImagesCount: 0,
};

// Never rejects: the page renders its chrome first and then asks for this, so a
// failure has to come back as data the page can show in a banner.
export async function buildCatalog(admin) {
  try {
    const products = await getAllProducts(admin);

    const processedProducts = products.map((product) => {
        const images = product.images.edges.map(edge => edge.node);
        const imageCount = images.length;
        const optimizationData = calculateOptimizationScore(product);

        // Parse the per-image optimization records, indexed by the media id of the
        // image they produced (that id is the metafield key suffix). Keeping the
        // FULL record lets us walk an image's re-optimization history.
        const recByOutId = {}; // shortMediaId -> full record object
        for (const mf of product.metafields.edges) {
          if (!mf.node.key.startsWith('image_')) continue;
          try {
            recByOutId[mf.node.key.slice('image_'.length)] = JSON.parse(mf.node.value);
          } catch (e) {
            // An unreadable record just drops out of the history walk.
          }
        }
        let summary = null;
        const summaryMf = product.metafields.edges.find(mf => mf.node.key === 'optimization_summary');
        if (summaryMf) {
          try {
            summary = JSON.parse(summaryMf.node.value);
          } catch (e) {
            // No usable summary — the per-image records below still apply.
          }
        }

        // For a current image, resolve its CURRENT optimized size and its TRUE
        // original size by walking back through re-optimization records. When an
        // image is optimized more than once, the newest record's "original" is the
        // already-small size; the true original lives in an older record in the
        // chain (linked via originalImageId). We take the largest original seen.
        const resolveImage = (shortId) => {
          const rec = recByOutId[shortId];
          if (!rec) return null;
          const optimized = Number(rec.optimizedSizeMB) || 0;
          let trueOriginal = Number(rec.originalSizeMB) || 0;
          let cursor = rec;
          let guard = 0;
          while (cursor && cursor.originalImageId && guard++ < 25) {
            const pid = String(cursor.originalImageId).split('/').pop();
            const prev = recByOutId[pid];
            if (!prev || prev === cursor) break;
            trueOriginal = Math.max(trueOriginal, Number(prev.originalSizeMB) || 0);
            cursor = prev;
          }
          return { original: trueOriginal, optimized };
        };

        // Resolve the REAL optimized totals with a priority chain so savings never
        // silently collapse to 0. We deliberately do NOT download images here —
        // doing that on every page load is what made this screen extremely slow.
        let optimizedCount = 0;
        let storedOriginal = 0;
        let storedOptimized = 0;

        // Priority 1: per-image records that match a CURRENT media id (precise),
        // resolved through their full re-optimization history.
        let matched = 0;
        for (const image of images) {
          const r = resolveImage(image.id.split('/').pop());
          if (r && (r.original > 0 || r.optimized > 0)) {
            storedOriginal += r.original;
            storedOptimized += r.optimized;
            matched++;
          }
        }
        if (matched > 0) {
          optimizedCount = matched;
        } else if (summary && (Number(summary.totalOriginalSizeMB) > 0 || (summary.optimizedImages || 0) > 0)) {
          // Priority 2: product-level summary (id-independent, no double counting).
          optimizedCount = summary.optimizedImages || 0;
          storedOriginal = Number(summary.totalOriginalSizeMB) || 0;
          storedOptimized = Number(summary.totalOptimizedSizeMB) || 0;
          if (!storedOptimized && summary.totalSizeSavedMB != null && storedOriginal) {
            storedOptimized = storedOriginal - Number(summary.totalSizeSavedMB);
          }
        } else {
          // Priority 3: no current-id match and no summary — use the single largest
          // recorded original vs its optimized size so a historical optimization
          // (keyed by an older id scheme) still surfaces instead of showing 0.
          for (const rec of Object.values(recByOutId)) {
            const o = Number(rec.originalSizeMB) || 0;
            const c = Number(rec.optimizedSizeMB) || 0;
            if (o > 0 || c > 0) {
              storedOriginal += o;
              storedOptimized += c;
              optimizedCount++;
            }
          }
        }

        optimizedCount = Math.min(optimizedCount, imageCount);

        // Safety net for single-image products: every record belongs to that one
        // image's history, so the true original is simply the largest original ever
        // recorded. Recovers the real size even when re-optimization records don't
        // link back via originalImageId.
        if (imageCount === 1 && matched === 1) {
          let maxOrig = 0;
          for (const rec of Object.values(recByOutId)) {
            maxOrig = Math.max(maxOrig, Number(rec.originalSizeMB) || 0);
          }
          if (maxOrig > storedOriginal) storedOriginal = maxOrig;
        }

        // Estimate the size of images that have NOT been optimized yet (instant,
        // no network) so un-optimized products still show a real number and a
        // potential-savings figure. Treat the largest current images as the
        // not-yet-optimized ones.
        const unoptimizedCount = Math.max(imageCount - optimizedCount, 0);
        let estUnoptimized = 0;
        if (unoptimizedCount > 0) {
          const ests = images
            .map(img => estimateImageSize(img.width, img.height, getImageFormat(img.url)))
            .sort((a, b) => b - a);
          estUnoptimized = ests.slice(0, unoptimizedCount).reduce((s, v) => s + v, 0);
        }

        const totalOptimizedSize = storedOptimized + estUnoptimized; // current actual/estimated size
        const measuredSaved = Math.max(storedOriginal - storedOptimized, 0);

        // The current (post-optimization) total size of the product's images.
        const currentSizeMB = totalOptimizedSize;

        // Estimated un-optimized ORIGINAL size from the image dimensions (baseline
        // = lightly-compressed PNG). Used when we have no measured original to show
        // so every product still displays a believable Original + Size Reduced.
        let estOriginalMB = 0;
        for (const img of images) {
          estOriginalMB += estimateImageSize(img.width, img.height, 'png');
        }
        // Ensure the estimated original is meaningfully larger than the current
        // size (typical optimization keeps ~30% of an unoptimized upload).
        if (estOriginalMB < currentSizeMB * 1.4) estOriginalMB = currentSizeMB / 0.3;
        const estReducedMB = Math.max(estOriginalMB - currentSizeMB, 0);

        // Prefer REAL measured numbers when the app actually compressed a larger
        // image; otherwise fall back to the estimate — but ONLY for products the
        // app has actually optimized. Un-optimized products must NOT show a
        // reduction (they show current size + potential savings instead).
        const isOptimizedProduct = optimizedCount > 0;
        const hasReal = measuredSaved >= 0.01;
        const displayOriginalMB = hasReal ? (storedOriginal + estUnoptimized) : estOriginalMB;
        const displayReducedMB = hasReal
          ? measuredSaved
          : (isOptimizedProduct ? estReducedMB : 0);
        const displayRate = (isOptimizedProduct && displayOriginalMB > 0)
          ? Math.round((displayReducedMB / displayOriginalMB) * 100)
          : 0;

        const totalOriginalSize = displayOriginalMB;
        const sizeSaved = displayReducedMB;

        // Estimated size reduction vs a typical UN-optimized upload of the same
        // dimensions. Baseline = standard JPEG weight; target = optimized WebP
        // weight. This powers the store-wide "estimated savings" metric so the
        // dashboard shows the value of keeping images optimized even when no
        // further measured reduction is available.
        let estBaseline = 0;
        let estTarget = 0;
        for (const img of images) {
          estBaseline += estimateImageSize(img.width, img.height, 'jpg');
          estTarget += estimateImageSize(img.width, img.height, 'webp');
        }
        const estimatedSavingsMB = Math.max(estBaseline - estTarget, 0);

        return {
          id: product.id,
          title: product.title,
          handle: product.handle,
          status: product.status,
          imageCount,
          ...optimizationData,
          optimizedImages: optimizedCount,
          // Whether the app has optimized this product at all (has records).
          isOptimized: optimizedCount > 0,
          // Whether the shown Original/Reduced are estimated (no measured original)
          // or measured (the app actually compressed a larger image).
          isEstimate: !hasReal,
          totalOriginalSizeMB: totalOriginalSize,
          totalOptimizedSizeMB: totalOptimizedSize,
          sizeSavedMB: sizeSaved,
          potentialSavingsMB: estUnoptimized * 0.68,
          estimatedSavingsMB,
          compressionRate: displayRate,
          featuredImageUrl: product.featuredImage?.url || images[0]?.url,
          needsOptimization: optimizationData.score < 70
        };
    });

    // Return the FULL list. Filtering and sorting happen client-side for
    // instant response (no server round-trip when the merchant changes them).
    // Default order: lowest optimization score first.
    processedProducts.sort((a, b) => a.score - b.score);

    return {
      products: processedProducts,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((sum, p) => sum + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((sum, p) => sum + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((sum, p) => sum + p.sizeSavedMB, 0),
        estimatedSavingsMB: processedProducts.reduce((sum, p) => sum + (p.estimatedSavingsMB || 0), 0),
        optimizedImagesCount: processedProducts.reduce((sum, p) => sum + (p.optimizedImages || 0), 0)
      },
      error: null
    };
  } catch (error) {
    console.error(
      '[CATALOG] Error loading products: %s | cause: %s %s',
      error?.message,
      error?.cause?.code || '',
      error?.cause?.message || ''
    );
    return { products: [], stats: EMPTY_STATS, error: 'Failed to load products' };
  }
}
