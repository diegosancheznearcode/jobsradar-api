# Build de todo el workspace pnpm, luego se queda solo con apps/api.
# Ver ARCHITECTURE.md sección 9 (dos repos, uno por servicio de despliegue).
FROM node:22-alpine AS base
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
RUN pnpm --filter @jobsradar/domain build \
  && pnpm --filter @jobsradar/contracts build \
  && pnpm --filter @jobsradar/api build

FROM node:22-alpine AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo .
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
