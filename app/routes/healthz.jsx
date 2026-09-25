/**
 * Readiness probe: /healthz
 *
 * Coolify had no health check for this app, so on every deploy it pointed the
 * proxy at the new container the moment Docker started it. The container does
 * not serve anything for the first several seconds — `docker-start` runs
 * prisma generate, prisma db push and two backfill scripts before
 * react-router-serve ever binds port 3000 — so every request that arrived in
 * that window hung with nothing listening, which is what "took too long to
 * respond" was.
 *
 * With this endpoint configured as the health check, the proxy only sends
 * traffic once the server is actually answering, and the old container keeps
 * serving until then.
 *
 * Deliberately does NOT touch the database or Shopify: it answers the one
 * question the proxy is asking — is this process ready to take a request. A
 * database outage should not also tear down the instance that could still
 * serve cached pages and report the error properly.
 */
export function loader() {
  return new Response('ok', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
}
