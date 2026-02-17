#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_TS="$(date +%s)"
RUN_ID="bakker-e2e-$(date +%s)-$$"
RUN_DIR="$ROOT_DIR/tmp/e2e/$RUN_ID"
DATA_DIR="$RUN_DIR/data"
CLI_CONFIG="$RUN_DIR/bakker.config.toml"
NETWORK="${RUN_ID}-net"
SRC_CONTAINER="${RUN_ID}-src"
DST_CONTAINER="${RUN_ID}-dst"
APP_CONTAINER="${RUN_ID}-app"
IMAGE_TAG="${BAKKER_E2E_IMAGE:-bakker:e2e-local}"
SKIP_BUILD="${BAKKER_E2E_SKIP_BUILD:-0}"
MAX_SECONDS="${BAKKER_E2E_MAX_SECONDS:-0}"
AUTH_TOKEN="bakker-e2e-token"
ENC_SECRET="bakker-e2e-secret"

SRC_DB="sourcedb"
DST_DB="restoredb"
SRC_USER="bakker"
SRC_PASS="sourcepass"
DST_USER="bakker"
DST_PASS="destpass"

API_PORT=""
API_URL=""
DST_PORT=""

log() {
  printf "[e2e] %s\n" "$*"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

container_exists() {
  local name="$1"
  docker ps -a --format "{{.Names}}" | grep -Fx "$name" >/dev/null 2>&1
}

cleanup() {
  local status=$?
  local end_ts elapsed
  end_ts="$(date +%s)"
  elapsed=$((end_ts - START_TS))

  if [[ $status -ne 0 ]]; then
    log "Failure detected, collecting diagnostic logs."
    if container_exists "$APP_CONTAINER"; then
      docker logs "$APP_CONTAINER" 2>/dev/null || true
      docker exec "$APP_CONTAINER" sh -lc 'tail -n 200 /data/logs/backup.log' 2>/dev/null || true
    fi
  fi

  docker rm -f "$APP_CONTAINER" "$SRC_CONTAINER" "$DST_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR"

  if [[ "$MAX_SECONDS" =~ ^[0-9]+$ ]] && [[ "$MAX_SECONDS" -gt 0 ]] && [[ "$elapsed" -gt "$MAX_SECONDS" ]]; then
    echo "E2E runtime exceeded limit: ${elapsed}s > ${MAX_SECONDS}s" >&2
    status=1
  fi

  if [[ $status -eq 0 ]]; then
    log "Cleanup complete (${elapsed}s)."
  fi

  exit "$status"
}
trap cleanup EXIT

wait_for_mysql() {
  local container="$1"
  local password="$2"
  local tries=120

  for _ in $(seq 1 "$tries"); do
    if docker exec -e MYSQL_PWD="$password" "$container" mysqladmin ping -uroot --silent >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "MySQL container did not become ready: $container" >&2
  return 1
}

wait_for_api() {
  local tries=120
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

api_post_json() {
  local path="$1"
  local body="$2"
  curl -fsS -X POST \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "$API_URL$path"
}

api_get() {
  local path="$1"
  curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL$path"
}

wait_for_backup() {
  local tries=180
  local json backup_file backup_id

  for _ in $(seq 1 "$tries"); do
    json="$(api_get "/api/backups")"
    backup_file="$(jq -r '.src[0].filename // empty' <<<"$json")"
    backup_id="$(jq -r '.src[0].id // empty' <<<"$json")"
    if [[ -n "$backup_file" && -n "$backup_id" ]]; then
      printf "%s\t%s\n" "$backup_file" "$backup_id"
      return 0
    fi
    sleep 1
  done

  echo "Backup artifact did not appear via API." >&2
  return 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "Assertion failed for $label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_contains() {
  local needle="$1"
  local haystack_file="$2"
  local label="$3"
  if ! grep -Fq "$needle" "$haystack_file"; then
    echo "Assertion failed for $label: expected to find '$needle' in $haystack_file" >&2
    exit 1
  fi
}

assert_not_contains() {
  local needle="$1"
  local haystack_file="$2"
  local label="$3"
  if grep -Fq "$needle" "$haystack_file"; then
    echo "Assertion failed for $label: did not expect to find '$needle' in $haystack_file" >&2
    exit 1
  fi
}

require_cmd docker
require_cmd curl
require_cmd jq
require_cmd mysql
require_cmd gunzip
mkdir -p "$DATA_DIR/config" "$DATA_DIR/backups" "$DATA_DIR/logs"

cat >"$DATA_DIR/config/config.json" <<JSON
{
  "retention": 5,
  "databases": {
    "src": {
      "db_host": "$SRC_CONTAINER",
      "db_port": "3306",
      "db_name": "$SRC_DB",
      "db_user": "$SRC_USER",
      "ignored_tables": ["ignored_table"],
      "structure_only_tables": ["structure_only"]
    }
  },
  "schedules": []
}
JSON

cat >"$CLI_CONFIG" <<TOML
[bakker]
api_url = "__API_URL__"
timeout_seconds = 60

[defaults]
output = "table"
confirm_import = false

[profiles.restore]
host = "127.0.0.1"
port = __DST_PORT__
user = "$DST_USER"
database = "$DST_DB"
TOML

if [[ "$SKIP_BUILD" == "1" ]]; then
  log "Skipping image build; expecting image '$IMAGE_TAG' to exist locally or be pullable by Docker."
else
  log "Building local Bakker image ($IMAGE_TAG)."
  docker build -t "$IMAGE_TAG" "$ROOT_DIR" >/dev/null
fi

log "Creating isolated Docker network: $NETWORK"
docker network create "$NETWORK" >/dev/null

log "Starting MySQL source and destination containers."
docker run -d --name "$SRC_CONTAINER" --network "$NETWORK" \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE="$SRC_DB" \
  -e MYSQL_USER="$SRC_USER" \
  -e MYSQL_PASSWORD="$SRC_PASS" \
  -e MYSQL_INITDB_SKIP_TZINFO=1 \
  mysql:8.4 --local-infile=ON >/dev/null

docker run -d --name "$DST_CONTAINER" --network "$NETWORK" \
  -p 127.0.0.1::3306 \
  -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE="$DST_DB" \
  -e MYSQL_USER="$DST_USER" \
  -e MYSQL_PASSWORD="$DST_PASS" \
  -e MYSQL_INITDB_SKIP_TZINFO=1 \
  mysql:8.4 --local-infile=ON >/dev/null

log "Waiting for MySQL readiness."
wait_for_mysql "$SRC_CONTAINER" "rootpass"
wait_for_mysql "$DST_CONTAINER" "rootpass"

DST_PORT="$(docker port "$DST_CONTAINER" 3306/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [[ -z "$DST_PORT" ]]; then
  echo "Failed to resolve mapped destination DB port." >&2
  exit 1
fi

log "Seeding source database."
docker exec -i -e MYSQL_PWD=rootpass "$SRC_CONTAINER" mysql -uroot "$SRC_DB" <<'SQL'
CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100));
INSERT INTO users VALUES (1,'alice'),(2,'bob'),(3,'carol');
CREATE TABLE ignored_table (id INT PRIMARY KEY, note VARCHAR(100));
INSERT INTO ignored_table VALUES (1,'skip-me'),(2,'skip-me-too');
CREATE TABLE structure_only (id INT PRIMARY KEY, payload VARCHAR(100));
INSERT INTO structure_only VALUES (1,'row1'),(2,'row2');
CREATE TABLE sql_edge_cases (
  id INT PRIMARY KEY,
  label VARCHAR(64) NOT NULL,
  payload LONGTEXT NOT NULL,
  meta_json LONGTEXT NOT NULL
);
INSERT INTO sql_edge_cases (id, label, payload, meta_json) VALUES
  (1, 'apostrophe', 'Fitzpatrick''s Atlas and Synopsis of Clinical Dermatology', '{"uid":"c94a931f-9499-4f6b-8d4b-94b7d3350eaa","value":"O''Reilly","autoAdded":false}'),
  (2, 'backslashes', CONCAT('Windows path C:', CHAR(92), 'Users', CHAR(92), 'alice', CHAR(92), 'dump.sql.gz'), CONCAT('{"path":"C:', CHAR(92), CHAR(92), 'Users', CHAR(92), CHAR(92), 'alice", "regex":"^', CHAR(92), CHAR(92), 'd+$"}')),
  (3, 'multiline', CONCAT('line one', CHAR(10), 'line two', CHAR(13), CHAR(10), 'line three'), CONCAT('{"note":"line1', CHAR(92), 'nline2", "tab":"a', CHAR(92), 'tb"}')),
  (4, 'sqlish', 'semicolon ; comment -- block /*like this*/ and commas, parentheses ()', '{"sql":"INSERT INTO t VALUES (1,''x''); -- not executable"}'),
  (5, 'json_blob', '[{"uid":"16c2ae05-f37c-45ca-b9de-e03cf85242a9","value":"5d07f844-cb37-4311-8ff6-8d1693b49026","autoAdded":false},{"uid":"a2885c57-8e2b-4e4f-ab0c-4a13907f6431","value":"Escapes: \\"double\\", ''single'', and backslash \\\\","autoAdded":false}]', '{"kind":"array","valid":true}');
