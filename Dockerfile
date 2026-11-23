# syntax=docker/dockerfile:1

# ── Build: compile TypeScript, then keep only production dependencies ──
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── Runtime: no compiler, no dev tools, non-root ──
FROM node:22-slim AS runtime
# The WhatsApp login goes to /app/auth (the default ./auth). Not set as ENV: the name looks like a secret to scanners.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# Fonts for report images (Latin, Hebrew, Arabic; SIL Open Font License)
COPY --chown=node:node assets ./assets
# Chromium draws the "@bot summary" picture from assets/templates (headless, offline, only our own page).
ENV CHROMIUM_PATH=/usr/bin/chromium
# Security: latest OS patches, and no package managers at runtime (smaller attack surface, fewer CVEs).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends chromium \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /app/auth && chown node:node /app/auth
USER node
VOLUME ["/app/auth"]
CMD ["node", "dist/main.js"]
