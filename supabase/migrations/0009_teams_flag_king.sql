-- Chase — 0009 — phase 5: teams, Flaggjakt, Konge på haugen, team podiums (PLAN §3.4, ADR-026).
--
--   * Teams: plan.teams = 2..4 (default 2 when the plan has a team round).
--     A round is a team round when its mode is 'flag' or 'king', or when a
--     'free'/'posts' round has "team": true. Teams are dealt once — by the
--     teacher («Fordel lag») or at the start of the first team round — with a
--     snake draft on the points so far in the session (strongest first), so
--     team sizes differ by at most one. Late joiners go to the smallest team.
--     The teacher can move a player at any time.
--   * Team score = everything the members earn in team rounds (their round
--     points, folded in at round end) + objective bonuses (flags held, hill held).
--   * Flaggjakt ('flag', «erobre poster»): teams + 1 flags (max 5), spread out.
--     A team takes a flag by having strictly more players than every other team
--     within max(15 m, acc) (fix ≤ 25 m) for 10 s: +10 p to each of them. Every
--     30 s a held flag gives its team +5.
--   * Konge på haugen ('king'): a 20 m hill that moves every 150 s. Every 10 s
--     the team with strictly most players in it gets +3, and each of its players
--     there +1.
--   * Phones (team rounds only): teammates on the map, quick messages
--     (help/come/mine/ok) with the sender's position for the team only, shown
--     30 s. The message lives in player_live (UNLOGGED, gone at «Avslutt»).
--     Outside team rounds: only my team, its place and score (PLAN §0, rule 5).
--   * Ceremony: «Lagspiller» (assists + team posts + flags + minutes on the
--     hill) before «Poeng», and «Lagpall» (every team) last. Pure function
--     _team_podiums(), twin in lib/rules/teams.ts.
--   * Lock order (ADR-025): every write to other players' rows locks their
--     players rows first, in id order.
--   * Wraps with guarded renames: _norm_plan, _round_view, _mode_*, _unfreeze,
--     host_action, host_snapshot (the migration runs twice in test-db.sh).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.rounds drop constraint if exists rounds_mode_check;
alter table chase.rounds add constraint rounds_mode_check
  check (mode in ('free', 'posts', 'tag', 'zone_only', 'teams', 'flag', 'king'));

alter table chase.teams add column if not exists n      smallint;
alter table chase.teams add column if not exists points int not null default 0;
create unique index if not exists teams_session_n_uq on chase.teams (session_id, n);
create index if not exists players_team_idx on chase.players (team_id) where team_id is not null;

alter table chase.player_stats add column if not exists team_acts  int not null default 0;
alter table chase.player_stats add column if not exists round_hill int not null default 0;
alter table chase.player_live add column if not exists msg_kind text;
alter table chase.player_live add column if not exists msg_at   timestamptz;
alter table chase.player_live add column if not exists msg_pos  geography(Point, 4326);

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/teams.ts (test diffs them).

create or replace function chase.kl(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'teams_default'     then 2      -- plan has team rounds but no count
    when 'teams_min'         then 2
    when 'teams_max'         then 4
    when 'flags_extra'       then 1      -- flags = teams + 1
    when 'flags_max'         then 5
    when 'flag_r_m'          then 15     -- capture ring: max(15 m, acc)
    when 'flag_max_acc_m'    then 25     -- worse fix does not count
    when 'flag_cap_s'        then 10     -- majority this long takes the flag
    when 'flag_cap_pts'      then 10     -- each capturer
    when 'flag_hold_every_s' then 30
    when 'flag_hold_pts'     then 5      -- team, per held flag per period
    when 'spot_gap_m'        then 40     -- hill moves at least this far
    when 'hill_r_m'          then 20
    when 'hill_move_s'       then 150
    when 'hill_every_s'      then 10
    when 'hill_team_pts'     then 3
    when 'hill_pts'          then 1      -- each holder in the hill
    when 'hill_per_act'      then 6      -- periods on the hill per «Lagspiller» point
    when 'msg_show_s'        then 30
    when 'msg_gap_s'         then 5
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/teams.ts) ─────────────────────────

create or replace function chase._is_team_round(p_round jsonb)
returns boolean
language sql
immutable
set search_path = chase, extensions, public
as $$
  select coalesce(p_round ->> 'mode' in ('flag', 'king')
                  or (jsonb_typeof(p_round -> 'team') = 'boolean' and (p_round ->> 'team')::boolean), false);
$$;

