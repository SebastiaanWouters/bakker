#!/usr/bin/env bash
set -euo pipefail

# Database backup retention cleanup
# Keeps last N backups per config name
#
# Usage: cleanup.sh <config_name> [retention_count]

CONFIG_NAME="${1:-}"
RETENTION="${2:-5}"
BACKUP_DIR="/data/backups"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] CLEANUP: $*"
    echo "$msg"
}

if [[ -z "$CONFIG_NAME" ]]; then
    echo "Usage: cleanup.sh <config_name> [retention_count]"
    exit 1
fi

PATTERN="${CONFIG_NAME}_[0-9]*.mysqlsh.tgz"

# Find matching files, sorted by name (timestamp in filename ensures chronological order)
mapfile -t FILES < <(find "$BACKUP_DIR" -maxdepth 1 -name "$PATTERN" -type f | sort)

TOTAL=${#FILES[@]}

if [[ $TOTAL -le $RETENTION ]]; then
    log "Retention OK: $TOTAL backups found for ${CONFIG_NAME} (limit: $RETENTION)"
    exit 0
fi

DELETE_COUNT=$((TOTAL - RETENTION))
log "Cleaning up: $TOTAL backups found for ${CONFIG_NAME}, keeping $RETENTION, deleting $DELETE_COUNT"

for ((i = 0; i < DELETE_COUNT; i++)); do
    FILE="${FILES[$i]}"
    log "Deleting: $(basename "$FILE")"
    rm -f "$FILE"
done

log "Cleanup complete for ${CONFIG_NAME}"
