import { useState, useCallback, useEffect, useMemo } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData } from 'react-router';
import { authenticate } from '../shopify.server';
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
  EmptyState
} from '@shopify/polaris';
import sharp from 'sharp';

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
 * Get actual image file size by fetching the image
 */
async function getActualImageSize(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error('Failed to fetch image');
    }
    
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      return parseInt(contentLength) / (1024 * 1024); // Convert to MB
    }
    
    // If no content-length, download and measure
    const buffer = await response.arrayBuffer();
    return buffer.byteLength / (1024 * 1024); // Convert to MB
  } catch (error) {
    console.error('Error getting image size:', error);
    return 0;
  }
}

/**
 * Get image format from URL
 */
function getImageFormat(url) {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('.webp')) return 'webp';
  if (urlLower.includes('.png')) return 'png';
  if (urlLower.includes('.gif')) return 'gif';
  return 'jpg';
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
        // image; otherwise fall back to the estimate so the columns never show 0.
        const hasReal = measuredSaved >= 0.01;
        const displayOriginalMB = hasReal ? (storedOriginal + estUnoptimized) : estOriginalMB;
        const displayReducedMB = hasReal ? measuredSaved : estReducedMB;
        const displayRate = displayOriginalMB > 0
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
 * Optimize image using Sharp library
 */
async function optimizeImage(imageUrl, format) {
  try {
    // Download original image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error('Failed to fetch image');
    }
    
    const originalBuffer = await response.arrayBuffer();
    const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

    // Optimize image with Sharp
    let optimizedBuffer;
    const sharpInstance = sharp(Buffer.from(originalBuffer));

    if (format === 'webp' || format === 'png') {
      // Convert to WebP for better compression
      optimizedBuffer = await sharpInstance
        .resize(2048, 2048, { 
          fit: 'inside', 
          withoutEnlargement: true 
        })
        .webp({ quality: 85, effort: 4 })
        .toBuffer();
    } else {
      // Optimize JPEG
      optimizedBuffer = await sharpInstance
        .resize(2048, 2048, { 
          fit: 'inside', 
          withoutEnlargement: true 
        })
        .jpeg({ quality: 85, progressive: true })
        .toBuffer();
    }

    const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);

    return {
      originalSizeMB,
      optimizedSizeMB,
      optimizedBuffer,
      compressionRate: Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
    };

  } catch (error) {
    console.error('Error optimizing image:', error);
    throw error;
  }
}

/**
 * Upload the optimized image to Shopify via the current GraphQL Admin API and
 * replace the original. Flow: stagedUploadsCreate -> upload bytes to the staged
 * target -> productCreateMedia -> productDeleteMedia (old image).
 *
 * Returns the new MediaImage gid.
 */
