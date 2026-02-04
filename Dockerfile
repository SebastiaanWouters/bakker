FROM oven/bun:1-slim AS bun

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    mariadb-client \
    gzip \
    cron \
    curl \
    ca-certificates \
    tini \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN mkdir -p /app /data/backups /data/config /data/logs
WORKDIR /app

COPY config/ config/
COPY scripts/ scripts/
COPY server/ server/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh scripts/*.sh

VOLUME ["/data"]
EXPOSE 3500

ENTRYPOINT ["tini", "--"]
CMD ["/app/entrypoint.sh"]
