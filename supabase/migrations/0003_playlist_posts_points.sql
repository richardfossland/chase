-- Chase — 0003 — phase 2: playlist (countdown → round → breather → … →
-- automatic gathering), Postjakt (spawn rules, GPS claim, golden posts,
-- physical QR posts), points (posts + movement), per-round stats, badges.
--
-- Session clock (ADR-020)
--   status        countdown → live → breather → countdown → … → live → gathering
--   phase_ends_at when the current phase is over; transitions are applied lazily
--                 by chase._advance() from tick() and host_snapshot() (no cron).
--                 Catch-up is exact: each new phase starts at the previous
--                 phase_ends_at, never at "now".
--   frozen_at     pause and gathering stop the clock; on resume every timer of
--                 the session (phase_ends_at, golden_at, golden expiry) is
--                 shifted by the frozen time.
--   After the last round the session goes to 'gathering' on its own: everybody
--   walks to the assembly point and the teacher only has to press «Avslutt».
--
-- Concurrency: one advisory xact lock per session ('chase:<id>') serialises
-- transitions and post spawning; a tick that cannot get it simply skips that
-- part (the next tick, ~30 ms later at 60 players, does it). Claims are
-- serialised by the post row (`claimed_by is null` in the UPDATE), so a post
-- can never be claimed twice.
--
-- Physical QR posts are session-level cards (round_idx -1, no position). Each
-- player can claim each card once per Postjakt round; the first player in a
-- round gets a bonus. They complement GPS posts and settle claims "uten
-- GPS-tvil" (PLAN §1).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.sessions add column if not exists phase_ends_at     timestamptz;
alter table chase.sessions add column if not exists frozen_at         timestamptz;
alter table chase.sessions add column if not exists pre_gather_status text;

alter table chase.player_live add column if not exists claim_post uuid;
alter table chase.player_live add column if not exists claim_hits smallint not null default 0;

alter table chase.player_stats add column if not exists round_points     int  not null default 0;
alter table chase.player_stats add column if not exists round_posts      int  not null default 0;
alter table chase.player_stats add column if not exists round_distance_m real not null default 0;
alter table chase.player_stats add column if not exists round_active_s   real not null default 0;
alter table chase.player_stats add column if not exists round_move_pts   int  not null default 0;
alter table chase.player_stats add column if not exists round_badges     text[] not null default '{}';
-- Explorer cells are a coarse trace of where a player has been: the array is
-- wiped by end_session(), only the count survives (PLAN §8).
alter table chase.player_stats add column if not exists explorer_n       int  not null default 0;

alter table chase.posts alter column pos drop not null;   -- physical QR cards have no position
alter table chase.posts add column if not exists code text;
alter table chase.posts add column if not exists n    smallint;
create unique index if not exists posts_code_uq on chase.posts (session_id, code) where code is not null;

create table if not exists chase.post_claims (
  post_id    uuid not null references chase.posts(id) on delete cascade,
  player_id  uuid not null references chase.players(id) on delete cascade,
  session_id uuid not null references chase.sessions(id) on delete cascade,
  round_idx  int  not null,
  points     int  not null,
  via        text not null check (via in ('gps', 'qr')),
  at         timestamptz not null default now(),
  primary key (post_id, player_id, round_idx)
);
create index if not exists post_claims_session_idx on chase.post_claims (session_id, round_idx);
alter table chase.post_claims enable row level security;   -- deny-all like every chase table

-- ───────────────────────── tunables ─────────────────────────
-- Game rules (PLAN §3.1, §5). Mirrored in lib/rules/game.ts (test diffs them).

create or replace function chase.kg(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'countdown_s'        then 10    -- default «Gjør deg klar» before each round
    when 'countdown_max_s'    then 30
    when 'breather_s'         then 60    -- default pustepause between rounds
    when 'breather_max_s'     then 300
    when 'round_min_s'        then 60
    when 'round_max_s'        then 1800
    when 'max_rounds'         then 10
    when 'qr_max'             then 12    -- physical QR cards per session
    when 'claim_radius_m'     then 12    -- claim within max(this, acc) …
    when 'claim_max_acc_m'    then 25    -- … but never with a worse fix than this
    when 'claim_hits'         then 2     -- consecutive ticks inside the radius
    when 'players_per_post'   then 4
    when 'posts_min'          then 3
    when 'posts_max'          then 15
    when 'post_min_player_m'  then 25    -- spawn at least this far from any player
    when 'post_min_post_m'    then 30    -- … and from other open posts
    when 'post_edge_m'        then 10    -- … and inside the boundary by this much
    when 'post_forbidden_m'   then 10    -- … and away from forbidden zones
    when 'post_outer_frac'    then 0.6   -- centre→edge fraction that counts as «ytterkant»
    when 'post_value'         then 10
    when 'post_value_outer'   then 20
    when 'golden_value'       then 50
    when 'golden_life_s'      then 60
    when 'golden_from'        then 0.35  -- golden post appears between 35 % …
    when 'golden_to'          then 0.65  -- … and 65 % of the round
    when 'golden_min_round_s' then 120   -- no golden post in shorter rounds
    when 'qr_value'           then 15
    when 'qr_first_bonus'     then 5
    when 'move_m_per_pt'      then 50    -- movement points: +1 per 50 m …
    when 'move_pts_cap'       then 20    -- … at most this many per round
    when 'cell_m'             then 20    -- explorer grid
  end::real;
$$;

-- ───────────────────────── plan ─────────────────────────

-- Validates and normalises a playlist. NULL = invalid.
--   {"rounds":[{"mode":"posts","duration_s":360}, …],
--    "countdown_s":10, "breather_s":60, "qr_posts":0}
create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_rounds jsonb := '[]'::jsonb;
  v_r      jsonb;
  v_mode   text;
  v_dur    numeric;
  v_cd     numeric;
  v_br     numeric;
  v_qr     numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'rounds') <> 'array' then
    return null;
  end if;
  if jsonb_array_length(p -> 'rounds') not between 1 and chase.kg('max_rounds') then
    return null;
  end if;
  for v_r in select * from jsonb_array_elements(p -> 'rounds') loop
    if jsonb_typeof(v_r) <> 'object' or jsonb_typeof(v_r -> 'duration_s') <> 'number' then
      return null;
    end if;
    v_mode := v_r ->> 'mode';
    v_dur  := (v_r ->> 'duration_s')::numeric;
    if v_mode not in ('free', 'posts') or v_dur <> floor(v_dur)
       or v_dur not between chase.kg('round_min_s') and chase.kg('round_max_s') then
      return null;
    end if;
    v_rounds := v_rounds || jsonb_build_object('mode', v_mode, 'duration_s', v_dur::int);
  end loop;

  v_cd := coalesce((p ->> 'countdown_s')::numeric, chase.kg('countdown_s'));
  v_br := coalesce((p ->> 'breather_s')::numeric,  chase.kg('breather_s'));
  v_qr := coalesce((p ->> 'qr_posts')::numeric, 0);
  if v_cd not between 0 and chase.kg('countdown_max_s') or v_cd <> floor(v_cd)
     or v_br not between 0 and chase.kg('breather_max_s') or v_br <> floor(v_br)
     or v_qr not between 0 and chase.kg('qr_max') or v_qr <> floor(v_qr) then
    return null;
  end if;
  return jsonb_build_object('rounds', v_rounds, 'countdown_s', v_cd::int,
                            'breather_s', v_br::int, 'qr_posts', v_qr::int);
