import { useState, useCallback, useEffect } from 'react';
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
            images(first: 250) {
              edges {
                node {
                  id
                  url
                  altText
                  width
                  height
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

    const processedProducts = await Promise.all(
      products.map(async (product) => {
        const images = product.images.edges.map(edge => edge.node);
        const optimizationData = calculateOptimizationScore(product);
        
        let totalOriginalSize = 0;
        let totalOptimizedSize = 0;

        // Get actual sizes - check metafields first, then fetch if needed
        for (const image of images) {
          const imageKey = `image_${image.id.split('/').pop()}`;
          const metafield = product.metafields.edges.find(
            mf => mf.node.key === imageKey
          );

          if (metafield) {
            try {
              const optData = JSON.parse(metafield.node.value);
              totalOriginalSize += optData.originalSizeMB || 0;
              totalOptimizedSize += optData.optimizedSizeMB || 0;
            } catch (e) {
              console.error('Error parsing metafield:', e);
            }
          } else {
            // Fetch actual size if not in metafield
            const actualSize = await getActualImageSize(image.url);
            totalOriginalSize += actualSize;
          }
        }

        return {
          id: product.id,
          title: product.title,
          handle: product.handle,
          status: product.status,
          imageCount: images.length,
          ...optimizationData,
          totalOriginalSizeMB: totalOriginalSize,
          totalOptimizedSizeMB: totalOptimizedSize,
          sizeSavedMB: totalOriginalSize - totalOptimizedSize,
          compressionRate: totalOriginalSize > 0 
            ? Math.round(((totalOriginalSize - totalOptimizedSize) / totalOriginalSize) * 100)
            : 0,
          featuredImageUrl: product.featuredImage?.url || images[0]?.url,
          needsOptimization: optimizationData.score < 70
        };
      })
    );

    // Apply filters
    let filteredProducts = processedProducts;
    if (filter === 'needs_optimization') {
      filteredProducts = processedProducts.filter(p => p.needsOptimization);
    } else if (filter === 'optimized') {
      filteredProducts = processedProducts.filter(p => !p.needsOptimization);
    } else if (filter === 'no_alt_text') {
      filteredProducts = processedProducts.filter(p => p.imagesWithAlt === 0);
    }

    // Apply sorting
    if (sortBy === 'score_asc') {
      filteredProducts.sort((a, b) => a.score - b.score);
    } else if (sortBy === 'score_desc') {
      filteredProducts.sort((a, b) => b.score - a.score);
    } else if (sortBy === 'size_desc') {
      filteredProducts.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    } else if (sortBy === 'images_desc') {
      filteredProducts.sort((a, b) => b.imageCount - a.imageCount);
    }

    return {
      products: filteredProducts,
      filter,
      sortBy,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((sum, p) => sum + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((sum, p) => sum + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((sum, p) => sum + p.sizeSavedMB, 0)
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
        potentialSavingsMB: 0
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
        .webp({ quality: 85, effort: 6 })
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
 * Delete old image from Shopify
 */
async function deleteImage(admin, productId, imageId) {
  try {
    const deleteMutation = `#graphql
      mutation productDeleteImages($id: ID!, $imageIds: [ID!]!) {
        productDeleteImages(id: $id, imageIds: $imageIds) {
          deletedImageIds
          product {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    await admin.graphql(deleteMutation, {
      variables: {
        id: productId,
        imageIds: [imageId]
      }
    });
  } catch (error) {
    console.error('Error deleting image:', error);
  }
}

/**
 * Upload optimized image to Shopify and replace original
 */
async function uploadAndReplaceImage(admin, session, productId, originalImage, optimizedBuffer, altText) {
  try {
    const shop = session.shop;
    const accessToken = session.accessToken;
    const productIdNumeric = productId.split('/').pop();
    
    // Convert buffer to base64
    const base64Image = optimizedBuffer.toString('base64');
    
    // Determine file extension based on buffer
    const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
    const filename = `optimized-${Date.now()}.${isWebP ? 'webp' : 'jpg'}`;
    
    // Use REST API to create the new image with proper binary upload
    const restUrl = `https://${shop}/admin/api/2024-01/products/${productIdNumeric}/images.json`;
    
    const imageData = {
      image: {
        attachment: base64Image,
        alt: altText,
        position: originalImage.position || 1
      }
    };

    const uploadResponse = await fetch(restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify(imageData)
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Failed to upload image:', errorText);
      throw new Error('Failed to upload optimized image');
    }

    const uploadData = await uploadResponse.json();
    const newImageId = uploadData.image.id;

    // Delete the old image
    const originalImageIdNumeric = originalImage.id.split('/').pop();
    const deleteUrl = `https://${shop}/admin/api/2024-01/products/${productIdNumeric}/images/${originalImageIdNumeric}.json`;
    
    await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'X-Shopify-Access-Token': accessToken
      }
    });

    return `gid://shopify/ProductImage/${newImageId}`;

  } catch (error) {
    console.error('Error uploading and replacing image:', error);
    throw error;
  }
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    
    try {
      // Fetch product details
      const response = await admin.graphql(
        `#graphql
          query GetProductImages($id: ID!) {
            product(id: $id) {
              id
              title
              images(first: 250) {
                edges {
                  node {
                    id
                    url
                    altText
                    width
                    height
                  }
                }
              }
            }
          }
        `,
        { variables: { id: productId } }
      );

      const data = await response.json();
      const product = data.data.product;
      const images = product.images.edges.map((edge, index) => ({
        ...edge.node,
        position: index + 1
      }));

      const optimizationResults = [];

      for (const image of images) {
        try {
          const format = getImageFormat(image.url);
          
          // Get actual original image size
          const originalSizeMB = await getActualImageSize(image.url);

          // Optimize image with Sharp
          const optimizationData = await optimizeImage(image.url, format);

          // Generate AI alt text if missing
          let altText = image.altText;
          if (!altText || altText.length < 10) {
            altText = await generateAIAltText(image.url, product.title);
          }

          // Upload optimized image and replace the original
          const newImageId = await uploadAndReplaceImage(
            admin,
            session,
            productId,
            image,
            optimizationData.optimizedBuffer,
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
                      originalSizeMB: originalSizeMB,
                      optimizedSizeMB: optimizationData.optimizedSizeMB,
                      compressionRate: optimizationData.compressionRate,
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
            originalSize: originalSizeMB,
            optimizedSize: optimizationData.optimizedSizeMB,
            compressionRate: optimizationData.compressionRate,
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

      return {
        success: true,
        message: `Successfully optimized ${successfulOptimizations.length} out of ${images.length} images for "${product.title}"`,
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

  const isSubmitting = navigation.state === 'submitting';

  useEffect(() => {
    if (actionData?.success) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 5000);
      
      // Reload products to show updated data
      submit({ filter, sortBy }, { method: 'get' });
    } else if (actionData?.error) {
      setError(actionData.error);
    }
  }, [actionData, filter, sortBy, submit]);

  const handleFilterChange = useCallback((value) => {
    setFilter(value);
    submit({ filter: value, sortBy }, { method: 'get' });
  }, [sortBy, submit]);

  const handleSortChange = useCallback((value) => {
    setSortBy(value);
    submit({ filter, sortBy: value }, { method: 'get' });
  }, [filter, submit]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => 
      prev.includes(id) ? prev.filter(pid => pid !== id) : [...prev, id]
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(
      selectedProducts.length === products.length ? [] : products.map(p => p.id)
    );
  }, [selectedProducts.length, products]);

  const handleOptimizeProduct = useCallback((productId) => {
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
    if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
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
                  <Text variant="bodyMd" as="p" tone="subdued">Actual Savings</Text>
                  <Text variant="heading2xl" as="h2" tone="success">{formatBytes(stats.potentialSavingsMB)}</Text>
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
                label={`Select All (${products.length} products)`}
                checked={selectedProducts.length === products.length && products.length > 0}
                onChange={handleSelectAll}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              {products.length === 0 ? (
                <EmptyState
                  heading="No products found"
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>Try adjusting your filters to see products.</p>
                </EmptyState>
              ) : (
                products.map((product) => (
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
                                <Badge tone="info">{product.imageCount} images</Badge>
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
                                {formatBytes(product.totalOriginalSizeMB)}
                              </Text>
                            </BlockStack>

                            <BlockStack gap="200">
                              <Text variant="bodySm" as="p" tone="subdued">Size Saved</Text>
                              <Text variant="bodyMd" as="p" fontWeight="semibold" tone="success">
                                {formatBytes(product.sizeSavedMB)} ({product.compressionRate}%)
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

                          {product.needsOptimization && (
                            <InlineStack align="end">
                              <Button
                                variant="primary"
                                onClick={() => handleOptimizeProduct(product.id)}
                                loading={isSubmitting}
                                disabled={isSubmitting}
                              >
                                Optimize This Product
                              </Button>
                            </InlineStack>
                          )}
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