SQL
SOURCE_EDGE_HASH="$(docker exec -e MYSQL_PWD=rootpass "$SRC_CONTAINER" mysql -N -uroot "$SRC_DB" -e "SET SESSION group_concat_max_len=1048576; SELECT SHA2(GROUP_CONCAT(CONCAT(id,'|',label,'|',HEX(payload),'|',HEX(meta_json)) ORDER BY id SEPARATOR '#'), 256) FROM sql_edge_cases;")"
if [[ -z "$SOURCE_EDGE_HASH" ]]; then
  echo "Failed to compute source edge-case hash." >&2
  exit 1
fi

log "Granting source schema privileges for backup user."
docker exec -i -e MYSQL_PWD=rootpass "$SRC_CONTAINER" mysql -uroot <<'SQL'
GRANT ALL PRIVILEGES ON sourcedb.* TO 'bakker'@'%';
FLUSH PRIVILEGES;
SQL

log "Starting Bakker container."
docker run -d --name "$APP_CONTAINER" --network "$NETWORK" -p 127.0.0.1::3500 \
  -e AUTH_TOKEN="$AUTH_TOKEN" \
  -e ENCRYPTION_SECRET="$ENC_SECRET" \
  -e HOST=0.0.0.0 \
  -e PORT=3500 \
  -v "$DATA_DIR:/data" \
  "$IMAGE_TAG" >/dev/null

