-- Chase — 0007 — phase 4: events, power-ups, more badges (PLAN §4, ADR-024).
--
--   * Event engine: one event at a time per round, in rounds.state.ev with
--     absolute times (pure function of time like the zone; pauses shift it).
--     Automatic every plan.event_every_s (0 = off, 60–300; wizard default 90),
--     plus the teacher's ⚡ button (2 taps). The teacher can switch the
--     automatic off/on while playing (sessions.events_off).
--   * Kinds (availability per round mode — _ev_kinds(), twin in lib/rules/events.ts):
--       sprint   all    a point ≥ 40 m from everybody; first 3 inside
--                       max(12 m, acc) with a fix ≤ 25 m: +20 p and a power-up
--       mission  all    an exercise where you stand; confirmed by scanning a
--                       physical QR post or «Ferdig» + teacher's confirmation:
--                       +15 p + badge. Auto only when the session has QR posts.
--       gather   all    everyone to the assembly point within 60 s: +10 p, the
--                       first 3 get a power-up (no penalty for the rest, rule 5)
--       golden   posts  a golden post right now
--       storm    tag    every role swaps for 30 s (5 s immunity), catches use
--                       Sisten rules meanwhile (_round_mode), then swap back
--       blackout tag    hunters' radar off for 45 s
--   * Power-ups (inventory max 2, one tap): shield (prey: immune 15 s), radar
--     (see all opponents 5 s), decoy (prey: fake radar ping 40 m away, 30 s),
--     turbo (double movement points 30 s). Prizes only (owner 2026-11-11),
--     drawn among the ones useful in this or a later round.
--   * Badges: m500, active_5, survived_60, catch_3 (3 catches in one round),
--     explorer_10, sprint, mission, gathered, powerup. Stored at once; the phone
--     shows at most one new badge per 30 s (ADR-024).
--   * Hooks: _mode_* are redefined (0006 bodies + the event layer);
--     host_action / host_snapshot / claim_qr / _norm_plan / _unfreeze are
--     wrapped with guarded renames (the migration runs twice in test-db.sh
--     and the provisioning script re-applies every migration).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.sessions add column if not exists events_off boolean not null default false;
alter table chase.player_stats add column if not exists powerups     text[] not null default '{}';
alter table chase.player_stats add column if not exists radar_until  timestamptz;
alter table chase.player_stats add column if not exists turbo_until  timestamptz;
alter table chase.player_stats add column if not exists turbo_base_m real not null default 0;
alter table chase.player_stats add column if not exists turbo_paid   int not null default 0;
alter table chase.player_live add column if not exists decoy_pos geography(Point, 4326);
alter table chase.player_live add column if not exists decoy_at  timestamptz;

-- Who reached / did what in an event. No coordinates. Goes with the session (24 h).
create table if not exists chase.event_entries (
  session_id uuid not null references chase.sessions(id) on delete cascade,
  round_idx  int not null,
  ev_no      int not null,
  player_id  uuid not null references chase.players(id) on delete cascade,
  kind       text not null check (kind in ('sprint', 'gather', 'mission')),
  state      text not null check (state in ('won', 'reached', 'pending', 'done')),
  place      int,
  points     int not null default 0,
  powerup    text,
  closes_at  timestamptz,
  at         timestamptz not null default now(),
  primary key (session_id, round_idx, ev_no, player_id)
);
alter table chase.event_entries enable row level security;   -- deny-all like every chase table

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/events.ts (test diffs them).

create or replace function chase.ke(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'every_default_s'  then 90     -- wizard default (PLAN §4)
    when 'every_min_s'      then 60
    when 'every_max_s'      then 300
    when 'end_margin_s'     then 15     -- no new event this close to round end
    when 'sprint_s'         then 45
    when 'sprint_winners'   then 3
    when 'sprint_pts'       then 20
    when 'sprint_min_m'     then 40     -- target at least this far from everybody
    when 'sprint_reach_m'   then 12     -- reached within max(this, acc) …
    when 'sprint_max_acc_m' then 25     -- … with a fix at least this good
    when 'mission_s'        then 90
    when 'mission_grace_s'  then 60     -- teacher may confirm this long after
    when 'mission_pts'      then 15
    when 'missions'         then 6      -- exercise texts (lib/locale/no.ts)
    when 'gather_s'         then 60
    when 'gather_pts'       then 10
    when 'gather_winners'   then 3      -- first ones get a power-up
    when 'storm_s'          then 30
    when 'storm_immune_s'   then 5
    when 'blackout_s'       then 45
    when 'show_done_s'      then 10     -- result stays on the phone this long
    when 'inv_max'          then 2
    when 'shield_s'         then 15
    when 'radar_s'          then 5
    when 'decoy_m'          then 40
    when 'decoy_s'          then 30
    when 'turbo_s'          then 30
    when 'badge_gap_s'      then 30     -- phone shows max one new badge per this
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/events.ts) ─────────────────────────

