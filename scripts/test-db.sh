#!/usr/bin/env bash
# DB test harness: ephemeral PostGIS in Docker, apply every migration (twice,
# to prove idempotency), then run SQL assertions in test/sql/*.sql.
#
#   ./scripts/test-db.sh
#
# Requires Docker. Uses postgis/postgis (Postgres 17 + PostGIS 3.5, like
# Supabase). Tears the container down on exit.
set -euo pipefail

CONTAINER="chase-testdb"
PORT=55443
PW=postgres
IMG="${CHASE_TEST_IMAGE:-postgis/postgis:17-3.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG="$ROOT/supabase/migrations"
TESTS="$ROOT/test/sql"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "Starting ephemeral PostGIS ($IMG) on :$PORT …"
# postgis/postgis ships amd64 only; on Apple Silicon run it under emulation.
PLATFORM_ARGS=()
if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then PLATFORM_ARGS=(--platform linux/amd64); fi
docker run -d "${PLATFORM_ARGS[@]}" --name "$CONTAINER" -e POSTGRES_PASSWORD="$PW" -p "$PORT:5432" "$IMG" >/dev/null

# -h 127.0.0.1: the image's temporary init server listens on the unix socket
# only, so TCP succeeds just once the real server is up.
PSQL() { docker exec -i "$CONTAINER" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
# Migrations: hide "already exists, skipping" notices; tests keep their NOTICEs.
PSQL_QUIET() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

echo "Waiting for Postgres …"
for i in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U postgres -d postgres -c 'select postgis_lib_version()' >/dev/null 2>&1; then break; fi
  sleep 0.5
  if [ "$i" -eq 120 ]; then echo "Postgres did not come up"; docker logs "$CONTAINER" | tail -20; exit 1; fi
done

# Supabase roles the migrations grant to.
PSQL <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
SQL

shopt -s nullglob
migrations=("$MIG"/*.sql)
echo "Applying ${#migrations[@]} migration(s) …"
for f in "${migrations[@]}"; do echo "  - $(basename "$f")"; PSQL_QUIET < "$f" >/dev/null; done
echo "Re-applying (idempotency) …"
for f in "${migrations[@]}"; do PSQL_QUIET < "$f" >/dev/null; done

tests=("$TESTS"/*.sql)
echo "Running ${#tests[@]} SQL test file(s) …"
for f in "${tests[@]}"; do
  echo "  - $(basename "$f")"
  if ! out="$(PSQL < "$f" 2>&1)"; then
    echo "$out"; echo "FAILED: $(basename "$f")"; exit 1
  fi
  echo "$out" | grep -v "truncate cascades" || true
done

echo "DB TEST GREEN"