API_PORT="$(docker port "$APP_CONTAINER" 3500/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [[ -z "$API_PORT" ]]; then
  echo "Failed to resolve mapped API port." >&2
  exit 1
fi
API_URL="http://127.0.0.1:$API_PORT"

sed -i "s|__API_URL__|$API_URL|g" "$CLI_CONFIG"
sed -i "s|__DST_PORT__|$DST_PORT|g" "$CLI_CONFIG"

log "Waiting for Bakker API readiness on $API_URL."
if ! wait_for_api; then
  echo "Bakker API did not become ready." >&2
  exit 1
fi

log "Configuring source DB password in Bakker."
api_post_json "/api/passwords/src" "{\"password\":\"$SRC_PASS\"}" >/dev/null

log "Triggering backup."
api_post_json "/api/backups/trigger" '{"database":"src"}' >/dev/null

log "Waiting for backup artifact."
IFS=$'\t' read -r BACKUP_FILE BACKUP_ID < <(wait_for_backup)

if [[ ! -f "$DATA_DIR/backups/$BACKUP_FILE" ]]; then
  echo "Backup file missing on disk: $DATA_DIR/backups/$BACKUP_FILE" >&2
  exit 1
fi

if [[ "$BACKUP_FILE" != *.sql.gz ]]; then
  echo "Unexpected backup extension: $BACKUP_FILE" >&2
  exit 1
fi

log "Listing backups via CLI."
BAKKER_AUTH_TOKEN="$AUTH_TOKEN" "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" backup list

log "Importing backup by ID via CLI (default heartbeat cadence)."
IMPORT_DEFAULT_LOG="$RUN_DIR/import-default.log"
RESTORE_DB_PASS="$DST_PASS" BAKKER_AUTH_TOKEN="$AUTH_TOKEN" \
  "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes "$BACKUP_ID" \
  2>&1 | tee "$IMPORT_DEFAULT_LOG"
assert_contains "Import progress updates enabled (every 30s)." "$IMPORT_DEFAULT_LOG" "default import heartbeat cadence"
assert_not_contains "ERROR 1064" "$IMPORT_DEFAULT_LOG" "default import SQL syntax error"

