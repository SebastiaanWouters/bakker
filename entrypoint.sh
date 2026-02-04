#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="/data/config/config.json"
DEFAULT_CONFIG="/app/config/default.json"
LOG_DIR="/data/logs"
LOG_FILE="$LOG_DIR/backup.log"
STATUS_PATTERN="/tmp/backup-status-*.json"

echo "[entrypoint] Starting DB Backup service..."

# Ensure directories exist
mkdir -p /data/backups /data/config "$LOG_DIR"

# Initialize config from default if not present
if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[entrypoint] No config found, copying default..."
    cp "$DEFAULT_CONFIG" "$CONFIG_FILE"
fi

# Initialize log file
touch "$LOG_FILE"

# Clear any stale status files
rm -f $STATUS_PATTERN

# Generate crontab from config
generate_crontab() {
    {
        echo "# DB Backup - auto-generated, do not edit manually"
        echo "SHELL=/bin/bash"
        echo "PATH=/usr/local/bin:/usr/bin:/bin"
        echo ""

        # Pass AUTH_TOKEN for backup script to retrieve passwords
        if [[ -n "${AUTH_TOKEN:-}" ]]; then
            echo "AUTH_TOKEN=$AUTH_TOKEN"
        fi
        echo "PORT=${PORT:-3500}"
        echo ""

        # Generate a cron line for each schedule entry
        local schedule_count
        schedule_count=$(jq -r '.schedules | length' "$CONFIG_FILE" 2>/dev/null || echo "0")

        for ((i = 0; i < schedule_count; i++)); do
            local db cron_expr
            db=$(jq -r ".schedules[$i].database" "$CONFIG_FILE")
            cron_expr=$(jq -r ".schedules[$i].cron" "$CONFIG_FILE")
            if [[ -n "$db" && "$db" != "null" && -n "$cron_expr" && "$cron_expr" != "null" ]]; then
                echo "$cron_expr root /app/scripts/backup.sh $db >> $LOG_FILE 2>&1"
            fi
        done
        echo "" # trailing newline required by cron
    } > /etc/cron.d/db-backup

    chmod 0644 /etc/cron.d/db-backup
    echo "[entrypoint] Crontab generated at /etc/cron.d/db-backup"
}

generate_crontab

# Start cron daemon in background
echo "[entrypoint] Starting cron daemon..."
cron

# Start Bun server in foreground
echo "[entrypoint] Starting web server on port ${PORT:-3500}..."
if [[ "${DEV:-0}" == "1" ]]; then
    exec bun --watch /app/server/index.ts
else
    exec bun run /app/server/index.ts
fi