-- Snake draft: the i-th player (0-based, strongest first) → team 1..n.
create or replace function chase._team_snake(p_i int, p_n int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when (p_i / p_n) % 2 = 0 then p_i % p_n + 1 else p_n - p_i % p_n end;
$$;

-- Strict majority: the team (1-based) with more players than every other, else null.
create or replace function chase._team_majority(p_counts int[])
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when m.top > 0 and (select count(*) from unnest(p_counts) c where c = m.top) = 1
              then array_position(p_counts, m.top) end
    from (select max(c) as top from unnest(p_counts) c) m;
$$;

-- Late joiner: the smallest team, then the one with fewest points, then the lowest number.
create or replace function chase._team_pick(p_counts int[], p_points int[])
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select i from generate_subscripts(p_counts, 1) i order by p_counts[i], coalesce(p_points[i], 0), i limit 1;
$$;

-- Podiums + «Lagspiller» before «Poeng» + «Lagpall» last.
-- p_teams: [{id, n, points}], p_rows: [{id, teamplay}].
create or replace function chase._team_podiums(p_podiums jsonb, p_teams jsonb, p_rows jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_tp  jsonb;
  v_tm  jsonb;
  v_out jsonb := '[]'::jsonb;
  v_p   jsonb;
begin
  if jsonb_array_length(coalesce(p_teams, '[]'::jsonb)) < 2 then
    return coalesce(p_podiums, '[]'::jsonb);
  end if;
  select jsonb_agg(jsonb_build_object('id', r ->> 'id', 'value', (r ->> 'teamplay')::numeric)
                   order by (r ->> 'teamplay')::numeric desc, (r ->> 'id') collate "C")
    into v_tp
    from (select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
           where coalesce((r ->> 'teamplay')::numeric, 0) > 0
           order by (r ->> 'teamplay')::numeric desc, (r ->> 'id') collate "C"
           limit chase.kc('podium_size')::int) q;
  select jsonb_agg(jsonb_build_object('id', t ->> 'id', 'value', (t ->> 'points')::numeric)
                   order by (t ->> 'points')::numeric desc, (t ->> 'n')::int)
    into v_tm
    from jsonb_array_elements(p_teams) t;
  for v_p in select * from jsonb_array_elements(coalesce(p_podiums, '[]'::jsonb)) loop
    if v_p ->> 'cat' = 'points' and v_tp is not null then
      v_out := v_out || jsonb_build_object('cat', 'teamplay', 'entries', v_tp);
      v_tp := null;
    end if;
    v_out := v_out || v_p;
  end loop;
  if v_tp is not null then
    v_out := v_out || jsonb_build_object('cat', 'teamplay', 'entries', v_tp);
  end if;
  return v_out || jsonb_build_object('cat', 'team', 'entries', v_tm);
end;
$$;

-- ───────────────────────── plan: teams, flag, king ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_ev(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_ev;
  end if;
end $$;

create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_in    jsonb := p;
  v_base  jsonb;
  v_r     jsonb;
  v_m     text;
  v_t     jsonb;
  v_nt    int := 0;
  v_teams numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'rounds') <> 'array' then
    return null;
  end if;
  -- The older layers know free/posts/tag; flag and king are checked as 'free'.
  for i in 0 .. jsonb_array_length(p -> 'rounds') - 1 loop
    if p -> 'rounds' -> i ->> 'mode' in ('flag', 'king') then
      v_in := jsonb_set(v_in, array['rounds', i::text, 'mode'], '"free"'::jsonb);
    end if;
  end loop;
  v_base := chase._norm_plan_ev(v_in);
  if v_base is null then
    return null;
  end if;
  for i in 0 .. jsonb_array_length(v_base -> 'rounds') - 1 loop
    v_r := p -> 'rounds' -> i;
    v_m := v_r ->> 'mode';
    v_t := v_r -> 'team';
    if v_t is not null and v_t <> 'null'::jsonb and jsonb_typeof(v_t) <> 'boolean' then
      return null;
    end if;
    if v_m in ('flag', 'king') then
      if v_base -> 'rounds' -> i ? 'zone' then
        return null;          -- the flags / the hill must stay reachable
      end if;
      v_base := jsonb_set(v_base, array['rounds', i::text, 'mode'], to_jsonb(v_m));
      v_nt := v_nt + 1;
    elsif v_t = 'true'::jsonb then
      if v_m not in ('free', 'posts') then
        return null;          -- Smittejakt stays individual
      end if;
      v_base := jsonb_set(v_base, array['rounds', i::text, 'team'], 'true'::jsonb);
      v_nt := v_nt + 1;
    end if;
  end loop;
  if p -> 'teams' is not null and p -> 'teams' <> 'null'::jsonb then
    if jsonb_typeof(p -> 'teams') <> 'number' then
      return null;
    end if;
    v_teams := (p ->> 'teams')::numeric;
    if v_teams <> floor(v_teams) or v_teams not between chase.kl('teams_min') and chase.kl('teams_max') then
      return null;
    end if;
  end if;
  if v_nt > 0 then
    v_base := v_base || jsonb_build_object('teams', coalesce(v_teams, chase.kl('teams_default'))::int);
  end if;
  return v_base;
exception when others then
  return null;
end;
$$;

-- ───────────────────────── team helpers ─────────────────────────

-- Playable area for flags and hills: inside the edge margin, away from forbidden zones.
create or replace function chase._team_area(p_session uuid)
returns geometry
language plpgsql
stable
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  v_area geometry;
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
  return v_area;
end;
$$;

-- p_k spots spread out (farthest-point sampling over 40 random candidates).
-- With p_avoid (the hill moving): a random candidate ≥ spot_gap_m from it,
-- else the farthest one.
create or replace function chase._team_spots(p_session uuid, p_k int, p_avoid geography default null)
returns geography[]
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_area geometry := chase._team_area(p_session);
  v_c    geography[];
  v_out  geography[] := '{}';
  v_best geography;
  v_bd   double precision;
  v_d    double precision;
  g      geography;
begin
  if v_area is null or ST_IsEmpty(v_area) then
    return v_out;
  end if;
  select array_agg(d.geom::geography) into v_c from ST_Dump(ST_GeneratePoints(v_area, 40)) d;
  if v_c is null then
    return v_out;
  end if;
  if p_avoid is not null and p_k = 1 then
    select x into v_best from unnest(v_c) x
     where ST_Distance(x, p_avoid) >= chase.kl('spot_gap_m') order by random() limit 1;
    if v_best is null then
      select x into v_best from unnest(v_c) x order by ST_Distance(x, p_avoid) desc limit 1;
    end if;
    return array[v_best];
  end if;
  for k in 1 .. p_k loop
    v_best := null;
    v_bd := -1;
    foreach g in array v_c loop
      select min(ST_Distance(g, x)) into v_d
        from unnest(v_out || case when p_avoid is null then '{}'::geography[] else array[p_avoid] end) x;
      v_d := coalesce(v_d, random());
      if v_d > v_bd then
        v_bd := v_d;
        v_best := g;
      end if;
    end loop;
    v_out := v_out || v_best;
  end loop;
  return v_out;
end;
$$;

-- Players per team (index = team n) standing within max(p_r, acc) of p_pos with a usable fix.
create or replace function chase._team_counts(p_session uuid, p_pos geography, p_r double precision)
returns int[]
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce(array_agg(coalesce(c.k, 0) order by t.n), '{}')
    from chase.teams t
    left join lateral (
      select count(*)::int as k
        from chase.players p join chase.player_live l on l.player_id = p.id
       where p.team_id = t.id and p.status = 'active' and p.role not in ('referee', 'sitting_out')
         and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
         and l.acc <= chase.kl('flag_max_acc_m')
         and ST_DWithin(l.pos, p_pos, greatest(p_r, l.acc))) c on true
   where t.session_id = p_session and t.n is not null;
$$;

create or replace function chase._team_in(p_session uuid, p_pos geography, p_r double precision, p_n int)
returns uuid[]
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce(array_agg(p.id order by p.id), '{}')
    from chase.teams t
    join chase.players p on p.team_id = t.id
    join chase.player_live l on l.player_id = p.id
   where t.session_id = p_session and t.n = p_n and p.status = 'active' and p.role not in ('referee', 'sitting_out')
     and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
     and l.acc <= chase.kl('flag_max_acc_m')
     and ST_DWithin(l.pos, p_pos, greatest(p_r, l.acc));
$$;

-- Points (+ «Lagspiller» acts, hill periods, a badge) to players other than the caller.
create or replace function chase._team_reward(p_ids uuid[], p_pts int, p_acts int, p_hill int, p_badge text)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_id uuid;
begin
  if coalesce(cardinality(p_ids), 0) = 0 then
    return;
  end if;
  perform 1 from chase.players where id = any(p_ids) order by id for update;   -- ADR-025
  update chase.player_stats
     set points = points + p_pts, round_points = round_points + p_pts,
         team_acts = team_acts + p_acts, round_hill = round_hill + p_hill
   where player_id = any(p_ids);
  for v_id in select player_id from chase.player_stats
               where player_id = any(p_ids) and not p_badge = any(badges) order by player_id loop
    perform chase._award_badges(v_id, array[p_badge]);
  end loop;
end;
$$;

-- Teams with the live score (members' round points while a team round is unpaid).
create or replace function chase._team_scores(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  with cur as (
    select exists (
      select 1 from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
       where s.id = p_session and chase._is_team_round(s.plan -> 'rounds' -> s.round_idx)
         and not coalesce((r.state ->> 'team_paid')::boolean, false)) as live)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'n', t.n, 'name', t.name, 'color', t.color,
           'points', t.points + case when cur.live then coalesce(m.rp, 0) else 0 end,
           'members', coalesce(m.cnt, 0)) order by t.n), '[]'::jsonb)
    from chase.teams t
    cross join cur
    left join lateral (
      select count(*)::int as cnt, sum(st.round_points)::int as rp
        from chase.players p join chase.player_stats st on st.player_id = p.id
       where p.team_id = t.id and p.status = 'active' and p.role <> 'referee') m on true
   where t.session_id = p_session and t.n is not null;
$$;

-- Deal every active player (not referees) into plan.teams teams. Caller may not
-- hold player rows yet: they are locked here first (ADR-025).
create or replace function chase._teams_deal(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_n      int := (select (plan ->> 'teams')::int from chase.sessions where id = p_session);
  v_names  text[] := array['Rød', 'Blå', 'Gul', 'Grønn'];
  v_colors text[] := array['#e5484d', '#3e63dd', '#f5b800', '#30a46c'];
begin
  if coalesce(v_n, 0) < 2 then
    return;
  end if;
  perform 1 from chase.players where session_id = p_session order by id for update;
  insert into chase.teams (session_id, n, name, color)
  select p_session, i, v_names[i], v_colors[i] from generate_series(1, v_n) i
  on conflict (session_id, n) do nothing;
  with o as (
    select p.id, (row_number() over (order by coalesce(st.points, 0) desc, random()) - 1)::int as i
      from chase.players p left join chase.player_stats st on st.player_id = p.id
     where p.session_id = p_session and p.status = 'active' and p.role <> 'referee')
  update chase.players pl set team_id = t.id
    from o join chase.teams t on t.session_id = p_session and t.n = chase._team_snake(o.i, v_n)
   where pl.id = o.id;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'teams_dealt', jsonb_build_object('teams', v_n));
end;
$$;

-- One player without a team → the smallest team. Caller holds that player's row.
create or replace function chase._team_assign(p_player uuid)
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s uuid;
  v_c int[];
  v_p int[];
  v_t uuid;
begin
  select session_id into v_s from chase.players where id = p_player;
  select array_agg(coalesce(m.cnt, 0) order by t.n), array_agg(coalesce(m.pts, 0) order by t.n)
    into v_c, v_p
    from chase.teams t
    left join lateral (
      select count(*)::int as cnt, sum(st.points)::int as pts
        from chase.players p left join chase.player_stats st on st.player_id = p.id
       where p.team_id = t.id and p.status = 'active' and p.role <> 'referee') m on true
   where t.session_id = v_s and t.n is not null;
  if v_c is null then
    return null;
  end if;
  select id into v_t from chase.teams where session_id = v_s and n = chase._team_pick(v_c, v_p);
  update chase.players set team_id = v_t where id = p_player;
  return v_t;
end;
$$;

-- ───────────────────────── team layer (hooks) ─────────────────────────

create or replace function chase._team_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_round jsonb;
  v_n     int;
  v_spots geography[];
  v_flags jsonb;
  v_id    uuid;
begin
  update chase.player_stats set round_hill = 0 where session_id = p_session;
  select * into s from chase.sessions where id = p_session;
  v_round := s.plan -> 'rounds' -> s.round_idx;
  if not chase._is_team_round(v_round) then
    return;
  end if;
  if not exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    perform chase._teams_deal(p_session);
  end if;
  perform 1 from chase.players where session_id = p_session order by id for update;
  for v_id in select id from chase.players
               where session_id = p_session and status = 'active' and role <> 'referee' and team_id is null
               order by joined_at loop
    perform chase._team_assign(v_id);
  end loop;
  v_n := (s.plan ->> 'teams')::int;
  if v_round ->> 'mode' = 'flag' then
    v_spots := chase._team_spots(p_session, least(chase.kl('flags_max')::int, v_n + chase.kl('flags_extra')::int));
    select coalesce(jsonb_agg(jsonb_build_object('n', o, 'pos', chase._latlng(g), 'owner', null, 'held_since', null,
                                                 'paid', 0, 'cap', null, 'cap_since', null) order by o), '[]'::jsonb)
      into v_flags
      from unnest(v_spots) with ordinality u(g, o);
    update chase.rounds set state = state || jsonb_build_object('flags', v_flags)
     where session_id = p_session and idx = s.round_idx;
  elsif v_round ->> 'mode' = 'king' then
    v_spots := chase._team_spots(p_session, 1);
    update chase.rounds set state = state || jsonb_build_object('hill', jsonb_build_object(
             'no', 1, 'pos', chase._latlng(v_spots[1]), 'r', chase.kl('hill_r_m'),
             'at', p_at, 'next_at', p_at + make_interval(secs => chase.kl('hill_move_s')),
             'per', 0, 'holder', null, 'counts', '[]'::jsonb))
     where session_id = p_session and idx = s.round_idx;
  end if;
end;
$$;

-- Round end: the members' round points go to the team (once per round).
create or replace function chase._team_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s chase.sessions;
  r chase.rounds;
begin
  select * into s from chase.sessions where id = p_session;
  if s.round_idx < 0 or not chase._is_team_round(s.plan -> 'rounds' -> s.round_idx) then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.session_id is null or coalesce((r.state ->> 'team_paid')::boolean, false) then
    return;
  end if;
  perform 1 from chase.players where session_id = p_session order by id for update;   -- ADR-025
  update chase.teams t
     set points = t.points + coalesce((
           select sum(st.round_points) from chase.players p join chase.player_stats st on st.player_id = p.id
            where p.team_id = t.id and p.status = 'active' and p.role <> 'referee'), 0)
   where t.session_id = p_session and t.n is not null;
  update chase.player_stats st
     set team_acts = st.team_acts + st.round_posts + st.round_hill / chase.kl('hill_per_act')::int
    from chase.players p
   where p.id = st.player_id and p.session_id = p_session and p.team_id is not null and p.role <> 'referee';
  update chase.rounds set state = state || '{"team_paid":true}'::jsonb
   where session_id = p_session and idx = s.round_idx;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'team_round_end', jsonb_build_object('round', s.round_idx, 'teams', (
    select jsonb_agg(jsonb_build_object('n', n, 'points', points) order by n)
      from chase.teams where session_id = p_session and n is not null)));
