# Built with the repository root as context: docker build -f teobeanie/Dockerfile .
# CI builds and publishes it on a version tag; a local add-on (scripts/deploy-local-addon.sh) builds on the device.
FROM node:24-alpine AS build
# better-sqlite3 has no musl prebuilds: compile it here.
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY panel/package.json ./panel/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY panel ./panel
RUN pnpm run build && pnpm --filter teobeanie-panel build
RUN CI=true pnpm prune --prod

FROM node:24-alpine
ARG BUILD_VERSION=dev
LABEL io.hass.name="Teobeanie" \
      io.hass.description="Event-sourced smart-home brain" \
      io.hass.type="addon" \
      io.hass.version="${BUILD_VERSION}"
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY --from=build /build/panel-dist ./panel-dist
# The starter packages (TypeScript, run as-is): copied into the config folder on start.
COPY packages ./packages
COPY package.json ./
COPY examples ./examples
ENV NODE_ENV=production
# The Supervisor's watchdog follows Docker health: an unresponsive server gets restarted.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1:8099/health || exit 1
CMD ["node", "dist/main.js"]