-- Kinds available in a round of this mode. p_auto: the automatic picker's pool
-- (no golden — Postjakt has its own —, mission only with physical QR posts).
create or replace function chase._ev_kinds(p_mode text, p_qr boolean, p_auto boolean)
returns text[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array_remove(array[
    'sprint',
    case when not p_auto or p_qr then 'mission' end,
    'gather',
    case when p_mode = 'posts' and not p_auto then 'golden' end,
    case when p_mode = 'tag' then 'storm' end,
    case when p_mode = 'tag' then 'blackout' end], null);
$$;

create or replace function chase._ev_dur(p_kind text)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select (case p_kind
    when 'sprint'   then chase.ke('sprint_s')
    when 'mission'  then chase.ke('mission_s')
    when 'gather'   then chase.ke('gather_s')
    when 'storm'    then chase.ke('storm_s')
    when 'blackout' then chase.ke('blackout_s')
    else 0 end)::int;
$$;

-- Power-ups worth winning: turbo always; the Smittejakt ones only if a tag
-- round is still to come (this one or later).
create or replace function chase._ev_prize_pool(p_tag_ahead boolean)
returns text[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when p_tag_ahead then array['shield', 'radar', 'decoy', 'turbo'] else array['turbo'] end;
$$;

-- What a power-up needs right now. null = usable, else the error code.
create or replace function chase._pu_check(p_kind text, p_mode text, p_role text)
returns text
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case
    when p_kind not in ('shield', 'radar', 'decoy', 'turbo') then 'bad_kind'
    when p_role in ('sitting_out', 'referee') then 'not_playing'
    when p_kind in ('shield', 'decoy') and (p_mode is distinct from 'tag' or p_role <> 'prey') then 'not_useful'
    when p_kind = 'radar' and (p_mode is distinct from 'tag' or p_role not in ('hunter', 'prey')) then 'not_useful'
  end;
$$;

-- ───────────────────────── plan: event_every_s ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_zone(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_zone;
  end if;
end $$;

create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_base jsonb := chase._norm_plan_zone(p);
  v_ev   numeric;
begin
  if v_base is null then
    return null;
  end if;
  if p -> 'event_every_s' is null or p -> 'event_every_s' = 'null'::jsonb then
    return v_base;                      -- off (absent = 0, older plans)
  end if;
  if jsonb_typeof(p -> 'event_every_s') <> 'number' then
    return null;
  end if;
  v_ev := (p ->> 'event_every_s')::numeric;
  if v_ev <> floor(v_ev) or (v_ev <> 0 and v_ev not between chase.ke('every_min_s') and chase.ke('every_max_s')) then
    return null;
  end if;
  if v_ev = 0 then
    return v_base;
  end if;
  return v_base || jsonb_build_object('event_every_s', v_ev::int);
end;
$$;

-- ───────────────────────── storm: Sisten rules while it lasts ─────────────────────────
-- 0004's _round_mode + the storm flag. catch() reads the variant from here, so
-- a storm catch swaps roles and a Smitte round cannot end mid-storm.

create or replace function chase._round_mode(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case
    when r.ended_at is null and r.state -> 'ev' ->> 'kind' = 'storm'
         and not coalesce((r.state -> 'ev' ->> 'done')::boolean, false)
      then (s.plan -> 'rounds' -> s.round_idx) || '{"variant":"swap","storm":true}'::jsonb
    else s.plan -> 'rounds' -> s.round_idx end
    from chase.sessions s
    left join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.round_idx >= 0;
$$;

-- ───────────────────────── event layer ─────────────────────────

create or replace function chase._ev_of(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select r.state -> 'ev'
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.round_idx >= 0 and r.ended_at is null;
$$;

create or replace function chase._ev_set(p_session uuid, p_ev jsonb)
returns void
language sql
set search_path = chase, extensions, public
as $$
  update chase.rounds r set state = r.state || jsonb_build_object('ev', p_ev)
    from chase.sessions s
   where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx;
$$;

-- Every hunter ↔ prey (storm start and end). The new prey get a short immunity.
create or replace function chase._ev_invert(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_id uuid;
begin
  -- Player rows first, then their stats: the same order as catch() and
  -- _tag_rebalance, so a catch landing on the storm edge cannot deadlock.
  perform 1 from chase.players
   where session_id = p_session and status = 'active' and role in ('hunter', 'prey')
   order by id for update;
  for v_id in select id from chase.players where session_id = p_session and status = 'active' and role = 'prey' loop
    perform chase._tag_end_stint(v_id);
  end loop;
  update chase.players
     set role = case role when 'hunter' then 'prey' else 'hunter' end,
         role_changed_at = now(),
         immune_until = case when role = 'hunter' then now() + make_interval(secs => chase.ke('storm_immune_s')) end,
         catch_code = coalesce(catch_code, chase._new_catch_code(p_session))
   where session_id = p_session and status = 'active' and role in ('hunter', 'prey');
  update chase.player_stats st set current_survival_start = now(), surv_pts_stint = 0
    from chase.players p
   where p.id = st.player_id and p.session_id = p_session and p.status = 'active' and p.role = 'prey';
end;
$$;

-- A random sprint target: inside the area (edge and forbidden margins, inside
-- the current zone circle), preferably ≥ sprint_min_m from every fresh fix.
create or replace function chase._ev_sprint_target(p_session uuid)
returns geography
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  v_area geometry;
  v_clip geometry;
  v_z    jsonb := chase._zone_of(p_session);
  v_pt   geography;
begin
  select * into s from chase.sessions where id = p_session;
  v_area := ST_Buffer(s.boundary, -chase.kg('post_edge_m'))::geometry;
  if s.forbidden is not null and v_area is not null and not ST_IsEmpty(v_area) then
    v_area := ST_Difference(v_area, ST_Buffer(s.forbidden, chase.kg('post_forbidden_m'))::geometry);
  end if;
  if v_area is null or ST_IsEmpty(v_area) or ST_Area(v_area::geography) < 50 then
    v_area := s.boundary::geometry;
    if s.forbidden is not null then
      v_area := ST_Difference(v_area, s.forbidden::geometry);
    end if;
  end if;
  if v_z is not null then
    v_clip := ST_Intersection(v_area, ST_Buffer(chase._zone_center(v_z),
                greatest(1, chase._zone_r(v_z, now()) - chase.kg('post_edge_m')))::geometry);
    if v_clip is not null and not ST_IsEmpty(v_clip) and ST_Area(v_clip::geography) >= 50 then
      v_area := v_clip;
    end if;
  end if;
  if v_area is null or ST_IsEmpty(v_area) then
    return null;
  end if;
  select g.pt into v_pt
    from (select d.geom::geography as pt from ST_Dump(ST_GeneratePoints(v_area, 20)) d) g
   order by (exists (select 1 from chase.player_live l join chase.players p on p.id = l.player_id
                      where l.session_id = p_session and p.status = 'active'
                        and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
                        and ST_DWithin(l.pos, g.pt, chase.ke('sprint_min_m'))))::int,
            random()
   limit 1;
  return v_pt;
end;
$$;

-- Start an event now. Caller holds the session (advisory lock or row lock).
-- → {"ok":true,"ev":…} or {"ok":false,"error":"busy"|"not_now"|"bad_kind"|"too_late"|"no_target"}
create or replace function chase._ev_start(p_session uuid, p_kind text, p_by text)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  v_ev   jsonb := chase._ev_of(p_session);
  v_mode text;
  v_dur  int := chase._ev_dur(p_kind);
  v_no   int;
  v_pt   geography;
  v_new  jsonb;
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  v_mode := s.plan -> 'rounds' -> s.round_idx ->> 'mode';
  if not p_kind = any(chase._ev_kinds(v_mode, coalesce((s.plan ->> 'qr_posts')::int, 0) > 0, false)) then
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;
  if v_ev is not null and not coalesce((v_ev ->> 'done')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;
  if s.phase_ends_at - now() < make_interval(secs => greatest(v_dur, 10)) then
    return jsonb_build_object('ok', false, 'error', 'too_late');
  end if;
  if p_kind = 'storm' and (
       not exists (select 1 from chase.players where session_id = p_session and status = 'active' and role = 'hunter')
    or not exists (select 1 from chase.players where session_id = p_session and status = 'active' and role = 'prey')) then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  if p_kind = 'sprint' then
    v_pt := chase._ev_sprint_target(p_session);
    if v_pt is null then
      return jsonb_build_object('ok', false, 'error', 'no_target');
    end if;
  elsif p_kind = 'gather' then
    v_pt := s.assembly_point;
  end if;

  v_no := coalesce((select (r.state ->> 'ev_n')::int from chase.rounds r
                     where r.session_id = p_session and r.idx = s.round_idx), 0) + 1;
  v_new := jsonb_build_object(
    'no', v_no, 'kind', p_kind, 'by', p_by,
    'at', now(), 'ends_at', now() + make_interval(secs => v_dur),
    'closes_at', now() + make_interval(secs => v_dur + case when p_kind = 'mission' then chase.ke('mission_grace_s')::int else 0 end),
    'target', case when v_pt is not null then chase._latlng(v_pt) end,
    'mission', case when p_kind = 'mission' then floor(random() * chase.ke('missions'))::int end,
    'done', p_kind = 'golden', 'done_at', case when p_kind = 'golden' then now() end);
  update chase.rounds set state = state || jsonb_build_object('ev', v_new, 'ev_n', v_no)
   where session_id = p_session and idx = s.round_idx;

  if p_kind = 'storm' then
    perform chase._ev_invert(p_session);
  elsif p_kind = 'golden' then
    perform chase._spawn_post(p_session, s.round_idx, 'golden');
  end if;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'ev_start', jsonb_build_object('round', s.round_idx, 'no', v_no, 'kind', p_kind, 'by', p_by));
  return jsonb_build_object('ok', true, 'ev', v_new);
end;
$$;

-- End the current event (time up, round over, teacher stop). Storm swaps back.
create or replace function chase._ev_end(p_session uuid, p_why text)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_ev jsonb;
  v_r  int;
begin
  -- Not _ev_of(): _finish_round marks the round ended before _mode_finish runs.
  select r.state -> 'ev' into v_ev
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session;
  if v_ev is null or coalesce((v_ev ->> 'done')::boolean, false) then
    return;
  end if;
  if v_ev ->> 'kind' = 'storm' then
    perform chase._ev_invert(p_session);
  end if;
  perform chase._ev_set(p_session, v_ev || jsonb_build_object('done', true, 'done_at', now()));
  select round_idx into v_r from chase.sessions where id = p_session;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'ev_end', jsonb_build_object('round', v_r, 'no', v_ev -> 'no', 'kind', v_ev ->> 'kind', 'why', p_why,
    'entries', (select count(*) from chase.event_entries e
                 where e.session_id = p_session and e.round_idx = v_r and e.ev_no = (v_ev ->> 'no')::int)));
end;
$$;

-- Points + maybe a power-up + a badge for one player. → the power-up given (or null).
create or replace function chase._ev_award(p_player uuid, p_pts int, p_powerup boolean, p_badge text)
returns text
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s    chase.sessions;
  v_pool text[];
  v_pu   text;
begin
  select s.* into v_s from chase.sessions s join chase.players p on p.session_id = s.id where p.id = p_player;
  -- Full inventory: points only.
  if p_powerup and (select cardinality(powerups) from chase.player_stats where player_id = p_player for update)
                   < chase.ke('inv_max') then
    v_pool := chase._ev_prize_pool(exists (
      select 1 from jsonb_array_elements(v_s.plan -> 'rounds') with ordinality t(r, i)
       where i - 1 >= v_s.round_idx and r ->> 'mode' = 'tag'));
    v_pu := v_pool[1 + floor(random() * cardinality(v_pool))::int];
  end if;
  update chase.player_stats
     set points = points + p_pts, round_points = round_points + p_pts,
         powerups = case when v_pu is not null then powerups || v_pu else powerups end
   where player_id = p_player;
  if p_badge is not null then
    perform chase._award_badges(p_player, array[p_badge]);
  end if;
  return v_pu;
end;
$$;

-- Mission done for one player (QR scan or teacher). → the entry, or null if not open.
create or replace function chase._ev_mission_award(p_session uuid, p_player uuid, p_round int, p_no int)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_e chase.event_entries;
begin
  insert into chase.event_entries (session_id, round_idx, ev_no, player_id, kind, state, points)
  values (p_session, p_round, p_no, p_player, 'mission', 'done', chase.ke('mission_pts')::int)
  on conflict (session_id, round_idx, ev_no, player_id) do update
    set state = 'done', points = excluded.points, at = now()
    where chase.event_entries.state = 'pending'
  returning * into v_e;
  if v_e.player_id is null then
    return null;     -- already done
  end if;
  perform chase._ev_award(p_player, chase.ke('mission_pts')::int, false, 'mission');
  return to_jsonb(v_e);
end;
$$;

-- Round start: reset the round's power-up clocks, schedule the first automatic event.
create or replace function chase._ev_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_every int;
begin
  update chase.player_stats set turbo_until = null, turbo_base_m = 0, turbo_paid = 0, radar_until = null
   where session_id = p_session;
  update chase.player_live set decoy_pos = null, decoy_at = null where session_id = p_session;
  select * into s from chase.sessions where id = p_session;
  v_every := coalesce((s.plan ->> 'event_every_s')::int, 0);
  update chase.rounds
     set state = state || jsonb_build_object('ev_n', 0,
           'ev_next', case when v_every > 0 then to_jsonb(p_at + make_interval(secs => v_every)) end)
   where session_id = p_session and idx = s.round_idx;
end;
$$;

-- Under the session lock (from _advance → _mode_upkeep), live round only.
create or replace function chase._ev_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  r       chase.rounds;
  v_ev    jsonb;
  v_every int;
  v_mode  text;
  v_pool  text[];
  v_kind  text;
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null or s.round_idx < 0 then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  v_ev := r.state -> 'ev';

  if v_ev is not null and not coalesce((v_ev ->> 'done')::boolean, false) then
    if now() >= (v_ev ->> 'ends_at')::timestamptz then
      perform chase._ev_end(p_session, 'time');
    elsif v_ev ->> 'kind' = 'sprint' and (select count(*) from chase.event_entries e
           where e.session_id = p_session and e.round_idx = s.round_idx and e.ev_no = (v_ev ->> 'no')::int)
           >= chase.ke('sprint_winners') then
      perform chase._ev_end(p_session, 'full');
    end if;
    select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
    v_ev := r.state -> 'ev';
  end if;

  v_every := coalesce((s.plan ->> 'event_every_s')::int, 0);
  if v_every <= 0 or s.events_off or r.state -> 'ev_next' is null or r.state -> 'ev_next' = 'null'::jsonb
     or now() < (r.state ->> 'ev_next')::timestamptz
     or (v_ev is not null and not coalesce((v_ev ->> 'done')::boolean, false)) then
    return;
  end if;
  update chase.rounds set state = state || jsonb_build_object('ev_next', now() + make_interval(secs => v_every))
   where session_id = p_session and idx = s.round_idx;
  v_mode := s.plan -> 'rounds' -> s.round_idx ->> 'mode';
  v_pool := chase._ev_kinds(v_mode, coalesce((s.plan ->> 'qr_posts')::int, 0) > 0, true);
  -- Enough time left for the event (+ margin), and not the same kind twice in a row.
  select array_agg(k) into v_pool from unnest(v_pool) k
   where s.phase_ends_at - now() >= make_interval(secs => chase._ev_dur(k) + chase.ke('end_margin_s'))
     and (k is distinct from v_ev ->> 'kind' or cardinality(v_pool) = 1);
  if v_pool is null or cardinality(v_pool) = 0 then
    return;
  end if;
  v_kind := v_pool[1 + floor(random() * cardinality(v_pool))::int];
  perform chase._ev_start(p_session, v_kind, 'auto');
end;
$$;

-- Per tick: sprint / gather arrivals, turbo, and what the player sees.
create or replace function chase._ev_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s    chase.sessions;
  v_p    chase.players;
  v_l    chase.player_live;
  st     chase.player_stats;
  v_ev   jsonb := chase._ev_of(p_session);
  v_kind text;
  v_no   int;
  v_open boolean;
  v_tgt  geography;
  v_dist double precision;
  v_n    int;
  v_pu   text;
  v_pts  int;
  v_me   chase.event_entries;
  v_view jsonb;
begin
  select * into v_s from chase.sessions where id = p_session;
  select * into v_p from chase.players where id = p_player;
  select * into v_l from chase.player_live where player_id = p_player;
  select * into st from chase.player_stats where player_id = p_player;

  -- Turbo: +1 extra per move_m_per_pt metres while it lasts (on top of the normal points).
  if v_s.status = 'live' and st.turbo_until is not null and now() <= st.turbo_until then
    v_n := floor(greatest(0, st.round_distance_m - st.turbo_base_m) / chase.kg('move_m_per_pt'))::int;
    if v_n > st.turbo_paid then
      update chase.player_stats
         set points = points + (v_n - turbo_paid), round_points = round_points + (v_n - turbo_paid), turbo_paid = v_n
       where player_id = p_player
      returning * into st;
    end if;
  end if;

  if v_ev is not null and v_s.status in ('live', 'paused') then
    v_kind := v_ev ->> 'kind';
    v_no := (v_ev ->> 'no')::int;
    v_open := not coalesce((v_ev ->> 'done')::boolean, false)
              and coalesce(v_s.frozen_at, now()) < (v_ev ->> 'ends_at')::timestamptz;
    if v_ev -> 'target' is not null and v_ev -> 'target' <> 'null'::jsonb then
      v_tgt := chase._pt((v_ev -> 'target' ->> 'lat')::float8, (v_ev -> 'target' ->> 'lng')::float8);
      v_dist := ST_Distance(p_pos, v_tgt);
    end if;

    if v_open and v_s.status = 'live' and v_p.role not in ('sitting_out', 'referee') and v_tgt is not null
       and not exists (select 1 from chase.event_entries e where e.session_id = p_session and e.round_idx = v_s.round_idx
                        and e.ev_no = v_no and e.player_id = p_player)
       and ((v_kind = 'sprint' and v_l.acc <= chase.ke('sprint_max_acc_m')
             and v_dist <= greatest(chase.ke('sprint_reach_m'), v_l.acc))
         or (v_kind = 'gather' and v_l.acc <= chase.k('uncertain_acc_m')
             and v_dist <= chase.k('gather_radius_m'))) then
      -- Exact places: arrivals in one event are serialised by their own lock.
      -- Taken after this tick's player row lock; nothing holding it waits for another lock.
      perform pg_advisory_xact_lock(hashtextextended('chase-ev:' || p_session::text, 0));
      select count(*) into v_n from chase.event_entries e
       where e.session_id = p_session and e.round_idx = v_s.round_idx and e.ev_no = v_no;
      if v_kind = 'gather' or v_n < chase.ke('sprint_winners') then
        v_pts := case when v_kind = 'sprint' then chase.ke('sprint_pts') else chase.ke('gather_pts') end::int;
        v_pu := chase._ev_award(p_player, v_pts,
                  v_kind = 'sprint' or v_n < chase.ke('gather_winners'),
                  case when v_kind = 'sprint' then 'sprint' else 'gathered' end);
        insert into chase.event_entries (session_id, round_idx, ev_no, player_id, kind, state, place, points, powerup)
        values (p_session, v_s.round_idx, v_no, p_player, v_kind,
                case when v_kind = 'sprint' then 'won' else 'reached' end, v_n + 1, v_pts, v_pu)
        on conflict do nothing;
        insert into chase.events (session_id, type, actor_player_id, payload)
        values (p_session, 'ev_' || v_kind, p_player, jsonb_build_object('no', v_no, 'place', v_n + 1, 'powerup', v_pu));
      end if;
    end if;

    if not coalesce((v_ev ->> 'done')::boolean, false)
       or (v_ev ->> 'done_at')::timestamptz > now() - make_interval(secs => chase.ke('show_done_s')) then
      select * into v_me from chase.event_entries e
       where e.session_id = p_session and e.round_idx = v_s.round_idx and e.ev_no = v_no and e.player_id = p_player;
      select count(*) into v_n from chase.event_entries e
       where e.session_id = p_session and e.round_idx = v_s.round_idx and e.ev_no = v_no;
      v_view := jsonb_build_object(
        'no', v_no, 'kind', v_kind,
        'at', v_ev -> 'at', 'ends_at', v_ev -> 'ends_at', 'closes_at', v_ev -> 'closes_at',
        'done', coalesce((v_ev ->> 'done')::boolean, false),
        'frozen_at', v_s.frozen_at,
        'target', v_ev -> 'target',
        'dist_m', case when v_dist is not null then round(v_dist::numeric) end,
        'mission', v_ev -> 'mission',
        'count', v_n,
        'left', case when v_kind = 'sprint' then greatest(0, chase.ke('sprint_winners')::int - v_n) end,
        'me', case when v_me.player_id is not null then jsonb_build_object(
                'state', v_me.state, 'place', v_me.place, 'points', v_me.points, 'powerup', v_me.powerup) end);
    end if;
  end if;

  select * into st from chase.player_stats where player_id = p_player;
  return jsonb_build_object(
    'event', v_view,
    'power', jsonb_build_object('inv', to_jsonb(st.powerups),
      'radar_until', case when st.radar_until > now() then st.radar_until end,
      'turbo_until', case when st.turbo_until > now() then st.turbo_until end,
      'decoy_until', case when v_l.decoy_at > now() - make_interval(secs => chase.ke('decoy_s'))
                          then v_l.decoy_at + make_interval(secs => chase.ke('decoy_s')) end));
end;
$$;

-- ───────────────────────── badges: + phase 4 ─────────────────────────
-- 0004's list + m500, active_5, survived_60, catch_3, explorer_10; the event
-- badges (sprint, mission, gathered, powerup) come in through p_extra.

create or replace function chase._award_badges(p_player uuid, p_extra text[] default '{}')
returns text[]
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  st    chase.player_stats;
  v_new text[] := '{}';
  v_b   text;
  v_c3  boolean := false;
begin
  select * into st from chase.player_stats where player_id = p_player;
  if st.player_id is null then
    return v_new;
  end if;
  if st.catches >= 3 and not 'catch_3' = any(st.badges) then
    select count(*) >= 3 into v_c3 from chase.events e join chase.sessions s on s.id = e.session_id
     where e.session_id = st.session_id and e.type = 'catch' and e.actor_player_id = p_player
       and e.at >= s.round_started_at;
  end if;
  foreach v_b in array p_extra || array[
      case when st.posts >= 1 then 'first_post' end,
      case when st.round_posts >= 5 then 'posts_5' end,
      case when st.distance_m >= 500 then 'm500' end,
      case when st.distance_m >= 1000 then 'km_1' end,
      case when st.active_s >= 300 then 'active_5' end,
      case when st.active_s >= 600 then 'active_10' end,
      case when cardinality(st.cells) >= 10 then 'explorer_10' end,
      case when cardinality(st.cells) >= 25 then 'explorer_25' end,
      case when st.catches >= 1 then 'first_catch' end,
      case when v_c3 then 'catch_3' end,
      case when st.catches >= 5 then 'catches_5' end,
      case when st.longest_survival_s >= 60
             or st.current_survival_start <= now() - interval '60 seconds' then 'survived_60' end] loop
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

-- ───────────────────────── hooks: 0006 bodies + events ─────────────────────────

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._tag_begin(p_session, p_at);
  perform chase._zone_begin(p_session, p_at);
  perform chase._ev_begin(p_session, p_at);
end;
$$;

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._ev_end(p_session, 'round_end');   -- storm swaps back before the survivors are counted
  perform chase._tag_finish(p_session, p_at);
  update chase.player_stats set zone_out_since = null, zone_pen_stint = 0, turbo_until = null, radar_until = null
   where session_id = p_session;
end;
$$;

create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._ev_upkeep(p_session);
  perform chase._tag_rebalance(p_session);
  perform chase._tag_upkeep(p_session);
  perform chase._zone_upkeep(p_session);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_status text;
  v_role   text;
  v_l      chase.player_live;
  v_out    jsonb;
  v_ev     jsonb;
  v_radar  jsonb;
  v_until  timestamptz;
begin
  select status into v_status from chase.sessions where id = p_session;
  select role into v_role from chase.players where id = p_player;
  select * into v_l from chase.player_live where player_id = p_player;

  -- Speed flag (0006): reported speed over 25 km/h for 10 s with a usable fix.
  if v_status not in ('lobby', 'ended') and v_role <> 'referee' then
    if coalesce(v_l.speed, 0) > chase.kc('speed_flag_mps') and coalesce(v_l.acc, 999) <= chase.kg('claim_max_acc_m') then
      update chase.player_live set fast_since = coalesce(fast_since, now()) where player_id = p_player
      returning * into v_l;
      if now() - v_l.fast_since >= make_interval(secs => chase.kc('speed_flag_s')) then
        perform chase._raise_alarm(p_session, p_player, 'speed', 1::smallint, null);
      end if;
    elsif v_l.fast_since is not null then
      update chase.player_live set fast_since = null where player_id = p_player;
    end if;
  end if;

  v_out := coalesce(chase._tag_tick(p_player, p_session, p_pos), '{}'::jsonb)
        || coalesce(chase._zone_tick(p_player, p_session, p_pos), '{}'::jsonb);
  if v_status = 'ceremony' then
    v_out := v_out || jsonb_build_object('ceremony', chase._ceremony_view(p_session, p_player));
  end if;
  if v_status in ('countdown', 'live', 'breather', 'paused', 'gathering') then
    v_out := v_out || chase._ev_tick(p_player, p_session, p_pos);
  end if;

  -- Smittejakt visibility + events/power-ups (PLAN §9.3: decided here only).
  if v_out ? 'tag' then
    v_ev := chase._ev_of(p_session);
    if v_out -> 'tag' ? 'radar' then
      if v_ev ->> 'kind' = 'blackout' and not coalesce((v_ev ->> 'done')::boolean, false) then
        v_out := jsonb_set(v_out, '{tag,radar}', '[]'::jsonb);
        v_out := jsonb_set(v_out, '{tag,blackout}', 'true'::jsonb);
      else
        -- Decoys look exactly like pings (same shape, mixed in by age).
        select coalesce(jsonb_agg(x order by (x ->> 'age_s')::numeric), '[]'::jsonb) into v_radar from (
          select jsonb_array_elements(v_out -> 'tag' -> 'radar') as x
          union all
          select jsonb_build_object('pos', chase._latlng(l.decoy_pos),
                                    'age_s', floor(extract(epoch from now() - l.decoy_at)), 'stealth', false)
            from chase.player_live l join chase.players p on p.id = l.player_id
           where l.session_id = p_session and p.role = 'prey' and p.status = 'active'
             and l.decoy_pos is not null and l.decoy_at > now() - make_interval(secs => chase.ke('decoy_s'))) q;
        v_out := jsonb_set(v_out, '{tag,radar}', v_radar);
      end if;
    end if;
    select radar_until into v_until from chase.player_stats where player_id = p_player;
    if v_until > now() and v_status in ('live', 'paused') and v_role in ('hunter', 'prey') then
      v_out := jsonb_set(v_out, '{tag,radar_live}', (
        select coalesce(jsonb_agg(chase._latlng(l.pos)), '[]'::jsonb)
          from chase.player_live l join chase.players p on p.id = l.player_id
         where l.session_id = p_session and p.status = 'active' and p.id <> p_player
           and p.role = case when v_role = 'hunter' then 'prey' else 'hunter' end
           and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))));
    end if;
  end if;
  return v_out;
end;
$$;

-- Pause: event, auto schedule and power-up clocks stop too.
do $$
begin
  if to_regprocedure('chase._unfreeze_zone(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_zone;
  end if;
end $$;

create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions;
  v_d interval;
  v_f timestamptz;
begin
  select * into v_s from chase.sessions where id = p_session;
  perform chase._unfreeze_zone(p_session);
  if v_s.frozen_at is null then
    return;
  end if;
  v_f := v_s.frozen_at;
  v_d := now() - v_f;
  update chase.rounds r
     set state = r.state
       || case when r.state ? 'ev' then jsonb_build_object('ev', (r.state -> 'ev')
            || (select coalesce(jsonb_object_agg(k, to_jsonb((r.state -> 'ev' ->> k)::timestamptz + v_d)), '{}'::jsonb)
                  from unnest(array['ends_at', 'closes_at']) k
                 where (r.state -> 'ev' ->> k)::timestamptz > v_f)) else '{}'::jsonb end
       || case when r.state ->> 'ev_next' is not null and (r.state ->> 'ev_next')::timestamptz > v_f
               then jsonb_build_object('ev_next', (r.state ->> 'ev_next')::timestamptz + v_d) else '{}'::jsonb end
   where r.session_id = p_session and r.idx = v_s.round_idx;
  update chase.event_entries set closes_at = closes_at + v_d
   where session_id = p_session and closes_at > v_f;
  update chase.player_stats
     set turbo_until = case when turbo_until > v_f then turbo_until + v_d else turbo_until end,
         radar_until = case when radar_until > v_f then radar_until + v_d else radar_until end
   where session_id = p_session;
  update chase.player_live set decoy_at = decoy_at + v_d
   where session_id = p_session and decoy_at > v_f - make_interval(secs => chase.ke('decoy_s'));
end;
$$;

-- ───────────────────────── player RPCs: power-up, mission «Ferdig» ─────────────────────────

create or replace function chase.use_powerup(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_kind       text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p     chase.players;
  v_s     chase.sessions;
  v_l     chase.player_live;
  v_inv   text[];
  v_i     int;
  v_mode  text;
  v_err   text;
  v_until timestamptz;
  v_pt    geography;
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
  select * into v_p from chase.players where id = p_player;
  if v_s.status <> 'live' or v_s.frozen_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  v_mode := v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode';
  v_err := chase._pu_check(p_kind, v_mode, v_p.role);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  select powerups into v_inv from chase.player_stats where player_id = p_player for update;
  v_i := array_position(v_inv, p_kind);
  if v_i is null then
    return jsonb_build_object('ok', false, 'error', 'none_left');
  end if;

  if p_kind = 'shield' then
    v_until := greatest(coalesce(v_p.immune_until, now()), now()) + make_interval(secs => chase.ke('shield_s'));
    update chase.players set immune_until = v_until where id = p_player;
  elsif p_kind = 'radar' then
    v_until := now() + make_interval(secs => chase.ke('radar_s'));
    update chase.player_stats set radar_until = v_until where player_id = p_player;
  elsif p_kind = 'turbo' then
    v_until := now() + make_interval(secs => chase.ke('turbo_s'));
    update chase.player_stats set turbo_until = v_until, turbo_base_m = round_distance_m, turbo_paid = 0
     where player_id = p_player;
  else   -- decoy: a point decoy_m away in a random direction, inside the area if possible
    select * into v_l from chase.player_live where player_id = p_player;
    if v_l.pos is null or v_l.fix_at < now() - make_interval(secs => chase.kt('fix_fresh_s')) then
      return jsonb_build_object('ok', false, 'error', 'no_fix');
    end if;
    select c.pt into v_pt
      from (select ST_Project(v_l.pos, chase.ke('decoy_m'), radians(b + random() * 45)) as pt
              from generate_series(0, 315, 45) b) c
     order by (not ST_Covers(v_s.boundary, c.pt))::int,
              (v_s.forbidden is not null and ST_DWithin(c.pt, v_s.forbidden, 5))::int,
              random()
     limit 1;
    v_until := now() + make_interval(secs => chase.ke('decoy_s'));
    update chase.player_live set decoy_pos = v_pt, decoy_at = now() where player_id = p_player;
  end if;

  update chase.player_stats set powerups = v_inv[1:v_i - 1] || v_inv[v_i + 1:] where player_id = p_player;
  insert into chase.events (session_id, type, actor_player_id, payload)
  values (p_session, 'powerup', p_player, jsonb_build_object('kind', p_kind));
  v_new := chase._award_badges(p_player, array['powerup']);
  return jsonb_build_object('ok', true, 'kind', p_kind, 'until', v_until, 'new_badges', to_jsonb(v_new));
end;
$$;

-- «Ferdig» on a mission: waits for the teacher's confirmation (or a QR scan).
create or replace function chase.mission_done(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p  chase.players;
  v_s  chase.sessions;
  v_ev jsonb;
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
  v_ev := chase._ev_of(p_session);
  if v_s.status <> 'live' or v_ev ->> 'kind' is distinct from 'mission'
     or coalesce((v_ev ->> 'done')::boolean, false) or now() >= (v_ev ->> 'ends_at')::timestamptz then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  if v_p.role in ('sitting_out', 'referee') then
    return jsonb_build_object('ok', false, 'error', 'not_playing');
  end if;
  insert into chase.event_entries (session_id, round_idx, ev_no, player_id, kind, state, closes_at)
  values (p_session, v_s.round_idx, (v_ev ->> 'no')::int, p_player, 'mission', 'pending',
          (v_ev ->> 'closes_at')::timestamptz)
  on conflict do nothing;
  return jsonb_build_object('ok', true,
    'state', (select state from chase.event_entries where session_id = p_session and round_idx = v_s.round_idx
               and ev_no = (v_ev ->> 'no')::int and player_id = p_player));
end;
$$;

-- QR scan during a mission confirms it (any physical QR post of the session);
-- otherwise as before (0003).
do $$
begin
  if to_regprocedure('chase._claim_qr_base(uuid,text,uuid,text)') is null then
    alter function chase.claim_qr(uuid, text, uuid, text) rename to _claim_qr_base;
  end if;
end $$;

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
  v_p    chase.players;
  v_s    chase.sessions;
  v_ev   jsonb;
  v_n    smallint;
  v_e    jsonb;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash;
  if v_p.id is not null and v_p.status = 'active' and v_p.session_id = p_session
     and v_p.role not in ('sitting_out', 'referee') then
    perform chase._advance(p_session);
    select * into v_s from chase.sessions where id = p_session;
    v_ev := chase._ev_of(p_session);
    select n into v_n from chase.posts where session_id = p_session and kind = 'physical_qr' and code = v_code;
    if v_n is not null and v_s.status = 'live' and v_ev ->> 'kind' = 'mission'
       and not coalesce((v_ev ->> 'done')::boolean, false)
       and now() < (v_ev ->> 'ends_at')::timestamptz then
      perform 1 from chase.players where id = p_player for update;
      v_e := chase._ev_mission_award(p_session, p_player, v_s.round_idx, (v_ev ->> 'no')::int);
      return jsonb_build_object('ok', true, 'mission', true, 'already', v_e is null, 'n', v_n,
        'value', case when v_e is null then 0 else chase.ke('mission_pts')::int end, 'first', false,
        'new_badges', case when v_e is null then '[]'::jsonb else '["mission"]'::jsonb end);
    end if;
  end if;
  return chase._claim_qr_base(p_player, p_token_hash, p_session, p_code);
end;
$$;

-- ───────────────────────── teacher: ⚡, stop, confirm, auto on/off ─────────────────────────

do $$
begin
  if to_regprocedure('chase._host_action_ceremony(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_ceremony;
  end if;
  if to_regprocedure('chase._host_snapshot_ceremony(uuid,text,boolean)') is null then
    alter function chase.host_snapshot(uuid, text, boolean) rename to _host_snapshot_ceremony;
  end if;
end $$;

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
  v_s   chase.sessions;
  v_pl  jsonb := coalesce(p_payload, '{}'::jsonb);
  v_ev  jsonb;
  v_res jsonb;
  v_e   record;
  v_n   int := 0;
begin
  if p_action not in ('event_start', 'event_stop', 'mission_confirm', 'events_auto') then
    return chase._host_action_ceremony(p_session, p_host_token_hash, p_action, p_payload);
  end if;
  select * into v_s from chase.sessions
   where id = p_session and host_token_hash = p_host_token_hash
   for update;
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  perform chase._advance(p_session);

  case p_action
  when 'event_start' then
    v_res := chase._ev_start(p_session, coalesce(v_pl ->> 'kind', ''), 'host');
    if not (v_res ->> 'ok')::boolean then
      return v_res;
    end if;
    -- The next automatic one comes a full interval after the teacher's.
    update chase.rounds set state = state || jsonb_build_object('ev_next',
             now() + make_interval(secs => greatest(coalesce((v_s.plan ->> 'event_every_s')::int, 0), 1)))
     where session_id = p_session and idx = v_s.round_idx and state -> 'ev_next' is not null
       and state -> 'ev_next' <> 'null'::jsonb;
  when 'event_stop' then
    perform chase._ev_end(p_session, 'host');
  when 'mission_confirm' then
    -- One player or everybody who pressed «Ferdig» in an open mission (this or the last round).
    for v_e in
      select e.player_id, e.round_idx, e.ev_no from chase.event_entries e
       where e.session_id = p_session and e.state = 'pending' and e.closes_at > now()
         and (not v_pl ? 'player_id' or e.player_id = (v_pl ->> 'player_id')::uuid)
       order by e.at
    loop
      if chase._ev_mission_award(p_session, v_e.player_id, v_e.round_idx, v_e.ev_no) is not null then
        v_n := v_n + 1;
      end if;
    end loop;
    if v_n = 0 then
      return jsonb_build_object('ok', false, 'error', 'none_pending');
    end if;
  when 'events_auto' then
    update chase.sessions set events_off = not coalesce((v_pl ->> 'on')::boolean, true) where id = p_session;
  end case;

  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'host:' || p_action,
          case when v_pl ? 'player_id' then (v_pl ->> 'player_id')::uuid end, v_pl);
  select * into v_s from chase.sessions where id = p_session;
  return jsonb_build_object('ok', true, 'status', v_s.status, 'round', chase._round_view(v_s),
                            'server_now', now(), 'confirmed', v_n);
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
  v_r    jsonb := chase._host_snapshot_ceremony(p_session, p_host_token_hash, p_include_geo);
  v_s    chase.sessions;
  v_ev   jsonb;
  v_mode text;
  v_view jsonb;
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  select * into v_s from chase.sessions where id = p_session;
  v_ev := chase._ev_of(p_session);
  v_mode := case when v_s.round_idx >= 0 then v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode' end;
  if v_ev is not null and v_s.status in ('live', 'paused', 'gathering')
     and (not coalesce((v_ev ->> 'done')::boolean, false)
          or (v_ev ->> 'done_at')::timestamptz > now() - make_interval(secs => chase.ke('show_done_s'))) then
    v_view := v_ev - 'by' || jsonb_build_object('entries', (
      select coalesce(jsonb_agg(jsonb_build_object('player_id', e.player_id, 'nickname', p.nickname, 'state', e.state,
                                                   'place', e.place, 'points', e.points, 'powerup', e.powerup)
                                order by e.place nulls last, e.at), '[]'::jsonb)
        from chase.event_entries e join chase.players p on p.id = e.player_id
       where e.session_id = p_session and e.round_idx = v_s.round_idx and e.ev_no = (v_ev ->> 'no')::int));
  end if;
  return v_r || jsonb_build_object(
    'event', v_view,
    'event_kinds', case when v_s.status = 'live' and v_mode is not null
                        then to_jsonb(chase._ev_kinds(v_mode, coalesce((v_s.plan ->> 'qr_posts')::int, 0) > 0, false)) end,
    'events_auto', coalesce((v_s.plan ->> 'event_every_s')::int, 0) > 0 and not v_s.events_off,
    'events_every_s', coalesce((v_s.plan ->> 'event_every_s')::int, 0),
    -- Mission confirmations still open from an earlier round (breather).
    'mission_pending', (select coalesce(jsonb_agg(jsonb_build_object('player_id', e.player_id, 'nickname', p.nickname)
                                                  order by e.at), '[]'::jsonb)
                          from chase.event_entries e join chase.players p on p.id = e.player_id
                         where e.session_id = p_session and e.state = 'pending' and e.closes_at > now()));
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
