-- Chase — 0001 — schema, extensions and core tables (PLAN §10).
--
-- Lives in the SHARED Supabase project (SundayChess owns `public`, quiz owns
-- `quiz`, turnering owns `turnering`). Everything Chase owns is in `chase`.
--
-- Security model: RLS is ENABLED on every table with NO policies (deny-all for
-- anon/authenticated). Clients never touch tables; Next API routes call
-- security-definer RPCs with the service role (added from 0002 on).
--
-- Privacy model (PLAN §8): no position history is ever stored. The only live
-- position per player is in the UNLOGGED table chase.player_live — it is not
-- written to WAL, so it never reaches replicas or backups — and it is wiped by
-- end_session() (0002+) plus a pg_cron safety net.

create extension if not exists pgcrypto;
create schema if not exists extensions;
-- No-op if PostGIS is already installed (in any schema) in the shared project.
create extension if not exists postgis with schema extensions;

create schema if not exists chase;

-- Unqualified geography/ST_* resolve via extensions (or public, if PostGIS was
-- installed there earlier by another app in the shared project).
set search_path = chase, extensions, public;

-- ───────────────────────── identity & library ─────────────────────────

-- A teacher is just the hash of their "lærernøkkel" (PLAN §0.14). No name, no email.
create table if not exists chase.teachers (
  id            uuid primary key default gen_random_uuid(),
  key_hash      text not null unique,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table if not exists chase.areas (
  id              uuid primary key default gen_random_uuid(),
  teacher_id      uuid not null references chase.teachers(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  boundary        geography(Polygon, 4326) not null,
  forbidden       geography(MultiPolygon, 4326),
  assembly_point  geography(Point, 4326) not null,
  share_code      text unique,
  is_shared       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- "Opplegg": a saved playlist of rounds + settings.
create table if not exists chase.plans (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references chase.teachers(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  rounds      jsonb not null default '[]'::jsonb,
  settings    jsonb not null default '{}'::jsonb,
  share_code  text unique,
  is_shared   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists chase.challenge_packs (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null references chase.teachers(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  items       jsonb not null default '[]'::jsonb,
  share_code  text unique,
  is_shared   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────────── sessions ─────────────────────────────

-- A session snapshots its area + plan so library edits never affect a live game.
create table if not exists chase.sessions (
  id               uuid primary key default gen_random_uuid(),
  join_pin         char(6) not null check (join_pin ~ '^[0-9]{6}$'),
  host_token_hash  text not null,
  teacher_id       uuid references chase.teachers(id) on delete set null,
  boundary         geography(Polygon, 4326) not null,
  forbidden        geography(MultiPolygon, 4326),
  assembly_point   geography(Point, 4326) not null,
  plan             jsonb not null default '{"rounds":[]}'::jsonb,
  settings         jsonb not null default '{}'::jsonb,
  status           text not null default 'lobby'
                   check (status in ('lobby','countdown','live','breather','paused','gathering','ceremony','ended')),
  round_idx        int not null default -1,
  round_started_at timestamptz,
  paused_at        timestamptz,
  pause_accum      interval not null default interval '0',
  teacher_phone    text,   -- wiped by end_session()
  is_sim           boolean not null default false,  -- simulator sessions (PLAN §11)
  created_at       timestamptz not null default now(),
  ended_at         timestamptz
);
-- PINs only need to be unique among sessions that are not over.
create unique index if not exists sessions_active_pin_uq
  on chase.sessions (join_pin) where status <> 'ended';

create table if not exists chase.rounds (
  session_id  uuid not null references chase.sessions(id) on delete cascade,
  idx         int not null check (idx >= 0),
  mode        text not null check (mode in ('free','posts','tag','zone_only','teams','flag')),
  config      jsonb not null default '{}'::jsonb,
  state       jsonb not null default '{}'::jsonb,   -- zone centre, seed, …
  started_at  timestamptz,
  ended_at    timestamptz,
  primary key (session_id, idx)
);

create table if not exists chase.teams (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references chase.sessions(id) on delete cascade,
  name        text not null,
  color       text not null
);

create table if not exists chase.players (
  id                    uuid primary key default gen_random_uuid(),
  session_id            uuid not null references chase.sessions(id) on delete cascade,
  nickname              text not null check (char_length(nickname) between 1 and 20),
  token_hash            text not null unique,
  resume_code_hash      text not null,
  device_id             text,
  team_id               uuid references chase.teams(id) on delete set null,
  role                  text not null default 'neutral'
                        check (role in ('hunter','prey','neutral','sitting_out','referee')),
  catch_code            char(4) check (catch_code ~ '^[0-9]{4}$'),
  catch_code_rotated_at timestamptz,
  immune_until          timestamptz,
  shield_until          timestamptz,
  inventory             jsonb not null default '[]'::jsonb,
  status                text not null default 'active' check (status in ('active','kicked','left')),
  checked_in_at         timestamptz,   -- roll call (opprop)
  joined_at             timestamptz not null default now(),
  last_tick_at          timestamptz
);
create index if not exists players_session_idx on chase.players (session_id);
create unique index if not exists players_nickname_uq
  on chase.players (session_id, lower(nickname)) where status = 'active';

-- The ONLY place a live position exists. UNLOGGED → not in WAL/backups.
create unlogged table if not exists chase.player_live (
  player_id       uuid primary key references chase.players(id) on delete cascade,
  session_id      uuid not null references chase.sessions(id) on delete cascade,
  pos             geography(Point, 4326) not null,
  acc             real not null check (acc >= 0),
  speed           real,
  fix_at          timestamptz not null,
  still_since     timestamptz,
  geofence_state  smallint not null default 0 check (geofence_state between 0 and 3),
  in_forbidden    boolean not null default false,
  in_zone         boolean not null default true
);
create index if not exists player_live_session_idx on chase.player_live (session_id);
create index if not exists player_live_pos_gix on chase.player_live using gist (pos);

create table if not exists chase.player_stats (
  player_id               uuid primary key references chase.players(id) on delete cascade,
  session_id              uuid not null references chase.sessions(id) on delete cascade,
  points                  int not null default 0,
  distance_m              real not null default 0,
  active_s                int not null default 0,
  catches                 int not null default 0,
  assists                 int not null default 0,
  times_caught            int not null default 0,
  longest_survival_s      int not null default 0,
  current_survival_start  timestamptz,
  posts                   int not null default 0,
  cells                   int[] not null default '{}',
  badges                  text[] not null default '{}',
  per_round               jsonb not null default '{}'::jsonb
);
create index if not exists player_stats_session_idx on chase.player_stats (session_id);

create table if not exists chase.posts (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references chase.sessions(id) on delete cascade,
  round_idx   int not null,
  pos         geography(Point, 4326) not null,
  radius_m    real not null default 12 check (radius_m > 0),
  value       int not null default 10,
  kind        text not null default 'normal' check (kind in ('normal','golden','physical_qr','sprint')),
  qr_secret   text,
  spawned_at  timestamptz not null default now(),
  expires_at  timestamptz,
  claimed_by  uuid references chase.players(id) on delete set null,
  claimed_at  timestamptz
);
create index if not exists posts_open_idx
  on chase.posts (session_id, round_idx) where claimed_by is null;
create index if not exists posts_pos_gix on chase.posts using gist (pos);

create table if not exists chase.alarms (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references chase.sessions(id) on delete cascade,
  player_id    uuid references chase.players(id) on delete cascade,
  kind         text not null check (kind in ('sos','forbidden','outside','signal','speed')),
  pos          geography(Point, 4326),   -- nulled by end_session()
  created_at   timestamptz not null default now(),
  acked_at     timestamptz,
  resolved_at  timestamptz
);
create index if not exists alarms_open_idx on chase.alarms (session_id) where resolved_at is null;

-- Audit/event log: catches, claims, overrides, messages. Never coordinates.
create table if not exists chase.events (
  id                bigint generated always as identity primary key,
  session_id        uuid not null references chase.sessions(id) on delete cascade,
  at                timestamptz not null default now(),
  type              text not null,
  actor_player_id   uuid references chase.players(id) on delete set null,
  target_player_id  uuid references chase.players(id) on delete set null,
  payload           jsonb not null default '{}'::jsonb
);
create index if not exists events_session_idx on chase.events (session_id, at);

-- The only thing kept after purge: anonymous aggregates. No names, no geometry.
create table if not exists chase.session_summaries (
  id                 uuid primary key default gen_random_uuid(),
  teacher_id         uuid references chase.teachers(id) on delete set null,
  created_at         timestamptz not null default now(),
  duration_s         int not null,
  player_count       int not null,
  modes              text[] not null default '{}',
  total_distance_m   real not null default 0,
  median_distance_m  real not null default 0,
  median_active_s    int not null default 0,
  active_histogram   jsonb not null default '{}'::jsonb,
  catches_total      int not null default 0
);

-- Geography indexes on library + session geometry.
create index if not exists areas_boundary_gix    on chase.areas    using gist (boundary);
create index if not exists sessions_boundary_gix on chase.sessions using gist (boundary);

-- ───────────────────────────── health ─────────────────────────────

create or replace function chase.health()
returns jsonb
language sql
stable
security definer
set search_path = chase, extensions, public
as $$
  select jsonb_build_object('schema', 'chase', 'postgis', postgis_lib_version());
$$;

-- ───────────────────────────── security ─────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'teachers','areas','plans','challenge_packs','sessions','rounds','teams',
    'players','player_live','player_stats','posts','alarms','events','session_summaries'
  ] loop
    -- ENABLE (not FORCE): security-definer RPCs run as the table owner and
    -- must not be filtered; anon/authenticated have no grants anyway.
    execute format('alter table chase.%I enable row level security', t);
  end loop;
end $$;

-- No usage for anon/authenticated at all: the schema is invisible to clients.
revoke all on schema chase from public;
grant usage on schema chase to service_role;
grant all on all tables in schema chase to service_role;
grant all on all sequences in schema chase to service_role;
revoke execute on all functions in schema chase from public, anon, authenticated;
revoke all on all tables in schema chase from anon, authenticated;
grant execute on all functions in schema chase to service_role;
alter default privileges in schema chase grant all on tables to service_role;
alter default privileges in schema chase grant all on sequences to service_role;
alter default privileges in schema chase revoke execute on functions from public;
alter default privileges in schema chase grant execute on functions to service_role;
