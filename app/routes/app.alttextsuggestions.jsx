import { useState, useCallback, useEffect } from 'react';
import { useLoaderData, useSubmit, useNavigation, useActionData } from 'react-router';
import { authenticate } from '../shopify.server';
import { 
  Page, 
  Layout, 
  Card, 
  Button, 
  TextField, 
  Badge, 
  Checkbox, 
  Text, 
  Box, 
  InlineStack, 
  BlockStack, 
  Thumbnail, 
  Divider, 
  Banner,
  Select 
} from '@shopify/polaris';

async function verifyOpenAIKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, error: 'API key not configured' };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just: working' }]
      })
    });

    if (response.ok) {
      return { success: true, workingModel: 'gpt-4o-mini', message: 'API key verified! Using gpt-4o-mini' };
    } else {
      const errorData = await response.json();
      return { success: false, error: `API Error: ${errorData.error?.message}` };
    }
  } catch (error) {
    return { success: false, error: `Connection error: ${error.message}` };
  }
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query GetProductsWithImages {
        products(first: 50) {
          edges {
            node {
              id
              title
              media(first: 10) {
                edges {
                  node {
                    id
                    alt
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
            }
          }
        }
      }
    `
  );

  const data = await response.json();
  const imagesList = [];

  data.data.products.edges.forEach(({ node: product }) => {
    product.media.edges.forEach(({ node: media }) => {
      // Only process images, skip videos etc
      if (media.mediaContentType !== 'IMAGE') return;

      imagesList.push({
        id: media.id,           // ✅ This is gid://shopify/MediaImage/... 
        productId: product.id,
        productTitle: product.title,
        url: media.image?.url || '',
        currentAlt: media.alt || '',
        suggestedAlt: '',
        seoScore: calculateSeoScore(media.alt),
        status: 'pending'
      });
    });
  });

  return { images: imagesList };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'verifyApiKey') {
    return await verifyOpenAIKey();
  }

  // ✅ Using fileUpdate with correct response fields
  if (actionType === 'applyAltText') {
    const imageId = formData.get('imageId');
    const altText = formData.get('altText');

    try {
      const response = await admin.graphql(
        `#graphql
          mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
              files {
                id
                alt
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
            files: [{ id: imageId, alt: altText }]
          }
        }
      );

      const result = await response.json();

      if (result.data?.fileUpdate?.userErrors?.length > 0) {
        return {
          success: false,
          error: result.data.fileUpdate.userErrors[0].message
        };
      }

      return { success: true, message: 'Alt text applied successfully!' };
    } catch (error) {
      console.error('Error updating image:', error);
      return { success: false, error: 'Failed to update image alt text: ' + error.message };
    }
  }

  // ✅ Bulk apply using fileUpdate with correct response fields
  if (actionType === 'applyBulk') {
    const updates = JSON.parse(formData.get('updates'));

    try {
      const response = await admin.graphql(
        `#graphql
          mutation fileUpdate($files: [FileUpdateInput!]!) {
            fileUpdate(files: $files) {
              files {
                id
                alt
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
            files: updates.map(({ imageId, altText }) => ({
              id: imageId,
              alt: altText
            }))
          }
        }
      );

      const result = await response.json();

      if (result.data?.fileUpdate?.userErrors?.length > 0) {
        return {
          success: false,
          error: result.data.fileUpdate.userErrors[0].message
        };
      }

      return { success: true, message: `Successfully updated ${updates.length} images` };
    } catch (error) {
      console.error('Error in bulk update:', error);
      return { success: false, error: 'Failed to update some images: ' + error.message };
    }
  }

  if (actionType === 'generateSuggestions') {
    try {
      const imagesData = JSON.parse(formData.get('images'));
      const aiProvider = formData.get('aiProvider') || 'openai';
      const batchSize = 3;
      const suggestions = [];

      for (let i = 0; i < imagesData.length; i += batchSize) {
        const batch = imagesData.slice(i, i + batchSize);

        const batchResults = await Promise.all(
          batch.map(async (image) => {
            try {
              const suggestion = await generateAIAltText(image.url, image.productTitle, aiProvider);
              return { id: image.id, suggestedAlt: suggestion.altText, seoScore: suggestion.seoScore };
            } catch (error) {
              return {
                id: image.id,
                suggestedAlt: generateSmartFallback(image.productTitle, image.url),
                seoScore: 70
              };
            }
          })
        );
        suggestions.push(...batchResults);

        if (i + batchSize < imagesData.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      return { success: true, suggestions };
    } catch (error) {
      return { success: false, error: 'Failed to generate AI suggestions: ' + error.message };
    }
  }

  return { success: false, error: 'Invalid action' };
}

function calculateSeoScore(altText) {
  if (!altText) return 0;
  let score = 50;
  const wordCount = altText.split(' ').length;
  if (wordCount >= 5 && wordCount <= 15) score += 30;
  else if (wordCount >= 3 && wordCount <= 20) score += 15;
  if (altText.match(/\b(color|size|style|material|pattern|texture|design|quality)\b/i)) score += 10;
  if (altText.length > 20 && altText.length < 125) score += 10;
  return Math.min(score, 100);
}

async function generateAIAltText(imageUrl, productTitle, provider = 'openai') {
  switch (provider) {
    case 'openai':
      return await generateWithOpenAI(imageUrl, productTitle);
    case 'anthropic':
      return await generateWithAnthropic(imageUrl, productTitle);
    default:
      return generateSmartFallbackObject(productTitle, imageUrl);
  }
}

async function generateWithOpenAI(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under 125 characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`
          },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  let altText = result.choices[0]?.message?.content?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';

  return { altText, seoScore: calculateSeoScore(altText) };
}

async function generateWithAnthropic(imageUrl, productTitle) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`Failed to fetch image: ${imageResponse.status}`);

  const imageBuffer = await imageResponse.arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString('base64');

  let mediaType = 'image/jpeg';
  const urlLower = imageUrl.toLowerCase();
  if (urlLower.includes('.png')) mediaType = 'image/png';
  else if (urlLower.includes('.webp')) mediaType = 'image/webp';
  else if (urlLower.includes('.gif')) mediaType = 'image/gif';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image }
          },
          {
            type: 'text',
            text: `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under 125 characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  let altText = result.content[0]?.text?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';

  return { altText, seoScore: calculateSeoScore(altText) };
}

function generateSmartFallback(productTitle, imageUrl) {
  const titleWords = productTitle.toLowerCase();
  const urlLower = imageUrl.toLowerCase();
  const colors = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'purple', 'pink', 'orange', 'brown', 'gray', 'grey', 'navy', 'beige', 'tan'];
  let detectedColor = colors.find(color => titleWords.includes(color) || urlLower.includes(color));
  let description = '';

  if (titleWords.match(/\b(shirt|tee|t-shirt|blouse|top)\b/)) {
    description = `casual ${detectedColor || ''} cotton fabric`.trim();
  } else if (titleWords.match(/\b(shoe|shoes|sneaker|sneakers|boot|boots)\b/)) {
    description = `comfortable ${detectedColor || 'quality'} footwear with durable construction`.trim();
  } else if (titleWords.match(/\b(watch|watches)\b/)) {
    description = `elegant ${detectedColor || 'premium'} timepiece with precision design`.trim();
  } else if (titleWords.match(/\b(bag|bags|backpack|purse|handbag)\b/)) {
    description = `durable ${detectedColor || 'quality'} bag with spacious storage`.trim();
  } else {
    description = `${detectedColor || 'quality'} product with professional design`.trim();
  }

  let altText = `${productTitle} - ${description}`;
  if (altText.length > 125) altText = altText.substring(0, 122) + '...';
  return altText;
}

function generateSmartFallbackObject(productTitle, imageUrl) {
  return {
    altText: generateSmartFallback(productTitle, imageUrl),
    seoScore: calculateSeoScore(generateSmartFallback(productTitle, imageUrl))
  };
}

export default function AltTextSuggestions() {
  const { images: initialImages } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [images, setImages] = useState(initialImages);
  const [selectedImages, setSelectedImages] = useState([]);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [aiProvider, setAiProvider] = useState('openai');
  const [isVerifying, setIsVerifying] = useState(false);

  const isSubmitting = navigation.state === 'submitting';
  const isGenerating = navigation.state === 'submitting' && navigation.formData?.get('actionType') === 'generateSuggestions';

  const handleVerifyApiKey = useCallback(() => {
    setError(null);
    setSuccessMessage(null);
    setIsVerifying(true);
    const formData = new FormData();
    formData.append('actionType', 'verifyApiKey');
    submit(formData, { method: 'post' });
  }, [submit]);

  useEffect(() => {
    if (actionData?.success && actionData?.suggestions) {
      setImages(prev =>
        prev.map(img => {
          const suggestion = actionData.suggestions.find(s => s.id === img.id);
          if (suggestion) {
            return { ...img, suggestedAlt: suggestion.suggestedAlt, seoScore: suggestion.seoScore };
          }
          return img;
        })
      );
      setSuccessMessage('AI suggestions generated successfully!');
      setTimeout(() => setSuccessMessage(null), 3000);
    } else if (actionData?.workingModel) {
      setSuccessMessage(actionData.message);
      setIsVerifying(false);
      setTimeout(() => setSuccessMessage(null), 5000);
    } else if (actionData?.error) {
      setError(actionData.error);
      setIsVerifying(false);
    } else if (actionData?.message) {
      setSuccessMessage(actionData.message);
      setTimeout(() => setSuccessMessage(null), 3000);
    }
  }, [actionData]);

  const generateSuggestions = useCallback(() => {
    setError(null);
    const pendingImages = images.filter(img => img.status === 'pending' && !img.suggestedAlt);
    if (pendingImages.length === 0) {
      setError('All images already have suggestions. Clear existing suggestions to regenerate.');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'generateSuggestions');
    formData.append('aiProvider', aiProvider);
    formData.append('images', JSON.stringify(pendingImages.map(img => ({
      id: img.id, url: img.url, productTitle: img.productTitle
    }))));
    submit(formData, { method: 'post' });
  }, [images, aiProvider, submit]);

  const handleSelectImage = useCallback((id) => {
    setSelectedImages(prev => prev.includes(id) ? prev.filter(imgId => imgId !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    const pendingImages = images.filter(img => img.status === 'pending');
    setSelectedImages(selectedImages.length === pendingImages.length ? [] : pendingImages.map(img => img.id));
  }, [selectedImages.length, images]);

  const handleApply = useCallback((imageId) => {
    const image = images.find(img => img.id === imageId);
    if (!image.suggestedAlt) {
      setError('Please generate a suggestion first');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyAltText');
    formData.append('imageId', image.id);
    formData.append('altText', image.suggestedAlt);
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      img.id === imageId ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages(prev => prev.filter(id => id !== imageId));
  }, [images, submit]);

  const handleApplySelected = useCallback(() => {
    const updates = selectedImages
      .map(id => {
        const image = images.find(img => img.id === id);
        if (!image.suggestedAlt) return null;
        return { imageId: image.id, altText: image.suggestedAlt };
      })
      .filter(Boolean);

    if (updates.length === 0) {
      setError('Please generate suggestions for selected images first');
      return;
    }
    const formData = new FormData();
    formData.append('actionType', 'applyBulk');
    formData.append('updates', JSON.stringify(updates));
    submit(formData, { method: 'post' });
    setImages(prev => prev.map(img =>
      selectedImages.includes(img.id) && img.suggestedAlt
        ? { ...img, currentAlt: img.suggestedAlt, status: 'applied' } : img
    ));
    setSelectedImages([]);
  }, [selectedImages, images, submit]);

  const handleEditSuggestion = useCallback((id, newText) => {
    setImages(prev => prev.map(img =>
      img.id === id ? { ...img, suggestedAlt: newText, seoScore: calculateSeoScore(newText) } : img
    ));
  }, []);

  const getSeoScoreStatus = (score) => {
    if (score >= 80) return 'success';
    if (score >= 60) return 'warning';
    return 'critical';
  };

  const aiProviderOptions = [
    { label: 'OpenAI GPT-4o-mini (Recommended)', value: 'openai' },
    { label: 'Anthropic Claude 3.5 Haiku', value: 'anthropic' },
    { label: 'Smart Fallback (No API)', value: 'fallback' }
  ];

  const pendingCount = images.filter(img => img.status === 'pending').length;
  const appliedCount = images.filter(img => img.status === 'applied').length;

  return (
    <Page
      title="AI Alt Text Suggestions"
      subtitle="Improve SEO and accessibility with AI-powered recommendations"
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
          <Card>
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="800">
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Pending</Text>
                    <Text variant="heading2xl" as="h2">{pendingCount}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Applied</Text>
                    <Text variant="heading2xl" as="h2" tone="success">{appliedCount}</Text>
                  </BlockStack>
                  <BlockStack gap="200">
                    <Text variant="bodySm" as="p" tone="subdued">Total</Text>
                    <Text variant="heading2xl" as="h2">{images.length}</Text>
                  </BlockStack>
                </InlineStack>
                <InlineStack gap="300" blockAlign="end">
                  <Box minWidth="220px">
                    <Select
                      label=""
                      options={aiProviderOptions}
                      value={aiProvider}
                      onChange={setAiProvider}
                    />
                  </Box>
                  <Button onClick={generateSuggestions} loading={isGenerating} disabled={isGenerating}>
                    {isGenerating ? 'Analyzing Images...' : 'Generate AI Suggestions'}
                  </Button>
                  {selectedImages.length > 0 && (
                    <Button
                      variant="primary"
                      onClick={handleApplySelected}
                      loading={isSubmitting && !isGenerating}
                      disabled={isSubmitting}
                    >
                      Apply Selected ({selectedImages.length})
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>

              <Divider />

              <Checkbox
                label="Select All Pending"
                checked={selectedImages.length === images.filter(img => img.status === 'pending').length && images.filter(img => img.status === 'pending').length > 0}
                onChange={handleSelectAll}
              />

              <BlockStack gap="400">
                {images.length === 0 ? (
                  <Box padding="1600">
                    <BlockStack gap="400" inlineAlign="center">
                      <Text variant="headingMd" as="h3" alignment="center">No images found</Text>
                      <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                        Add products with images to get started.
                      </Text>
                    </BlockStack>
                  </Box>
                ) : (
                  images.slice(0, 20).map((image) => (
                    <Card key={image.id} background={selectedImages.includes(image.id) ? 'bg-surface-selected' : undefined}>
                      <InlineStack gap="400" blockAlign="start">
                        <Checkbox
                          checked={selectedImages.includes(image.id)}
                          onChange={() => handleSelectImage(image.id)}
                          disabled={image.status === 'applied'}
                        />
                        <Thumbnail source={image.url} alt={image.currentAlt || 'Product image'} size="large" />
                        <Box width="100%">
                          <BlockStack gap="400">
                            <Text variant="headingSm" as="h4">{image.productTitle}</Text>

                            <InlineStack align="space-between">
                              <Box width="65%">
                                <BlockStack gap="200">
                                  <Text variant="bodySm" as="p" fontWeight="semibold">Current Alt Text</Text>
                                  <Text variant="bodyMd" as="p" tone={image.currentAlt ? undefined : 'subdued'}>
                                    {image.currentAlt || 'No alt text'}
                                  </Text>
                                </BlockStack>
                              </Box>
                              <BlockStack gap="200" inlineAlign="end">
                                <Text variant="bodySm" as="p" tone="subdued">SEO Score</Text>
                                <Badge tone={getSeoScoreStatus(image.seoScore)}>{image.seoScore}%</Badge>
                              </BlockStack>
                            </InlineStack>

                            <Divider />

                            <BlockStack gap="300">
                              <InlineStack gap="200" blockAlign="center">
                                <Text variant="bodySm" as="p" fontWeight="semibold">AI Suggested Alt Text</Text>
                                {image.status === 'applied' && <Badge tone="success">Applied</Badge>}
                              </InlineStack>
                              <TextField
                                value={image.suggestedAlt}
                                onChange={(value) => handleEditSuggestion(image.id, value)}
                                disabled={image.status === 'applied'}
                                multiline={2}
                                autoComplete="off"
                                placeholder="Click 'Generate AI Suggestions' to analyze images with AI..."
                              />
                            </BlockStack>

                            {image.status === 'pending' && image.suggestedAlt && (
                              <Button
                                variant="primary"
                                onClick={() => handleApply(image.id)}
                                loading={isSubmitting && !isGenerating}
                                disabled={isSubmitting}
                              >
                                Apply This Alt Text
                              </Button>
                            )}
                          </BlockStack>
                        </Box>
                      </InlineStack>
                    </Card>
                  ))
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}