#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_TS="$(date +%s)"
RUN_ID="bakker-perf-$(date +%s)-$$"
RUN_DIR="$ROOT_DIR/tmp/perf/$RUN_ID"
DATA_DIR="$RUN_DIR/data"
CLI_CONFIG="$RUN_DIR/bakker.config.toml"
NETWORK="${RUN_ID}-net"
SRC_CONTAINER="${RUN_ID}-src"
DST_CONTAINER="${RUN_ID}-dst"
APP_CONTAINER="${RUN_ID}-app"
IMAGE_TAG="${BAKKER_PERF_IMAGE:-bakker:perf-local}"
SKIP_BUILD="${BAKKER_PERF_SKIP_BUILD:-0}"
ROWS="${BAKKER_PERF_ROWS:-200000}"
REPEATS="${BAKKER_PERF_REPEATS:-3}"
LOG_DOWNLOAD_PERF="${BAKKER_PERF_LOG_DOWNLOAD_PERF:-0}"

AUTH_TOKEN="bakker-perf-token"
ENC_SECRET="bakker-perf-secret"

SRC_DB="sourcedb"
DST_DB="restoredb"
SRC_USER="bakker"
SRC_PASS="sourcepass"
DST_USER="bakker"
DST_PASS="destpass"

API_PORT=""
API_URL=""
DST_PORT=""
BACKUP_FILE=""
BACKUP_ID=""
LOCAL_GZ=""
LOCAL_SQL=""
DOWNLOAD_ONLY_GZ=""
SOURCE_SIGNATURE=""
RESULTS_FILE="$RUN_DIR/results.tsv"

log() {
  printf "[perf] %s\n" "$*"
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

now_millis() {
  local ms
  ms="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ms" =~ ^[0-9]+$ ]]; then
    printf '%s' "$ms"
    return
  fi
  printf '%s000' "$(date +%s)"
}

