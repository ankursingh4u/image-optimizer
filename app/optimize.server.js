import sharp from 'sharp';
import {
  reserveUsage,
  refundUsage,
  quotaMessage,
  METRICS,
} from './usage.server';

/**
 * Image optimization, one image at a time.
 *
 * The unit of work here is a single image, not a product. That is what lets the
 * browser report honest progress ("image 3 of 8") and run a few images at once:
 * every call returns as soon as one image is done, so each response is a
 * progress event and no single request is long enough to hit a proxy timeout.
 *
 * Optimizing a product used to be one long server-side loop, which meant the
 * page could only show a spinner and the images were processed strictly one
 * after another with nothing overlapped.
 */

const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 85;
const WEBP_QUALITY = 85;

// A re-encode has to beat the file currently on the store by this much to be
// worth replacing. Many images are already compressed, and re-encoding those
// comes out LARGER — replacing them would inflate the store and delete the
// smaller original.
const BENEFIT_THRESHOLD = 0.98;

/** Format from the URL. Decides whether we output WebP or JPEG. */
export function getImageFormat(url) {
  const urlLower = String(url).toLowerCase();
  if (urlLower.includes('.webp')) return 'webp';
  if (urlLower.includes('.png')) return 'png';
  if (urlLower.includes('.gif')) return 'gif';
  return 'jpg';
}

/** The metafield key an image's optimization record is stored under. */
export function imageMetafieldKey(mediaId) {
  return `image_${String(mediaId).split('/').pop()}`;
}

/**
 * GraphQL with a retry on Shopify's THROTTLED error.
 *
 * Needed now that several images are in flight at once: each image costs four
 * or five mutations, so a burst can drain the leaky bucket. Throttling arrives
 * as a 200 with an errors array, not an HTTP error, so it has to be inspected.
 */
async function gql(admin, query, variables, attempts = 4) {
  let delay = 600;

  for (let attempt = 1; ; attempt++) {
    const response = await admin.graphql(query, { variables });
    const json = await response.json();
    const throttled = (json.errors || []).some(
      (e) => e?.extensions?.code === 'THROTTLED'
    );

    if (!throttled || attempt >= attempts) {
      if (json.errors?.length) {
        console.error(
          '[optimize] graphql errors:',
          JSON.stringify(json.errors).slice(0, 400)
        );
      }
      return json;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay *= 2;
  }
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the image (HTTP ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    sizeMB: arrayBuffer.byteLength / (1024 * 1024),
  };
}

async function encodeImage(buffer, format) {
  const resized = sharp(buffer).resize(MAX_DIMENSION, MAX_DIMENSION, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  // PNG and WebP sources go out as WebP (much better compression); everything
  // else stays JPEG so we don't change the format a theme expects.
  const toWebp = format === 'webp' || format === 'png';
  const out = toWebp
    ? await resized.webp({ quality: WEBP_QUALITY, effort: 4 }).toBuffer()
    : await resized.jpeg({ quality: JPEG_QUALITY, progressive: true }).toBuffer();

  return {
    buffer: out,
    sizeMB: out.byteLength / (1024 * 1024),
    isWebp: toWebp,
  };
}

/** Ask Shopify for a signed URL to POST the optimized bytes to. */
async function requestStagedUpload(admin, filename, mimeType) {
  const json = await gql(
    admin,
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }
    `,
    { input: [{ filename, mimeType, resource: 'IMAGE', httpMethod: 'POST' }] }
  );

  const errors = json.data?.stagedUploadsCreate?.userErrors || [];
  const target = json.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (errors.length || !target) {
    throw new Error('stagedUploadsCreate failed: ' + JSON.stringify(errors));
  }
  return target;
}

async function putBytes(target, buffer, filename, mimeType) {
  // Order matters: every provided parameter first, the file last.
  const form = new FormData();
  for (const param of target.parameters) {
    form.append(param.name, param.value);
  }
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(target.url, { method: 'POST', body: form });
  if (!response.ok) {
    const text = await response.text();
    console.error(
      '[optimize] staged upload failed:',
      response.status,
      text.slice(0, 300)
    );
    throw new Error('Staged upload failed with status ' + response.status);
  }
}

async function attachMedia(admin, productId, resourceUrl, altText) {
  const json = await gql(
    admin,
    `#graphql
      mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media { id ... on MediaImage { id } }
          mediaUserErrors { field message }
        }
      }
    `,
    {
      productId,
      media: [
        {
          alt: altText,
          mediaContentType: 'IMAGE',
          originalSource: resourceUrl,
        },
      ],
    }
  );

  const errors = json.data?.productCreateMedia?.mediaUserErrors || [];
  if (errors.length) {
    throw new Error('productCreateMedia failed: ' + JSON.stringify(errors));
  }
  const newMediaId = json.data?.productCreateMedia?.media?.[0]?.id;
  if (!newMediaId) {
    throw new Error('productCreateMedia returned no media id');
  }
  return newMediaId;
}

async function deleteMedia(admin, productId, mediaId) {
  const json = await gql(
    admin,
    `#graphql
      mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
        productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
          deletedMediaIds
          mediaUserErrors { field message }
        }
      }
    `,
    { productId, mediaIds: [mediaId] }
  );

  const errors = json.data?.productDeleteMedia?.mediaUserErrors || [];
  if (errors.length) {
    // Non-fatal: the optimized copy is already attached, so the merchant has
    // the benefit. Leaving the original behind is better than failing here.
    console.error('[optimize] productDeleteMedia failed:', JSON.stringify(errors));
  }
}

async function writeImageRecord(admin, productId, key, record) {
  await gql(
    admin,
    `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { key }
          userErrors { field message }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: 'image_optimization',
          key,
          value: JSON.stringify(record),
          type: 'json',
        },
      ],
    }
  );
}