end;
$$;

-- Every advance in a live team round (under the session lock): flags and hill.
create or replace function chase._team_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s        chase.sessions;
  r        chase.rounds;
  v_round  jsonb;
  v_f      jsonb;
  v_flags  jsonb := '[]'::jsonb;
  v_h      jsonb;
  v_pos    geography;
  v_new    geography;
  v_counts int[];
  v_lead   int;
  v_own    int;
  v_per    int;
  v_ids    uuid[];
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null or s.round_idx < 0 then
    return;
  end if;
  v_round := s.plan -> 'rounds' -> s.round_idx;
  if v_round ->> 'mode' not in ('flag', 'king') then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.session_id is null or r.ended_at is not null then
    return;
  end if;

  if v_round ->> 'mode' = 'flag' and jsonb_typeof(r.state -> 'flags') = 'array' then
    for v_f in select f from jsonb_array_elements(r.state -> 'flags') with ordinality t(f, o) order by o loop
      v_pos := chase._pt((v_f -> 'pos' ->> 'lat')::float8, (v_f -> 'pos' ->> 'lng')::float8);
      v_counts := chase._team_counts(p_session, v_pos, chase.kl('flag_r_m'));
      v_lead := chase._team_majority(v_counts);
      v_own := (v_f ->> 'owner')::int;
      if v_lead is not null and v_lead is distinct from v_own then
        if (v_f ->> 'cap')::int is not distinct from v_lead then
          if now() - (v_f ->> 'cap_since')::timestamptz >= make_interval(secs => chase.kl('flag_cap_s')) then
            v_ids := chase._team_in(p_session, v_pos, chase.kl('flag_r_m'), v_lead);
            perform chase._team_reward(v_ids, chase.kl('flag_cap_pts')::int, 1, 0, 'flag');
            v_f := v_f || jsonb_build_object('owner', v_lead, 'held_since', now(), 'paid', 0, 'cap', null, 'cap_since', null);
            insert into chase.events (session_id, type, payload)
            values (p_session, 'flag_capture', jsonb_build_object('flag', v_f -> 'n', 'team', v_lead, 'from', v_own,
                                                                  'players', cardinality(v_ids)));
          end if;
        else
          v_f := v_f || jsonb_build_object('cap', v_lead, 'cap_since', now());
        end if;
      elsif v_f ->> 'cap' is not null then
        v_f := v_f || jsonb_build_object('cap', null, 'cap_since', null);
      end if;
      if v_f ->> 'owner' is not null then
        v_per := floor(extract(epoch from now() - (v_f ->> 'held_since')::timestamptz) / chase.kl('flag_hold_every_s'))::int;
        if v_per > (v_f ->> 'paid')::int then
          update chase.teams set points = points + (v_per - (v_f ->> 'paid')::int) * chase.kl('flag_hold_pts')::int
           where session_id = p_session and n = (v_f ->> 'owner')::int;
          v_f := v_f || jsonb_build_object('paid', v_per);
        end if;
      end if;
      v_flags := v_flags || v_f;
    end loop;
    if v_flags is distinct from r.state -> 'flags' then
      update chase.rounds set state = state || jsonb_build_object('flags', v_flags)
       where session_id = p_session and idx = s.round_idx;
    end if;

  elsif v_round ->> 'mode' = 'king' and jsonb_typeof(r.state -> 'hill') = 'object' then
    v_h := r.state -> 'hill';
    v_pos := chase._pt((v_h -> 'pos' ->> 'lat')::float8, (v_h -> 'pos' ->> 'lng')::float8);
    if now() >= (v_h ->> 'next_at')::timestamptz then
      v_new := (chase._team_spots(p_session, 1, v_pos))[1];
      v_h := v_h || jsonb_build_object(
        'no', (v_h ->> 'no')::int + 1, 'pos', coalesce(chase._latlng(v_new), v_h -> 'pos'),
        'at', now(), 'next_at', now() + make_interval(secs => chase.kl('hill_move_s')),
        'per', 0, 'holder', null, 'counts', '[]'::jsonb);
      v_pos := coalesce(v_new, v_pos);
      insert into chase.events (session_id, type, payload)
      values (p_session, 'hill_move', jsonb_build_object('no', v_h -> 'no'));
    end if;
    v_per := floor(extract(epoch from now() - (v_h ->> 'at')::timestamptz) / chase.kl('hill_every_s'))::int;
    if v_per > (v_h ->> 'per')::int then
      v_counts := chase._team_counts(p_session, v_pos, chase.kl('hill_r_m'));
      v_lead := chase._team_majority(v_counts);
      if v_lead is not null then
        update chase.teams set points = points + chase.kl('hill_team_pts')::int
         where session_id = p_session and n = v_lead;
        v_ids := chase._team_in(p_session, v_pos, chase.kl('hill_r_m'), v_lead);
        perform chase._team_reward(v_ids, chase.kl('hill_pts')::int, 0, 1, 'hill');
      end if;
      v_h := v_h || jsonb_build_object('per', v_per, 'holder', v_lead, 'counts', to_jsonb(v_counts));
    end if;
    if v_h is distinct from r.state -> 'hill' then
      update chase.rounds set state = state || jsonb_build_object('hill', v_h)
       where session_id = p_session and idx = s.round_idx;
    end if;
  end if;
