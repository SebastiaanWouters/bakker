#!/usr/bin/env bash
set -euo pipefail

# Database Backup Script
#
# Usage: backup.sh <config_name>

CONFIG_NAME="${1:-}"
CONFIG_FILE="/data/config/config.json"
BACKUP_DIR="/data/backups"
LOG_FILE="/data/logs/backup.log"
LOCK_FILE="/tmp/backup-${CONFIG_NAME:-unknown}.lock"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE"
}

error() {
    log "ERROR: $*"
    exit 1
}

if [[ -z "$CONFIG_NAME" ]]; then
    error "Usage: backup.sh <config_name>"
fi

# Acquire lock (prevent overlapping runs)
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    error "Another backup is already running (lock: $LOCK_FILE)"
fi

# Write status file for the API
STATUS_FILE="/tmp/backup-status.json"
echo "{\"running\":true,\"database\":\"$CONFIG_NAME\",\"started\":\"$(date -Iseconds)\"}" > "$STATUS_FILE"

cleanup_status() {
    echo '{"running":false}' > "$STATUS_FILE"
}
trap cleanup_status EXIT

# Read config
if [[ ! -f "$CONFIG_FILE" ]]; then
    error "Config file not found: $CONFIG_FILE"
fi

DB_HOST=$(jq -r ".databases.\"${CONFIG_NAME}\".db_host" "$CONFIG_FILE")
DB_PORT=$(jq -r ".databases.\"${CONFIG_NAME}\".db_port // \"3306\"" "$CONFIG_FILE")
DB_NAME=$(jq -r ".databases.\"${CONFIG_NAME}\".db_name" "$CONFIG_FILE")
DB_USER=$(jq -r ".databases.\"${CONFIG_NAME}\".db_user" "$CONFIG_FILE")

if [[ -z "$DB_NAME" || "$DB_NAME" == "null" ]]; then
    error "No database config found for: $CONFIG_NAME"
fi

# Get password from environment variable: config name -> DB_PASS_UPPERCASE_NAME
PASSWORD_VAR="DB_PASS_$(echo "$CONFIG_NAME" | tr '[:lower:]' '[:upper:]')"
DB_PASSWORD="${!PASSWORD_VAR:-}"

if [[ -z "$DB_PASSWORD" ]]; then
    error "Password not set. Please set $PASSWORD_VAR environment variable."
fi

# Test connection
log "Testing database connection to $DB_HOST:$DB_PORT as $DB_USER..."
if ! MYSQL_PWD="$DB_PASSWORD" mariadb -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --connect-timeout=10 -e 'SELECT 1' "$DB_NAME" > /dev/null 2>&1; then
    error "Failed to connect to database $DB_NAME@$DB_HOST:$DB_PORT"
fi
log "Connection successful"

# Read ignored_tables and structure_only_tables from config
readarray -t IGNORED_TABLES < <(jq -r ".databases.\"${CONFIG_NAME}\".ignored_tables // [] | .[]" "$CONFIG_FILE")
readarray -t STRUCTURE_ONLY_TABLES < <(jq -r ".databases.\"${CONFIG_NAME}\".structure_only_tables // [] | .[]" "$CONFIG_FILE")

# Build --ignore-table flags (completely excluded tables)
IGNORE_FLAGS=()
for table in "${IGNORED_TABLES[@]}"; do
    [[ -n "$table" ]] && IGNORE_FLAGS+=("--ignore-table=${DB_NAME}.${table}")
done

# Build --ignore-table-data flags (structure only, no data)
for table in "${STRUCTURE_ONLY_TABLES[@]}"; do
    [[ -n "$table" ]] && IGNORE_FLAGS+=("--ignore-table-data=${DB_NAME}.${table}")
done

# Generate output filename
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
DUMP_FILE="${BACKUP_DIR}/${CONFIG_NAME}_${TIMESTAMP}.sql.gz"

log "Starting export to: $DUMP_FILE (${#IGNORED_TABLES[@]} ignored, ${#STRUCTURE_ONLY_TABLES[@]} structure-only)"

# Execute mariadb-dump
MYSQL_PWD="$DB_PASSWORD" mariadb-dump \
    -h "$DB_HOST" \
    -P "$DB_PORT" \
    -u "$DB_USER" \
    "$DB_NAME" \
    --single-transaction \
    --skip-lock-tables \
    --no-tablespaces \
    --extended-insert \
    --disable-keys \
    --max-allowed-packet=512M \
    "${IGNORE_FLAGS[@]}" \
    | gzip > "$DUMP_FILE"

DUMP_EXIT=${PIPESTATUS[0]}
if [[ $DUMP_EXIT -ne 0 ]]; then
    rm -f "$DUMP_FILE"
    error "Database export failed (exit code: $DUMP_EXIT). Check credentials, network connectivity, and disk space."
fi

FILE_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE" 2>/dev/null || echo "0")
FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1024 / 1024}")
log "Export completed: $DUMP_FILE (${FILE_SIZE_MB} MB)"

# Run cleanup
log "Running retention cleanup..."
RETENTION=$(jq -r '.retention // 5' "$CONFIG_FILE")
/app/scripts/cleanup.sh "$CONFIG_NAME" "$RETENTION"

log "Backup completed successfully"
