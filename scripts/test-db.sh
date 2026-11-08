#!/usr/bin/env bash
# DB test harness: ephemeral PostGIS in Docker, apply every migration (twice,
# to prove idempotency), then run SQL assertions in test/sql/*.sql.
#
#   ./scripts/test-db.sh
#
# Requires Docker. Uses the pinned Supabase Postgres image (ADR-012): the same
# Postgres 17 + PostGIS 3.3.7 + pg_cron as the shared production project, native
# on arm64 and amd64. Migrations and tests run as the non-superuser `postgres`
# role, like in Supabase. Tears the container down on exit.
set -euo pipefail

CONTAINER="chase-testdb"
PORT=55443
PW=postgres
IMG="${CHASE_TEST_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.106}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG="$ROOT/supabase/migrations"
TESTS="$ROOT/test/sql"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "Starting ephemeral Supabase Postgres ($IMG) on :$PORT …"
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD="$PW" -p "$PORT:5432" "$IMG" >/dev/null

# -h 127.0.0.1: the image's temporary init server listens on the unix socket
# only, so TCP succeeds just once the real server is up.
PSQL() { docker exec -i -e PGPASSWORD="$PW" "$CONTAINER" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
# Migrations: hide "already exists, skipping" notices; tests keep their NOTICEs.
PSQL_QUIET() { docker exec -i -e PGPASSWORD="$PW" -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" psql -h 127.0.0.1 -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

echo "Waiting for Postgres …"
for i in $(seq 1 240); do
  # service_role exists once Supabase's init scripts have run.
  if [ "$(PSQL -Atc "select count(*) from pg_roles where rolname = 'service_role'" 2>/dev/null)" = "1" ]; then break; fi
  sleep 0.5
  if [ "$i" -eq 240 ]; then echo "Postgres did not come up"; docker logs "$CONTAINER" | tail -20; exit 1; fi
done

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
