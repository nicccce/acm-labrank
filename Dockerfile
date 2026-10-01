FROM node:24.21.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN npm install --global pnpm@11.19.0 --registry=$NPM_REGISTRY

FROM base AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/connectors/package.json packages/connectors/package.json
RUN pnpm install --frozen-lockfile --registry=$NPM_REGISTRY
COPY . .
RUN pnpm typecheck && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=UTC
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@acm/web", "start"]
