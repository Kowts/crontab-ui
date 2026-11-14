# Use Docker Compose with deployment secrets; the image does not provide a public default deployment.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /crontab-ui
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY agent/secure-exec.c agent/exec-wrapper.c ./agent/
RUN cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now agent/secure-exec.c -o /crontab-ui/secure-exec \
      && cc -O2 -Wall -Wextra -Werror -fPIE -pie -Wl,-z,relro,-z,now agent/exec-wrapper.c -o /crontab-ui/agent-exec

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

ENV   CRON_PATH=/etc/crontabs
RUN   mkdir -p "$CRON_PATH" \
      && touch "$CRON_PATH/node" \
      && chown -R node:node "$CRON_PATH" \
      && chmod 0700 "$CRON_PATH" \
      && chmod 0600 "$CRON_PATH/node"

RUN   apk --no-cache upgrade \
      && apk --no-cache add \
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
COPY --from=build /crontab-ui/secure-exec /usr/local/bin/crontab-ui-secure-exec
COPY --from=build /crontab-ui/agent-exec /usr/local/libexec/crontab-ui-agent-exec
COPY --chown=node:node . .
RUN mkdir -p /crontab-ui/crontabs/logs && chown -R node:node /crontab-ui/crontabs && chmod -R go-rwx /crontab-ui/crontabs

ENV   HOST=0.0.0.0
ENV   PORT=8000
ENV   CRON_IN_DOCKER=true
ENV   CRON_USER=node
ENV   NODE_ENV=production

# Build identity, reported by /diagnostics so a running instance maps to an exact source and image.
ARG   GIT_COMMIT=unknown
ARG   IMAGE_VERSION=unknown
ENV   GIT_COMMIT=${GIT_COMMIT}
ENV   IMAGE_VERSION=${IMAGE_VERSION}
LABEL org.opencontainers.image.revision=${GIT_COMMIT}
LABEL org.opencontainers.image.version=${IMAGE_VERSION}
LABEL org.opencontainers.image.source="https://github.com/Kowts/crontab-ui"

EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Volumes created by earlier releases keep open permissions; tighten them before the services
# start, because production start-up refuses data that group/others can access. Best effort: the
# hardened container drops CAP_FOWNER, and the application then reports any remaining problem.
CMD ["sh", "-c", "chmod -R go-rwx /crontab-ui/crontabs 2>/dev/null; exec supervisord -c /crontab-ui/supervisord.conf"]
