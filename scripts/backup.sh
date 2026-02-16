#!/usr/bin/env bash
set -euo pipefail

# Database Backup Script
#
# Usage: backup.sh <config_name>

CONFIG_NAME="${1:-}"
CONFIG_FILE="/data/config/config.json"
BACKUP_DIR="/data/backups"
LOCK_FILE="/tmp/backup-${CONFIG_NAME:-unknown}.lock"

export LANG=C.UTF-8
export LC_ALL=C.UTF-8

log() {
    local msg
    msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
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
STATUS_FILE="/tmp/backup-status-${CONFIG_NAME}.json"
TMP_DUMP_FILE=""
echo "{\"running\":true,\"database\":\"$CONFIG_NAME\",\"pid\":$$,\"started\":\"$(date -Iseconds)\"}" > "$STATUS_FILE"

cleanup_resources() {
    rm -f "$STATUS_FILE"
    if [[ -n "$TMP_DUMP_FILE" ]]; then
        rm -f "$TMP_DUMP_FILE"
    fi
}
trap cleanup_resources EXIT

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
if [[ -z "$DB_HOST" || "$DB_HOST" == "null" ]]; then
    error "Missing db_host for: $CONFIG_NAME"
fi
if [[ -z "$DB_USER" || "$DB_USER" == "null" ]]; then
    error "Missing db_user for: $CONFIG_NAME"
fi

# Get password from env var or API

# First try env var (server-triggered runs pass DB_PASSWORD)
if [[ -n "${DB_PASSWORD:-}" ]]; then
    : # password provided via env
# Otherwise try API (cron jobs)
elif [[ -n "${AUTH_TOKEN:-}" ]]; then
    API_URL="http://localhost:${PORT:-3500}/api/passwords/${CONFIG_NAME}"

    API_RESPONSE=$(curl -fsS --max-time 10 -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL") ||
        error "Failed to fetch password from API. Ensure AUTH_TOKEN is set correctly and password is configured for '$CONFIG_NAME'."
    
    DB_PASSWORD=$(echo "$API_RESPONSE" | jq -r '.password // empty')
    
    if [[ -z "$DB_PASSWORD" ]]; then
        error "Password not found for '$CONFIG_NAME'. Please configure the password via UI."
    fi
else
    error "No password available. Set AUTH_TOKEN for API access or DB_PASSWORD env var."
fi

log "Backup started for '$CONFIG_NAME'"

# Test connection
if ! command -v mysql >/dev/null 2>&1; then
    error "No SQL client found: mysql"
fi

if ! MYSQL_PWD="$DB_PASSWORD" mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --connect-timeout=10 -e 'SELECT 1' "$DB_NAME" > /dev/null 2>&1; then
    error "Failed to connect to database $DB_NAME@$DB_HOST:$DB_PORT"
fi

# Read ignored_tables and structure_only_tables from config
readarray -t IGNORED_TABLES < <(jq -r ".databases.\"${CONFIG_NAME}\".ignored_tables // [] | .[]" "$CONFIG_FILE")
readarray -t STRUCTURE_ONLY_TABLES < <(jq -r ".databases.\"${CONFIG_NAME}\".structure_only_tables // [] | .[]" "$CONFIG_FILE")

is_ignored_table() {
    local candidate="$1"
    local ignored
    for ignored in "${IGNORED_TABLES[@]}"; do
        [[ "$ignored" == "$candidate" ]] && return 0
    done
    return 1
}

# Build --ignore-table flags for the main dump.
# We exclude:
# - ignored tables entirely
# - structure_only tables from the main pass (they are dumped as DDL-only later)
MAIN_IGNORE_FLAGS=()
for table in "${IGNORED_TABLES[@]}"; do
    [[ -n "$table" ]] && MAIN_IGNORE_FLAGS+=("--ignore-table=${DB_NAME}.${table}")
done

for table in "${STRUCTURE_ONLY_TABLES[@]}"; do
    is_ignored_table "$table" && continue
    [[ -n "$table" ]] && MAIN_IGNORE_FLAGS+=("--ignore-table=${DB_NAME}.${table}")
done

# Generate output filename
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
DUMP_FILE="${BACKUP_DIR}/${CONFIG_NAME}_${TIMESTAMP}.sql.gz"
TMP_DUMP_FILE="${DUMP_FILE}.part"
rm -f "$TMP_DUMP_FILE"

if ! command -v mysqldump >/dev/null 2>&1; then
    error "No dump command found: mysqldump"
fi

log "Using dump command: mysqldump"
set +e
(
    set -e

    MYSQL_PWD="$DB_PASSWORD" mysqldump \
        -h "$DB_HOST" \
        -P "$DB_PORT" \
        -u "$DB_USER" \
        "$DB_NAME" \
        --single-transaction \
        --quick \
        --skip-lock-tables \
        --no-tablespaces \
        --extended-insert \
        --disable-keys \
        --max-allowed-packet=512M \
        "${MAIN_IGNORE_FLAGS[@]}"

    # Append schema-only definitions for structure_only tables.
    for table in "${STRUCTURE_ONLY_TABLES[@]}"; do
        is_ignored_table "$table" && continue
        [[ -z "$table" ]] && continue
        MYSQL_PWD="$DB_PASSWORD" mysqldump \
            -h "$DB_HOST" \
            -P "$DB_PORT" \
            -u "$DB_USER" \
            --no-data \
            "$DB_NAME" \
            "$table"
    done
) | gzip > "$TMP_DUMP_FILE"
DUMP_EXIT=$?
set -e

if [[ $DUMP_EXIT -ne 0 ]]; then
    error "Database export failed (exit code: $DUMP_EXIT). Check credentials, network connectivity, and disk space."
fi

mv "$TMP_DUMP_FILE" "$DUMP_FILE"
TMP_DUMP_FILE=""

FILE_SIZE=$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE" 2>/dev/null || echo "0")
FILE_SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $FILE_SIZE / 1024 / 1024}")

# Run cleanup
RETENTION=$(jq -r '.retention // 5' "$CONFIG_FILE")
/app/scripts/cleanup.sh "$CONFIG_NAME" "$RETENTION"

log "Backup completed for '$CONFIG_NAME' (${FILE_SIZE_MB} MB)"
