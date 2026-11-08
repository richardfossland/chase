-- Chase — 0002 — phase 1 RPCs: session shell, join/resume, tick (position,
-- distance, active time, geofence 1–3, forbidden zones), SOS + alarms, host
-- actions (pause, message, gather, roll call), host snapshot (signal loss),
-- end_session (privacy wipe + anonymous summary) and purge_expired (pg_cron).
--
-- Conventions
--   * Every RPC is SECURITY DEFINER, search_path pinned, EXECUTE for
--     service_role only. API routes hash tokens (SHA-256 hex) before calling.
--   * Expected failures return {ok:false, error:'<code>'}; only programmer
--     errors raise.
--   * Server time only (CLAUDE.md rule 6). client_ts is used solely to drop
--     out-of-order ticks.
--   * PostGIS functions limited to what 3.3 has (ADR-009).
--   * Safety beats game (rule 4): geofence, forbidden-zone and SOS alarms are
--     evaluated in every non-lobby state, including pause. Game accounting
--     (distance, active time) only runs while 'live'.
--
-- Alarm lifecycle (decided 2026-11-08): one open alarm per (player, kind).
--   resolved_at = the condition cleared (player back inside, GPS back).
--   acked_at    = the teacher has seen it.
-- An alarm stays in the teacher's strip until it is acked, even when resolved,
-- so nothing disappears unseen. Escalation (outside > 100 m) raises the level
-- and clears acked_at again. SOS never auto-resolves; ack resolves it.

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.sessions add column if not exists pre_pause_status  text;
alter table chase.sessions add column if not exists live_since        timestamptz;  -- start/resume; signal-loss reference
alter table chase.sessions add column if not exists gather_started_at timestamptz;

-- UNLOGGED like the rest of player_live: these are positions too.
alter table chase.player_live add column if not exists last_good_pos  geography(Point, 4326);
alter table chase.player_live add column if not exists last_good_at   timestamptz;
alter table chase.player_live add column if not exists still_anchor   geography(Point, 4326);
alter table chase.player_live add column if not exists outside_since  timestamptz;
alter table chase.player_live add column if not exists outside_m      real not null default 0;
alter table chase.player_live add column if not exists last_client_ts timestamptz;

alter table chase.alarms add column if not exists level smallint not null default 1;  -- 1 normal, 2 high
-- Active seconds accumulate in fractions per tick.
alter table chase.player_stats alter column active_s type real;

create unique index if not exists alarms_one_open_uq
  on chase.alarms (player_id, kind) where resolved_at is null;
create unique index if not exists players_resume_uq
  on chase.players (session_id, resume_code_hash);
create index if not exists events_message_idx
  on chase.events (session_id, at) where type = 'message';

-- ───────────────────────── tunables ─────────────────────────
-- Single source for thresholds (PLAN §5.1, §6, §7). Mirrored in lib/rules/safety.ts.

