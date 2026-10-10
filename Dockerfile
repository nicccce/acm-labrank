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
RUN pnpm typecheck && pnpm build && rm -rf apps/web/.next/cache

FROM base AS runtime
ENV NODE_ENV=production
ENV TZ=UTC
ARG VCS_REF=unknown
ARG APP_VERSION=1.1.0
LABEL org.opencontainers.image.source="https://github.com/nicccce/acm-labrank" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@acm/web", "start"]

# Browser OS layers are independent of application source changes.
FROM base AS browser-system
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
RUN sed -i "s|http://deb.debian.org/debian$|${DEBIAN_MIRROR}|;s|http://deb.debian.org/debian-security$|${DEBIAN_SECURITY_MIRROR}|" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends chromium xvfb x11-utils openbox x11vnc novnc websockify tigervnc-tools fonts-noto-cjk \
    && sed -i "s|${DEBIAN_MIRROR}$|http://deb.debian.org/debian|;s|${DEBIAN_SECURITY_MIRROR}$|http://deb.debian.org/debian-security|" /etc/apt/sources.list.d/debian.sources \
    && rm -rf /var/lib/apt/lists/*

FROM browser-system AS worker-browser
ENV NODE_ENV=production
ENV TZ=UTC
ARG VCS_REF=unknown
ARG APP_VERSION=1.1.0
LABEL org.opencontainers.image.source="https://github.com/nicccce/acm-labrank" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.version=$APP_VERSION
COPY --from=runtime --chown=node:node /app /app
ENV DISPLAY=:99
ENV TMPDIR=/tmp/qoj-browser
ENV XDG_CONFIG_HOME=/tmp/qoj-config
ENV XDG_CACHE_HOME=/tmp/qoj-cache
USER node
EXPOSE 6080
ENTRYPOINT ["node", "scripts/qoj-container.mjs"]
CMD ["pnpm", "--filter", "@acm/worker", "start"]

# Plain docker build still produces the normal application image.
FROM runtime AS default