exception when others then
  return null;   -- non-numeric strings etc.
end;
$$;

-- What a client needs to draw the round clock. Times are server time.
create or replace function chase._round_view(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when s.round_idx < 0 then null else jsonb_build_object(
    'idx', s.round_idx,
    'count', jsonb_array_length(s.plan -> 'rounds'),
    'mode', s.plan -> 'rounds' -> s.round_idx ->> 'mode',
    'duration_s', (s.plan -> 'rounds' -> s.round_idx ->> 'duration_s')::int,
    'phase_ends_at', s.phase_ends_at,
    'frozen', s.frozen_at is not null,
    'qr', coalesce((s.plan ->> 'qr_posts')::int, 0) > 0,
    'next', s.plan -> 'rounds' -> (s.round_idx + 1)) end;
$$;

-- ───────────────────────── posts ─────────────────────────

create or replace function chase._lock_session(p_session uuid)
returns boolean
language sql
set search_path = chase, extensions, public
as $$
  select pg_try_advisory_xact_lock(hashtextextended('chase:' || p_session::text, 0));
$$;

-- Spawn one GPS post (PLAN §3.1): inside the boundary (by post_edge_m), away
-- from forbidden zones, ≥ 25 m from players with a recent fix and ≥ 30 m from
-- other open posts. Rules are relaxed in that order rather than failing.
-- Value: 10 near the centre, 20 in the outer part; golden = 50 in the outer
-- part, lives 60 s.
create or replace function chase._spawn_post(p_session uuid, p_round int, p_kind text default 'normal')
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s        chase.sessions;
  v_area   geometry;
  v_c      geography;
  v_ring   geography;
  v_pt     geography;
  v_ratio  double precision;
  v_golden boolean := p_kind = 'golden';
  v_id     uuid;
begin
  select * into s from chase.sessions where id = p_session;
  v_area := ST_Buffer(s.boundary, -chase.kg('post_edge_m'))::geometry;
  if s.forbidden is not null and v_area is not null and not ST_IsEmpty(v_area) then
    v_area := ST_Difference(v_area, ST_Buffer(s.forbidden, chase.kg('post_forbidden_m'))::geometry);
  end if;
  if v_area is null or ST_IsEmpty(v_area) or ST_Area(v_area::geography) < 50 then
    v_area := s.boundary::geometry;          -- tiny / mostly forbidden area: fall back
    if s.forbidden is not null then
      v_area := ST_Difference(v_area, s.forbidden::geometry);
    end if;
  end if;
  if v_area is null or ST_IsEmpty(v_area) then
    return null;
  end if;

  v_c := ST_Centroid(s.boundary::geometry)::geography;
  v_ring := ST_ExteriorRing(s.boundary::geometry)::geography;

  select c.pt, c.ratio into v_pt, v_ratio
    from (select d.geom::geography as pt from ST_Dump(ST_GeneratePoints(v_area, 30)) d) g
    cross join lateral (
      select g.pt,
             ST_Distance(g.pt, v_c) / nullif(ST_Distance(g.pt, v_c) + ST_Distance(g.pt, v_ring), 0) as ratio,
             (exists (select 1 from chase.player_live l join chase.players p on p.id = l.player_id
                       where l.session_id = p_session and p.status = 'active'
                         and l.fix_at > now() - interval '30 seconds'
                         and ST_DWithin(l.pos, g.pt, chase.kg('post_min_player_m'))))::int
           + (exists (select 1 from chase.posts o
                       where o.session_id = p_session and o.round_idx = p_round and o.claimed_by is null
                         and o.pos is not null and (o.expires_at is null or o.expires_at > now())
                         and ST_DWithin(o.pos, g.pt, chase.kg('post_min_post_m'))))::int as bad) c
   order by c.bad,
            case when v_golden then (c.ratio < chase.kg('post_outer_frac'))::int else 0 end,
            random()
   limit 1;
  if v_pt is null then
    return null;
  end if;

  insert into chase.posts (session_id, round_idx, pos, radius_m, value, kind, expires_at)
  values (p_session, p_round, v_pt, chase.kg('claim_radius_m'),
          case when v_golden then chase.kg('golden_value')
               when coalesce(v_ratio, 0) >= chase.kg('post_outer_frac') then chase.kg('post_value_outer')
               else chase.kg('post_value') end::int,
          case when v_golden then 'golden' else 'normal' end,
          case when v_golden then now() + make_interval(secs => chase.kg('golden_life_s')) end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Keep the live Postjakt round stocked: drop expired golden posts, top up to
-- ~players/4 open posts (3–15), spawn the golden post when its time comes.
-- Caller holds the session lock. Returns true when a golden post appeared.
create or replace function chase._posts_upkeep(p_session uuid, p_max int default 3)
returns boolean
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s        chase.sessions;
  r        chase.rounds;
  v_target int;
  v_open   int;
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null then
    return false;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.mode is distinct from 'posts' then
    return false;
  end if;

  delete from chase.posts
   where session_id = p_session and round_idx = s.round_idx and claimed_by is null
     and expires_at is not null and expires_at <= now();

  select greatest(chase.kg('posts_min'), least(chase.kg('posts_max'),
           ceil(count(*) / chase.kg('players_per_post'))))::int
    into v_target
    from chase.players p
   where p.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out');
  select count(*) into v_open
    from chase.posts
   where session_id = p_session and round_idx = s.round_idx and claimed_by is null and kind = 'normal';
  for i in 1 .. least(v_target - v_open, p_max) loop
    perform chase._spawn_post(p_session, s.round_idx, 'normal');
  end loop;

  if r.state ? 'golden_at' and not coalesce((r.state ->> 'golden_done')::boolean, false)
     and now() >= (r.state ->> 'golden_at')::timestamptz then
    update chase.rounds set state = state || '{"golden_done":true}'::jsonb
     where session_id = p_session and idx = s.round_idx;
    if chase._spawn_post(p_session, s.round_idx, 'golden') is not null then
      insert into chase.events (session_id, type, payload)
      values (p_session, 'golden', jsonb_build_object('round', s.round_idx));
      return true;
    end if;
  end if;
  return false;
end;
$$;

-- ───────────────────────── round lifecycle ─────────────────────────

create or replace function chase._begin_round(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_round jsonb;
  v_dur   int;
  v_state jsonb := '{}'::jsonb;
begin
  select * into s from chase.sessions where id = p_session;
  v_round := s.plan -> 'rounds' -> s.round_idx;
  v_dur := (v_round ->> 'duration_s')::int;
  if v_round ->> 'mode' = 'posts' and v_dur >= chase.kg('golden_min_round_s') then
    v_state := jsonb_build_object('golden_at', p_at + make_interval(secs =>
      v_dur * (chase.kg('golden_from') + random() * (chase.kg('golden_to') - chase.kg('golden_from')))));
  end if;
  insert into chase.rounds (session_id, idx, mode, config, state, started_at)
  values (p_session, s.round_idx, v_round ->> 'mode', v_round, v_state, p_at)
  on conflict (session_id, idx) do update
    set started_at = excluded.started_at, state = excluded.state, ended_at = null;

  update chase.player_stats
     set round_points = 0, round_posts = 0, round_distance_m = 0, round_active_s = 0,
         round_move_pts = 0, round_badges = '{}'
   where session_id = p_session;
  update chase.player_live set claim_post = null, claim_hits = 0 where session_id = p_session;
  update chase.sessions
     set status = 'live', round_started_at = p_at, live_since = now(),
         phase_ends_at = p_at + make_interval(secs => v_dur)
   where id = p_session;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'round_start', jsonb_build_object('round', s.round_idx, 'mode', v_round ->> 'mode'));
  perform chase._posts_upkeep(p_session, chase.kg('posts_max')::int);
end;
$$;

create or replace function chase._finish_round(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s chase.sessions;
begin
  select * into s from chase.sessions where id = p_session;
  update chase.rounds set ended_at = p_at where session_id = p_session and idx = s.round_idx;
  delete from chase.posts
   where session_id = p_session and round_idx = s.round_idx and claimed_by is null;
  update chase.player_live set claim_post = null, claim_hits = 0 where session_id = p_session;
  update chase.player_stats
     set per_round = per_round || jsonb_build_object(s.round_idx::text, jsonb_build_object(
           'points', round_points, 'posts', round_posts, 'distance_m', round(round_distance_m),
           'active_s', floor(round_active_s), 'move_pts', round_move_pts, 'badges', to_jsonb(round_badges)))
   where session_id = p_session;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'round_end', jsonb_build_object('round', s.round_idx));
end;
$$;

-- Apply every transition that is due, then keep posts stocked. Cheap when
-- nothing is due (one row read + a try-lock). Returns {changed, golden}; the
-- API route turns either into a broadcast hint so all phones tick at once.
create or replace function chase._advance(p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s         chase.sessions;
  v_n       int;
  v_t       timestamptz;
  v_i       int := 0;
  v_changed boolean := false;
  v_golden  boolean := false;
begin
  select * into s from chase.sessions where id = p_session;
  if s.id is null or s.status not in ('countdown', 'live', 'breather') or not chase._lock_session(p_session) then
    return jsonb_build_object('changed', false, 'golden', false);
  end if;

  if s.phase_ends_at is not null and s.phase_ends_at <= now() then
    select * into s from chase.sessions where id = p_session for update;
    v_n := jsonb_array_length(s.plan -> 'rounds');
    while s.status in ('countdown', 'live', 'breather') and s.frozen_at is null
          and s.phase_ends_at is not null and s.phase_ends_at <= now() and v_i < 50 loop
      v_i := v_i + 1;
      v_t := s.phase_ends_at;
      v_changed := true;
      if s.status = 'countdown' then
        perform chase._begin_round(p_session, v_t);
      elsif s.status = 'live' then
        perform chase._finish_round(p_session, v_t);
        if s.round_idx + 1 < v_n then
          update chase.sessions
             set status = 'breather', phase_ends_at = v_t + make_interval(secs => (s.plan ->> 'breather_s')::int)
           where id = p_session;
        else
          -- Playlist done: everybody to the assembly point (roll call), teacher ends.
          update chase.players set checked_in_at = null where session_id = p_session;
          update chase.sessions
             set status = 'gathering', phase_ends_at = null, gather_started_at = now(),
                 pre_gather_status = null, frozen_at = null
           where id = p_session;
          insert into chase.events (session_id, type) values (p_session, 'playlist_done');
        end if;
      else   -- breather → next round's countdown
        update chase.sessions
           set status = 'countdown', round_idx = round_idx + 1,
               phase_ends_at = v_t + make_interval(secs => (s.plan ->> 'countdown_s')::int)
         where id = p_session;
      end if;
      select * into s from chase.sessions where id = p_session;
    end loop;
  end if;

  if s.status = 'live' then
    v_golden := chase._posts_upkeep(p_session);
  end if;
  return jsonb_build_object('changed', v_changed, 'golden', v_golden);
end;
$$;

-- Stop / restart the session clock (pause, gathering).
create or replace function chase._freeze(p_session uuid)
returns void
language sql
set search_path = chase, extensions, public
as $$
  update chase.sessions set frozen_at = coalesce(frozen_at, now()) where id = p_session;
$$;

create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_d interval;
  v_s chase.sessions;
begin
  select * into v_s from chase.sessions where id = p_session;
  if v_s.frozen_at is null then
    return;
  end if;
  v_d := now() - v_s.frozen_at;
  update chase.sessions set phase_ends_at = phase_ends_at + v_d, frozen_at = null where id = p_session;
  update chase.posts set expires_at = expires_at + v_d
   where session_id = p_session and claimed_by is null and expires_at is not null;
  update chase.rounds
     set state = jsonb_set(state, '{golden_at}', to_jsonb((state ->> 'golden_at')::timestamptz + v_d))
   where session_id = p_session and idx = v_s.round_idx and state ? 'golden_at'
     and not coalesce((state ->> 'golden_done')::boolean, false);
end;
$$;

-- ───────────────────────── badges ─────────────────────────
-- «Enkle merker» (PLAN §1 principle 4). Awarded once per session, the moment
-- they are earned; returned to the player in the tick that earned them.
--   first_post  første post          golden   tok en gyllen post
--   posts_5     5 poster i én runde   qr       skannet en fysisk post
--   km_1        1 km totalt           active_10 10 aktive minutter
--   explorer_25 25 ulike ruter (20 × 20 m)
create or replace function chase._award_badges(p_player uuid, p_extra text[] default '{}')
returns text[]
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  st    chase.player_stats;
  v_new text[] := '{}';
  v_b   text;
begin
  select * into st from chase.player_stats where player_id = p_player;
  if st.player_id is null then
    return v_new;
  end if;
  foreach v_b in array p_extra || array[
      case when st.posts >= 1 then 'first_post' end,
      case when st.round_posts >= 5 then 'posts_5' end,
      case when st.distance_m >= 1000 then 'km_1' end,
      case when st.active_s >= 600 then 'active_10' end,
      case when cardinality(st.cells) >= 25 then 'explorer_25' end] loop
    if v_b is not null and not v_b = any(st.badges) and not v_b = any(v_new) then
      v_new := v_new || v_b;
    end if;
  end loop;
  if cardinality(v_new) > 0 then
    update chase.player_stats
       set badges = badges || v_new, round_badges = round_badges || v_new
     where player_id = p_player;
  end if;
  return v_new;
end;
$$;

-- ───────────────────────── create_session ─────────────────────────
-- As 0002, plus playlist validation and physical QR cards.

create or replace function chase.create_session(
  p_host_token_hash  text,
  p_teacher_key_hash text,
  p_boundary         jsonb,
  p_assembly         jsonb,
  p_forbidden        jsonb default null,
  p_plan             jsonb default '{"rounds":[{"mode":"free","duration_s":600}]}'::jsonb,
  p_settings         jsonb default '{}'::jsonb,
  p_teacher_phone    text default null,
  p_is_sim           boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_boundary  geography;
  v_assembly  geography;
  v_forbidden geography;
  v_g         geometry;
  v_teacher   uuid;
  v_pin       text;
  v_id        uuid;
  v_area      double precision;
  v_phone     text;
  v_plan      jsonb;
  v_code      text;
  v_alpha     constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if coalesce(length(p_host_token_hash), 0) < 32 then
    return jsonb_build_object('ok', false, 'error', 'bad_token');
  end if;

  begin
    v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_boundary::text), 4326);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_boundary');
  end;
  if GeometryType(v_g) <> 'POLYGON' or not ST_IsValid(v_g) or ST_NPoints(v_g) > 500 then
    return jsonb_build_object('ok', false, 'error', 'bad_boundary');
  end if;
  v_boundary := v_g::geography;
  v_area := ST_Area(v_boundary);
  -- Hard limits; the wizard warns earlier (PLAN §2.1: ~3 000 m² / ~0.5 km²).
  if v_area < 500 or v_area > 5000000 then
    return jsonb_build_object('ok', false, 'error', 'area_size');
  end if;

  begin
    v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_assembly::text), 4326);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_assembly');
  end;
  if GeometryType(v_g) <> 'POINT' then
    return jsonb_build_object('ok', false, 'error', 'bad_assembly');
  end if;
  v_assembly := v_g::geography;
  if not ST_DWithin(v_boundary, v_assembly, 200) then
    return jsonb_build_object('ok', false, 'error', 'assembly_far');
  end if;

  if p_forbidden is not null and p_forbidden <> 'null'::jsonb then
    begin
      v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_forbidden::text), 4326);
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'bad_forbidden');
    end;
    if GeometryType(v_g) not in ('POLYGON', 'MULTIPOLYGON') or not ST_IsValid(v_g) or ST_NPoints(v_g) > 1000 then
      return jsonb_build_object('ok', false, 'error', 'bad_forbidden');
    end if;
    v_forbidden := ST_Multi(v_g)::geography;
  end if;

  if p_teacher_phone is not null then
    v_phone := regexp_replace(p_teacher_phone, '[\s\-()]', '', 'g');
    if v_phone = '' then
      v_phone := null;
    elsif v_phone !~ '^\+?[0-9]{8,15}$' then
      return jsonb_build_object('ok', false, 'error', 'bad_phone');
    end if;
  end if;

  v_plan := chase._norm_plan(coalesce(p_plan, '{"rounds":[{"mode":"free","duration_s":600}]}'::jsonb));
  if v_plan is null then
    return jsonb_build_object('ok', false, 'error', 'bad_plan');
  end if;

  if p_teacher_key_hash is not null then
    insert into chase.teachers (key_hash) values (p_teacher_key_hash)
    on conflict (key_hash) do update set last_seen_at = now()
    returning id into v_teacher;
  end if;

  -- PIN unique among non-ended sessions; retry on the rare clash.
  for i in 1..30 loop
    v_pin := lpad((floor(random() * 1000000))::int::text, 6, '0');
    begin
      insert into chase.sessions (join_pin, host_token_hash, teacher_id, boundary, forbidden,
                                  assembly_point, plan, settings, teacher_phone, is_sim)
      values (v_pin, p_host_token_hash, v_teacher, v_boundary, v_forbidden,
              v_assembly, v_plan, coalesce(p_settings, '{}'::jsonb),
              v_phone, coalesce(p_is_sim, false))
      returning id into v_id;
      exit;
    exception when unique_violation then
      v_pin := null;
    end;
  end loop;
  if v_id is null then
    raise exception 'chase.create_session: could not allocate a PIN';
  end if;

  -- Physical QR cards: 5 unambiguous characters, unique within the session.
  for i in 1 .. (v_plan ->> 'qr_posts')::int loop
    loop
      select string_agg(substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1), '')
        into v_code from generate_series(1, 5);
      exit when not exists (select 1 from chase.posts where session_id = v_id and code = v_code);
    end loop;
    insert into chase.posts (session_id, round_idx, pos, value, kind, code, n)
    values (v_id, -1, null, chase.kg('qr_value')::int, 'physical_qr', v_code, i);
  end loop;

  insert into chase.events (session_id, type, payload)
  values (v_id, 'session_created', jsonb_build_object('area_m2', round(v_area),
          'rounds', jsonb_array_length(v_plan -> 'rounds'), 'qr_posts', (v_plan ->> 'qr_posts')::int));

  return jsonb_build_object('ok', true, 'session_id', v_id, 'pin', v_pin, 'area_m2', round(v_area));