create or replace function chase.k(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'max_players'        then 60
    when 'edge_warn_m'        then 15    -- geofence level 1
    when 'outside_alarm_s'    then 30    -- level 3 after this long outside …
    when 'outside_alarm_m'    then 40    -- … or this far outside
    when 'outside_high_m'     then 100   -- high alarm
    when 'forbidden_margin_m' then 15    -- "possibly inside": within min(acc, this)
    when 'good_acc_m'         then 25    -- distance/active: discard worse fixes
    when 'uncertain_acc_m'    then 50    -- shown as uncertain above this
    when 'max_speed_mps'      then 8     -- distance: discard faster segments
    when 'active_min_mps'     then 1.2
    when 'active_max_mps'     then 7
    when 'segment_reset_s'    then 30    -- gap that restarts the distance anchor
    when 'jitter_min_m'       then 3     -- anchor gate: greatest(this, acc/2)
    when 'still_radius_m'     then 10
    when 'still_alert_s'      then 90
    when 'signal_uncertain_s' then 20
    when 'signal_alarm_s'     then 60
    when 'gather_radius_m'    then 25
    when 'message_window_s'   then 120
  end::real;
$$;

-- ───────────────────────── helpers ─────────────────────────

create or replace function chase._pt(p_lat double precision, p_lng double precision)
returns geography
language sql
immutable
set search_path = chase, extensions, public
as $$
  select ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
$$;

create or replace function chase._latlng(p geography)
returns jsonb
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when p is null then null
    else jsonb_build_object('lat', round(ST_Y(p::geometry)::numeric, 7), 'lng', round(ST_X(p::geometry)::numeric, 7)) end;
$$;

-- Host authentication: returns the session row or null.
create or replace function chase._host_session(p_session uuid, p_host_token_hash text)
returns chase.sessions
language sql
stable
set search_path = chase, extensions, public
as $$
  select s.* from chase.sessions s
   where s.id = p_session and s.host_token_hash = p_host_token_hash;
$$;

-- Raise or refresh an alarm. Returns true when the teacher must be (re)alerted:
-- a new alarm, or an escalation of an open one.
create or replace function chase._raise_alarm(
  p_session uuid, p_player uuid, p_kind text, p_level smallint, p_pos geography)
returns boolean
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_id    uuid;
  v_level smallint;
begin
  select id, level into v_id, v_level
    from chase.alarms
   where player_id = p_player and kind = p_kind and resolved_at is null
   for update;
  if v_id is null then
    begin
      insert into chase.alarms (session_id, player_id, kind, level, pos)
      values (p_session, p_player, p_kind, p_level, p_pos);
      return true;
    exception when unique_violation then
      return false;   -- a concurrent call (e.g. two snapshot polls) raised it first
    end;
  end if;
  if p_level > v_level then
    update chase.alarms set level = p_level, pos = coalesce(p_pos, pos), acked_at = null where id = v_id;
    return true;
  end if;
  if p_pos is not null then
    update chase.alarms set pos = p_pos where id = v_id;
  end if;
  return false;
end;
$$;

create or replace function chase._clear_alarm(p_player uuid, p_kind text)
returns void
language sql
set search_path = chase, extensions, public
as $$
  update chase.alarms set resolved_at = now()
   where player_id = p_player and kind = p_kind and resolved_at is null;
$$;

-- Static geometry for maps (boundary, forbidden, assembly point) as GeoJSON.
create or replace function chase._session_geo(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select jsonb_build_object(
    'boundary',  ST_AsGeoJSON(s.boundary, 7)::jsonb,
    'forbidden', case when s.forbidden is null then null else ST_AsGeoJSON(s.forbidden, 7)::jsonb end,
    'assembly',  chase._latlng(s.assembly_point));
$$;

-- ───────────────────────── create_session ─────────────────────────

-- Geometry arrives as GeoJSON geometry objects (lng/lat order, WGS84).
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
              v_assembly, coalesce(p_plan, '{"rounds":[]}'::jsonb), coalesce(p_settings, '{}'::jsonb),
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

  insert into chase.events (session_id, type, payload)
  values (v_id, 'session_created', jsonb_build_object('area_m2', round(v_area)));

  return jsonb_build_object('ok', true, 'session_id', v_id, 'pin', v_pin, 'area_m2', round(v_area));
end;
$$;

-- ───────────────────────── join / resume ─────────────────────────

create or replace function chase.join_session(
  p_pin              text,
  p_nickname         text,
  p_token_hash       text,
  p_resume_code_hash text,
  p_device_id        text default null)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s      chase.sessions;
  v_nick   text := btrim(regexp_replace(coalesce(p_nickname, ''), '\s+', ' ', 'g'));
  v_player uuid;
  v_n      int;
begin
  if coalesce(length(p_token_hash), 0) < 32 or coalesce(length(p_resume_code_hash), 0) < 32 then
    return jsonb_build_object('ok', false, 'error', 'bad_token');
  end if;
  if char_length(v_nick) not between 1 and 20 then
    return jsonb_build_object('ok', false, 'error', 'bad_nickname');
  end if;

  select * into v_s from chase.sessions
   where join_pin = btrim(p_pin) and status <> 'ended'
   for update;   -- serialises joins per session for the player cap
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;

  if p_device_id is not null and exists (
       select 1 from chase.players
        where session_id = v_s.id and device_id = p_device_id and status = 'kicked') then
    return jsonb_build_object('ok', false, 'error', 'kicked');
  end if;

  select count(*) into v_n from chase.players where session_id = v_s.id and status = 'active';
  if v_n >= chase.k('max_players') then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;

  begin
    insert into chase.players (session_id, nickname, token_hash, resume_code_hash, device_id)
    values (v_s.id, v_nick, p_token_hash, p_resume_code_hash, p_device_id)
    returning id into v_player;
  exception when unique_violation then
    if exists (select 1 from chase.players
                where session_id = v_s.id and lower(nickname) = lower(v_nick) and status = 'active') then
      return jsonb_build_object('ok', false, 'error', 'nickname_taken');
    end if;
    return jsonb_build_object('ok', false, 'error', 'code_clash');  -- caller retries with new codes
  end;

  insert into chase.player_stats (player_id, session_id) values (v_player, v_s.id);
  insert into chase.events (session_id, type, actor_player_id) values (v_s.id, 'join', v_player);

  return jsonb_build_object('ok', true, 'session_id', v_s.id, 'player_id', v_player,
                            'nickname', v_nick, 'status', v_s.status);
end;
$$;

-- Resume on a new device / after clearing storage: PIN + resume code. Rotates
-- the token so the old device stops working.
create or replace function chase.resume_player(
  p_pin              text,
  p_resume_code_hash text,
  p_new_token_hash   text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p chase.players;
begin
  if coalesce(length(p_new_token_hash), 0) < 32 then
    return jsonb_build_object('ok', false, 'error', 'bad_token');
  end if;
  select p.* into v_p
    from chase.players p join chase.sessions s on s.id = p.session_id
   where s.join_pin = btrim(p_pin) and s.status <> 'ended'
     and p.resume_code_hash = p_resume_code_hash;
  if v_p.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_p.status = 'kicked' then
    return jsonb_build_object('ok', false, 'error', 'kicked');
  end if;
  update chase.players set token_hash = p_new_token_hash, status = 'active' where id = v_p.id;
  return jsonb_build_object('ok', true, 'session_id', v_p.session_id, 'player_id', v_p.id,
                            'nickname', v_p.nickname);
end;
$$;

-- Static info for the player client (map geometry, teacher's phone for the
-- "Ring lærer" button). Never other players' data.
create or replace function chase.player_bootstrap(p_player uuid, p_token_hash text, p_session uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p chase.players;
  v_s chase.sessions;
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if p_session is not null and v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_s from chase.sessions where id = v_p.session_id;
  return jsonb_build_object('ok', true, 'session_id', v_s.id, 'player_id', v_p.id,
    'nickname', v_p.nickname, 'status', v_s.status, 'teacher_phone', v_s.teacher_phone,
    'geo', chase._session_geo(v_s), 'server_now', now());
end;
$$;

-- ───────────────────────── tick ─────────────────────────

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
  select * into v_s from chase.sessions where id = v_p.session_id;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;

  select * into v_l from chase.player_live where player_id = p_player;
  -- Retries / reordered requests: never move a player backwards in time.
  if p_client_ts is not null and v_l.last_client_ts is not null and p_client_ts <= v_l.last_client_ts then
    return jsonb_build_object('ok', false, 'error', 'stale', 'server_now', v_now);
  end if;

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

  insert into chase.player_live as pl (player_id, session_id, pos, acc, speed, fix_at, still_since,
      geofence_state, in_forbidden, in_zone, last_good_pos, last_good_at, still_anchor,
      outside_since, outside_m, last_client_ts)
  values (p_player, v_s.id, v_pos, v_acc, p_speed, v_now, v_still_s,
      v_level, v_forbidden, true, v_good_pos, v_good_at, v_still_a,
      case when v_level >= 2 then v_out_since end, v_out_m, p_client_ts)
  on conflict (player_id) do update set
      pos = excluded.pos, acc = excluded.acc, speed = excluded.speed, fix_at = excluded.fix_at,
      still_since = excluded.still_since, geofence_state = excluded.geofence_state,
      in_forbidden = excluded.in_forbidden, last_good_pos = excluded.last_good_pos,
      last_good_at = excluded.last_good_at, still_anchor = excluded.still_anchor,
      outside_since = excluded.outside_since, outside_m = excluded.outside_m,
      last_client_ts = coalesce(excluded.last_client_ts, pl.last_client_ts);

  update chase.player_stats
     set distance_m = distance_m + v_add_m, active_s = active_s + v_add_s
   where player_id = p_player
  returning * into v_st;
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
    'role', v_p.role,
    'stats', jsonb_build_object('points', v_st.points, 'distance_m', round(v_st.distance_m::numeric, 1),
                                'active_s', floor(v_st.active_s)),
    'safety', jsonb_build_object('geofence', v_level, 'forbidden', v_forbidden,
                                 'outside_m', round(v_out_m::numeric, 1),
                                 'uncertain', v_acc > chase.k('uncertain_acc_m')),
    'alert_host', v_alert,     -- API route pushes a broadcast hint to the host channel
    'sos', v_sos,
    'gather', v_gather,
    'messages', v_msgs);
end;
$$;

-- ───────────────────────── SOS ─────────────────────────

-- Position: the fix sent with the press if any, else the last live position.
create or replace function chase.raise_sos(
  p_player     uuid,
  p_token_hash text,
  p_lat        double precision default null,
  p_lng        double precision default null,
  p_session    uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p   chase.players;
  v_pos geography;
  v_new boolean;
  v_id  uuid;
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if p_session is not null and v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if (select status from chase.sessions where id = v_p.session_id) = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  if p_lat between -90 and 90 and p_lng between -180 and 180 then
    v_pos := chase._pt(p_lat, p_lng);
  else
    select pos into v_pos from chase.player_live where player_id = p_player;
  end if;
  v_new := chase._raise_alarm(v_p.session_id, p_player, 'sos', 2::smallint, v_pos);
  select id into v_id from chase.alarms where player_id = p_player and kind = 'sos' and resolved_at is null;
  if v_new then
    insert into chase.events (session_id, type, actor_player_id) values (v_p.session_id, 'sos', p_player);
  end if;
  return jsonb_build_object('ok', true, 'alarm_id', v_id, 'session_id', v_p.session_id, 'new', v_new);
end;
$$;

create or replace function chase.ack_alarm(p_session uuid, p_alarm uuid, p_host_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions := chase._host_session(p_session, p_host_token_hash);
  v_a chase.alarms;
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  update chase.alarms
     set acked_at = coalesce(acked_at, now()),
         resolved_at = case when kind = 'sos' then coalesce(resolved_at, now()) else resolved_at end
   where id = p_alarm and session_id = p_session
  returning * into v_a;
  if v_a.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'alarm_ack', v_a.player_id, jsonb_build_object('kind', v_a.kind));
  return jsonb_build_object('ok', true, 'alarm_id', v_a.id, 'player_id', v_a.player_id, 'kind', v_a.kind);
end;
$$;

-- ───────────────────────── host actions ─────────────────────────

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
  v_round  jsonb;
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
    -- Phase 1: the plan's first round (default «fri løping»). Playlists come in phase 2.
    v_round := coalesce(v_s.plan -> 'rounds' -> 0, '{"mode":"free"}'::jsonb);
    insert into chase.rounds (session_id, idx, mode, config, started_at)
    values (p_session, 0, coalesce(v_round ->> 'mode', 'free'), v_round, now())
    on conflict (session_id, idx) do nothing;
    update chase.sessions set status = 'live', round_idx = 0, round_started_at = now(), live_since = now()
     where id = p_session;

  when 'pause' then
    if v_s.status not in ('live', 'countdown', 'breather', 'gathering') then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions set pre_pause_status = status, status = 'paused', paused_at = now()
     where id = p_session;

  when 'resume' then
    if v_s.status <> 'paused' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions
       set status = coalesce(pre_pause_status, 'live'), pre_pause_status = null,
           pause_accum = pause_accum + (now() - paused_at), paused_at = null, live_since = now()
     where id = p_session;

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
    update chase.players set checked_in_at = null where session_id = p_session;
    update chase.sessions
       set status = 'gathering', gather_started_at = now(), pre_pause_status = null,
           pause_accum = pause_accum + coalesce(now() - paused_at, interval '0'), paused_at = null
     where id = p_session;

  when 'end_gather' then
    if v_s.status <> 'gathering' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions set status = 'live', gather_started_at = null, live_since = now() where id = p_session;

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
  return jsonb_build_object('ok', true, 'status', v_s.status, 'server_now', now());
end;
$$;

-- ───────────────────────── host snapshot ─────────────────────────

-- The teacher sees everyone (supervision). Signal loss and stillness are
-- derived here from fix age (no cron); signal alarms are materialised so they
-- can be acked like the rest.
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
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;

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

  return jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'status', v_s.status,
    'pin', v_s.join_pin,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'paused_at', v_s.paused_at,
    'gather_started_at', v_s.gather_started_at,
    'players', v_players,
    'alarms', v_alarms,
    'alert_host', v_alert,
    'geo', case when p_include_geo then chase._session_geo(v_s) end);
end;
$$;

-- ───────────────────────── end + purge ─────────────────────────

-- Internal: privacy wipe + anonymous summary in one transaction (PLAN §8).
create or replace function chase._end_session(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions;
begin
  select * into v_s from chase.sessions where id = p_session for update;
  if v_s.id is null or v_s.status = 'ended' then
    return;
  end if;

  insert into chase.session_summaries (teacher_id, duration_s, player_count, modes,
      total_distance_m, median_distance_m, median_active_s, active_histogram, catches_total)
  select v_s.teacher_id,
         greatest(0, extract(epoch from now() - coalesce(v_s.round_started_at, now()) - v_s.pause_accum))::int,
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
  update chase.alarms
     set pos = null, resolved_at = coalesce(resolved_at, now())
   where session_id = p_session;
  update chase.sessions
     set status = 'ended', ended_at = now(), teacher_phone = null, paused_at = null
   where id = p_session;
  insert into chase.events (session_id, type) values (p_session, 'session_ended');
end;
$$;

-- Roll-call guard (PLAN §6): once the game has started, ending requires every
-- active player checked in, or p_force (teacher confirmed «Avslutt likevel»).
create or replace function chase.end_session(
  p_session         uuid,
  p_host_token_hash text,
  p_force           boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s       chase.sessions;
  v_missing jsonb;
begin
  select * into v_s from chase.sessions
   where id = p_session and host_token_hash = p_host_token_hash
   for update;
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  if v_s.round_idx >= 0 and not coalesce(p_force, false) then
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nickname', p.nickname,
                                                  'pos', chase._latlng(l.pos)) order by p.nickname), '[]')
      into v_missing
      from chase.players p left join chase.player_live l on l.player_id = p.id
     where p.session_id = p_session and p.status = 'active' and p.role <> 'referee'
       and p.checked_in_at is null;
    if jsonb_array_length(v_missing) > 0 then
      return jsonb_build_object('ok', false, 'error', 'missing', 'missing', v_missing);
    end if;
  end if;

  if coalesce(p_force, false) then
    insert into chase.events (session_id, type) values (p_session, 'end_forced');
  end if;
  perform chase._end_session(p_session);
  return jsonb_build_object('ok', true);
end;
$$;

-- pg_cron safety net (PLAN §8), every 15 min:
--   1. sessions not ended after 4 h are ended (wipe + summary),
--   2. sessions ended more than 24 h ago are deleted (cascades players,
--      stats, events, alarms, rounds, posts; summaries have no FK and stay),
--   3. stray live positions of ended sessions are removed.
create or replace function chase.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_id      uuid;
  v_ended   int := 0;
  v_deleted int := 0;
  v_stray   int := 0;
begin
  for v_id in
    select id from chase.sessions where status <> 'ended' and created_at < now() - interval '4 hours'
  loop
    perform chase._end_session(v_id);
    v_ended := v_ended + 1;
  end loop;

  with d as (delete from chase.sessions where status = 'ended' and ended_at < now() - interval '24 hours' returning 1)
  select count(*) into v_deleted from d;

  with d as (
    delete from chase.player_live l using chase.sessions s
     where s.id = l.session_id and s.status = 'ended' returning 1)
  select count(*) into v_stray from d;

  return jsonb_build_object('ended', v_ended, 'deleted', v_deleted, 'stray_positions', v_stray);
end;
$$;

-- Schedule when pg_cron is available (Supabase and the pinned test image have it).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    begin
      perform cron.unschedule('chase-purge-expired');
    exception when others then
      null;   -- not scheduled yet
    end;
    perform cron.schedule('chase-purge-expired', '*/15 * * * *', 'select chase.purge_expired();');
  else
    raise warning 'pg_cron not available: chase.purge_expired() is not scheduled';
  end if;
end $$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
