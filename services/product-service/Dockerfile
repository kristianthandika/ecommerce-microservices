# product-service — multi-stage, non-root, all-Alpine.
# BUILD CONTEXT WAJIB = ROOT REPO. `docker build -f services/product-service/Dockerfile .`
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/storage/package.json packages/storage/
COPY packages/logger/package.json packages/logger/
COPY packages/resilient-http-client/package.json packages/resilient-http-client/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
COPY services/gateway/package.json services/gateway/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build:packages
RUN npm prune --omit=dev --no-audit --no-fund && mkdir -p /app/services/product-service/node_modules

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY scripts/backup.ts ./scripts/backup.ts
COPY services/product-service ./services/product-service
COPY --from=build /app/services/product-service/node_modules ./services/product-service/node_modules
RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/services/product-service
EXPOSE 3002
CMD ["node", "src/index.ts"]
