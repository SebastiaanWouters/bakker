#!/usr/bin/env bash
set -euo pipefail

CONFIG_FILE="/data/config/config.json"
DEFAULT_CONFIG="/app/config/default.json"
LOG_DIR="/data/logs"
LOG_FILE="$LOG_DIR/backup.log"
STATUS_FILE="/tmp/backup-status.json"

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

# Initialize status file
echo '{"running":false}' > "$STATUS_FILE"

# Generate crontab from config
generate_crontab() {
    {
        echo "# DB Backup - auto-generated, do not edit manually"
        echo "SHELL=/bin/bash"
        echo "PATH=/usr/local/bin:/usr/bin:/bin"
        echo ""

        # Pass through all DB_PASS_* env vars dynamically
        env | grep '^DB_PASS_' || true
        echo ""

        # Generate a cron line for each schedule entry
        local schedule_count
        schedule_count=$(jq -r '.schedules | length' "$CONFIG_FILE" 2>/dev/null || echo "0")

        for ((i = 0; i < schedule_count; i++)); do
            local db cron_expr
            db=$(jq -r ".schedules[$i].database" "$CONFIG_FILE")
            cron_expr=$(jq -r ".schedules[$i].cron" "$CONFIG_FILE")
            if [[ -n "$db" && "$db" != "null" && -n "$cron_expr" && "$cron_expr" != "null" ]]; then
                echo "$cron_expr root flock -n /tmp/backup-${db}.lock /app/scripts/backup.sh $db >> $LOG_FILE 2>&1"
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
exec bun run /app/server/index.ts