end;
$$;

-- ───────────────────────── tick ─────────────────────────
-- As 0002, plus: lazy session advance, movement points, explorer cells,
-- GPS post claims, badges, round clock, visible posts, round summary.

create or replace function chase.tick(
  p_player     uuid,
  p_token_hash text,
  p_lat        double precision,
  p_lng        double precision,
  p_acc        real,
  p_speed      real default null,
  p_client_ts  timestamptz default null,
  p_session    uuid default null)   -- the route's session; mismatch = not_found, before any write
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_now        timestamptz := now();
  v_p          chase.players;
  v_s          chase.sessions;
  v_l          chase.player_live;
  v_pos        geography;
  v_acc        real := greatest(coalesce(p_acc, 999), 0);
  v_inside     boolean;
  v_out_m      double precision := 0;
  v_edge_m     double precision;
  v_level      smallint := 0;
  v_out_since  timestamptz;
  v_forbidden  boolean := false;
  v_safety_on  boolean;
  v_alert      boolean := false;
  v_dt         double precision;
  v_seg        double precision;
  v_v          double precision;
  v_add_m      double precision := 0;
  v_add_s      double precision := 0;
  v_good_pos   geography;
  v_good_at    timestamptz;
  v_still_a    geography;
  v_still_s    timestamptz;
  v_st         chase.player_stats;
  v_gather     jsonb;
  v_sos        jsonb;
  v_msgs       jsonb;
  v_adv        jsonb;
  v_mode       text;
  v_playing    boolean;
  v_cap        int := chase.kg('move_pts_cap')::int;
  v_mpp        double precision := chase.kg('move_m_per_pt');
  v_c          geometry;
  v_cell       int;
  v_cand       uuid;
  v_hits       smallint := 0;
  v_cval       int;
  v_ckind      text;
  v_claimed    jsonb;
  v_lost       boolean := false;
  v_badges     text[] := '{}';
  v_posts      jsonb;
  v_summary    jsonb;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'error', 'bad_fix');
  end if;

  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if p_session is not null and v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', v_p.status);   -- 'kicked' | 'left'
  end if;

  select * into v_l from chase.player_live where player_id = p_player;
  -- Retries / reordered requests: never move a player backwards in time.
  if p_client_ts is not null and v_l.last_client_ts is not null and p_client_ts <= v_l.last_client_ts then
    return jsonb_build_object('ok', false, 'error', 'stale', 'server_now', v_now);
  end if;

  v_adv := chase._advance(v_p.session_id);   -- round transitions + post upkeep (lazy, PLAN §9.2)
  select * into v_s from chase.sessions where id = v_p.session_id;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  v_mode := case when v_s.round_idx >= 0 then v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode' end;
  v_playing := v_s.status = 'live' and v_p.role not in ('sitting_out', 'referee');

  v_pos := chase._pt(p_lat, p_lng);

  -- ── safety: geofence (PLAN §7) ──
  v_safety_on := v_s.status <> 'lobby' and v_p.role <> 'referee';
  v_inside := ST_Covers(v_s.boundary, v_pos);
  if v_inside then
    v_edge_m := ST_Distance(v_pos, ST_ExteriorRing(v_s.boundary::geometry)::geography);
    v_level := case when v_edge_m <= chase.k('edge_warn_m') then 1 else 0 end;
  else
    v_out_m := ST_Distance(v_pos, v_s.boundary);
    if v_out_m <= v_acc then
      v_level := 1;                 -- outside but within GPS error: "Nær grensa"
    else
      v_level := 2;
      v_out_since := coalesce(v_l.outside_since, v_now);
      if v_now - v_out_since > make_interval(secs => chase.k('outside_alarm_s'))
         or v_out_m > chase.k('outside_alarm_m') then
        v_level := 3;
      end if;
    end if;
  end if;

  -- Forbidden zones: "possibly inside" — within min(acc, margin) counts (safety first).
  if v_s.forbidden is not null then
    v_forbidden := ST_DWithin(v_pos, v_s.forbidden, least(v_acc, chase.k('forbidden_margin_m')));
  end if;

  if v_safety_on then
    if v_level = 3 then
      v_alert := chase._raise_alarm(v_s.id, p_player, 'outside',
                   case when v_out_m > chase.k('outside_high_m') then 2 else 1 end::smallint, v_pos) or v_alert;
    elsif v_level < 2 then
      perform chase._clear_alarm(p_player, 'outside');
    end if;
    if v_forbidden then
      v_alert := chase._raise_alarm(v_s.id, p_player, 'forbidden', 2::smallint, v_pos) or v_alert;
    else
      perform chase._clear_alarm(p_player, 'forbidden');
    end if;
    perform chase._clear_alarm(p_player, 'signal');   -- a fix just arrived
  end if;

  -- ── movement: distance + active seconds (PLAN §5.1) ──
  v_good_pos := v_l.last_good_pos;
  v_good_at  := v_l.last_good_at;
  if v_acc <= chase.k('good_acc_m') then
    if v_good_pos is null then
      v_good_pos := v_pos; v_good_at := v_now;
    else
      v_dt  := extract(epoch from v_now - v_good_at);
      v_seg := ST_Distance(v_good_pos, v_pos);
      if v_dt > chase.k('segment_reset_s') or v_dt <= 0 then
        v_good_pos := v_pos; v_good_at := v_now;               -- gap: restart, count nothing
      elsif v_seg >= greatest(chase.k('jitter_min_m'), v_acc / 2) then
        v_v := v_seg / v_dt;
        if v_v <= chase.k('max_speed_mps') and v_s.status = 'live' and v_p.role <> 'sitting_out' then
          v_add_m := v_seg;
          if v_v between chase.k('active_min_mps') and chase.k('active_max_mps') then
            v_add_s := v_dt;
          end if;
        end if;
        v_good_pos := v_pos; v_good_at := v_now;               -- glitches move the anchor too
      end if;                                                  -- else: jitter, keep anchor
    end if;
  end if;

  -- Stillness (derived in host_snapshot as now - still_since).
  if v_l.still_anchor is null or ST_Distance(v_l.still_anchor, v_pos) > greatest(chase.k('still_radius_m'), v_acc) then
    v_still_a := v_pos; v_still_s := v_now;
  else
    v_still_a := v_l.still_anchor; v_still_s := v_l.still_since;
  end if;

  -- ── Postjakt: claim = inside max(12 m, acc) on two consecutive ticks (PLAN §3.1) ──
  if v_playing and v_mode = 'posts' and v_acc <= chase.kg('claim_max_acc_m') then
    select o.id into v_cand
      from chase.posts o
     where o.session_id = v_s.id and o.round_idx = v_s.round_idx and o.claimed_by is null
       and o.pos is not null and (o.expires_at is null or o.expires_at > v_now)
       and ST_DWithin(o.pos, v_pos, greatest(o.radius_m, v_acc))
     order by ST_Distance(o.pos, v_pos)
     limit 1;
    if v_cand is not null then
      v_hits := case when v_l.claim_post = v_cand then coalesce(v_l.claim_hits, 0) + 1 else 1 end;
      if v_hits >= chase.kg('claim_hits') then
        update chase.posts set claimed_by = p_player, claimed_at = v_now
         where id = v_cand and claimed_by is null
        returning value, kind into v_cval, v_ckind;
        if v_cval is not null then
          insert into chase.post_claims (post_id, player_id, session_id, round_idx, points, via)
          values (v_cand, p_player, v_s.id, v_s.round_idx, v_cval, 'gps');
          update chase.player_stats
             set points = points + v_cval, round_points = round_points + v_cval,
                 posts = posts + 1, round_posts = round_posts + 1
           where player_id = p_player;
          insert into chase.events (session_id, type, actor_player_id, payload)
          values (v_s.id, 'claim', p_player,
                  jsonb_build_object('post', v_cand, 'value', v_cval, 'kind', v_ckind, 'via', 'gps'));
          v_claimed := jsonb_build_object('post_id', v_cand, 'value', v_cval, 'kind', v_ckind);
          if v_ckind = 'golden' then
            v_badges := v_badges || 'golden'::text;
          end if;
        else
          v_lost := true;            -- someone else got there first
        end if;
        v_cand := null; v_hits := 0;
      end if;
    end if;
  end if;

  insert into chase.player_live as pl (player_id, session_id, pos, acc, speed, fix_at, still_since,
      geofence_state, in_forbidden, in_zone, last_good_pos, last_good_at, still_anchor,
      outside_since, outside_m, last_client_ts, claim_post, claim_hits)
  values (p_player, v_s.id, v_pos, v_acc, p_speed, v_now, v_still_s,
      v_level, v_forbidden, true, v_good_pos, v_good_at, v_still_a,
      case when v_level >= 2 then v_out_since end, v_out_m, p_client_ts, v_cand, v_hits)
  on conflict (player_id) do update set
      pos = excluded.pos, acc = excluded.acc, speed = excluded.speed, fix_at = excluded.fix_at,
      still_since = excluded.still_since, geofence_state = excluded.geofence_state,
      in_forbidden = excluded.in_forbidden, last_good_pos = excluded.last_good_pos,
      last_good_at = excluded.last_good_at, still_anchor = excluded.still_anchor,
      outside_since = excluded.outside_since, outside_m = excluded.outside_m,
      last_client_ts = coalesce(excluded.last_client_ts, pl.last_client_ts),
      claim_post = excluded.claim_post, claim_hits = excluded.claim_hits;

  -- Explorer cell (20 × 20 m, local projection from the area centroid).
  if v_playing and v_acc <= chase.k('good_acc_m') then
    v_c := ST_Centroid(v_s.boundary::geometry);
    v_cell := (floor((p_lng - ST_X(v_c)) * 111320 * cos(radians(ST_Y(v_c))) / chase.kg('cell_m'))::int + 1000) * 10000
            + (floor((p_lat - ST_Y(v_c)) * 111320 / chase.kg('cell_m'))::int + 1000);
  end if;

  -- Movement points: +1 per 50 m in the round, capped (PLAN §3).
  update chase.player_stats
     set distance_m = distance_m + v_add_m,
         active_s = active_s + v_add_s,
         round_distance_m = round_distance_m + v_add_m,
         round_active_s = round_active_s + v_add_s,
         points = points + (least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int) - round_move_pts),
         round_points = round_points + (least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int) - round_move_pts),
         round_move_pts = least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int),
         cells = case when v_cell is null or v_cell = any(cells) then cells else cells || v_cell end
   where player_id = p_player;
  if v_playing then
    v_badges := chase._award_badges(p_player, v_badges);
  end if;
  select * into v_st from chase.player_stats where player_id = p_player;
  update chase.players set last_tick_at = v_now where id = p_player;

  -- ── roll call: auto check-in near the assembly point (PLAN §6) ──
  if v_s.status = 'gathering' then
    if v_p.checked_in_at is null and v_acc <= chase.k('uncertain_acc_m')
       and ST_DWithin(v_pos, v_s.assembly_point, chase.k('gather_radius_m')) then
      update chase.players set checked_in_at = v_now where id = p_player;
      v_p.checked_in_at := v_now;
      insert into chase.events (session_id, type, actor_player_id, payload)
      values (v_s.id, 'check_in', p_player, '{"auto":true}');
    end if;
    v_gather := jsonb_build_object(
      'assembly', chase._latlng(v_s.assembly_point),
      'distance_m', round(ST_Distance(v_pos, v_s.assembly_point)::numeric, 1),
      'checked_in', v_p.checked_in_at is not null);
  end if;

  -- Visible posts: all open posts of the live Postjakt round; never players.
  if v_s.status in ('live', 'paused') and v_mode = 'posts' then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'pos', chase._latlng(o.pos), 'value', o.value,
                                                 'kind', o.kind, 'radius_m', o.radius_m, 'expires_at', o.expires_at)
                              order by o.spawned_at), '[]')
      into v_posts
      from chase.posts o
     where o.session_id = v_s.id and o.round_idx = v_s.round_idx and o.claimed_by is null
       and o.pos is not null and (o.expires_at is null or o.expires_at > v_now);
  end if;

  -- Round summary for the breather (and after the last round).
  -- round_* columns still hold the finished round until the next one goes live.
  if v_s.status in ('breather', 'gathering') and v_s.round_idx >= 0
     and exists (select 1 from chase.rounds r where r.session_id = v_s.id and r.idx = v_s.round_idx
                 and r.ended_at is not null) then
    v_summary := jsonb_build_object(
      'round', v_s.round_idx,
      'points', v_st.round_points, 'posts', v_st.round_posts,
      'distance_m', round(v_st.round_distance_m), 'active_s', floor(v_st.round_active_s),
      'move_pts', v_st.round_move_pts, 'badges', to_jsonb(v_st.round_badges));
  end if;

  -- Show the SOS card until acked, then "Læreren har sett det" for a minute.
  select jsonb_build_object('id', a.id, 'acked', a.acked_at is not null)
    into v_sos from chase.alarms a
   where a.player_id = p_player and a.kind = 'sos'
     and (a.acked_at is null or a.acked_at > v_now - interval '60 seconds')
   order by a.created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'text', e.payload ->> 'text',
                                               'private', e.target_player_id is not null) order by e.at), '[]')
    into v_msgs
    from chase.events e
   where e.session_id = v_s.id and e.type = 'message'
     and e.at > v_now - make_interval(secs => chase.k('message_window_s'))
     and (e.target_player_id is null or e.target_player_id = p_player);

  return jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'session_id', v_s.id,
    'status', v_s.status,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'round', chase._round_view(v_s),
    'role', v_p.role,
    'stats', jsonb_build_object('points', v_st.points, 'distance_m', round(v_st.distance_m::numeric, 1),
                                'active_s', floor(v_st.active_s), 'posts', v_st.posts,
                                'round_points', v_st.round_points, 'badges', to_jsonb(v_st.badges)),
    'posts', v_posts,
    'claim', case when v_cand is not null then jsonb_build_object('post_id', v_cand, 'hits', v_hits,
                                                                  'need', chase.kg('claim_hits')::int) end,
    'claimed', v_claimed,
    'lost', v_lost,
    'new_badges', to_jsonb(v_badges),
    'summary', v_summary,
    'safety', jsonb_build_object('geofence', v_level, 'forbidden', v_forbidden,
                                 'outside_m', round(v_out_m::numeric, 1),
                                 'uncertain', v_acc > chase.k('uncertain_acc_m')),
    'alert_host', v_alert,     -- API route pushes a broadcast hint to the host channel
    'hint_all', (v_adv ->> 'changed')::boolean or (v_adv ->> 'golden')::boolean,
    'sos', v_sos,
    'gather', v_gather,
    'messages', v_msgs);