elapsed_millis() {
  local start_ms="$1"
  local end_ms="${2:-}"
  if [[ -z "$end_ms" ]]; then
    end_ms="$(now_millis)"
  fi
  printf '%s' "$((end_ms - start_ms))"
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

  if [[ $status -eq 0 ]]; then
    log "Finished in ${elapsed}s. Results: $RUN_DIR"
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

reset_destination_schema() {
  docker exec -i -e MYSQL_PWD=rootpass "$DST_CONTAINER" mysql -uroot <<SQL
DROP DATABASE IF EXISTS \`$DST_DB\`;
CREATE DATABASE \`$DST_DB\`;
GRANT ALL PRIVILEGES ON \`$DST_DB\`.* TO '$DST_USER'@'%';
FLUSH PRIVILEGES;
SQL
}

compute_signature() {
  local container="$1"
  local user="$2"
  local pass="$3"
  local db="$4"
  docker exec -e MYSQL_PWD="$pass" "$container" mysql -N -u"$user" "$db" -e \
    "SELECT CONCAT(COUNT(*), ':', COALESCE(SUM(id), 0), ':', COALESCE(SUM(CAST(CRC32(payload) AS UNSIGNED)), 0), ':', COALESCE(SUM(CAST(CRC32(meta) AS UNSIGNED)), 0)) FROM bench_payload;"
}

assert_destination_signature() {
  local label="$1"
  local destination_signature
  destination_signature="$(compute_signature "$DST_CONTAINER" "$DST_USER" "$DST_PASS" "$DST_DB")"
  if [[ "$destination_signature" != "$SOURCE_SIGNATURE" ]]; then
    echo "Signature mismatch for $label. expected='$SOURCE_SIGNATURE' got='$destination_signature'" >&2
    exit 1
  fi
}

run_case() {
  local case_name="$1"
  local run_index="$2"
  local log_file="$RUN_DIR/${case_name}-${run_index}.log"
  local started_ms duration_ms

  reset_destination_schema
  started_ms="$(now_millis)"
  case "$case_name" in
    native_sql)
      {
        MYSQL_PWD="$DST_PASS" mysql -h 127.0.0.1 -P "$DST_PORT" -u"$DST_USER" "$DST_DB" < "$LOCAL_SQL"
      } >"$log_file" 2>&1
      ;;
    native_gzip_pipe)
      {
        gunzip -c "$LOCAL_GZ" | MYSQL_PWD="$DST_PASS" mysql -h 127.0.0.1 -P "$DST_PORT" -u"$DST_USER" "$DST_DB"
      } >"$log_file" 2>&1
      ;;
    cli_local_file)
      {
        RESTORE_DB_PASS="$DST_PASS" "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes "$LOCAL_GZ"
      } >"$log_file" 2>&1
      ;;
    cli_id_download)
      {
        RESTORE_DB_PASS="$DST_PASS" BAKKER_AUTH_TOKEN="$AUTH_TOKEN" \
          "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes "$BACKUP_ID"
      } >"$log_file" 2>&1
      ;;
    cli_id_download_skipcheck)
      {
        RESTORE_DB_PASS="$DST_PASS" BAKKER_AUTH_TOKEN="$AUTH_TOKEN" \
          "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes --skip-connectivity-check "$BACKUP_ID"
      } >"$log_file" 2>&1
      ;;
    cli_download_then_import)
      {
        rm -f "$DOWNLOAD_ONLY_GZ"
        BAKKER_AUTH_TOKEN="$AUTH_TOKEN" \
          "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" backup download --force --output "$DOWNLOAD_ONLY_GZ" "$BACKUP_ID"
        RESTORE_DB_PASS="$DST_PASS" \
          "$ROOT_DIR/cli/bakker" --config "$CLI_CONFIG" import --profile restore --yes "$DOWNLOAD_ONLY_GZ"
      } >"$log_file" 2>&1
      ;;
    *)
      echo "Unknown benchmark case: $case_name" >&2
      exit 1
      ;;
  esac

  duration_ms="$(elapsed_millis "$started_ms")"
  assert_destination_signature "$case_name/run-$run_index"
  printf "%s\t%s\t%s\n" "$case_name" "$run_index" "$duration_ms" >>"$RESULTS_FILE"
  log "$case_name run $run_index completed in ${duration_ms}ms"
}

calc_avg_ms() {
  local case_name="$1"
  awk -F'\t' -v n="$case_name" '$1 == n { sum += $3; count += 1 } END { if (count == 0) { print 0 } else { printf "%.2f", sum / count } }' "$RESULTS_FILE"
}

calc_min_ms() {
  local case_name="$1"
  awk -F'\t' -v n="$case_name" '
    $1 == n {
      if (min == 0 || $3 < min) min = $3
    }
    END { print min + 0 }
  ' "$RESULTS_FILE"
}

calc_max_ms() {
  local case_name="$1"
  awk -F'\t' -v n="$case_name" '
    $1 == n {
      if ($3 > max) max = $3
    }
    END { print max + 0 }
  ' "$RESULTS_FILE"
}

calc_overhead_percent() {
  local baseline="$1"
  local candidate="$2"
  awk -v b="$baseline" -v c="$candidate" 'BEGIN { if (b <= 0) { print "n/a" } else { printf "%.2f%%", ((c - b) / b) * 100 } }'
}

require_cmd docker
require_cmd curl
require_cmd jq
require_cmd mysql
require_cmd gunzip
mkdir -p "$DATA_DIR/config" "$DATA_DIR/backups" "$DATA_DIR/logs" "$RUN_DIR"

if [[ ! "$ROWS" =~ ^[0-9]+$ || "$ROWS" -lt 1 ]]; then
  echo "Invalid BAKKER_PERF_ROWS: $ROWS" >&2
  exit 1
fi
if [[ ! "$REPEATS" =~ ^[0-9]+$ || "$REPEATS" -lt 1 ]]; then
  echo "Invalid BAKKER_PERF_REPEATS: $REPEATS" >&2
  exit 1
fi

cat >"$DATA_DIR/config/config.json" <<JSON
{
  "retention": 5,
  "databases": {
    "src": {
      "db_host": "$SRC_CONTAINER",
      "db_port": "3306",
      "db_name": "$SRC_DB",
      "db_user": "$SRC_USER",
      "ignored_tables": [],
      "structure_only_tables": []
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
  log "Skipping image build; using '$IMAGE_TAG'."
else
  log "Building image '$IMAGE_TAG'."
  docker build -t "$IMAGE_TAG" "$ROOT_DIR" >/dev/null
fi

log "Creating network $NETWORK"
docker network create "$NETWORK" >/dev/null

log "Starting MySQL source and destination containers"
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

wait_for_mysql "$SRC_CONTAINER" "rootpass"
wait_for_mysql "$DST_CONTAINER" "rootpass"

DST_PORT="$(docker port "$DST_CONTAINER" 3306/tcp | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
if [[ -z "$DST_PORT" ]]; then
  echo "Failed to resolve mapped destination DB port." >&2
  exit 1
fi

log "Seeding source dataset with ${ROWS} rows"
docker exec -i -e MYSQL_PWD=rootpass "$SRC_CONTAINER" mysql -uroot "$SRC_DB" <<SQL
CREATE TABLE bench_payload (
  id INT PRIMARY KEY,
  payload LONGTEXT NOT NULL,
  meta LONGTEXT NOT NULL
);
SET @row := 0;
INSERT INTO bench_payload (id, payload, meta)
SELECT seq,
       CONCAT('payload-', seq, '-Fitzpatrick''s-', CHAR(92), 'path-', LPAD(seq, 8, '0')),
       JSON_OBJECT('seq', seq, 'nested', JSON_OBJECT('escaped', CONCAT('line1', CHAR(92), 'nline2')))
FROM (
  SELECT @row := @row + 1 AS seq
  FROM information_schema.COLUMNS c1
  CROSS JOIN information_schema.COLUMNS c2
  LIMIT $ROWS
) src_rows;
SQL

docker exec -i -e MYSQL_PWD=rootpass "$SRC_CONTAINER" mysql -uroot <<'SQL'
GRANT ALL PRIVILEGES ON sourcedb.* TO 'bakker'@'%';
FLUSH PRIVILEGES;
SQL

SOURCE_SIGNATURE="$(compute_signature "$SRC_CONTAINER" "$SRC_USER" "$SRC_PASS" "$SRC_DB")"
if [[ -z "$SOURCE_SIGNATURE" ]]; then
  echo "Failed to compute source signature." >&2
  exit 1
fi

log "Starting Bakker API container"
docker run -d --name "$APP_CONTAINER" --network "$NETWORK" -p 127.0.0.1::3500 \
  -e AUTH_TOKEN="$AUTH_TOKEN" \
  -e ENCRYPTION_SECRET="$ENC_SECRET" \
  -e HOST=0.0.0.0 \
  -e PORT=3500 \
  -e LOG_DOWNLOAD_PERF="$LOG_DOWNLOAD_PERF" \
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

if ! wait_for_api; then
  echo "Bakker API did not become ready." >&2
  exit 1
fi

api_post_json "/api/passwords/src" "{\"password\":\"$SRC_PASS\"}" >/dev/null
api_post_json "/api/backups/trigger" '{"database":"src"}' >/dev/null
IFS=$'\t' read -r BACKUP_FILE BACKUP_ID < <(wait_for_backup)

LOCAL_GZ="$RUN_DIR/$BACKUP_FILE"
LOCAL_SQL="$RUN_DIR/${BACKUP_FILE%.gz}"
DOWNLOAD_ONLY_GZ="$RUN_DIR/download-only-${BACKUP_FILE}"
ENCODED_BACKUP_FILE="$(printf '%s' "$BACKUP_FILE" | jq -sRr @uri)"
curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" "$API_URL/api/backups/$ENCODED_BACKUP_FILE" -o "$LOCAL_GZ"
gunzip -c "$LOCAL_GZ" >"$LOCAL_SQL"

echo -e "case\trun\tms" >"$RESULTS_FILE"

for run_index in $(seq 1 "$REPEATS"); do
  run_case "native_sql" "$run_index"
  run_case "native_gzip_pipe" "$run_index"
  run_case "cli_local_file" "$run_index"
  run_case "cli_id_download" "$run_index"
  run_case "cli_id_download_skipcheck" "$run_index"
  run_case "cli_download_then_import" "$run_index"
done

native_sql_avg="$(calc_avg_ms native_sql)"
native_gzip_avg="$(calc_avg_ms native_gzip_pipe)"
cli_local_avg="$(calc_avg_ms cli_local_file)"
cli_id_avg="$(calc_avg_ms cli_id_download)"
cli_id_skipcheck_avg="$(calc_avg_ms cli_id_download_skipcheck)"
cli_download_then_import_avg="$(calc_avg_ms cli_download_then_import)"

printf "\nBenchmark summary (%s rows, %s runs each)\n" "$ROWS" "$REPEATS"
printf "%-20s %12s %12s %12s\n" "CASE" "AVG_MS" "MIN_MS" "MAX_MS"
for case_name in native_sql native_gzip_pipe cli_local_file cli_id_download cli_id_download_skipcheck cli_download_then_import; do
  printf "%-20s %12s %12s %12s\n" \
    "$case_name" \
    "$(calc_avg_ms "$case_name")" \
    "$(calc_min_ms "$case_name")" \
    "$(calc_max_ms "$case_name")"
done

printf "\nOverhead vs native_gzip_pipe:\n"
printf "cli_local_file: %s\n" "$(calc_overhead_percent "$native_gzip_avg" "$cli_local_avg")"
printf "cli_id_download: %s\n" "$(calc_overhead_percent "$native_gzip_avg" "$cli_id_avg")"
printf "cli_id_download_skipcheck: %s\n" "$(calc_overhead_percent "$native_gzip_avg" "$cli_id_skipcheck_avg")"
printf "cli_download_then_import: %s\n" "$(calc_overhead_percent "$native_gzip_avg" "$cli_download_then_import_avg")"

printf "\nInitial bottleneck hint:\n"
awk -v ng="$native_gzip_avg" -v cl="$cli_local_avg" -v ci="$cli_id_avg" -v cis="$cli_id_skipcheck_avg" -v cdi="$cli_download_then_import_avg" '
  BEGIN {
    if (ng <= 0) {
      print "- insufficient data to infer bottleneck"
      exit
    }
    if (cl <= ng * 1.10) {
      print "- CLI local-file path is near native gzip->mysql; destination DB/storage likely dominates."
    } else {
      print "- CLI local-file path is materially slower than native; import pipeline overhead is significant."
    }
    if (ci > cl * 1.20) {
      print "- API download path adds notable overhead; investigate web/network throughput."
    } else {
      print "- API download overhead is modest relative to local CLI path."
    }
    if (cis < ci * 0.95) {
      print "- Connectivity preflight check is measurable; use --skip-connectivity-check when you need lowest startup latency."
    } else {
      print "- Connectivity preflight check overhead is small relative to total import time."
    }
    if (cdi > ci * 1.10) {
      print "- Download-then-import is notably slower than streaming import by ID; prefer direct streaming unless local archive retention is required."
    } else {
      print "- Download-then-import is close to direct streaming; choose based on operational preference."
    }
  }
'

printf "\nRaw results saved to %s\n" "$RESULTS_FILE"
