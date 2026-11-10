-- Chase — 0004 — phase 3, part 1: Smittejakt (PLAN §3.2).
--
--   * Round mode 'tag' with variant 'convert' (smitte: the caught one becomes a
--     hunter; the round ends when nobody is left) or 'swap' (sisten: hunter and
--     prey swap roles; the hunter count is constant).
--   * Roles are dealt at round start: ~15 % hunters (at least 1), the rest prey.
--     Every player carries a 4-digit catch code, unique in the session, rotated
--     after every catch and at every round start (cannot be passed around).
--   * chase.catch(): the hunter scans the prey's QR (or types the code). Server
--     checks roles, live round, distance ≤ min(50, max(30, accA + accB)),
--     immunity and the code. +15 to the hunter, +5 assist to other hunters near
--     the prey in the last 10 s, 20 s immunity for whoever just became prey.
--   * Prey: +1 per 5 s survived. Convert: survivors at round end (or the very
--     last prey converted) get +25.
--   * Visibility engine: hunters get radar pings of prey every 30 s (10 s for a
--     prey standing still > 15 s, skipped when running > 2 m/s = «stealth»),
--     and «Bytte i nærheten» under 30 m. Prey get a warning ring when a hunter
--     is within 60 m, never a point.
--   * Mode hooks: _mode_begin / _mode_finish / _mode_upkeep / _mode_tick are the
--     extension points for later modes (shrinking zone in part 2) so tick()
--     does not have to be copied again.

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.players add column if not exists role_changed_at timestamptz;
alter table chase.player_live add column if not exists ping_pos     geography(Point, 4326);
alter table chase.player_live add column if not exists ping_at      timestamptz;
alter table chase.player_live add column if not exists ping_stealth boolean not null default false;
alter table chase.player_stats add column if not exists surv_pts_stint int not null default 0;

-- ───────────────────────── tunables ─────────────────────────
-- Smittejakt rules (PLAN §3.2, §1). Mirrored in lib/rules/tag.ts (test diffs them).