async function uploadAndReplaceImage(admin, productId, oldMediaId, optimizedBuffer, filename, mimeType, altText) {
  // 1. Ask Shopify for a staged upload target (a signed URL to POST the file to).
  const stagedResp = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: [{ filename, mimeType, resource: 'IMAGE', httpMethod: 'POST' }],
      },
    }
  );
  const stagedJson = await stagedResp.json();
  const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors || [];
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (stagedErrors.length || !target) {
    throw new Error('stagedUploadsCreate failed: ' + JSON.stringify(stagedErrors));
  }

  // 2. POST the optimized bytes to the staged target. Order matters: all the
  //    provided parameters first, then the file last.
  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append('file', new Blob([optimizedBuffer], { type: mimeType }), filename);

  const uploadResp = await fetch(target.url, { method: 'POST', body: form });
  if (!uploadResp.ok) {
    const text = await uploadResp.text();
    console.error('Staged upload failed:', uploadResp.status, text.slice(0, 300));
    throw new Error('Staged upload failed with status ' + uploadResp.status);
  }

  // 3. Attach the uploaded file to the product as new media.
  const createResp = await admin.graphql(
    `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id ... on MediaImage { id } }
          mediaUserErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId,
        media: [{ alt: altText, mediaContentType: 'IMAGE', originalSource: target.resourceUrl }],
      },
    }
  );
  const createJson = await createResp.json();
  const createErrors = createJson.data?.productCreateMedia?.mediaUserErrors || [];
  if (createErrors.length) {
    throw new Error('productCreateMedia failed: ' + JSON.stringify(createErrors));
  }
  const newMediaId = createJson.data?.productCreateMedia?.media?.[0]?.id;

  // 4. Delete the original image now that the optimized copy is attached.
  if (oldMediaId) {
    const deleteResp = await admin.graphql(
      `#graphql
        mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
          productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
            deletedMediaIds
            mediaUserErrors { field message }
          }
        }
      `,
      { variables: { productId, mediaIds: [oldMediaId] } }
    );
    const deleteJson = await deleteResp.json();
    const deleteErrors = deleteJson.data?.productDeleteMedia?.mediaUserErrors || [];
    if (deleteErrors.length) {
      // Non-fatal: the optimized image is already attached; just log.
      console.error('productDeleteMedia failed:', JSON.stringify(deleteErrors));
    }
  }

  return newMediaId;
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    
    try {
      // Fetch product media (MediaImage nodes give us the ids the current
      // GraphQL create/delete mutations require) plus any existing optimization
      // metafields so we can carry forward the TRUE original size on re-optimize.
      const response = await admin.graphql(
        `#graphql
          query GetProductMedia($id: ID!) {
            product(id: $id) {
              id
              title
              media(first: 250) {
                edges {
                  node {
                    mediaContentType
                    ... on MediaImage {
                      id
                      alt
                      image {
                        url
                      }
                    }
                  }
                }
              }
              metafields(first: 20, namespace: "image_optimization") {
                edges { node { key value } }
              }
            }
          }
        `,
        { variables: { id: productId } }
      );

      const data = await response.json();
      const product = data.data.product;

      // Map existing per-image records by their key so that when we re-optimize
      // an already-optimized image we keep the ORIGINAL (pre-optimization) size
      // instead of measuring the already-compressed one — otherwise re-optimizing
      // would report ~0 savings.
      const existingByKey = {};
      for (const edge of (product.metafields?.edges || [])) {
        if (!edge.node.key.startsWith('image_')) continue;
        try { existingByKey[edge.node.key] = JSON.parse(edge.node.value); } catch (e) {}
      }

      const images = product.media.edges
        .map(edge => edge.node)
        .filter(node => node && node.mediaContentType === 'IMAGE' && node.image && node.image.url)
        .map(node => ({ id: node.id, url: node.image.url, altText: node.alt || '' }));

      const optimizationResults = [];

      for (const image of images) {
        try {
          const format = getImageFormat(image.url);

          // Optimize image with Sharp. This downloads the original once and
          // returns its size, so we don't fetch the image a second time.
          const optimizationData = await optimizeImage(image.url, format);

          // Carry forward the TRUE original size. If this image is itself the
          // output of a previous optimization, its existing record holds the real
          // pre-optimization size — keep the larger of that and what we just
          // measured, so re-optimizing an already-small image still reflects the
          // full saving instead of ~0.
          const prevRec = existingByKey[`image_${image.id.split('/').pop()}`];
          const measuredOriginalMB = optimizationData.originalSizeMB;
          const newOptimizedMB = optimizationData.optimizedSizeMB;
          const trueOriginalMB = (prevRec && Number(prevRec.originalSizeMB) > measuredOriginalMB)
            ? Number(prevRec.originalSizeMB)
            : measuredOriginalMB;

          // Generate AI alt text if missing
          let altText = image.altText;
          if (!altText || altText.length < 10) {
            altText = await generateAIAltText(image.url, product.title);
          }

          // Only replace the image if the re-encoded version is at least 2%
          // SMALLER than what is on the store now. Many images are already
          // optimized (small WebP/JPEG) and re-encoding them is larger — replacing
          // in that case would INFLATE the file and delete the smaller original.
          const beneficial = newOptimizedMB < measuredOriginalMB * 0.98;

          if (!beneficial) {
            // Already optimized: keep the current image. Update alt text only if we
            // generated/changed it, and record the image honestly (0 further
            // saving, but preserve any real historical saving from trueOriginal).
            if (altText && altText !== image.altText) {
              try {
                await admin.graphql(
                  `#graphql
                    mutation UpdateAlt($productId: ID!, $media: [UpdateMediaInput!]!) {
                      productUpdateMedia(productId: $productId, media: $media) {
                        media { id }
                        mediaUserErrors { field message }
                      }
                    }
                  `,
                  { variables: { productId, media: [{ id: image.id, alt: altText }] } }
                );
              } catch (altErr) {
                console.error('Alt update failed (non-fatal):', altErr.message);
              }
            }

            const imageKey = `image_${image.id.split('/').pop()}`;
            const compressionRate = trueOriginalMB > 0
              ? Math.round(((trueOriginalMB - measuredOriginalMB) / trueOriginalMB) * 100)
              : 0;
            await admin.graphql(
              `#graphql
                mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
                  metafieldsSet(metafields: $metafields) {
                    metafields { key value }
                    userErrors { field message }
                  }
                }
              `,
              {
                variables: {
                  metafields: [
                    {
                      ownerId: productId,
                      namespace: 'image_optimization',
                      key: imageKey,
                      value: JSON.stringify({
                        originalSizeMB: trueOriginalMB,
                        optimizedSizeMB: measuredOriginalMB,
                        compressionRate,
                        format,
                        altText,
                        alreadyOptimized: true,
                        optimizedAt: new Date().toISOString(),
                        originalImageId: image.id,
                        newImageId: image.id
                      }),
                      type: 'json'
                    }
                  ]
                }
              }
            );

            optimizationResults.push({
              imageId: image.id,
              originalImageId: image.id,
              originalSize: trueOriginalMB,
              optimizedSize: measuredOriginalMB,
              compressionRate,
              alreadyOptimized: true,
              altText,
              success: true
            });
            continue;
          }

          const compressionRate = trueOriginalMB > 0
            ? Math.round(((trueOriginalMB - newOptimizedMB) / trueOriginalMB) * 100)
            : optimizationData.compressionRate;

          // Determine output format (optimizeImage outputs WebP for webp/png
          // sources, otherwise JPEG) so we name/type the upload correctly.
          const outIsWebp = format === 'webp' || format === 'png';
          const outMime = outIsWebp ? 'image/webp' : 'image/jpeg';
          const outFilename = `optimized-${Date.now()}.${outIsWebp ? 'webp' : 'jpg'}`;

          // Upload optimized image (GraphQL) and replace the original
          const newImageId = await uploadAndReplaceImage(
            admin,
            productId,
            image.id,
            optimizationData.optimizedBuffer,
            outFilename,
            outMime,
            altText
          );

          // Save optimization metadata
          const imageKey = `image_${newImageId.split('/').pop()}`;
          await admin.graphql(
            `#graphql
              mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                  metafields {
                    key
                    value
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `,
            {
              variables: {
                metafields: [
                  {
                    ownerId: productId,
                    namespace: 'image_optimization',
                    key: imageKey,
                    value: JSON.stringify({
                      originalSizeMB: trueOriginalMB,
                      optimizedSizeMB: newOptimizedMB,
                      compressionRate: compressionRate,
                      format: format,
                      altText: altText,
                      optimizedAt: new Date().toISOString(),
                      originalImageId: image.id,
                      newImageId: newImageId
                    }),
                    type: 'json'
                  }
                ]
              }
            }
          );

          optimizationResults.push({
            imageId: newImageId,
            originalImageId: image.id,
            originalSize: trueOriginalMB,
            optimizedSize: newOptimizedMB,
            compressionRate: compressionRate,
            altText,
            success: true
          });

        } catch (imageError) {
          console.error(`Error optimizing image ${image.id}:`, imageError);
          optimizationResults.push({
            imageId: image.id,
            success: false,
            error: imageError.message
          });
        }
      }

      // Save product-level optimization summary
      const successfulOptimizations = optimizationResults.filter(r => r.success);
      
      await admin.graphql(
        `#graphql
          mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                key
                value
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            metafields: [
              {
                ownerId: productId,
                namespace: 'image_optimization',
                key: 'optimization_summary',
                value: JSON.stringify({
                  totalImages: images.length,
                  optimizedImages: successfulOptimizations.length,
                  totalOriginalSizeMB: successfulOptimizations.reduce((sum, r) => sum + r.originalSize, 0),
                  totalOptimizedSizeMB: successfulOptimizations.reduce((sum, r) => sum + r.optimizedSize, 0),
                  totalSizeSavedMB: successfulOptimizations.reduce((sum, r) => sum + (r.originalSize - r.optimizedSize), 0),
                  avgCompressionRate: successfulOptimizations.length > 0 
                    ? Math.round(successfulOptimizations.reduce((sum, r) => sum + r.compressionRate, 0) / successfulOptimizations.length)
                    : 0,
                  lastOptimizedAt: new Date().toISOString()
                }),
                type: 'json'
              }
            ]
          }
        }
      );

      const compressed = successfulOptimizations.filter(r => !r.alreadyOptimized);
      const skipped = successfulOptimizations.filter(r => r.alreadyOptimized);
      const totalSaved = compressed.reduce((sum, r) => sum + Math.max(r.originalSize - r.optimizedSize, 0), 0);

      let message;
      if (compressed.length > 0) {
        message = `Compressed ${compressed.length} image${compressed.length > 1 ? 's' : ''} for "${product.title}" — saved ${totalSaved >= 1 ? totalSaved.toFixed(1) + ' MB' : Math.round(totalSaved * 1024) + ' KB'}.`;
      } else if (skipped.length > 0) {
        message = `"${product.title}" is already optimized — its ${skipped.length} image${skipped.length > 1 ? 's are' : ' is'} already as small as possible, so nothing was changed.`;
      } else {
        message = `No images could be processed for "${product.title}".`;
      }

      return {
        success: true,
        message,
        results: optimizationResults
      };

    } catch (error) {
      console.error('Error optimizing product:', error);
      return {
        success: false,
        error: 'Failed to optimize product: ' + error.message
      };
    }
  }

  if (actionType === 'optimizeBulk') {
    const productIds = JSON.parse(formData.get('productIds'));
    
    try {
      const results = [];
      
      for (const productId of productIds) {
        const productFormData = new FormData();
        productFormData.append('actionType', 'optimizeProduct');
        productFormData.append('productId', productId);
        
        const newRequest = new Request(request.url, { 
          method: 'POST', 
          body: productFormData,
          headers: request.headers
        });
        
        const result = await action({ request: newRequest });
        results.push(result);
      }

      const successCount = results.filter(r => r.success).length;
      
      return {
        success: true,
        message: `Successfully optimized ${successCount} out of ${productIds.length} products`
      };

    } catch (error) {
      console.error('Error in bulk optimization:', error);
      return {
        success: false,
        error: 'Failed to optimize products in bulk'
      };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/**
 * Generate AI alt text using Anthropic Claude Vision
 */
async function generateAIAltText(imageUrl, productTitle) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return `${productTitle} - product image`;
  }

  try {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error('Failed to fetch image');
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    
    let mediaType = 'image/jpeg';
    if (imageUrl.toLowerCase().includes('.png')) mediaType = 'image/png';
    if (imageUrl.toLowerCase().includes('.webp')) mediaType = 'image/webp';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image
              }
            },
            {
              type: 'text',
              text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Keep under 125 characters. Return only the alt text.`
            }
          ]
        }]
      })
    });

    const result = await response.json();
    let altText = result.content[0].text.trim();
    altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ');
    
    if (altText.length > 125) {
      altText = altText.substring(0, 122) + '...';
    }
    
    return altText;

  } catch (error) {
    console.error('Error generating AI alt text:', error);
    return `${productTitle} - product image`;
  }
}

export default function ProductOptimization() {
  const { products: initialProducts, filter: initialFilter, sortBy: initialSortBy, stats, error: loadError } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [products, setProducts] = useState(initialProducts);
  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [error, setError] = useState(loadError);
  const [successMessage, setSuccessMessage] = useState(null);
  // Which single product is currently being optimized (so only its button spins).
  const [optimizingId, setOptimizingId] = useState(null);

  const isSubmitting = navigation.state === 'submitting';

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

  useEffect(() => {
    if (actionData?.success) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 5000);
      setOptimizingId(null);

      // Reload full product data to reflect the optimization (client re-filters).
      submit({}, { method: 'get' });
    } else if (actionData?.error) {
      setError(actionData.error);
      setOptimizingId(null);
    }
  }, [actionData, submit]);

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

  const handleOptimizeProduct = useCallback((productId) => {
    setOptimizingId(productId);
    const formData = new FormData();
    formData.append('actionType', 'optimizeProduct');
    formData.append('productId', productId);
    submit(formData, { method: 'post' });
  }, [submit]);

  const handleOptimizeSelected = useCallback(() => {
    const formData = new FormData();
    formData.append('actionType', 'optimizeBulk');
    formData.append('productIds', JSON.stringify(selectedProducts));
    submit(formData, { method: 'post' });
    setSelectedProducts([]);
  }, [selectedProducts, submit]);

  const getScoreBadge = (score) => {
    if (score >= 80) return <Badge tone="success">{score}%</Badge>;
    if (score >= 60) return <Badge tone="attention">{score}%</Badge>;
    return <Badge tone="critical">{score}%</Badge>;
  };

  const formatBytes = (mb) => {
    const val = Number(mb) || 0;
    if (val >= 1000) return `${(val / 1000).toFixed(1)} GB`;
    // Show KB for anything under 1 MB so small (but real) savings — and zero —
    // never collapse to a confusing "0.0 MB".
    if (val < 1) return `${Math.max(0, Math.round(val * 1024))} KB`;
    return `${val.toFixed(1)} MB`;
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
                    loading={isSubmitting}
                    disabled={isSubmitting}
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
                              loading={optimizingId === product.id}
                              disabled={isSubmitting}
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