FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=5173 \
    MOJUAN_HOST=0.0.0.0 \
    MOJUAN_DB=/data/mojuan.sqlite \
    MOJUAN_ALLOW_REGISTRATION=false \
    MOJUAN_COOKIE_SECURE=true

WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public/data ./public/data
COPY --chown=node:node server ./server
COPY --chown=node:node scripts/serve-local.mjs ./scripts/serve-local.mjs
USER node
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5173/api/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/serve-local.mjs"]
