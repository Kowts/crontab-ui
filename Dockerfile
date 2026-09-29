# Use Docker Compose with deployment secrets; the image does not provide a public default deployment.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /crontab-ui
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV   CRON_PATH=/etc/crontabs
RUN   mkdir -p "$CRON_PATH" \
      && touch "$CRON_PATH/node" \
      && chown -R node:node "$CRON_PATH" \
      && chmod 0700 "$CRON_PATH" \
      && chmod 0600 "$CRON_PATH/node"

RUN   apk --no-cache add \
      curl \
      supercronic \
      supervisor \
      tini \
      tzdata

# npm is only needed in the build stage. Removing it from the runtime image
# reduces the attack surface and excludes its bundled packages from deployment.
RUN   rm -rf /usr/local/lib/node_modules/npm \
      && rm -f /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /crontab-ui

LABEL maintainer="@alseambusher"
LABEL description="Crontab-UI docker"

COPY --from=build /crontab-ui/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p /crontab-ui/crontabs/logs && chown -R node:node /crontab-ui/crontabs

ENV   HOST=0.0.0.0
ENV   PORT=8000
ENV   CRON_IN_DOCKER=true
ENV   CRON_USER=node
ENV   NODE_ENV=production

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["supervisord", "-c", "/crontab-ui/supervisord.conf"]
