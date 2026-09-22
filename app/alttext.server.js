/**
 * AI alt text, in one place.
 *
 * There were two implementations: the Alt Text page called OpenAI, and the
 * optimizer called Anthropic directly with its own prompt and its own model.
 * Same job, two providers, two sets of behaviour to keep correct — and two API
 * keys to keep configured, so whichever one was missing failed quietly.
 *
 * OpenAI is the app's provider, so that is what lives here.
 */

const MODEL = 'gpt-4o-mini';
const MAX_LENGTH = 125;

const PROMPT = (productTitle) => `Generate SEO-optimized alt text for this e-commerce product image.

Product: ${productTitle}

Requirements:
- Include specific visual details (color, material, style, pattern)
- Describe what you actually see in the image
- Keep it under ${MAX_LENGTH} characters
- Make it natural and descriptive
- Don't use "image of" or "picture of"
- Focus on features that help customers understand the product

Return ONLY the alt text, nothing else.`;

/** Whether alt text can be generated at all right now. */
export function altTextAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Describe one image.
 *
 * Throws if the key is missing or the call fails — callers decide whether that
 * is fatal. The optimizer treats it as non-fatal and refunds the quota unit it
 * reserved, because a failed description must not cost a merchant anything.
 *
 * `imageUrl` is passed to OpenAI as-is rather than uploaded: Shopify's CDN URLs
 * are public, so nobody has to download the image to describe it.
 */
export async function generateAltText(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 150,
      temperature: 0.4,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT(productTitle) },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${errorText.slice(0, 200)}`);
  }

  const result = await response.json();
  let altText = result.choices?.[0]?.message?.content?.trim() || '';
  altText = altText.replace(/^["']|["']$/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ');

  if (!altText) throw new Error('OpenAI returned no alt text');
  if (altText.length > MAX_LENGTH) {
    altText = altText.substring(0, MAX_LENGTH - 3) + '...';
  }
  return altText;
}
