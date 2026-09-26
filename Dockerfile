# docker run -d -p 8000:8000 alseambusher/crontab-ui
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /crontab-ui
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV   CRON_PATH=/etc/crontabs
RUN   touch $CRON_PATH/root && chmod +x $CRON_PATH/root

RUN   apk --no-cache add \
      curl \
      supervisor \
      tini \
      tzdata

WORKDIR /crontab-ui

LABEL maintainer="@alseambusher"
LABEL description="Crontab-UI docker"

COPY --from=build /crontab-ui/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p /crontab-ui/crontabs/logs && chown -R node:node /crontab-ui/crontabs

ENV   HOST=0.0.0.0
ENV   PORT=8000
ENV   CRON_IN_DOCKER=true
ENV   NODE_ENV=production

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["supervisord", "-c", "/crontab-ui/supervisord.conf"]