end;
$$;

-- ───────────────────────── physical QR posts ─────────────────────────

create or replace function chase.claim_qr(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_code       text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p     chase.players;
  v_s     chase.sessions;
  v_post  chase.posts;
  v_code  text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_first boolean;
  v_value int;
  v_new   text[];
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform chase._advance(p_session);
  select * into v_s from chase.sessions where id = p_session;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;

  select * into v_post from chase.posts
   where session_id = p_session and kind = 'physical_qr' and code = v_code;
  if v_post.id is null then
    return jsonb_build_object('ok', false, 'error', 'bad_code');
  end if;
  if v_s.status <> 'live' or v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode' <> 'posts' then
    return jsonb_build_object('ok', false, 'error', 'not_now', 'n', v_post.n);
  end if;
  if v_p.role in ('sitting_out', 'referee') then
    return jsonb_build_object('ok', false, 'error', 'not_playing');
  end if;

  perform 1 from chase.posts where id = v_post.id for update;   -- serialise «first in round»
  v_first := not exists (select 1 from chase.post_claims where post_id = v_post.id and round_idx = v_s.round_idx);
  v_value := v_post.value + case when v_first then chase.kg('qr_first_bonus')::int else 0 end;
  insert into chase.post_claims (post_id, player_id, session_id, round_idx, points, via)
  values (v_post.id, p_player, p_session, v_s.round_idx, v_value, 'qr')
  on conflict do nothing;
  if not found then
    return jsonb_build_object('ok', true, 'already', true, 'n', v_post.n, 'value', 0);
  end if;

  update chase.player_stats
     set points = points + v_value, round_points = round_points + v_value,
         posts = posts + 1, round_posts = round_posts + 1
   where player_id = p_player;
  insert into chase.events (session_id, type, actor_player_id, payload)
  values (p_session, 'claim', p_player,
          jsonb_build_object('post', v_post.id, 'value', v_value, 'kind', 'physical_qr', 'via', 'qr', 'first', v_first));
  v_new := chase._award_badges(p_player, array['qr']);
  return jsonb_build_object('ok', true, 'already', false, 'n', v_post.n, 'value', v_value,
                            'first', v_first, 'new_badges', to_jsonb(v_new));
end;
$$;

-- ───────────────────────── host actions ─────────────────────────
-- As 0002, plus: start runs the playlist (countdown first), next, extend;
-- pause and gathering freeze the session clock.

create or replace function chase.host_action(
  p_session         uuid,
  p_host_token_hash text,
  p_action          text,
  p_payload         jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s      chase.sessions;
  v_pl     jsonb := coalesce(p_payload, '{}'::jsonb);
  v_target uuid;
  v_text   text;
  v_nick   text;
  v_secs   numeric;
  v_prev   text;
begin
  select * into v_s from chase.sessions
   where id = p_session and host_token_hash = p_host_token_hash
   for update;
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;

  if v_pl ? 'player_id' then
    v_target := (v_pl ->> 'player_id')::uuid;
    if not exists (select 1 from chase.players where id = v_target and session_id = p_session) then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
  end if;

  case p_action
  when 'start' then
    if v_s.status <> 'lobby' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions
       set status = 'countdown', round_idx = 0, live_since = now(),
           phase_ends_at = now() + make_interval(secs => (plan ->> 'countdown_s')::int)
     where id = p_session;
    perform chase._advance(p_session);   -- countdown 0 → live at once

  when 'next' then
    -- Skip the rest of the current phase (countdown, round or breather).
    if v_s.status not in ('countdown', 'live', 'breather') then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions set phase_ends_at = now() where id = p_session;
    perform chase._advance(p_session);

  when 'extend' then
    v_secs := coalesce((v_pl ->> 'seconds')::numeric, 60);
    if v_s.status <> 'live' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    if v_secs not between 30 and 900 then
      return jsonb_build_object('ok', false, 'error', 'bad_seconds');
    end if;
    update chase.sessions set phase_ends_at = phase_ends_at + make_interval(secs => v_secs) where id = p_session;

  when 'pause' then
    if v_s.status not in ('live', 'countdown', 'breather', 'gathering') then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    perform chase._freeze(p_session);
    update chase.sessions set pre_pause_status = status, status = 'paused', paused_at = now()
     where id = p_session;

  when 'resume' then
    if v_s.status <> 'paused' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    v_prev := coalesce(v_s.pre_pause_status, 'live');
    update chase.sessions
       set status = v_prev, pre_pause_status = null,
           pause_accum = pause_accum + (now() - paused_at), paused_at = null, live_since = now()
     where id = p_session;
    if v_prev <> 'gathering' then
      perform chase._unfreeze(p_session);
    end if;

  when 'message' then
    v_text := btrim(coalesce(v_pl ->> 'text', ''));
    if char_length(v_text) not between 1 and 200 then
      return jsonb_build_object('ok', false, 'error', 'bad_text');
    end if;
    insert into chase.events (session_id, type, target_player_id, payload)
    values (p_session, 'message', v_target, jsonb_build_object('text', v_text));

  when 'gather' then
    if v_s.status not in ('live', 'countdown', 'breather', 'paused') then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    perform chase._freeze(p_session);
    update chase.players set checked_in_at = null where session_id = p_session;
    update chase.sessions
       set status = 'gathering', gather_started_at = now(),
           pre_gather_status = case when status = 'paused' then coalesce(pre_pause_status, 'live') else status end,
           pre_pause_status = null,
           pause_accum = pause_accum + coalesce(now() - paused_at, interval '0'), paused_at = null
     where id = p_session;

  when 'end_gather' then
    -- After the last round there is nothing to go back to: the teacher ends the session.
    if v_s.status <> 'gathering' or v_s.pre_gather_status is null then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions
       set status = pre_gather_status, pre_gather_status = null, gather_started_at = null, live_since = now()
     where id = p_session;
    perform chase._unfreeze(p_session);

  when 'check_in' then
    if v_target is null then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
    update chase.players
       set checked_in_at = case when coalesce((v_pl ->> 'checked')::boolean, true) then coalesce(checked_in_at, now()) end
     where id = v_target;

  when 'rename' then
    v_nick := btrim(regexp_replace(coalesce(v_pl ->> 'nickname', ''), '\s+', ' ', 'g'));
    if v_target is null or char_length(v_nick) not between 1 and 20 then
      return jsonb_build_object('ok', false, 'error', 'bad_nickname');
    end if;
    begin
      update chase.players set nickname = v_nick where id = v_target;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'nickname_taken');
    end;

  when 'kick' then
    if v_target is null then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
    update chase.players set status = 'kicked' where id = v_target;
    delete from chase.player_live where player_id = v_target;
    update chase.alarms set resolved_at = coalesce(resolved_at, now()), acked_at = coalesce(acked_at, now()), pos = null
     where player_id = v_target;

  when 'sit_out' then
    if v_target is null then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
    update chase.players
       set role = case when coalesce((v_pl ->> 'on')::boolean, true) then 'sitting_out' else 'neutral' end
     where id = v_target;

  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end case;

  -- Audit log. Message text is in its own 'message' event; never coordinates.
  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'host:' || p_action, v_target, v_pl - 'text');

  select * into v_s from chase.sessions where id = p_session;
  return jsonb_build_object('ok', true, 'status', v_s.status, 'round', chase._round_view(v_s), 'server_now', now());