/**
 * Alt text from Claude vision.
 *
 * `prefetched` is the buffer the optimizer already downloaded. Without it this
 * function fetched the full image a SECOND time, which on a large image was
 * often the single slowest thing in the whole per-image path.
 */
export async function generateAIAltText(imageUrl, productTitle, prefetched = null) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return `${productTitle} - product image`;
  }

  try {
    let buffer = prefetched;
    if (!buffer) {
      const downloaded = await downloadImage(imageUrl);
      buffer = downloaded.buffer;
    }
    const base64Image = Buffer.from(buffer).toString('base64');

    let mediaType = 'image/jpeg';
    const lower = String(imageUrl).toLowerCase();
    if (lower.includes('.png')) mediaType = 'image/png';
    if (lower.includes('.webp')) mediaType = 'image/webp';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64Image },
              },
              {
                type: 'text',
                text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Keep under 125 characters. Return only the alt text.`,
              },
            ],
          },
        ],
      }),
    });

    const result = await response.json();
    let altText = result.content[0].text.trim();
    altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ');
    if (altText.length > 125) {
      altText = altText.substring(0, 122) + '...';
    }
    return altText;
  } catch (error) {
    console.error('[optimize] alt text generation failed:', error.message);
    return `${productTitle} - product image`;
  }
}

/**
 * The images currently on a product, in the order the merchant has them.
 *
 * The browser needs this before it can show "image 1 of 8" or decide how much
 * work is left, and the returned order is what gets restored afterwards.
 */
export async function listProductImages(admin, productId) {
  const json = await gql(
    admin,
    `#graphql
      query ProductImages($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) {
            edges {
              node {
                mediaContentType
                ... on MediaImage { id alt image { url } }
              }
            }
          }
        }
      }
    `,
    { id: productId }
  );

  const product = json.data?.product;
  if (!product) return null;

  const images = (product.media?.edges || [])
    .map((edge) => edge.node)
    .filter((node) => node?.mediaContentType === 'IMAGE' && node.image?.url)
    .map((node) => ({
      id: node.id,
      url: node.image.url,
      altText: node.alt || '',
      hasAltText: !!(node.alt && node.alt.length >= 10),
    }));

  return { id: product.id, title: product.title, images };
}

/**
 * Optimize exactly one image and replace it on the product.
 *
 * Returns a plain result object rather than throwing, so a single bad image
 * never takes down the rest of a run.
 */
export async function optimizeProductImage({
  admin,
  quota,
  productId,
  imageId,
}) {
  // One query for everything this image needs: its current URL and alt text
  // (authoritative — never trusted from the browser), the product title for the
  // AI prompt, and any previous optimization record for this image.
  const key = imageMetafieldKey(imageId);
  const context = await gql(
    admin,
    `#graphql
      query OptimizeImageContext($imageId: ID!, $productId: ID!, $key: String!) {
        node(id: $imageId) {
          ... on MediaImage { id alt image { url } }
        }
        product(id: $productId) {
          id
          title
          metafield(namespace: "image_optimization", key: $key) { value }
        }
      }
    `,
    { imageId, productId, key }
  );

  const node = context.data?.node;
  const product = context.data?.product;
  if (!node?.image?.url || !product) {
    return {
      success: false,
      imageId,
      error: 'That image is no longer on the product — it may have been deleted.',
    };
  }

  const imageUrl = node.image.url;
  const currentAlt = node.alt || '';

  // Carry forward the TRUE original size. If this image is itself the output of
  // a previous optimization, its record holds the real pre-optimization size —
  // without this, re-optimizing an already-small image reports ~0 saving.
  let previousOriginalMB = 0;
  if (product.metafield?.value) {
    try {
      previousOriginalMB = Number(JSON.parse(product.metafield.value).originalSizeMB) || 0;
    } catch (err) {
      /* a corrupt record just means no history to carry forward */
    }
  }

  // Reserve the quota unit BEFORE doing the work. Reserving atomically (rather
  // than checking then recording afterwards) is what keeps the count exact now
  // that several images are in flight at once — three concurrent images can no
  // longer each read "1 remaining" and all proceed.
  const reserved = await reserveUsage(quota, METRICS.IMAGES_OPTIMIZED, 1);
  if (!reserved.allowed) {
    return {
      success: false,
      imageId,
      // Flagged so the browser stops the whole run instead of asking for every
      // remaining image and collecting the same refusal each time.
      quotaExhausted: true,
      error: quotaMessage(METRICS.IMAGES_OPTIMIZED, reserved),
    };
  }

  let quotaSpent = false;

  try {
    const format = getImageFormat(imageUrl);
    const original = await downloadImage(imageUrl);

    const outIsWebp = format === 'webp' || format === 'png';
    const outMime = outIsWebp ? 'image/webp' : 'image/jpeg';
    const outFilename = `optimized-${Date.now()}-${String(imageId).split('/').pop()}.${
      outIsWebp ? 'webp' : 'jpg'
    }`;

    // Only generate alt text when the image is actually missing it, and meter
    // it against the SAME allowance the Alt Text page spends — otherwise a
    // merchant would get unlimited AI by routing it through the optimizer.
    const needsAltText = !currentAlt || currentAlt.length < 10;
    let altTextWork = Promise.resolve(currentAlt);
    let aiAltTextGenerated = false;

    if (needsAltText && process.env.ANTHROPIC_API_KEY) {
      const aiReserved = await reserveUsage(quota, METRICS.AI_ALT_TEXT, 1);
      if (aiReserved.allowed) {
        aiAltTextGenerated = true;
        // Reuses the buffer we just downloaded instead of fetching the image
        // again, and runs alongside the re-encode instead of after it.
        altTextWork = generateAIAltText(imageUrl, product.title, original.buffer);
      }
      // Running out of AI quota does NOT abort the image: the compression is
      // separately metered and already reserved, so we keep the existing alt.
    }

    // Three independent things, started together: the CPU re-encode, the
    // network round-trip that reserves an upload slot, and the AI call. Run one
    // after another these were the bulk of the per-image wall clock.
    const [encoded, stagedTarget, altText] = await Promise.all([
      encodeImage(original.buffer, format),
      requestStagedUpload(admin, outFilename, outMime),
      altTextWork,
    ]);

    const trueOriginalMB = Math.max(previousOriginalMB, original.sizeMB);
    const beneficial = encoded.sizeMB < original.sizeMB * BENEFIT_THRESHOLD;

    if (!beneficial) {
      // Already as small as it gets. Keep the current image; only push the alt
      // text if we generated one. Recording it honestly (no further saving, but
      // preserving any real historical saving) keeps the dashboard truthful.
      if (altText && altText !== currentAlt) {
        try {
          await gql(
            admin,
            `#graphql
              mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
                productUpdateMedia(productId: $productId, media: $media) {
                  media { id }
                  mediaUserErrors { field message }
                }
              }
            `,
            { productId, media: [{ id: imageId, alt: altText }] }
          );
        } catch (altError) {
          console.error('[optimize] alt update failed (non-fatal):', altError.message);
        }
      }

      const compressionRate = trueOriginalMB > 0
        ? Math.round(((trueOriginalMB - original.sizeMB) / trueOriginalMB) * 100)
        : 0;

      await writeImageRecord(admin, productId, key, {
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: original.sizeMB,
        compressionRate,
        format,
        altText,
        alreadyOptimized: true,
        optimizedAt: new Date().toISOString(),
        originalImageId: imageId,
        newImageId: imageId,
      });

      // An image already at its smallest costs the merchant nothing, so the
      // reserved unit goes back — charging for it would penalise re-running.
      return {
        success: true,
        imageId,
        newImageId: imageId,
        alreadyOptimized: true,
        originalSizeMB: trueOriginalMB,
        optimizedSizeMB: original.sizeMB,
        compressionRate,
        altText,
        aiAltTextGenerated,
      };
    }

    await putBytes(stagedTarget, encoded.buffer, outFilename, outMime);
    const newImageId = await attachMedia(
      admin,
      productId,
      stagedTarget.resourceUrl,
      altText
    );

    // The new copy is attached, so the work is real and paid for from here on
    // even if the tidy-up below misbehaves.
    quotaSpent = true;

    await deleteMedia(admin, productId, imageId);

    const compressionRate = trueOriginalMB > 0
      ? Math.round(((trueOriginalMB - encoded.sizeMB) / trueOriginalMB) * 100)
      : 0;

    await writeImageRecord(admin, productId, imageMetafieldKey(newImageId), {
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: encoded.sizeMB,
      compressionRate,
      format,
      altText,
      optimizedAt: new Date().toISOString(),
      originalImageId: imageId,
      newImageId,
    });

    return {
      success: true,
      imageId,
      newImageId,
      alreadyOptimized: false,
      originalSizeMB: trueOriginalMB,
      optimizedSizeMB: encoded.sizeMB,
      savedMB: Math.max(trueOriginalMB - encoded.sizeMB, 0),
      compressionRate,
      altText,
      aiAltTextGenerated,
    };
  } catch (error) {
    console.error('[optimize] image %s failed:', imageId, error);
    return { success: false, imageId, error: error.message };
  } finally {
    // Nothing was replaced, so nothing was consumed. AI calls are NOT refunded
    // — that cost is incurred the moment the request goes out.
    if (!quotaSpent) {
      await refundUsage(quota.shop, METRICS.IMAGES_OPTIMIZED, 1);
    }
  }
}

/**
 * Close out a product: rewrite its summary metafield from what is actually on
 * the product now, and restore the merchant's image order.
 *
 * The order matters. Replacing an image appends the optimized copy at the end
 * and deletes the original, so processing images one at a time happened to
 * preserve the order — running several at once does not, because they finish in
 * whatever order they finish. `desiredOrder` is the order the images were in
 * before the run, which is what gets put back.
 */
export async function finalizeProduct(admin, productId, desiredOrder = []) {
  const json = await gql(
    admin,
    `#graphql
      query ProductOptimizationState($id: ID!) {
        product(id: $id) {
          id
          media(first: 250) {
            edges {
              node {
                mediaContentType
                ... on MediaImage { id }
              }
            }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }
    `,
    { id: productId }
  );

  const product = json.data?.product;
  if (!product) return null;

  const currentImageIds = (product.media?.edges || [])
    .map((edge) => edge.node)
    .filter((node) => node?.mediaContentType === 'IMAGE' && node.id)
    .map((node) => node.id);
  const currentShortIds = new Set(currentImageIds.map((id) => id.split('/').pop()));

  const records = {};
  for (const edge of product.metafields?.edges || []) {
    if (!edge.node.key.startsWith('image_')) continue;
    try {
      records[edge.node.key.slice('image_'.length)] = JSON.parse(edge.node.value);
    } catch (err) {
      /* skip unreadable records */
    }
  }

  // Only count records belonging to an image that is on the product RIGHT NOW.
  // Records for replaced images stay behind and would otherwise be counted
  // twice, inflating both the image count and the savings.
  let optimizedImages = 0;
  let totalOriginalSizeMB = 0;
  let totalOptimizedSizeMB = 0;
  let rateSum = 0;

  for (const shortId of currentShortIds) {
    const record = records[shortId];
    if (!record) continue;
    optimizedImages += 1;
    totalOriginalSizeMB += Number(record.originalSizeMB) || 0;
    totalOptimizedSizeMB += Number(record.optimizedSizeMB) || 0;
    rateSum += Number(record.compressionRate) || 0;
  }

  const summary = {
    totalImages: currentImageIds.length,
    optimizedImages,
    totalOriginalSizeMB,
    totalOptimizedSizeMB,
    totalSizeSavedMB: Math.max(totalOriginalSizeMB - totalOptimizedSizeMB, 0),
    avgCompressionRate: optimizedImages > 0 ? Math.round(rateSum / optimizedImages) : 0,
    lastOptimizedAt: new Date().toISOString(),
  };

  await writeImageRecord(admin, productId, 'optimization_summary', summary);

  // Restore the original order. Unknown ids make the mutation fail outright, so
  // only ids still on the product are moved, and anything the caller didn't
  // mention is appended after them rather than dropped.
  const wanted = desiredOrder.filter((id) => currentImageIds.includes(id));
  const ordered = [...wanted, ...currentImageIds.filter((id) => !wanted.includes(id))];
  const orderChanged = ordered.some((id, index) => id !== currentImageIds[index]);

  if (orderChanged && ordered.length > 1) {
    try {
      await gql(
        admin,
        `#graphql
          mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
            productReorderMedia(id: $id, moves: $moves) {
              job { id }
              mediaUserErrors { field message }
            }
          }
        `,
        {
          id: productId,
          moves: ordered.map((id, index) => ({ id, newPosition: String(index) })),
        }
      );
    } catch (error) {
      // Cosmetic. A failed reorder must not fail a successful optimization.
      console.error('[optimize] reorder failed (non-fatal):', error.message);
    }
  }

  return summary;
}

/**
 * Optimize every image on a product in one call.
 *
 * Kept as the single-request path for callers that can't drive the per-image
 * queue (and for a browser still running the previous build right after a
 * deploy). Sequential and silent by nature — the UI uses the per-image route.
 */
export async function optimizeWholeProduct({ admin, quota, productId }) {
  const product = await listProductImages(admin, productId);
  if (!product) {
    return { success: false, error: 'That product could not be loaded.' };
  }
  if (product.images.length === 0) {
    return { success: false, error: `"${product.title}" has no images to optimize.` };
  }

  const results = [];
  for (const image of product.images) {
    const result = await optimizeProductImage({
      admin,
      quota,
      productId,
      imageId: image.id,
    });
    results.push(result);
    if (result.quotaExhausted) break;
  }

  await finalizeProduct(
    admin,
    productId,
    results.map((r, i) => r.newImageId || product.images[i].id)
  );

  const compressed = results.filter((r) => r.success && !r.alreadyOptimized);
  const skipped = results.filter((r) => r.success && r.alreadyOptimized);
  const quotaHit = results.find((r) => r.quotaExhausted);
  const totalSaved = compressed.reduce((sum, r) => sum + (r.savedMB || 0), 0);

  if (compressed.length === 0 && skipped.length === 0) {
    return {
      success: false,
      quotaExhausted: !!quotaHit,
      error: quotaHit?.error || results.find((r) => r.error)?.error
        || `No images could be processed for "${product.title}".`,
    };
  }

  let message;
  if (compressed.length > 0) {
    const saved = totalSaved >= 1
      ? `${totalSaved.toFixed(1)} MB`
      : `${Math.round(totalSaved * 1024)} KB`;
    message = `Compressed ${compressed.length} image${compressed.length > 1 ? 's' : ''} for "${product.title}" — saved ${saved}.`;
  } else {
    message = `"${product.title}" is already optimized — its ${skipped.length} image${skipped.length > 1 ? 's are' : ' is'} already as small as possible, so nothing was changed.`;
  }
  if (quotaHit) {
    message += ` ${quotaHit.error}`;
  }

  return { success: true, message, quotaExhausted: !!quotaHit, results };
}