create or replace function chase.kt(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'hunters_frac'      then 0.15
    when 'catch_min_m'       then 30    -- catch distance: max(this, accA + accB) …
    when 'catch_max_m'       then 50    -- … capped here
    when 'near_m'            then 30    -- hunter sees «Bytte i nærheten»
    when 'danger_m'          then 60    -- prey sees the warning ring
    when 'immune_s'          then 20    -- after a role change to prey (no tag-back)
    when 'catch_pts'         then 15
    when 'assist_pts'        then 5
    when 'assist_m'          then 30
    when 'assist_s'          then 10
    when 'survive_every_s'   then 5     -- prey: +1 per this many seconds
    when 'survivor_pts'      then 25    -- convert: last survivors
    when 'ping_s'            then 30    -- radar ping interval
    when 'ping_still_s'      then 10    -- … for a prey standing still
    when 'still_ping_after_s' then 15
    when 'stealth_mps'       then 2     -- running faster skips a ping
    when 'fix_fresh_s'       then 20    -- positions older than this do not count
  end::real;
$$;

-- ───────────────────────── catch codes ─────────────────────────

create or replace function chase._new_catch_code(p_session uuid)
returns text
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_code text;
begin
  for i in 1..200 loop
    v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (select 1 from chase.players where session_id = p_session and catch_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- ───────────────────────── mode hooks ─────────────────────────

create or replace function chase._round_mode(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select s.plan -> 'rounds' -> s.round_idx from chase.sessions s where s.id = p_session and s.round_idx >= 0;
$$;

-- Round start: deal roles + fresh codes for Smittejakt, neutral otherwise.
create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_round jsonb := chase._round_mode(p_session);
  v_n     int;
  v_h     int;
begin
  update chase.player_live set ping_pos = null, ping_at = null, ping_stealth = false where session_id = p_session;
  update chase.player_stats set current_survival_start = null, surv_pts_stint = 0 where session_id = p_session;
  if v_round ->> 'mode' is distinct from 'tag' then
    update chase.players set role = 'neutral', immune_until = null
     where session_id = p_session and status = 'active' and role in ('hunter', 'prey');
    return;
  end if;

  select count(*) into v_n from chase.players
   where session_id = p_session and status = 'active' and role not in ('sitting_out', 'referee');
  v_h := greatest(1, round(v_n * chase.kt('hunters_frac')))::int;

  -- Distinct codes for everyone in one go (birthday clashes at 60 players are likely otherwise).
  with p as (
    select id, row_number() over (order by random()) as rn from chase.players
     where session_id = p_session and status = 'active' and role not in ('sitting_out', 'referee')),
  c as (
    select lpad(x::text, 4, '0') as code, row_number() over () as rn
      from (select x from generate_series(0, 9999) x order by random() limit (select count(*) from p)) q)
  update chase.players pl
     set role = case when p.rn <= v_h then 'hunter' else 'prey' end,
         catch_code = c.code, catch_code_rotated_at = p_at, immune_until = null, role_changed_at = p_at
    from p join c using (rn)
   where pl.id = p.id;

  update chase.player_stats st set current_survival_start = p_at, surv_pts_stint = 0
    from chase.players p
   where p.id = st.player_id and p.session_id = p_session and p.role = 'prey';
  insert into chase.events (session_id, type, payload)
  values (p_session, 'tag_roles', jsonb_build_object('hunters', v_h, 'players', v_n, 'variant', v_round ->> 'variant'));
end;
$$;

-- Round end: survival bookkeeping, convert survivors +25, roles back to neutral.
create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_round jsonb := chase._round_mode(p_session);
  v_id    uuid;
begin
  if v_round ->> 'mode' is distinct from 'tag' then
    return;
  end if;
  update chase.player_stats st
     set longest_survival_s = greatest(longest_survival_s, extract(epoch from p_at - current_survival_start)::int),
         current_survival_start = null, surv_pts_stint = 0
    from chase.players p
   where p.id = st.player_id and p.session_id = p_session and p.role = 'prey' and st.current_survival_start is not null;
  if v_round ->> 'variant' = 'convert' then
    for v_id in select id from chase.players where session_id = p_session and role = 'prey' and status = 'active' loop
      update chase.player_stats
         set points = points + chase.kt('survivor_pts')::int, round_points = round_points + chase.kt('survivor_pts')::int
       where player_id = v_id;
      perform chase._award_badges(v_id, array['survivor']);
    end loop;
  end if;
  update chase.players set role = 'neutral', immune_until = null
   where session_id = p_session and role in ('hunter', 'prey');
end;
$$;

-- Every advance (under the session lock): radar pings for the live Smittejakt round.
create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if chase._round_mode(p_session) ->> 'mode' is distinct from 'tag' then
    return;
  end if;
  update chase.player_live l
     set ping_stealth = coalesce(l.speed, 0) > chase.kt('stealth_mps'),
         ping_pos = case when coalesce(l.speed, 0) > chase.kt('stealth_mps') then l.ping_pos else l.pos end,
         ping_at = now()
    from chase.players p
   where p.id = l.player_id and l.session_id = p_session and p.role = 'prey' and p.status = 'active'
     and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
     and (l.ping_at is null or now() - l.ping_at >= make_interval(secs =>
           case when l.still_since < now() - make_interval(secs => chase.kt('still_ping_after_s'))
                then chase.kt('ping_still_s') else chase.kt('ping_s') end));
end;
$$;

-- Per-tick mode layer: survival points + what this player may see (PLAN §9.3:
-- visibility is decided here, the client never gets more).
create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s     chase.sessions;
  v_p     chase.players;
  v_round jsonb := chase._round_mode(p_session);
  v_n     int;
  v_view  jsonb;
begin
  if v_round ->> 'mode' is distinct from 'tag' then
    return '{}'::jsonb;
  end if;
  select * into v_s from chase.sessions where id = p_session;
  select * into v_p from chase.players where id = p_player;

  if v_s.status = 'live' and v_p.role = 'prey' then
    update chase.player_stats st
       set points = points + (floor(extract(epoch from now() - current_survival_start) / chase.kt('survive_every_s'))::int - surv_pts_stint),
           round_points = round_points + (floor(extract(epoch from now() - current_survival_start) / chase.kt('survive_every_s'))::int - surv_pts_stint),
           surv_pts_stint = floor(extract(epoch from now() - current_survival_start) / chase.kt('survive_every_s'))::int
     where player_id = p_player and current_survival_start is not null;
  end if;

  v_view := jsonb_build_object(
    'variant', v_round ->> 'variant',
    'code', case when v_p.role in ('prey', 'hunter') then v_p.catch_code end,
    'immune_until', case when v_p.immune_until > now() then v_p.immune_until end,
    'role_changed_at', v_p.role_changed_at,
    'hunters', (select count(*) from chase.players where session_id = p_session and role = 'hunter' and status = 'active'),
    'prey', (select count(*) from chase.players where session_id = p_session and role = 'prey' and status = 'active'));

  if v_s.status in ('live', 'paused') and v_p.role = 'hunter' then
    select count(*) into v_n
      from chase.player_live l join chase.players p on p.id = l.player_id
     where l.session_id = p_session and p.role = 'prey' and p.status = 'active'
       and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
       and ST_DWithin(l.pos, p_pos, chase.kt('near_m'));
    v_view := v_view || jsonb_build_object(
      'prey_near', v_n,
      'radar', (select coalesce(jsonb_agg(jsonb_build_object('pos', chase._latlng(l.ping_pos),
                                 'age_s', floor(extract(epoch from now() - l.ping_at)),
                                 'stealth', l.ping_stealth) order by l.ping_at desc), '[]')
                  from chase.player_live l join chase.players p on p.id = l.player_id
                 where l.session_id = p_session and p.role = 'prey' and p.status = 'active' and l.ping_pos is not null));
  elsif v_s.status in ('live', 'paused') and v_p.role = 'prey' then
    v_view := v_view || jsonb_build_object('hunter_near', exists (
      select 1 from chase.player_live l join chase.players p on p.id = l.player_id
       where l.session_id = p_session and p.role = 'hunter' and p.status = 'active'
         and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
         and ST_DWithin(l.pos, p_pos, chase.kt('danger_m'))));
  end if;
  return jsonb_build_object('tag', v_view);
end;
$$;

-- ───────────────────────── catch ─────────────────────────

create or replace function chase.catch(
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
  v_h      chase.players;
  v_prey   chase.players;
  v_s      chase.sessions;
  v_round  jsonb;
  v_hl     chase.player_live;
  v_pl     chase.player_live;
  v_code   text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
  v_dist   double precision;
  v_limit  double precision;
  v_assist int := 0;
  v_last   boolean := false;
  v_new    text[];
  v_fail   text;
begin
  select * into v_h from chase.players where id = p_player and token_hash = p_token_hash;
  if v_h.id is null or v_h.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_h.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  -- Catches in one session are serialised by their own lock (no double catch,
  -- exact «last prey»). Taken before any row lock; tick() never takes it, so
  -- the row-lock order tick uses (player → session) cannot deadlock with this.
  perform pg_advisory_xact_lock(hashtextextended('chase-catch:' || p_session::text, 0));
  perform chase._advance(p_session);
  select * into v_s from chase.sessions where id = p_session;
  v_round := chase._round_mode(p_session);
  select * into v_h from chase.players where id = p_player for update;

  if v_s.status <> 'live' or v_round ->> 'mode' is distinct from 'tag' then
    v_fail := 'not_now';
  elsif v_h.role <> 'hunter' then
    v_fail := 'not_hunter';
  elsif length(v_code) <> 4 then
    v_fail := 'bad_code';
  end if;
  if v_fail is null then
    select * into v_prey from chase.players
     where session_id = p_session and catch_code = v_code and status = 'active' and id <> p_player
     for update;
    if v_prey.id is null or v_prey.role <> 'prey' then
      v_fail := 'bad_code';
    elsif v_prey.immune_until > now() then
      v_fail := 'immune';
    end if;
  end if;
  if v_fail is null then
    select * into v_hl from chase.player_live where player_id = p_player;
    select * into v_pl from chase.player_live where player_id = v_prey.id;
    if v_hl.player_id is null or v_pl.player_id is null
       or v_hl.fix_at < now() - make_interval(secs => chase.kt('fix_fresh_s'))
       or v_pl.fix_at < now() - make_interval(secs => chase.kt('fix_fresh_s')) then
      v_fail := 'no_fix';
    else
      v_dist := ST_Distance(v_hl.pos, v_pl.pos);
      v_limit := least(chase.kt('catch_max_m'), greatest(chase.kt('catch_min_m'), v_hl.acc + v_pl.acc));
      if v_dist > v_limit then
        v_fail := 'too_far';
      end if;
    end if;
  end if;
  if v_fail is not null then
    -- Attempts are counted for «90 % without dispute» (PLAN §13). Never coordinates.
    insert into chase.events (session_id, type, actor_player_id, target_player_id, payload)
    values (p_session, 'catch_fail', p_player, v_prey.id, jsonb_build_object('reason', v_fail));
    return jsonb_build_object('ok', false, 'error', v_fail);
  end if;

  -- Survival stint of the prey ends.
  update chase.player_stats
     set longest_survival_s = greatest(longest_survival_s, extract(epoch from now() - current_survival_start)::int),
         current_survival_start = null, surv_pts_stint = 0, times_caught = times_caught + 1
   where player_id = v_prey.id;

  -- Hunter: +15. Assist: other hunters near the prey in the last 10 s.
  update chase.player_stats
     set points = points + chase.kt('catch_pts')::int, round_points = round_points + chase.kt('catch_pts')::int,
         catches = catches + 1
   where player_id = p_player;
  with a as (
    update chase.player_stats st
       set points = points + chase.kt('assist_pts')::int, round_points = round_points + chase.kt('assist_pts')::int,
           assists = assists + 1
      from chase.players p join chase.player_live l on l.player_id = p.id
     where st.player_id = p.id and p.session_id = p_session and p.role = 'hunter' and p.id <> p_player
       and l.fix_at > now() - make_interval(secs => chase.kt('assist_s'))
       and ST_DWithin(l.pos, v_pl.pos, chase.kt('assist_m'))
    returning 1)
  select count(*) into v_assist from a;

  if v_round ->> 'variant' = 'swap' then
    -- Sisten: roles swap; the old hunter is prey now, with immunity (no tag-back).
    update chase.players
       set role = 'hunter', role_changed_at = now(), immune_until = null,
           catch_code = chase._new_catch_code(p_session), catch_code_rotated_at = now()
     where id = v_prey.id;
    update chase.players
       set role = 'prey', role_changed_at = now(),
           immune_until = now() + make_interval(secs => chase.kt('immune_s')),
           catch_code = chase._new_catch_code(p_session), catch_code_rotated_at = now()
     where id = p_player;
    update chase.player_stats set current_survival_start = now(), surv_pts_stint = 0 where player_id = p_player;
  else
    -- Smitte: the prey becomes a hunter and keeps its points.
    update chase.players
       set role = 'hunter', role_changed_at = now(), immune_until = null,
           catch_code = chase._new_catch_code(p_session), catch_code_rotated_at = now()
     where id = v_prey.id;
    if not exists (select 1 from chase.players where session_id = p_session and role = 'prey' and status = 'active') then
      v_last := true;
      update chase.player_stats
         set points = points + chase.kt('survivor_pts')::int, round_points = round_points + chase.kt('survivor_pts')::int
       where player_id = v_prey.id;
      perform chase._award_badges(v_prey.id, array['survivor']);
    end if;
  end if;

  insert into chase.events (session_id, type, actor_player_id, target_player_id, payload)
  values (p_session, 'catch', p_player, v_prey.id,
          jsonb_build_object('variant', v_round ->> 'variant', 'assists', v_assist, 'last', v_last,
                             'dist_m', round(v_dist::numeric)));
  v_new := chase._award_badges(p_player);

  if v_last then
    -- Everybody is a hunter: the round is over.
    update chase.sessions set phase_ends_at = now() where id = p_session;
    perform chase._advance(p_session);
  end if;

  return jsonb_build_object('ok', true, 'prey_id', v_prey.id, 'nickname', v_prey.nickname,
    'points', chase.kt('catch_pts')::int, 'variant', v_round ->> 'variant', 'last', v_last,
    'new_badges', to_jsonb(v_new),
    'immune_until', case when v_round ->> 'variant' = 'swap' then now() + make_interval(secs => chase.kt('immune_s')) end);
end;
$$;

-- ───────────────────────── redefined from 0003 (hooks added) ─────────────────────────
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
    if v_mode not in ('free', 'posts', 'tag') or v_dur <> floor(v_dur)
       or (v_mode = 'tag' and coalesce(v_r ->> 'variant', 'convert') not in ('convert', 'swap'))
       or v_dur not between chase.kg('round_min_s') and chase.kg('round_max_s') then
      return null;
    end if;
    v_rounds := v_rounds || case when v_mode = 'tag'
      then jsonb_build_object('mode', v_mode, 'duration_s', v_dur::int, 'variant', coalesce(v_r ->> 'variant', 'convert'))
      else jsonb_build_object('mode', v_mode, 'duration_s', v_dur::int) end;
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
    'variant', s.plan -> 'rounds' -> s.round_idx ->> 'variant',
    'duration_s', (s.plan -> 'rounds' -> s.round_idx ->> 'duration_s')::int,
    'phase_ends_at', s.phase_ends_at,
    'frozen', s.frozen_at is not null,
    'qr', coalesce((s.plan ->> 'qr_posts')::int, 0) > 0,
    'next', s.plan -> 'rounds' -> (s.round_idx + 1)) end;
$$;

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
  perform chase._mode_begin(p_session, p_at);
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
  perform chase._mode_finish(p_session, p_at);
  update chase.player_stats
     set per_round = per_round || jsonb_build_object(s.round_idx::text, jsonb_build_object(
           'points', round_points, 'posts', round_posts, 'distance_m', round(round_distance_m),
           'active_s', floor(round_active_s), 'move_pts', round_move_pts, 'badges', to_jsonb(round_badges)))
   where session_id = p_session;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'round_end', jsonb_build_object('round', s.round_idx));
end;
$$;

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
    perform chase._mode_upkeep(p_session);
  end if;
  return jsonb_build_object('changed', v_changed, 'golden', v_golden);
end;
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
  -- Smittejakt clocks (0004): survival time and immunity do not run while frozen.
  update chase.player_stats set current_survival_start = current_survival_start + v_d
   where session_id = p_session and current_survival_start is not null;
  update chase.players set immune_until = immune_until + v_d
   where session_id = p_session and immune_until > v_s.frozen_at;
  update chase.rounds
     set state = jsonb_set(state, '{golden_at}', to_jsonb((state ->> 'golden_at')::timestamptz + v_d))
   where session_id = p_session and idx = v_s.round_idx and state ? 'golden_at'
     and not coalesce((state ->> 'golden_done')::boolean, false);
end;
$$;

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
      case when cardinality(st.cells) >= 25 then 'explorer_25' end,
      case when st.catches >= 1 then 'first_catch' end,
      case when st.catches >= 5 then 'catches_5' end] loop
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
  v_extra      jsonb;
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

  -- Mode layer (0004+): Smittejakt view, survival points; zone later.
  v_extra := chase._mode_tick(p_player, v_s.id, v_pos);
  select * into v_st from chase.player_stats where player_id = p_player;

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

  return coalesce(v_extra, '{}'::jsonb) || jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'session_id', v_s.id,
    'status', v_s.status,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'round', chase._round_view(v_s),
    'role', (select role from chase.players where id = p_player),
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
      'catches', st.catches,
      'times_caught', st.times_caught,
      'immune', p.immune_until > v_now,
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
  update chase.players set catch_code = null, immune_until = null where session_id = p_session;
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

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
