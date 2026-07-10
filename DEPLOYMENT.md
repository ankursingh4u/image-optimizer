# Deployment

This app is hosted on a self-managed **Coolify** server and deploys automatically.

## Push-to-deploy

Pushing to the `main` branch of `github.com/ankursingh4u/image-optimizer` triggers
an automatic build & deploy on Coolify (via a GitHub webhook → Coolify manual
webhook receiver). No manual step required.

```bash
git add -A
git commit -m "your change"
git push origin main   # Coolify builds and deploys automatically
```

## Manual deploy (fallback)

If you ever need to trigger a deploy by hand:

```bash
curl "http://<coolify-host>:8000/api/v1/deploy?uuid=<app-uuid>&force=true" \
  -H "Authorization: Bearer <coolify-api-token>"
```

## Configuration

- Runtime config lives in Coolify env vars (never committed): Shopify keys,
  `DATABASE_URL`, AI keys, etc.
- Database schema is created on boot via `prisma db push`.
- Live URL: https://imageoptimizer.onkra.online
