import { authenticate, BASIC_PLAN } from "../shopify.server";
import { resolveBillingMode } from "../billing.server";

/**
 * Subscribe action. Creates the Basic subscription directly via the admin
 * GraphQL client (which is authenticated correctly for this app's
 * direct_api_mode = "online" setup), then redirects the merchant — top-level,
 * out of the iframe — to Shopify's approval page. After approval Shopify
 * returns them to `returnUrl` (the embedded app).
 *
 * We call appSubscriptionCreate ourselves (instead of billing.request) because
 * the library's helper used the stored offline token, which was returning 401.
 */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  const env = process.env;
  // isTest=false means a REAL charge. Resolved centrally so a listed test shop
  // (e.g. a dev store, which Shopify won't let us charge for real) stays on
  // test charges even after the app goes live.
  const { isTest } = resolveBillingMode(session.shop);
  const store = session.shop.replace(".myshopify.com", "");

  // Return the merchant into the embedded app after approval.
  let appHandle = null;
  try {
    const h = await admin.graphql(
      `#graphql
        query AppHandle { currentAppInstallation { app { handle } } }`
    );
    appHandle = (await h.json())?.data?.currentAppInstallation?.app?.handle;
  } catch (err) {
    console.error("[subscribe] app handle lookup failed:", err?.message);
  }
  const returnUrl = appHandle
    ? `https://admin.shopify.com/store/${store}/apps/${appHandle}`
    : `${env.SHOPIFY_APP_URL}/app`;

  const resp = await admin.graphql(
    `#graphql
      mutation CreateSubscription(
        $name: String!
        $returnUrl: URL!
        $test: Boolean
        $trialDays: Int
        $lineItems: [AppSubscriptionLineItemInput!]!
      ) {
        appSubscriptionCreate(
          name: $name
          returnUrl: $returnUrl
          test: $test
          trialDays: $trialDays
          lineItems: $lineItems
        ) {
          confirmationUrl
          appSubscription { id status }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        name: BASIC_PLAN,
        returnUrl,
        test: isTest,
        trialDays: 3,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: "30.00", currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    }
  );

  const json = await resp.json();
  console.log("[subscribe][debug] appSubscriptionCreate =", JSON.stringify(json));

  const result = json?.data?.appSubscriptionCreate;
  const userErrors = result?.userErrors || [];
  const confirmationUrl = result?.confirmationUrl;

  if (userErrors.length || !confirmationUrl) {
    return {
      error:
        "Could not start subscription: " +
        (userErrors.map((e) => e.message).join("; ") || "no confirmation URL returned"),
    };
  }

  // Return the approval URL to the client; App Bridge performs the top-level
  // redirect out of the iframe (a server redirect to this shop-admin URL 401s).
  return { confirmationUrl };
};

export default function Subscribe() {
  return null;
}
