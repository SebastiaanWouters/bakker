ARG BAKKER_BASE_IMAGE=bakker-base-local

FROM oven/bun:1-slim AS bun

FROM debian:bookworm-slim AS bakker-base-local

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    locales \
    && curl -fsSL https://repo.mysql.com/RPM-GPG-KEY-mysql-2025 \
      | gpg --dearmor -o /usr/share/keyrings/mysql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/mysql.gpg] http://repo.mysql.com/apt/debian/ bookworm mysql-8.4-lts" \
      > /etc/apt/sources.list.d/mysql.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      mysql-client \
      gzip \
      cron \
      tini \
      jq \
    && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN mkdir -p /app /data/backups /data/config /data/logs
WORKDIR /app

VOLUME ["/data"]
ENV HOST=::
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
EXPOSE 3500

ENTRYPOINT ["tini", "--"]

FROM ${BAKKER_BASE_IMAGE}

WORKDIR /app

# Ensure mysql CLI tooling is present even when using an older prebuilt base image.
RUN if ! command -v mysql >/dev/null 2>&1 || ! command -v mysqldump >/dev/null 2>&1; then \
      apt-get update && apt-get install -y --no-install-recommends mysql-client && rm -rf /var/lib/apt/lists/*; \
    fi

COPY config/ config/
COPY scripts/ scripts/
COPY server/ server/
COPY entrypoint.sh .

RUN chmod +x entrypoint.sh scripts/*.sh

CMD ["/app/entrypoint.sh"]
