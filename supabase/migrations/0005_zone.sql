-- Chase — 0005 — phase 3, part 2: shrinking zone (PLAN §3.3).
--
--   * A layer on any round: plan rounds take "zone": true (Postjakt + sone,
--     Sisten + sone, …).
--   * Round start: a centre inside the area (weighted away from forbidden
--     zones, far enough from the edge for the final circle), radius r0 = the
--     farthest area vertex (phase 0 covers everything), then N = 3 phases down
--     to 25 % of the area (equal-area circle). Phase k starts at D·k/(N+1).
--   * The zone is a PURE FUNCTION OF TIME: rounds.state.zone holds the centre,
--     the radii and the absolute phase times (shifted by pauses like golden_at).
--     zone(t) = circle(c, r[#{at ≤ t}]) — lib/rules/zone.ts computes the same
--     thing, same vectors (test/zone.test.ts ↔ test/sql/0005_zone.test.sql).
--   * Outside: −1 p per 3 s, never below 0 for the round. GPS benefit of the
--     doubt: inside = dist ≤ r + min(acc, 15 m); a fix worse than 30 m counts
--     as inside. Inside the new circle at a phase change: +5. Inside at every
--     phase change of a round: badge «Sonemester» (zone_master).
--   * Posts in a zone round spawn inside the next circle; open posts left
--     outside a new circle are removed (upkeep restocks).
--   * Hooks: 0004's _mode_* hooks are renamed to _tag_* and the new _mode_*
--     call tag + zone. _norm_plan / _unfreeze are wrapped the same way. The
--     renames are guarded so the migration can run twice (test-db.sh, and the
--     provisioning script re-applies every migration in order).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.player_stats add column if not exists zone_out_since  timestamptz;
alter table chase.player_stats add column if not exists zone_pen_stint  int not null default 0;
alter table chase.player_stats add column if not exists round_zone_pen  int not null default 0;
alter table chase.player_stats add column if not exists round_zone_hits int not null default 0;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/zone.ts (test diffs them).

create or replace function chase.kz(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'phases'          then 3
    when 'final_frac'      then 0.25   -- final circle = this share of the area
    when 'min_r_m'         then 20     -- never smaller than this (tiny areas)
    when 'warn_s'          then 20     -- next circle shown this long before
    when 'out_every_s'     then 3      -- −1 p per this many seconds outside
    when 'bonus_pts'       then 5      -- inside the new circle at a phase change
    when 'slack_m'         then 15     -- inside = dist ≤ r + min(acc, this)
    when 'uncertain_acc_m' then 30     -- worse fix: counts as inside, no bonus
    when 'center_tries'    then 20
  end::real;
$$;

-- ───────────────────────── pure zone maths (twins in lib/rules/zone.ts) ─────────────────────────

-- Phase start offsets in seconds from round start: D·k/(N+1), k = 1..N.
create or replace function chase._zone_offsets(p_dur int)
returns int[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array(select round(p_dur * k / (chase.kz('phases') + 1)::numeric)::int
                 from generate_series(1, chase.kz('phases')::int) k order by k);
$$;

-- Radii r[0..N]: r0 covers the area, then equal-area circles shrinking linearly
-- in area to final_frac, clamped to [min_r, r0]. Rounded to 0.1 m.
create or replace function chase._zone_radii(p_r0 double precision, p_area_m2 double precision)
returns double precision[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array[round(p_r0::numeric, 1)::float8] || array(
    select round(least(p_r0, greatest(chase.kz('min_r_m'),
             sqrt(p_area_m2 / pi()) * sqrt(1 - (1 - chase.kz('final_frac')) * k / chase.kz('phases'))))::numeric, 1)::float8
      from generate_series(1, chase.kz('phases')::int) k order by k);
$$;

-- Current phase index = number of phase times already reached.
create or replace function chase._zone_k(p_zone jsonb, p_at timestamptz)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select count(*)::int from jsonb_array_elements_text(p_zone -> 'at') t where t::timestamptz <= p_at;
$$;

create or replace function chase._zone_r(p_zone jsonb, p_at timestamptz)
returns double precision
language sql
immutable
set search_path = chase, extensions, public
as $$
  select (p_zone -> 'r' ->> chase._zone_k(p_zone, p_at))::float8;
$$;

create or replace function chase._zone_center(p_zone jsonb)
returns geography
language sql
immutable
set search_path = chase, extensions, public
as $$
  select chase._pt((p_zone -> 'c' ->> 'lat')::float8, (p_zone -> 'c' ->> 'lng')::float8);
$$;

-- The live round's zone, or null (no zone round / not started yet).
create or replace function chase._zone_of(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select r.state -> 'zone'
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.round_idx >= 0 and r.ended_at is null;
$$;

-- ───────────────────────── plan: "zone": true on any round ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_base(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_base;
  end if;
end $$;

create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_base jsonb := chase._norm_plan_base(p);
  v_z    jsonb;
begin
  if v_base is null then
    return null;
  end if;
  for i in 0 .. jsonb_array_length(v_base -> 'rounds') - 1 loop
    v_z := p -> 'rounds' -> i -> 'zone';
    if v_z is not null and v_z <> 'null'::jsonb then
      if jsonb_typeof(v_z) <> 'boolean' then
        return null;
      end if;
      if v_z = 'true'::jsonb then
        v_base := jsonb_set(v_base, array['rounds', i::text, 'zone'], 'true'::jsonb);
      end if;
    end if;
  end loop;
  return v_base;
end;
$$;

-- ───────────────────────── round view: + zone ─────────────────────────

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
    'zoned', coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'zone')::boolean, false),
    'duration_s', (s.plan -> 'rounds' -> s.round_idx ->> 'duration_s')::int,
    'phase_ends_at', s.phase_ends_at,
    'frozen', s.frozen_at is not null,
    'qr', coalesce((s.plan ->> 'qr_posts')::int, 0) > 0,
    -- Centre, radii, phase times (+ frozen_at so a paused clock stops the zone too).
    'zone', (select (r.state -> 'zone') - 'paid' || jsonb_build_object('frozen_at', s.frozen_at)
               from chase.rounds r
              where r.session_id = s.id and r.idx = s.round_idx and r.state ? 'zone'
                and s.status in ('live', 'paused')),
    'next', s.plan -> 'rounds' -> (s.round_idx + 1)) end;
$$;

-- ───────────────────────── zone layer ─────────────────────────

create or replace function chase._zone_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_round jsonb := chase._round_mode(p_session);
  v_area  double precision;
  v_rf    double precision;
  v_inner geometry;
  v_c     geography;
  v_r0    double precision;
  v_offs  int[];
begin
  update chase.player_stats
     set zone_out_since = null, zone_pen_stint = 0, round_zone_pen = 0, round_zone_hits = 0
   where session_id = p_session;
  if not coalesce((v_round ->> 'zone')::boolean, false) then
    return;
  end if;
  select * into s from chase.sessions where id = p_session;

  v_area := ST_Area(s.boundary);
  v_rf := greatest(chase.kz('min_r_m'), sqrt(v_area / pi()) * sqrt(chase.kz('final_frac')));
  -- Candidates far enough inside for the final circle, outside forbidden zones.
  v_inner := ST_Buffer(s.boundary, -v_rf)::geometry;
  if v_inner is null or ST_IsEmpty(v_inner) then
    v_inner := s.boundary::geometry;
  end if;
  if s.forbidden is not null and not ST_IsEmpty(ST_Difference(v_inner, s.forbidden::geometry)) then
    v_inner := ST_Difference(v_inner, s.forbidden::geometry);
  end if;
  select g.pt into v_c
    from (select d.geom::geography as pt from ST_Dump(ST_GeneratePoints(v_inner, chase.kz('center_tries')::int)) d) g
   order by least(coalesce(ST_Distance(g.pt, s.forbidden), 1e9), v_rf) desc, random()
   limit 1;
  if v_c is null then
    v_c := ST_PointOnSurface(s.boundary::geometry)::geography;
  end if;
  -- r0: the farthest vertex (the farthest point of a polygon from a point is a vertex).
  select max(ST_Distance(v_c, d.geom::geography)) into v_r0
    from ST_DumpPoints(s.boundary::geometry) d;
  v_offs := chase._zone_offsets((v_round ->> 'duration_s')::int);

  update chase.rounds
     set state = state || jsonb_build_object('zone', jsonb_build_object(
           'c', chase._latlng(v_c),
           'r', to_jsonb(chase._zone_radii(v_r0, v_area)),
           'at', (select jsonb_agg(to_jsonb(p_at + make_interval(secs => o)) order by o) from unnest(v_offs) o),
           'paid', 0))
   where session_id = p_session and idx = s.round_idx;
end;
$$;

-- Under the session lock (from _advance → _mode_upkeep): pay every phase change reached.
create or replace function chase._zone_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s     chase.sessions;
  v_z   jsonb := chase._zone_of(p_session);
  v_k   int;
  v_paid int;
  v_n   int := chase.kz('phases')::int;
  v_c   geography;
  v_r   double precision;
  v_in  int;
  v_id  uuid;
begin
  if v_z is null then
    return;
  end if;
  v_k := chase._zone_k(v_z, now());
  v_paid := coalesce((v_z ->> 'paid')::int, 0);
  if v_k <= v_paid then
    return;
  end if;
  select * into s from chase.sessions where id = p_session;
  v_c := chase._zone_center(v_z);

  for j in v_paid + 1 .. v_k loop
    v_r := (v_z -> 'r' ->> j)::float8;
    with ok as (
      select p.id from chase.players p join chase.player_live l on l.player_id = p.id
       where p.session_id = p_session and p.status = 'active' and p.role not in ('sitting_out', 'referee')
         and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
         and l.acc <= chase.kz('uncertain_acc_m')
         and ST_DWithin(l.pos, v_c, v_r + least(l.acc, chase.kz('slack_m'))))
    update chase.player_stats st
       set points = points + chase.kz('bonus_pts')::int,
           round_points = round_points + chase.kz('bonus_pts')::int,
           round_zone_hits = round_zone_hits + 1
      from ok where st.player_id = ok.id;
    get diagnostics v_in = row_count;
    -- Posts left outside the new circle go; _posts_upkeep restocks inside it.
    delete from chase.posts
     where session_id = p_session and round_idx = s.round_idx and claimed_by is null
       and pos is not null and not ST_DWithin(pos, v_c, v_r);
    insert into chase.events (session_id, type, payload)
    values (p_session, 'zone_shrink', jsonb_build_object('round', s.round_idx, 'phase', j, 'r', v_r, 'inside', v_in));
  end loop;

  if v_k >= v_n then
    for v_id in select st.player_id from chase.player_stats st
                 where st.session_id = p_session and st.round_zone_hits >= v_n loop
      perform chase._award_badges(v_id, array['zone_master']);
    end loop;
  end if;
  update chase.rounds set state = jsonb_set(state, '{zone,paid}', to_jsonb(v_k))
   where session_id = p_session and idx = s.round_idx;
end;
$$;

-- Per tick (after player_live is written): outside penalty + what the player sees.
create or replace function chase._zone_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_z      jsonb := chase._zone_of(p_session);
  v_s      chase.sessions;
  v_p      chase.players;
  v_acc    real;
  v_dist   double precision;
  v_r      double precision;
  v_inside boolean;
  v_n      int;
  st       chase.player_stats;
begin
  if v_z is null then
    return '{}'::jsonb;
  end if;
  select * into v_s from chase.sessions where id = p_session;
  select * into v_p from chase.players where id = p_player;
  select acc into v_acc from chase.player_live where player_id = p_player;
  v_dist := ST_Distance(p_pos, chase._zone_center(v_z));
  v_r := chase._zone_r(v_z, coalesce(v_s.frozen_at, now()));
  v_inside := coalesce(v_acc, 999) > chase.kz('uncertain_acc_m')
              or v_dist <= v_r + least(coalesce(v_acc, 0), chase.kz('slack_m'));
  update chase.player_live set in_zone = v_inside where player_id = p_player;

  if v_s.status = 'live' and v_p.role not in ('sitting_out', 'referee') then
    if v_inside then
      update chase.player_stats set zone_out_since = null, zone_pen_stint = 0 where player_id = p_player;
    else
      update chase.player_stats set zone_out_since = coalesce(zone_out_since, now())
       where player_id = p_player
      returning * into st;
      v_n := floor(extract(epoch from now() - st.zone_out_since) / chase.kz('out_every_s'))::int;
      -- Never below 0 for the round: take at most what the round has.
      update chase.player_stats
         set points = points - least(v_n - zone_pen_stint, greatest(round_points, 0)),
             round_zone_pen = round_zone_pen + least(v_n - zone_pen_stint, greatest(round_points, 0)),
             round_points = round_points - least(v_n - zone_pen_stint, greatest(round_points, 0)),
             zone_pen_stint = v_n
       where player_id = p_player and v_n > zone_pen_stint;
    end if;
  end if;

  select * into st from chase.player_stats where player_id = p_player;
  return jsonb_build_object('zone', jsonb_build_object(
    'inside', v_inside,
    'dist_m', round(v_dist::numeric),
    'pen', st.round_zone_pen,
    'hits', st.round_zone_hits));
end;
$$;

-- ───────────────────────── hooks: tag + zone ─────────────────────────

do $$
begin
  if to_regprocedure('chase._tag_begin(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _tag_begin;
  end if;
  if to_regprocedure('chase._tag_finish(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _tag_finish;
  end if;
  if to_regprocedure('chase._tag_upkeep(uuid)') is null then
    alter function chase._mode_upkeep(uuid) rename to _tag_upkeep;
  end if;
  if to_regprocedure('chase._tag_tick(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _tag_tick;
  end if;
  if to_regprocedure('chase._unfreeze_base(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_base;
  end if;
end $$;

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._tag_begin(p_session, p_at);
  perform chase._zone_begin(p_session, p_at);
end;
$$;

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._tag_finish(p_session, p_at);
  update chase.player_stats set zone_out_since = null, zone_pen_stint = 0 where session_id = p_session;
end;
$$;

create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._tag_upkeep(p_session);
  perform chase._zone_upkeep(p_session);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  return coalesce(chase._tag_tick(p_player, p_session, p_pos), '{}'::jsonb)
      || coalesce(chase._zone_tick(p_player, p_session, p_pos), '{}'::jsonb);
end;
$$;

-- Pause: the zone clock and the outside clock stop too.
create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions;
  v_d interval;
begin
  select * into v_s from chase.sessions where id = p_session;
  perform chase._unfreeze_base(p_session);
  if v_s.frozen_at is null then
    return;
  end if;
  v_d := now() - v_s.frozen_at;
  update chase.rounds
     set state = jsonb_set(state, '{zone,at}', (
           select jsonb_agg(case when t.x::timestamptz > v_s.frozen_at
                                 then to_jsonb(t.x::timestamptz + v_d) else to_jsonb(t.x::timestamptz) end
                            order by t.ord)
             from jsonb_array_elements_text(state -> 'zone' -> 'at') with ordinality t(x, ord)))
   where session_id = p_session and idx = v_s.round_idx and state ? 'zone';
  update chase.player_stats set zone_out_since = zone_out_since + v_d
   where session_id = p_session and zone_out_since is not null;
end;
$$;

-- ───────────────────────── posts spawn inside the next circle ─────────────────────────
-- 0003's _spawn_post with one change: in a zone round the candidate area is
-- clipped to the circle of the next phase (falls back to the whole area).

create or replace function chase._spawn_post(p_session uuid, p_round int, p_kind text default 'normal')
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s        chase.sessions;
  v_area   geometry;
  v_clip   geometry;
  v_z      jsonb := chase._zone_of(p_session);
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
  if v_z is not null then
    v_clip := ST_Intersection(v_area, ST_Buffer(chase._zone_center(v_z),
                greatest(1, (v_z -> 'r' ->> least(chase._zone_k(v_z, now()) + 1, chase.kz('phases')::int))::float8
                            - chase.kg('post_edge_m')))::geometry);
    if v_clip is not null and not ST_IsEmpty(v_clip) and ST_Area(v_clip::geography) >= 50 then
      v_area := v_clip;
    end if;
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

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