log "Resetting destination schema before verbose import validation."
docker exec -i -e MYSQL_PWD=rootpass "$DST_CONTAINER" mysql -uroot <<SQL
DROP DATABASE IF EXISTS \`$DST_DB\`;
CREATE DATABASE \`$DST_DB\`;
GRANT ALL PRIVILEGES ON \`$DST_DB\`.* TO '$DST_USER'@'%';
FLUSH PRIVILEGES;
SQL

log "Enabling NO_BACKSLASH_ESCAPES globally on destination to stress SQL import parsing."
docker exec -e MYSQL_PWD=rootpass "$DST_CONTAINER" mysql -N -uroot -e "SET GLOBAL sql_mode = CONCAT_WS(',', @@GLOBAL.sql_mode, 'NO_BACKSLASH_ESCAPES');"

log "Re-importing backup with -vvv heartbeat cadence."
IMPORT_VERBOSE_LOG="$RUN_DIR/import-verbose.log"
RESTORE_DB_PASS="$DST_PASS" BAKKER_AUTH_TOKEN="$AUTH_TOKEN" \
  "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" -vvv import --profile restore --yes "$BACKUP_ID" \
  2>&1 | tee "$IMPORT_VERBOSE_LOG"
assert_contains "Import progress updates enabled (every 3s)." "$IMPORT_VERBOSE_LOG" "verbose import heartbeat cadence"
assert_not_contains "awk: " "$IMPORT_VERBOSE_LOG" "verbose import parser errors"
assert_not_contains "ERROR 1064" "$IMPORT_VERBOSE_LOG" "verbose import SQL syntax error"

log "Validating restore results."
USERS_COUNT="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SELECT COUNT(*) FROM users;")"
STRUCT_EXISTS="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DST_DB' AND table_name='structure_only';")"
STRUCT_ROWS="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SELECT COUNT(*) FROM structure_only;")"
IGNORED_EXISTS="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DST_DB' AND table_name='ignored_table';")"
EDGE_ROWS="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SELECT COUNT(*) FROM sql_edge_cases;")"
EDGE_HASH="$(docker exec -e MYSQL_PWD="$DST_PASS" "$DST_CONTAINER" mysql -N -u"$DST_USER" "$DST_DB" -e "SET SESSION group_concat_max_len=1048576; SELECT SHA2(GROUP_CONCAT(CONCAT(id,'|',label,'|',HEX(payload),'|',HEX(meta_json)) ORDER BY id SEPARATOR '#'), 256) FROM sql_edge_cases;")"

assert_eq "3" "$USERS_COUNT" "users row count"
assert_eq "1" "$STRUCT_EXISTS" "structure_only table exists"
assert_eq "0" "$STRUCT_ROWS" "structure_only row count"
assert_eq "0" "$IGNORED_EXISTS" "ignored_table exists"
assert_eq "5" "$EDGE_ROWS" "sql_edge_cases row count"
assert_eq "$SOURCE_EDGE_HASH" "$EDGE_HASH" "sql_edge_cases content hash"

log "Verifying clean Ctrl+C cancellation behavior during import."
INTERRUPT_SQL="$RUN_DIR/interrupt-large.sql"
INTERRUPT_SQL_GZ="$RUN_DIR/interrupt-large.sql.gz"
INTERRUPT_LOG="$RUN_DIR/import-interrupt.log"

: >"$INTERRUPT_SQL"
echo "DROP TABLE IF EXISTS interrupt_probe;" >>"$INTERRUPT_SQL"
echo "CREATE TABLE interrupt_probe (id INT PRIMARY KEY, payload VARCHAR(255));" >>"$INTERRUPT_SQL"
awk 'BEGIN { for (i=1; i<=600000; i++) printf "INSERT INTO interrupt_probe (id, payload) VALUES (%d,\047payload-%d\047);\n", i, i; }' >>"$INTERRUPT_SQL"
gzip -c "$INTERRUPT_SQL" >"$INTERRUPT_SQL_GZ"

set +e
RESTORE_DB_PASS="$DST_PASS" timeout --signal=INT --kill-after=5s 2s \
  "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes "$INTERRUPT_SQL_GZ" \
  >"$INTERRUPT_LOG" 2>&1
INTERRUPT_STATUS=$?
set -e

if [[ "$INTERRUPT_STATUS" -eq 0 ]]; then
  echo "Expected interrupted import to exit non-zero." >&2
  cat "$INTERRUPT_LOG" >&2
  exit 1
fi
assert_contains "Import interrupted; stopping active transfer..." "$INTERRUPT_LOG" "interrupt notice"
assert_contains "Import cancelled." "$INTERRUPT_LOG" "interrupt completion"
assert_not_contains "ERROR 1064" "$INTERRUPT_LOG" "interrupt SQL syntax noise"

log "PASS - backup/import e2e is working."
log "backup_file=$BACKUP_FILE backup_id=$BACKUP_ID users=$USERS_COUNT structure_only_rows=$STRUCT_ROWS ignored_exists=$IGNORED_EXISTS edge_rows=$EDGE_ROWS"
