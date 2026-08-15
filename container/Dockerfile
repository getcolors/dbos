# syntax=docker/dockerfile:1
FROM node:24.6.0-bookworm AS app-build
WORKDIR /app
COPY application/package.json application/package-lock.json ./
RUN npm ci
COPY application/tsconfig.json ./
COPY application/src ./src
RUN npm run build && npm prune --omit=dev

FROM postgres:17.6-bookworm
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli ca-certificates curl gzip libcap2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1000 --home /app --shell /usr/sbin/nologin dbos
COPY --from=app-build /usr/local/bin/node /usr/local/bin/node
COPY --from=app-build /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=app-build /app /app
COPY container/entrypoint container/backup /usr/local/bin/
RUN chmod 0755 /usr/local/bin/entrypoint /usr/local/bin/backup \
 && setcap cap_net_bind_service=+ep /usr/local/bin/node \
 && mkdir -p /storage /app && chown -R postgres:postgres /storage && chown -R dbos:dbos /app
ENV PGDATA=/storage/postgres
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=12 CMD curl -fsS http://127.0.0.1/up || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint"]
