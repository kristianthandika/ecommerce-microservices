# gateway — multi-stage, non-root, all-Alpine.
# BUILD CONTEXT WAJIB = ROOT REPO. `docker build -f services/gateway/Dockerfile .`
FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/logger/package.json packages/logger/
COPY packages/resilient-http-client/package.json packages/resilient-http-client/
COPY services/auth-service/package.json services/auth-service/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
COPY services/gateway/package.json services/gateway/
COPY frontend/package.json frontend/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build:packages
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY services/gateway ./services/gateway
USER node
WORKDIR /app/services/gateway
EXPOSE 8080
CMD ["node", "src/index.ts"]