end;
$$;

-- ───────────────────────── host snapshot ─────────────────────────
-- As 0002, plus: lazy advance, round clock, posts of the round, points per
-- round, and the QR cards (only with p_include_geo, for the print sheet).

create or replace function chase.host_snapshot(
  p_session         uuid,
  p_host_token_hash text,
  p_include_geo     boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_now     timestamptz := now();
  v_s       chase.sessions := chase._host_session(p_session, p_host_token_hash);
  v_r       record;
  v_ref     timestamptz;
  v_alert   boolean := false;
  v_players jsonb;
  v_alarms  jsonb;
  v_adv     jsonb := '{"changed":false,"golden":false}'::jsonb;
  v_posts   jsonb;
  v_cards   jsonb;
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  v_adv := chase._advance(p_session);
  select * into v_s from chase.sessions where id = p_session;

  -- Signal loss (PLAN §7): only in an active round; the reference is the last
  -- fix or the moment the game (re)started, whichever is later.
  if v_s.status = 'live' then
    for v_r in
      select p.id, l.fix_at, l.pos
        from chase.players p left join chase.player_live l on l.player_id = p.id
       where p.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out')
    loop
      v_ref := greatest(coalesce(v_r.fix_at, '-infinity'::timestamptz), v_s.live_since);
      if v_now - v_ref > make_interval(secs => chase.k('signal_alarm_s')) then
        v_alert := chase._raise_alarm(p_session, v_r.id, 'signal', 1::smallint, v_r.pos) or v_alert;
      end if;
    end loop;
  end if;

  select coalesce(jsonb_agg(x order by x ->> 'nickname'), '[]') into v_players from (
    select jsonb_build_object(
      'id', p.id, 'nickname', p.nickname, 'role', p.role, 'status', p.status,
      'checked_in', p.checked_in_at is not null,
      'pos', chase._latlng(l.pos),
      'acc', l.acc,
      'fix_age_s', case when l.fix_at is null then null else round(extract(epoch from v_now - l.fix_at)::numeric, 1) end,
      'signal', case
        when l.fix_at is null then 'none'
        when v_now - l.fix_at > make_interval(secs => chase.k('signal_alarm_s')) then 'lost'
        when v_now - l.fix_at > make_interval(secs => chase.k('signal_uncertain_s'))
          or l.acc > chase.k('uncertain_acc_m') then 'uncertain'
        else 'ok' end,
      'geofence', coalesce(l.geofence_state, 0),
      'outside_m', round(coalesce(l.outside_m, 0)::numeric, 1),
      'forbidden', coalesce(l.in_forbidden, false),
      'still_s', case when l.still_since is null then null else floor(extract(epoch from v_now - l.still_since)) end,
      'points', st.points,
      'round_points', st.round_points,
      'posts', st.posts,
      'badges', cardinality(st.badges),
      'distance_m', round(coalesce(st.distance_m, 0)::numeric, 1),
      'active_s', floor(coalesce(st.active_s, 0))) as x
    from chase.players p
    left join chase.player_live l on l.player_id = p.id
    left join chase.player_stats st on st.player_id = p.id
    where p.session_id = p_session and p.status = 'active'
  ) q;

  -- Strip: everything not yet acked, plus acked-but-ongoing; most severe first.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'player_id', a.player_id, 'nickname', p.nickname, 'kind', a.kind, 'level', a.level,
      'pos', chase._latlng(a.pos), 'created_at', a.created_at,
      'acked', a.acked_at is not null, 'resolved', a.resolved_at is not null)
      order by (a.acked_at is not null), array_position(array['sos','forbidden','outside','signal','speed'], a.kind),
               a.level desc, a.created_at), '[]')
    into v_alarms
    from chase.alarms a left join chase.players p on p.id = a.player_id
   where a.session_id = p_session and (a.acked_at is null or a.resolved_at is null);

  if v_s.round_idx >= 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'pos', chase._latlng(o.pos), 'value', o.value,
                                                 'kind', o.kind, 'expires_at', o.expires_at,
                                                 'claimed_by', pc.nickname) order by o.spawned_at), '[]')
      into v_posts
      from chase.posts o left join chase.players pc on pc.id = o.claimed_by
     where o.session_id = p_session and o.round_idx = v_s.round_idx and o.pos is not null
       and (o.claimed_by is not null or o.expires_at is null or o.expires_at > v_now);
  end if;

  if p_include_geo then
    select coalesce(jsonb_agg(jsonb_build_object('n', o.n, 'code', o.code, 'value', o.value) order by o.n), '[]')
      into v_cards
      from chase.posts o where o.session_id = p_session and o.kind = 'physical_qr';
  end if;

  return jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'status', v_s.status,
    'pin', v_s.join_pin,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'round', chase._round_view(v_s),
    'plan', v_s.plan,
    'paused_at', v_s.paused_at,
    'gather_started_at', v_s.gather_started_at,
    'playlist_done', v_s.status = 'gathering' and v_s.pre_gather_status is null and v_s.round_idx >= 0,
    'players', v_players,
    'alarms', v_alarms,
    'posts', v_posts,
    'qr_cards', v_cards,
    'alert_host', v_alert,
    'hint_all', (v_adv ->> 'changed')::boolean or (v_adv ->> 'golden')::boolean,
    'geo', case when p_include_geo then chase._session_geo(v_s) end);
