import { authenticate, BASIC_PLAN } from "../shopify.server";

/**
 * Subscribe action. Posting here (from the in-app pricing screen) sends the
 * merchant out to Shopify's subscription approval page. After approval, the
 * library returns them into the embedded app (default embedded return URL).
 */
export const action = async ({ request }) => {
  const { billing } = await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  const isTest = process.env.BILLING_TEST_MODE !== "false";

  // billing.request redirects out of the app to Shopify's approval page.
  return billing.request({ plan: BASIC_PLAN, isTest });
};

// This route only exists for its action. The in-app pricing UI is rendered by
// the parent app layout, so there is nothing to render here.
export default function Subscribe() {
  return null;
}