end;
$$;

-- Per tick: my team (always once dealt), teammates + messages (team rounds only).
create or replace function chase._team_tick(p_player uuid, p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s        chase.sessions;
  v_p      chase.players;
  v_t      chase.teams;
  v_scores jsonb;
  v_mine   int;
  v_out    jsonb;
begin
  if not exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    return '{}'::jsonb;
  end if;
  select * into s from chase.sessions where id = p_session;
  select * into v_p from chase.players where id = p_player;
  if v_p.role = 'referee' or v_p.status <> 'active' then
    return '{}'::jsonb;
  end if;
  if v_p.team_id is null then
    perform chase._team_assign(p_player);   -- tick holds my row
    select * into v_p from chase.players where id = p_player;
  end if;
  select * into v_t from chase.teams where id = v_p.team_id;
  if v_t.id is null then
    return '{}'::jsonb;
  end if;
  v_scores := chase._team_scores(p_session);
  select (x ->> 'points')::int into v_mine from jsonb_array_elements(v_scores) x where (x ->> 'n')::int = v_t.n;
  v_out := jsonb_build_object(
    'n', v_t.n, 'name', v_t.name, 'color', v_t.color, 'points', v_mine,
    'rank', 1 + (select count(*) from jsonb_array_elements(v_scores) x where (x ->> 'points')::int > v_mine),
    'of', jsonb_array_length(v_scores),
    'palette', (select jsonb_agg(jsonb_build_object('n', x -> 'n', 'name', x -> 'name', 'color', x -> 'color')
                                 order by (x ->> 'n')::int) from jsonb_array_elements(v_scores) x));
  if s.status in ('live', 'paused') and chase._is_team_round(s.plan -> 'rounds' -> s.round_idx) then
    v_out := v_out || jsonb_build_object(
      'mates', (select coalesce(jsonb_agg(jsonb_build_object('nickname', q.nickname, 'pos', chase._latlng(l.pos))
                                          order by q.nickname), '[]'::jsonb)
                  from chase.players q join chase.player_live l on l.player_id = q.id
                 where q.team_id = v_t.id and q.id <> p_player and q.status = 'active' and q.role <> 'referee'
                   and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))),
      'msgs', (select coalesce(jsonb_agg(jsonb_build_object('nickname', q.nickname, 'kind', l.msg_kind,
                                                            'pos', chase._latlng(l.msg_pos), 'at', l.msg_at,
                                                            'me', q.id = p_player) order by l.msg_at desc), '[]'::jsonb)
                 from chase.players q join chase.player_live l on l.player_id = q.id
                where q.team_id = v_t.id and q.status = 'active'
                  and l.msg_at > now() - make_interval(secs => chase.kl('msg_show_s'))));
  end if;
  return jsonb_build_object('team', v_out);
