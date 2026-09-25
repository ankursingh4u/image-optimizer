FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the Prisma client at BUILD time. It was running on every container
# start instead, which pushed back the moment the server binds port 3000 — and
# during a deploy, every second before that bind is a second of requests
# hanging. Nothing about the client depends on runtime state.
RUN npx prisma generate

RUN npm run build

# Docker-level health check. Coolify reads this, and so does `docker ps`, so a
# container that is up but not yet serving is visible as such rather than
# silently receiving traffic.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "docker-start"]