end;
$$;

-- ───────────────────────── end ─────────────────────────
-- As 0002, plus: posts (and their claims) are deleted with the live positions,
-- and the summary's duration counts from the first round.

create or replace function chase._end_session(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s     chase.sessions;
  v_first timestamptz;
begin
  select * into v_s from chase.sessions where id = p_session for update;
  if v_s.id is null or v_s.status = 'ended' then
    return;
  end if;
  select min(started_at) into v_first from chase.rounds where session_id = p_session;

  insert into chase.session_summaries (teacher_id, duration_s, player_count, modes,
      total_distance_m, median_distance_m, median_active_s, active_histogram, catches_total)
  select v_s.teacher_id,
         greatest(0, extract(epoch from now() - coalesce(v_first, now()) - v_s.pause_accum))::int,
         count(p.id),
         coalesce((select array_agg(distinct r.mode) from chase.rounds r where r.session_id = p_session), '{}'),
         coalesce(sum(st.distance_m), 0),
         coalesce(percentile_cont(0.5) within group (order by st.distance_m), 0),
         coalesce(percentile_cont(0.5) within group (order by st.active_s), 0)::int,
         coalesce((select jsonb_object_agg(b, n) from (
             select (floor(st2.active_s / 300) * 5)::int::text as b, count(*) as n
               from chase.player_stats st2 join chase.players p2 on p2.id = st2.player_id
              where st2.session_id = p_session and p2.role <> 'referee'
              group by 1) h), '{}'::jsonb),
         coalesce(sum(st.catches), 0)
    from chase.players p join chase.player_stats st on st.player_id = p.id
   where p.session_id = p_session and p.role <> 'referee' and p.status <> 'kicked';

  delete from chase.player_live where session_id = p_session;
  delete from chase.posts where session_id = p_session;          -- cascades post_claims
  update chase.player_stats set explorer_n = cardinality(cells), cells = '{}' where session_id = p_session;
  update chase.alarms
     set pos = null, resolved_at = coalesce(resolved_at, now())
   where session_id = p_session;
  update chase.sessions
     set status = 'ended', ended_at = now(), teacher_phone = null, paused_at = null,
         phase_ends_at = null, frozen_at = null
   where id = p_session;
  insert into chase.events (session_id, type) values (p_session, 'session_ended');
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on chase.post_claims from public, anon, authenticated;
revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
