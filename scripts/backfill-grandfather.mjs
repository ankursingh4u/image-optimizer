/**
 * One-time backfill of GrandfatheredShop from the existing Session table.
 *
 * Every shop that already has a session at the moment this runs installed the
 * app while it was free, so it keeps full access when BILLING_ENFORCED is
 * turned on. Shops that install afterwards get no row and are therefore gated.
 *
 * Safe to leave in the codebase and in docker-start:
 *   - idempotent: skipInDuplicates, never updates or deletes an existing row
 *   - self-disabling: does nothing once the table is non-empty, so a merchant
 *     who uninstalls and reinstalls later is not silently grandfathered
 *   - never throws: a failure here must not take the app down
 *
 * Force a re-run (e.g. after adding a shop manually) with
 * BILLING_GRANDFATHER_FORCE=true.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const existing = await prisma.grandfatheredShop.count();
  const force = process.env.BILLING_GRANDFATHER_FORCE === "true";

  if (existing > 0 && !force) {
    console.log(
      `[grandfather] already populated (${existing} shops) — skipping.`
    );
  } else {
    const rows = await prisma.session.findMany({
      select: { shop: true },
      distinct: ["shop"],
    });
    const shops = [...new Set(rows.map((r) => r.shop).filter(Boolean))];

    if (shops.length === 0) {
      console.log("[grandfather] no sessions found — nothing to backfill.");
    } else {
      const result = await prisma.grandfatheredShop.createMany({
        data: shops.map((shop) => ({
          shop,
          reason: "installed before billing enforcement",
        })),
        skipDuplicates: true,
      });
      console.log(
        `[grandfather] backfilled ${result.count} of ${shops.length} shops.`
      );
    }
  }

  const total = await prisma.grandfatheredShop.count();
  console.log(`[grandfather] GrandfatheredShop now has ${total} rows.`);
} catch (err) {
  // Never take down the app because of a backfill hiccup. Note that the billing
  // gate fails OPEN on lookup errors, so a broken backfill cannot lock anyone
  // out — it can only fail to gate someone it should have.
  console.error("[grandfather] FAILED (app will still start):", err.message);
} finally {
  await prisma.$disconnect().catch(() => {});
}
