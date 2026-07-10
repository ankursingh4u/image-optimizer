/**
 * One-time Session import from the old Heroku Postgres into the current DB.
 *
 * Safe to leave in the codebase: it is a NO-OP unless HEROKU_DATABASE_URL is set.
 * It reads from the source DB (Heroku) and upserts each Session row into the
 * database pointed to by DATABASE_URL (the new Coolify Postgres). It never
 * deletes anything and is idempotent (upsert by primary key).
 *
 * Enable by setting HEROKU_DATABASE_URL in the Coolify app env, deploy once,
 * confirm the log line, then remove the env var.
 */
import { PrismaClient } from "@prisma/client";

const source = process.env.HEROKU_DATABASE_URL;
if (!source) {
  console.log("[import-sessions] HEROKU_DATABASE_URL not set — skipping (no-op).");
  process.exit(0);
}

// Heroku Postgres (RDS) requires SSL; do not verify the CA chain.
const sourceUrl = source.includes("sslmode=")
  ? source
  : source + (source.includes("?") ? "&" : "?") + "sslmode=require";

const src = new PrismaClient({ datasources: { db: { url: sourceUrl } } });
const dst = new PrismaClient(); // uses DATABASE_URL

try {
  const rows = await src.session.findMany();
  console.log(`[import-sessions] read ${rows.length} sessions from source.`);

  let ok = 0;
  for (const row of rows) {
    await dst.session.upsert({ where: { id: row.id }, create: row, update: row });
    ok++;
  }

  const total = await dst.session.count();
  console.log(`[import-sessions] upserted ${ok} rows. Destination now has ${total} sessions.`);
} catch (err) {
  // Never take down the app because of a migration hiccup.
  console.error("[import-sessions] FAILED (app will still start):", err.message);
} finally {
  await src.$disconnect().catch(() => {});
  await dst.$disconnect().catch(() => {});
}
