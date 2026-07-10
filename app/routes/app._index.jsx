import { useEffect } from "react";
import { useFetcher, useNavigate } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  return null;
};

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  return (
    <s-page heading="Image Optimizer & SEO Suite">
      <s-button slot="primary-action" onClick={() => navigate('/app/alttextsuggestions')}>
        Generate Alt Text
      </s-button>

      <s-section heading="Welcome to Your Image Optimization Hub 🚀">
        <s-paragraph>
          Boost your store's performance, accessibility, and search rankings with our comprehensive image optimization suite.
          This app provides three powerful modules to help you optimize images, generate SEO-friendly alt text, and track performance improvements.
        </s-paragraph>
      </s-section>

      <s-section heading="Quick Start Guide">
        <s-paragraph>
          Follow these three simple steps to optimize your store:
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">Step 1: Generate AI Alt Text 🤖</s-heading>
              <s-paragraph>
                Use AI to create SEO-optimized descriptions for your product images. Supports Claude, OpenAI, and smart fallback options.
              </s-paragraph>
              <s-button onClick={() => navigate('/app/alttextsuggestions')}>
                Start Generating Alt Text →
              </s-button>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">Step 2: Optimize Images ⚡</s-heading>
              <s-paragraph>
                Compress images to reduce file sizes by up to 70%. Automatic WebP conversion and smart compression for maximum performance.
              </s-paragraph>
              <s-button onClick={() => navigate('/app/productoptimization')}>
                Optimize Your Images →
              </s-button>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">Step 3: Track Performance 📊</s-heading>
              <s-paragraph>
                Monitor improvements with detailed analytics. Track Core Web Vitals, run live PageSpeed tests, and see the impact of your optimizations.
              </s-paragraph>
              <s-button onClick={() => navigate('/app/pagespeedimpactreports')}>
                View Performance Reports →
              </s-button>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Available Modules">
        <s-stack direction="block" gap="base">
          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">✨ AI Alt Text Suggestions</s-heading>
              <s-paragraph>
                Generate SEO-optimized alt text for product images using AI. Features include:
              </s-paragraph>
              <s-unordered-list>
                <s-list-item>AI-powered vision analysis (Claude, OpenAI)</s-list-item>
                <s-list-item>SEO score optimization</s-list-item>
                <s-list-item>Bulk processing for multiple images</s-list-item>
                <s-list-item>Edit and customize suggestions</s-list-item>
              </s-unordered-list>
              <s-link href="/app/alttextsuggestions">Open Alt Text Generator →</s-link>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">⚡ Image Optimization Dashboard</s-heading>
              <s-paragraph>
                Compress and optimize product images automatically. Features include:
              </s-paragraph>
              <s-unordered-list>
                <s-list-item>Automatic WebP conversion</s-list-item>
                <s-list-item>Smart compression (reduce size by 70%)</s-list-item>
                <s-list-item>Batch optimization for all products</s-list-item>
                <s-list-item>Size reduction tracking</s-list-item>
              </s-unordered-list>
              <s-link href="/app/productoptimization">Open Optimization Dashboard →</s-link>
            </s-stack>
          </s-box>

          <s-box
            padding="base"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
          >
            <s-stack direction="block" gap="small">
              <s-heading size="small">📊 Page Speed Impact Reports</s-heading>
              <s-paragraph>
                Track performance improvements and Core Web Vitals. Features include:
              </s-paragraph>
              <s-unordered-list>
                <s-list-item>Live PageSpeed testing integration</s-list-item>
                <s-list-item>Core Web Vitals tracking (LCP, FID, CLS)</s-list-item>
                <s-list-item>Before/after performance metrics</s-list-item>
                <s-list-item>Performance insights and recommendations</s-list-item>
              </s-unordered-list>
              <s-link href="/app/pagespeedimpactreports">View Performance Reports →</s-link>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Key Features">
        <s-paragraph>
          <s-text>🎨 AI-Powered Alt Text: </s-text>
          Generate SEO-optimized descriptions using Claude or OpenAI
        </s-paragraph>
        <s-paragraph>
          <s-text>⚡ Smart Compression: </s-text>
          Reduce image sizes by up to 70% with automatic WebP conversion
        </s-paragraph>
        <s-paragraph>
          <s-text>📈 Performance Tracking: </s-text>
          Monitor Core Web Vitals and PageSpeed scores in real-time
        </s-paragraph>
        <s-paragraph>
          <s-text>🔄 Batch Processing: </s-text>
          Process hundreds of images and generate alt text in bulk
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Getting Started">
        <s-unordered-list>
          <s-list-item>
            Start by generating{" "}
            <s-link href="/app/alttextsuggestions">
              AI alt text
            </s-link>{" "}
            for better SEO
          </s-list-item>
          <s-list-item>
            Optimize your images in the{" "}
            <s-link href="/app/productoptimization">
              optimization dashboard
            </s-link>
          </s-list-item>
          <s-list-item>
            Track improvements in{" "}
            <s-link href="/app/pagespeedimpactreports">
              performance reports
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Best Practices">
        <s-unordered-list>
          <s-list-item>
            Generate alt text before optimizing images for better organization
          </s-list-item>
          <s-list-item>
            Run optimization on all products for consistent performance
          </s-list-item>
          <s-list-item>
            Monitor PageSpeed reports regularly to track improvements
          </s-list-item>
          <s-list-item>
            Use batch processing for faster workflow with multiple products
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};