end;
$$;

-- ───────────────────────── hooks: 0007 bodies + teams ─────────────────────────

do $$
begin
  if to_regprocedure('chase._mode_begin_ev(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _mode_begin_ev;
  end if;
  if to_regprocedure('chase._mode_finish_ev(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _mode_finish_ev;
  end if;
  if to_regprocedure('chase._mode_upkeep_ev(uuid)') is null then
    alter function chase._mode_upkeep(uuid) rename to _mode_upkeep_ev;
  end if;
  if to_regprocedure('chase._mode_tick_ev(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_ev;
  end if;
  if to_regprocedure('chase._unfreeze_ev(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_ev;
  end if;
  if to_regprocedure('chase._round_view_zone(chase.sessions)') is null then
    alter function chase._round_view(chase.sessions) rename to _round_view_zone;
  end if;
end $$;

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_begin_ev(p_session, p_at);
  perform chase._team_begin(p_session, p_at);
end;
$$;

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_finish_ev(p_session, p_at);
  perform chase._team_finish(p_session, p_at);
end;
$$;

create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_upkeep_ev(p_session);
  perform chase._team_upkeep(p_session);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_out    jsonb := chase._mode_tick_ev(p_player, p_session, p_pos);
  v_status text;
begin
  select status into v_status from chase.sessions where id = p_session;
  if v_status not in ('ceremony', 'ended') then
    v_out := coalesce(v_out, '{}'::jsonb) || chase._team_tick(p_player, p_session);
  end if;
  return v_out;
end;
$$;

-- Pause: capture, hold and hill clocks stop too (every stored time moves by the pause).
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
  perform chase._unfreeze_ev(p_session);
  if v_s.frozen_at is null then
    return;
  end if;
  v_d := now() - v_s.frozen_at;
  update chase.rounds r
     set state = r.state
       || case when jsonb_typeof(r.state -> 'flags') = 'array' then jsonb_build_object('flags', (
            select coalesce(jsonb_agg(f || (
                     select coalesce(jsonb_object_agg(k, to_jsonb((f ->> k)::timestamptz + v_d)), '{}'::jsonb)
                       from unnest(array['held_since', 'cap_since']) k where f ->> k is not null) order by o), '[]'::jsonb)
              from jsonb_array_elements(r.state -> 'flags') with ordinality t(f, o))) else '{}'::jsonb end
       || case when jsonb_typeof(r.state -> 'hill') = 'object' then jsonb_build_object('hill', (r.state -> 'hill') || (
            select coalesce(jsonb_object_agg(k, to_jsonb((r.state -> 'hill' ->> k)::timestamptz + v_d)), '{}'::jsonb)
              from unnest(array['at', 'next_at']) k where r.state -> 'hill' ->> k is not null)) else '{}'::jsonb end
   where r.session_id = p_session and r.idx = v_s.round_idx;
end;
$$;

-- Round view: + team flag, flags, hill (live/paused only, like the zone).
create or replace function chase._round_view(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when q.b is null then null else q.b || jsonb_build_object(
    'team', chase._is_team_round(s.plan -> 'rounds' -> s.round_idx),
    'flags', (select (select jsonb_agg(f - 'paid' - 'held_since' order by o)
                        from jsonb_array_elements(r.state -> 'flags') with ordinality t(f, o))
                from chase.rounds r
               where r.session_id = s.id and r.idx = s.round_idx and jsonb_typeof(r.state -> 'flags') = 'array'
                 and r.ended_at is null and s.status in ('live', 'paused')),
    'hill', (select (r.state -> 'hill') - 'per' || jsonb_build_object('frozen_at', s.frozen_at)
               from chase.rounds r
              where r.session_id = s.id and r.idx = s.round_idx and jsonb_typeof(r.state -> 'hill') = 'object'
                and r.ended_at is null and s.status in ('live', 'paused'))) end
    from (select chase._round_view_zone(s) as b) q;
$$;

-- ───────────────────────── ceremony: team entries ─────────────────────────
-- 0006's view; entries may be teams now (name + colour, «me» = my team).

create or replace function chase._ceremony_view(p_session uuid, p_player uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select jsonb_build_object(
    'step', s.ceremony_step,
    'total', jsonb_array_length(coalesce(s.podiums, '[]'::jsonb)),
    'spread', s.ceremony_spread,
    'revealed', coalesce((
      select jsonb_agg(jsonb_build_object('cat', pod ->> 'cat', 'entries', (
               select jsonb_agg(jsonb_build_object(
                        'place', e.o, 'nickname', coalesce(pl.nickname, tm.name), 'value', e.x -> 'value',
                        'color', tm.color,
                        'me', p_player is not null and (pl.id = p_player or (tm.id is not null and tm.id = (
                                select team_id from chase.players where id = p_player))))
                      order by e.o)
                 from jsonb_array_elements(pod -> 'entries') with ordinality e(x, o)
                 left join chase.players pl on pl.id = (e.x ->> 'id')::uuid
                 left join chase.teams tm on tm.id = (e.x ->> 'id')::uuid
                where pl.id is not null or tm.id is not null)) order by i)
        from jsonb_array_elements(s.podiums) with ordinality t(pod, i)
       where i <= s.ceremony_step), '[]'::jsonb),
    'best', case when p_player is not null and s.ceremony_step > jsonb_array_length(coalesce(s.podiums, '[]'::jsonb))
                 then (select st.best from chase.player_stats st where st.player_id = p_player) end,
    'on_podium', case when p_player is not null then exists (
                   select 1 from jsonb_array_elements(s.podiums) pod, jsonb_array_elements(pod -> 'entries') e
                    where pod ->> 'cat' <> 'team' and (e ->> 'id')::uuid = p_player) end,
    'voted', case when p_player is not null then (select voted_again from chase.players where id = p_player) end,
    'again', case when p_player is null then jsonb_build_object('yes', s.again_yes, 'no', s.again_no, 'teacher', s.teacher_again) end)
  from chase.sessions s where s.id = p_session;
$$;

create or replace function chase._team_ceremony(p_session uuid)
returns void
language sql
set search_path = chase, extensions, public
as $$
  update chase.sessions s set podiums = chase._team_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'n', t.n, 'points', t.points)), '[]'::jsonb)
       from chase.teams t where t.session_id = p_session and t.n is not null),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'teamplay', st.team_acts + st.assists)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee' and p.team_id is not null))
   where s.id = p_session;
$$;

-- ───────────────────────── player RPC: quick team message ─────────────────────────

create or replace function chase.team_msg(
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
  v_p chase.players;
  v_s chase.sessions;
  v_l chase.player_live;
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if coalesce(p_kind, '') not in ('help', 'come', 'mine', 'ok') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;
  select * into v_s from chase.sessions where id = p_session;
  if v_s.status not in ('live', 'paused') or v_s.round_idx < 0
     or not chase._is_team_round(v_s.plan -> 'rounds' -> v_s.round_idx) then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  if v_p.team_id is null or v_p.role = 'referee' then
    return jsonb_build_object('ok', false, 'error', 'no_team');
  end if;
  select * into v_l from chase.player_live where player_id = p_player for update;
  if v_l.player_id is null then
    return jsonb_build_object('ok', false, 'error', 'no_fix');
  end if;
  if v_l.msg_at > now() - make_interval(secs => chase.kl('msg_gap_s')) then
    return jsonb_build_object('ok', false, 'error', 'too_soon');
  end if;
  update chase.player_live
     set msg_kind = p_kind, msg_at = now(),
         msg_pos = case when fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s')) then pos end
   where player_id = p_player;
  return jsonb_build_object('ok', true, 'kind', p_kind, 'at', now());
end;
$$;

-- ───────────────────────── host: deal / move, ceremony, snapshot ─────────────────────────

do $$
begin
  if to_regprocedure('chase._host_action_ev(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_ev;
  end if;
  if to_regprocedure('chase._host_snapshot_ev(uuid,text,boolean)') is null then
    alter function chase.host_snapshot(uuid, text, boolean) rename to _host_snapshot_ev;
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
  v_res jsonb;
  v_t   uuid;
begin
  if p_action = 'ceremony_start' then
    v_res := chase._host_action_ev(p_session, p_host_token_hash, p_action, p_payload);
    if coalesce((v_res ->> 'ok')::boolean, false) then
      perform chase._team_ceremony(p_session);
    end if;
    return v_res;
  end if;
  if p_action not in ('teams_deal', 'team_set') then
    return chase._host_action_ev(p_session, p_host_token_hash, p_action, p_payload);
  end if;

  select * into v_s from chase.sessions where id = p_session and host_token_hash = p_host_token_hash;
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  if coalesce((v_s.plan ->> 'teams')::int, 0) < 2 then
    return jsonb_build_object('ok', false, 'error', 'no_teams');
  end if;
  -- Player rows before the session row (ADR-025).
  perform 1 from chase.players where session_id = p_session order by id for update;
  select * into v_s from chase.sessions where id = p_session for update;

  if p_action = 'teams_deal' then
    if v_s.status not in ('lobby', 'countdown', 'breather')
       or exists (select 1 from chase.rounds r where r.session_id = p_session and chase._is_team_round(r.config)) then
      return jsonb_build_object('ok', false, 'error', 'teams_locked');   -- a team round has been played
    end if;
    perform chase._teams_deal(p_session);
  else
    select id into v_t from chase.teams where session_id = p_session and n = (v_pl ->> 'team')::int;
    if v_t is null then
      return jsonb_build_object('ok', false, 'error', 'bad_team');
    end if;
    update chase.players set team_id = v_t
     where id = (v_pl ->> 'player_id')::uuid and session_id = p_session and status = 'active';
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  end if;

  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'host:' || p_action,
          case when v_pl ? 'player_id' then (v_pl ->> 'player_id')::uuid end, v_pl);
  select * into v_s from chase.sessions where id = p_session;
  return jsonb_build_object('ok', true, 'status', v_s.status, 'round', chase._round_view(v_s), 'server_now', now());
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
  v_r jsonb := chase._host_snapshot_ev(p_session, p_host_token_hash, p_include_geo);
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  return v_r || jsonb_build_object(
    'teams', chase._team_scores(p_session),
    'team_of', (select coalesce(jsonb_object_agg(p.id, t.n), '{}'::jsonb)
                  from chase.players p join chase.teams t on t.id = p.team_id
                 where p.session_id = p_session and p.status = 'active'));
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
