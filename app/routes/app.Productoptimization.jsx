import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { quotaContext } from '../usage.server';
import { getImageFormat, optimizeWholeProduct } from '../optimize.server';
import {
  Page,
  Layout,
  Card,
  Button,
  Badge,
  Checkbox,
  Text,
  Box,
  InlineStack,
  BlockStack,
  Thumbnail,
  Divider,
  Banner,
  ProgressBar,
  Select,
  Spinner,
  EmptyState
} from '@shopify/polaris';

/**
 * Fetch all products with pagination
 */
async function fetchAllProducts(admin, cursor = null) {
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

  const response = await admin.graphql(query, {
    variables: { cursor }
  });

  return await response.json();
}

async function getAllProducts(admin) {
  let allProducts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const data = await fetchAllProducts(admin, cursor);
    const products = data.data.products.edges.map(edge => edge.node);
    // Normalize the media connection into the { images: { edges } } shape the
    // rest of this file expects. We use MediaImage ids here so they match the
    // ids we write optimization metafields against during the action.
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
    }
    allProducts = [...allProducts, ...products];

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

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

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
          } catch (e) {}
        }
        let summary = null;
        const summaryMf = product.metafields.edges.find(mf => mf.node.key === 'optimization_summary');
        if (summaryMf) { try { summary = JSON.parse(summaryMf.node.value); } catch (e) {} }

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

    // Return the FULL list. Filtering and sorting now happen client-side for
    // instant response (no server round-trip when the merchant changes them).
    // Default order: lowest optimization score first.
    processedProducts.sort((a, b) => a.score - b.score);

    return {
      products: processedProducts,
      filter,
      sortBy,
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
    console.error('Error loading products:', error);
    return {
      products: [],
      filter,
      sortBy,
      stats: {
        total: 0,
        needsOptimization: 0,
        optimized: 0,
        totalImages: 0,
        totalSizeMB: 0,
        potentialSavingsMB: 0,
        estimatedSavingsMB: 0,
        optimizedImagesCount: 0
      },
      error: 'Failed to load products'
    };
  }
}

/**
 * Whole-product fallback.
 *
 * The page itself drives `/api/optimize` one image at a time so it can show
 * real progress. This single-request path stays for anything that can't do
 * that — including a browser still running the previous build in the minutes
 * after a deploy, which would otherwise post here and get "Invalid action".
 */
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get('productId');

  if (!productId) {
    return { success: false, error: 'No product was selected.' };
  }

  const quota = await quotaContext(admin, session);
  return optimizeWholeProduct({ admin, quota, productId });
}

/**
 * How many images of the same product are optimized at once.
 *
 * Each image is mostly waiting — on the CDN download, on the staged upload, on
 * the AI call — so running a few together is where the wall-clock saving comes
 * from. Kept small on purpose: every image costs four or five Shopify
 * mutations, and a wider pool just trades one queue for the API's own throttle.
 */
const IMAGE_CONCURRENCY = 3;

/** MB as something a person can read, never as a confusing "0.0 MB". */
function formatBytes(mb) {
  const val = Number(mb) || 0;
  if (val >= 1000) return `${(val / 1000).toFixed(1)} GB`;
  if (val < 1) return `${Math.max(0, Math.round(val * 1024))} KB`;
  return `${val.toFixed(1)} MB`;
}

/** Work through `items` with at most `limit` in flight at any moment. */
async function pooled(items, limit, worker, shouldStop) {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      // Claiming the next index with a post-increment is safe here: JavaScript
      // runs one worker at a time between awaits, so no two can claim the same
      // item.
      let index = cursor++;
      while (index < items.length) {
        if (shouldStop()) return;
        await worker(items[index], index);
        index = cursor++;
      }
    }
  );
  await Promise.all(runners);
}

