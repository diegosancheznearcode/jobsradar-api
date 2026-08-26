# Fase 0/6.2: el login/renovación de sesión de Wellfound necesita un navegador
# real (Playwright). Esta imagen base es un placeholder de Fase 1 — se cambia
# a la imagen oficial de Playwright en la Fase 4 cuando se implemente
# BrowserClient.
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
  && pnpm --filter @jobsradar/worker build

FROM node:22-alpine AS runtime
WORKDIR /repo
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /repo .
CMD ["node", "apps/worker/dist/index.js"]