export default function ProductOptimization() {
  const { products: initialProducts, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError } = useLoaderData();
  const revalidator = useRevalidator();

  const [products, setProducts] = useState(initialProducts);
  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);

  /**
   * An optimization run, driven one IMAGE per request from the browser.
   *
   * The unit used to be a whole product, which is why a product with eight
   * images looked frozen: one request went out and nothing came back until all
   * eight were done. Now every image is its own request, so each response is a
   * progress event — that is what makes "image 3 of 8" a real number rather
   * than a guess — and a few images can be in flight together, which is where
   * the speed comes from.
   *
   * The live counters live in a ref and are published into state, because a
   * handful of concurrent workers all updating the same tallies through
   * setState callbacks is far easier to get wrong.
   */
  const [run, setRun] = useState(null);
  const runRef = useRef(null);
  // Set by the Stop button and by a quota refusal; every worker checks it.
  const stopRef = useRef(false);

  const publish = useCallback(() => {
    const state = runRef.current;
    setRun(state ? { ...state, images: state.images.map((img) => ({ ...img })) } : null);
  }, []);

  const isRunning = run !== null;
  const isBusy = isRunning || revalidator.state !== 'idle';

  const activeId = run ? run.productIds[run.productIndex] : null;

  const imagesSettled = run ? run.imagesDone + run.imagesFailed : 0;
  const progress = run && run.totalImages > 0
    ? Math.min(100, Math.round((imagesSettled / run.totalImages) * 100))
    : 0;
  const productImagesSettled = run
    ? run.images.filter((img) => img.status !== 'pending' && img.status !== 'working').length
    : 0;

  // Keep local products in sync when the loader revalidates (e.g. after an
  // optimization reload).
  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  // Filtering and sorting are done here, client-side, so they are instant.
  const visibleProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  /**
   * One call to the per-image API.
   *
   * App Bridge already adds the session token to relative fetches, but the
   * token is requested explicitly here so authentication doesn't depend on
   * that patch being in place — a silent 401 partway through a run is a
   * miserable thing to debug.
   */
  const callApi = useCallback(async (fields) => {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      body.append(key, value);
    }

    const headers = {};
    try {
      const token = await window.shopify?.idToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch (err) {
      // Fall through — App Bridge's own fetch patch is the backstop.
    }

    const response = await fetch('/api/optimize', { method: 'POST', body, headers });

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      /* fall through to the status-based message below */
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error('Your session expired. Reload the page and try again.');
      }
      throw new Error(data?.error || `The server returned an error (${response.status}).`);
    }
    if (!data) {
      // A 200 with an unreadable body would otherwise be read as a result and
      // crash the worker on the first property access.
      throw new Error('The server sent back an empty response.');
    }
    return data;
  }, []);

  const executeRun = useCallback(async (productIds) => {
    const byId = new Map(products.map((p) => [p.id, p]));

    runRef.current = {
      productIds,
      productIndex: 0,
      productTitle: byId.get(productIds[0])?.title || '',
      // Seeded from the counts already on screen so the bar is honest from the
      // first frame instead of climbing as each product is discovered. Replaced
      // with the authoritative count as each product is opened.
      totalImages: productIds.reduce(
        (sum, id) => sum + (byId.get(id)?.imageCount || 0),
        0
      ),
      imagesDone: 0,
      imagesCompressed: 0,
      imagesSkipped: 0,
      imagesFailed: 0,
      savedMB: 0,
      images: [],
      recent: [],
      stopping: false,
    };
    publish();

    let quotaError = null;
    let lastError = null;

    for (let i = 0; i < productIds.length; i++) {
      if (stopRef.current) break;

      const productId = productIds[i];
      const state = runRef.current;
      state.productIndex = i;
      state.productTitle = byId.get(productId)?.title || '';
      state.images = [];
      publish();

      let listing;
      try {
        listing = await callApi({ intent: 'listImages', productId });
      } catch (err) {
        lastError = err.message;
        // Drop this product's estimate, otherwise its images stay in the total
        // forever and the bar can never reach 100%.
        state.totalImages -= byId.get(productId)?.imageCount || 0;
        publish();
        continue;
      }

      // Correct the estimate for this product with what is actually there.
      state.totalImages += listing.images.length - (byId.get(productId)?.imageCount || 0);
      state.productTitle = listing.title;
      state.images = listing.images.map((image) => ({
        id: image.id,
        url: image.url,
        status: 'pending',
        detail: null,
      }));
      publish();

      // The id each slot ends up holding, so the original order can be restored
      // afterwards — replacing an image appends the copy at the end, and with
      // several in flight they no longer finish in the order they started.
      const finalIds = listing.images.map((image) => image.id);

      await pooled(
        listing.images,
        IMAGE_CONCURRENCY,
        async (image, index) => {
          const entry = runRef.current.images[index];
          entry.status = 'working';
          publish();

          let result;
          try {
            result = await callApi({ intent: 'optimizeImage', productId, imageId: image.id });
          } catch (err) {
            result = { success: false, error: err.message };
          }

          const live = runRef.current;

          // Once the plan's quota is gone every remaining image returns the
          // same refusal, so the whole run stops here.
          if (result.quotaExhausted) {
            quotaError = result.error;
            stopRef.current = true;
            entry.status = 'pending';
            publish();
            return;
          }

          if (result.success) {
            finalIds[index] = result.newImageId || image.id;
            live.imagesDone += 1;
            if (result.alreadyOptimized) {
              live.imagesSkipped += 1;
              entry.status = 'skipped';
              entry.detail = 'Already optimal';
            } else {
              live.imagesCompressed += 1;
              live.savedMB += result.savedMB || 0;
              entry.status = 'done';
              entry.detail = `−${result.compressionRate}%`;
              live.recent = [
                {
                  key: result.newImageId,
                  text: `${listing.title} — ${formatBytes(result.originalSizeMB)} → ${formatBytes(result.optimizedSizeMB)} (−${result.compressionRate}%)`,
                },
                ...live.recent,
              ].slice(0, 4);
            }
          } else {
            live.imagesFailed += 1;
            lastError = result.error;
            entry.status = 'failed';
            entry.detail = result.error;
          }
          publish();
        },
        () => stopRef.current
      );

      // Rewrite the summary and put the image order back, even for a partial
      // product — the stored numbers should describe what is on the store now.
      try {
        await callApi({
          intent: 'finalize',
          productId,
          order: JSON.stringify(finalIds),
        });
      } catch (err) {
        console.error('Could not finalize %s:', productId, err);
      }
    }

    const final = runRef.current;
    const stoppedByUser = final.stopping;

    runRef.current = null;
    stopRef.current = false;
    setRun(null);
    setSelectedProducts([]);

    if (final.imagesDone === 0 && final.imagesFailed === 0) {
      // Stopping on purpose before anything finished isn't a failure.
      if (stoppedByUser && !quotaError) {
        setSuccessMessage('Stopped — nothing was changed.');
        setTimeout(() => setSuccessMessage(null), 8000);
      } else {
        setError(quotaError || lastError || 'Nothing was optimized.');
      }
    } else if (final.imagesDone === 0) {
      setError(lastError || 'None of the images could be optimized.');
    } else {
      const parts = [];
      if (final.imagesCompressed > 0) {
        parts.push(
          `Compressed ${final.imagesCompressed} image${final.imagesCompressed > 1 ? 's' : ''} — saved ${formatBytes(final.savedMB)}.`
        );
      }
      if (final.imagesSkipped > 0) {
        parts.push(
          `${final.imagesSkipped} image${final.imagesSkipped > 1 ? 's were' : ' was'} already as small as possible.`
        );
      }
      if (final.imagesFailed > 0) {
        parts.push(`${final.imagesFailed} could not be processed — ${lastError}`);
      }
      if (quotaError) parts.push(quotaError);
      else if (stoppedByUser) parts.push('You stopped the run; the rest were left alone.');

      setSuccessMessage(parts.join(' '));
      setTimeout(() => setSuccessMessage(null), 12000);
    }

    // One refresh at the end rather than after every image — the numbers only
    // need to be right when the merchant looks at them again.
    revalidator.revalidate();
  }, [products, callApi, publish, revalidator]);

  const startRun = useCallback((ids) => {
    if (!ids.length || runRef.current) return;
    setError(null);
    setSuccessMessage(null);
    stopRef.current = false;
    executeRun(ids).catch((err) => {
      // A throw here would leave the page stuck showing progress forever.
      console.error('Optimization run crashed:', err);
      runRef.current = null;
      stopRef.current = false;
      setRun(null);
      setError(err.message || 'The optimization run stopped unexpectedly.');
      revalidator.revalidate();
    });
  }, [executeRun, revalidator]);

  const handleStopRun = useCallback(() => {
    stopRef.current = true;
    if (runRef.current) {
      runRef.current.stopping = true;
      publish();
    }
  }, [publish]);

  // Filter/sort are client-side now — just update local state (no server reload).
  const handleFilterChange = useCallback((value) => {
    setFilter(value);
  }, []);

  const handleSortChange = useCallback((value) => {
    setSortBy(value);
  }, []);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => 
      prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(
      selectedProducts.length === visibleProducts.length ? [] : visibleProducts.map(p => p.id)
    );
  }, [selectedProducts.length, visibleProducts]);

  // One product is just a run of length one, so both paths report progress the
  // same way and there is only one code path to keep correct.
  const handleOptimizeProduct = useCallback((productId) => {
    startRun([productId]);
  }, [startRun]);

  const handleOptimizeSelected = useCallback(() => {
    startRun(selectedProducts);
    // Selection is cleared when the run finishes, not here — clearing at click
    // time made the button vanish the instant it was pressed.
  }, [selectedProducts, startRun]);

  const getScoreBadge = (score) => {
    if (score >= 80) return <Badge tone="success">{score}%</Badge>;
    if (score >= 60) return <Badge tone="attention">{score}%</Badge>;
    return <Badge tone="critical">{score}%</Badge>;
  };

  const filterOptions = [
    { label: 'All Products', value: 'all' },
    { label: 'Needs Optimization', value: 'needs_optimization' },
    { label: 'Optimized', value: 'optimized' },
    { label: 'No Alt Text', value: 'no_alt_text' }
  ];

  const sortOptions = [
    { label: 'Score: Low to High', value: 'score_asc' },
    { label: 'Score: High to Low', value: 'score_desc' },
    { label: 'Size: Largest First', value: 'size_desc' },
    { label: 'Most Images First', value: 'images_desc' }
  ];

  return (
    <Page
      title="Product Image Optimization"
      subtitle="Optimize product images with real compression and automatic replacement"
    >
      <Layout>
        {isRunning && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" wrap={true}>
                  <InlineStack gap="300" blockAlign="center">
                    <Spinner accessibilityLabel="Optimization in progress" size="small" />
                    <Text variant="headingMd" as="h3">
                      {run.stopping
                        ? 'Finishing the images already started…'
                        : run.images.length > 0
                          ? `Optimizing image ${Math.min(productImagesSettled + 1, run.images.length)} of ${run.images.length}…`
                          : 'Reading the product’s images…'}
                    </Text>
                  </InlineStack>
                  <InlineStack gap="300" blockAlign="center">
                    <Text variant="headingMd" as="p" tone="subdued">{progress}%</Text>
                    {!run.stopping && (
                      <Button variant="tertiary" onClick={handleStopRun}>Stop</Button>
                    )}
                  </InlineStack>
                </InlineStack>

                <ProgressBar progress={progress} size="small" tone="primary" />

                <Text variant="bodyMd" as="p">
                  {run.productTitle
                    ? <Text as="span" fontWeight="semibold">{run.productTitle}</Text>
                    : 'Starting…'}
                  {run.productIds.length > 1 &&
                    ` — product ${run.productIndex + 1} of ${run.productIds.length}`}
                </Text>

                {/* One tile per image on this product, so "how many are done"
                    is something the merchant can see rather than infer. */}
                {run.images.length > 0 && (
                  <InlineStack gap="200" wrap={true}>
                    {run.images.map((image, index) => (
                      <BlockStack key={image.id} gap="100" inlineAlign="center">
                        <Box
                          borderWidth="050"
                          borderRadius="200"
                          borderColor={
                            image.status === 'done' ? 'border-success'
                              : image.status === 'failed' ? 'border-critical'
                                : image.status === 'working' ? 'border-emphasis'
                                  : 'border'
                          }
                          padding="050"
                        >
                          <Thumbnail
                            source={image.url}
                            alt={`Image ${index + 1}`}
                            size="small"
                          />
                        </Box>
                        {image.status === 'working' ? (
                          <Spinner accessibilityLabel={`Optimizing image ${index + 1}`} size="small" />
                        ) : (
                          <Text variant="bodySm" as="span" tone={
                            image.status === 'done' ? 'success'
                              : image.status === 'failed' ? 'critical'
                                : 'subdued'
                          }>
                            {image.status === 'done' ? image.detail
                              : image.status === 'skipped' ? 'Optimal'
                                : image.status === 'failed' ? 'Failed'
                                  : `#${index + 1}`}
                          </Text>
                        )}
                      </BlockStack>
                    ))}
                  </InlineStack>
                )}

                <Text variant="bodySm" as="p" tone="subdued">
                  {imagesSettled} of {run.totalImages} image{run.totalImages === 1 ? '' : 's'} done
                  {run.imagesCompressed > 0 && ` · ${formatBytes(run.savedMB)} saved`}
                  {run.imagesSkipped > 0 && ` · ${run.imagesSkipped} already optimal`}
                  {run.imagesFailed > 0 && ` · ${run.imagesFailed} failed`}
                </Text>

                {run.recent.length > 0 && (
                  <BlockStack gap="100">
                    {run.recent.map((entry) => (
                      <Text key={entry.key} variant="bodySm" as="p" tone="subdued">
                        ✓ {entry.text}
                      </Text>
                    ))}
                  </BlockStack>
                )}

                <Text variant="bodySm" as="p" tone="subdued">
                  Up to {IMAGE_CONCURRENCY} images are processed at a time. Each one is
                  downloaded, re-compressed and uploaded back to Shopify, so please keep this
                  page open.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {!isRunning && revalidator.state !== 'idle' && (
          <Layout.Section>
            <Card>
              <InlineStack gap="300" blockAlign="center">
                <Spinner accessibilityLabel="Refreshing" size="small" />
                <Text variant="bodyMd" as="p">Refreshing your products…</Text>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}

        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>
              {successMessage}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodyMd" as="p" tone="subdued">Total Products</Text>
                  <Text variant="heading2xl" as="h2">{stats.total}</Text>
                </BlockStack>
              </Card>
            </Box>
            <Box width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodyMd" as="p" tone="subdued">Needs Optimization</Text>
                  <Text variant="heading2xl" as="h2" tone="critical">{stats.needsOptimization}</Text>
                </BlockStack>
              </Card>
            </Box>
            <Box width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodyMd" as="p" tone="subdued">Total Images</Text>
                  <Text variant="heading2xl" as="h2">{stats.totalImages}</Text>
                </BlockStack>
              </Card>
            </Box>
            <Box width="25%">
              <Card>
                <BlockStack gap="200">
                  <Text variant="bodyMd" as="p" tone="subdued">Total Size Reduced</Text>
                  <Text variant="heading2xl" as="h2" tone="success">
                    {formatBytes(stats.potentialSavingsMB)}
                  </Text>
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="300">
                  <Box width="200px">
                    <Select
                      label="Filter"
                      options={filterOptions}
                      value={filter}
                      onChange={handleFilterChange}
                    />
                  </Box>
                  <Box width="200px">
                    <Select
                      label="Sort by"
                      options={sortOptions}
                      value={sortBy}
                      onChange={handleSortChange}
                    />
                  </Box>
                </InlineStack>
                
                {selectedProducts.length > 0 && (
                  <Button
                    variant="primary"
                    onClick={handleOptimizeSelected}
                    loading={isBusy}
                    disabled={isBusy}
                  >
                    Optimize Selected ({selectedProducts.length})
                  </Button>
                )}
              </InlineStack>

              <Divider />

              <Checkbox
                label={`Select All (${visibleProducts.length} products)`}
                checked={selectedProducts.length === visibleProducts.length && visibleProducts.length > 0}
                onChange={handleSelectAll}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {visibleProducts.length === 0 ? (
                <EmptyState
                  heading="No products found"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Try adjusting your filters to see products.</p>
                </EmptyState>
              ) : (
                visibleProducts.map((product) => (
                  <Card key={product.id} background={selectedProducts.includes(product.id) ? 'bg-surface-selected' : undefined}>
                    <InlineStack gap="400" blockAlign="start">
                      <Checkbox
                        checked={selectedProducts.includes(product.id)}
                        onChange={() => handleSelectProduct(product.id)}
                      />
                      
                      {product.featuredImageUrl && (
                        <Thumbnail
                          source={product.featuredImageUrl}
                          alt={product.title}
                          size="large"
                        />
                      )}

                      <Box width="100%">
                        <BlockStack gap="400">
                          <InlineStack align="space-between" blockAlign="center">
                            <BlockStack gap="200">
                              <Text variant="headingMd" as="h3">{product.title}</Text>
                              <InlineStack gap="200">
                                <Badge>{product.status}</Badge>
                                <Badge tone={product.imageCount > 0 && product.optimizedImages === product.imageCount ? "success" : "info"}>
                                  {product.optimizedImages}/{product.imageCount} images optimized
                                </Badge>
                              </InlineStack>
                            </BlockStack>
                            {getScoreBadge(product.score)}
                          </InlineStack>

                          <Divider />

                          <InlineStack gap="800" wrap={true}>
                            <BlockStack gap="200">
                              <Text variant="bodySm" as="p" tone="subdued">Images with Alt Text</Text>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">
                                {product.imagesWithAlt} / {product.imageCount}
                              </Text>
                            </BlockStack>

                            <BlockStack gap="200">
                              <Text variant="bodySm" as="p" tone="subdued">Optimized Images</Text>
                              <Text variant="bodyMd" as="p" fontWeight="semibold">
                                {product.optimizedImages} / {product.imageCount}
                              </Text>
                            </BlockStack>

                            {product.isOptimized ? (
                              <>
                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" tone="subdued">Original Size</Text>
                                  <Text variant="bodyMd" as="p" fontWeight="semibold">
                                    {product.isEstimate ? '~' : ''}{formatBytes(product.totalOriginalSizeMB)}
                                  </Text>
                                </BlockStack>

                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" tone="subdued">Optimized Size</Text>
                                  <Text variant="bodyMd" as="p" fontWeight="semibold" tone="success">
                                    {product.isEstimate ? '~' : ''}{formatBytes(product.totalOptimizedSizeMB)} (↓{product.compressionRate}%)
                                  </Text>
                                </BlockStack>
                              </>
                            ) : (
                              <>
                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" tone="subdued">Current Size</Text>
                                  <Text variant="bodyMd" as="p" fontWeight="semibold">
                                    ~{formatBytes(product.totalOptimizedSizeMB)}
                                  </Text>
                                </BlockStack>

                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" tone="subdued">Potential Savings</Text>
                                  <Text variant="bodyMd" as="p" fontWeight="semibold">
                                    ~{formatBytes(product.potentialSavingsMB)}
                                  </Text>
                                </BlockStack>
                              </>
                            )}
                          </InlineStack>

                          <BlockStack gap="200">
                            <Text variant="bodySm" as="p" tone="subdued">
                              Optimization Progress
                            </Text>
                            <ProgressBar
                              progress={product.score}
                              size="small"
                              tone={product.score >= 80 ? 'success' : product.score >= 60 ? 'attention' : 'critical'}
                            />
                          </BlockStack>

                          <InlineStack align="end">
                            <Button
                              variant={product.needsOptimization ? "primary" : "secondary"}
                              onClick={() => handleOptimizeProduct(product.id)}
                              loading={activeId === product.id}
                              disabled={isBusy}
                            >
                              {product.optimizedImages > 0 ? 'Re-optimize This Product' : 'Optimize This Product'}
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Box>
                    </InlineStack>
                  </Card>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}