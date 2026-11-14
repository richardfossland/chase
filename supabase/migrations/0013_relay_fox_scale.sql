-- Chase — 0013 — phase 8: Stafett, Sporing and over 150 players (PLAN §3.4, §13 fase 8, ADR-030).
--
--   * Sporing (tag variant 'fox'): one fox (prey), everybody else hunts. The
--     fox sees every hunter within 150 m (live positions) and earns the usual
--     +1 per 5 s; hunters get a radar ping of the fox every 20 s (never skipped
--     for running, «stealth» does not apply). A catch swaps roles like sisten:
--     the catcher is the new fox with 20 s immunity. A fox that leaves or sits
--     out is replaced by a random hunter. Late joiners hunt. The fox at the
--     round end gets +25 and the badge «Rev».
--   * Stafett ('relay', always a team round): five posts spread away from the
--     assembly point (the base). Each team runs them in a fixed cycle starting
--     at its own post. A runner holds a baton: reach the target post (within
--     max(15 m, acc), fix ≤ 25 m) = +5 to the runner, then back to the base
--     (within max(25 m, acc)) = one leg, +10 to the team. The baton then goes to
--     the next teammate — at the base first, then whoever has run least.
--     Batons per team = ceil(members / 5), so a big team keeps everyone moving.
--     A baton not home within 3 min moves on (lost, stopped, phone in pocket).
--     Most legs wins; legs also count for «Lagspiller». Badge «Stafett» at 3
--     legs. Events in a relay round: only the teacher's missions (no sprint or
--     gathering pulling runners off the course).
--   * Over 150 players: max_players 60 → 300, open posts up to 40, the team
--     view is cached per team (each tick reads its own team only) and carries
--     the 20 nearest teammates, a hunter's radar carries the 25 nearest pings.
--     Measured locally at 300 bots (ADR-030): DB time per tick stays ~4 ms.
--   * Privacy fix: «Avslutt» now deletes the team caches (teammates' positions,
--     0011 kept them until the session row went 24 h later). PLAN § 8.
--   * Wraps with guarded renames (the migration runs twice in test-db.sh):
--     _norm_plan, _mode_begin, _mode_finish, _mode_upkeep_team, _mode_tick,
--     _round_view, _end_session. Redefined: k, kg, _is_team_round, _ev_kinds, _tag_rebalance,
--     catch (fox = swap), _mode_upkeep and _team_tick (0011, per-team cache).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.rounds drop constraint if exists rounds_mode_check;
alter table chase.rounds add constraint rounds_mode_check
  check (mode in ('free', 'posts', 'tag', 'zone_only', 'teams', 'flag', 'king', 'relay'));

alter table chase.player_stats add column if not exists relay_post  smallint;
alter table chase.player_stats add column if not exists relay_back  boolean not null default false;
alter table chase.player_stats add column if not exists relay_since timestamptz;
alter table chase.player_stats add column if not exists relay_legs  int not null default 0;
alter table chase.player_stats add column if not exists round_relay int not null default 0;

-- Per-team view cache (scores stay in session_clock.team_cache). UNLOGGED like session_clock.
create unlogged table if not exists chase.team_clock (
  team_id    uuid primary key references chase.teams(id) on delete cascade,
  session_id uuid not null references chase.sessions(id) on delete cascade,
  view       jsonb not null,
  at         timestamptz not null
);
alter table chase.team_clock enable row level security;
create index if not exists team_clock_session_idx on chase.team_clock (session_id);

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/relay.ts (test diffs them).

create or replace function chase.k8(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'fox_ping_s'      then 20     -- hunters see the fox this often
    when 'fox_radar_m'     then 150    -- the fox sees hunters this far
    when 'fox_end_pts'     then 25     -- fox at the round end
    when 'relay_posts'     then 5
    when 'relay_r_m'       then 15     -- reach a post within max(this, acc) …
    when 'relay_max_acc_m' then 25     -- … with a fix no worse than this
    when 'base_r_m'        then 25     -- back at the base within max(this, acc)
    when 'per_baton'       then 5      -- one baton per started 5 team members
    when 'leg_team_pts'    then 10
    when 'leg_pts'         then 5      -- to the runner, at the post
    when 'relay_badge_legs' then 3
    when 'baton_max_s'     then 180    -- a baton that does not come home in time moves on
    when 'mates_max'       then 20     -- nearest teammates in the team view
    when 'radar_max'       then 25     -- nearest pings on a hunter's radar
    when 'hunters_max'     then 40     -- nearest hunters on the fox's radar
  end::real;
$$;

-- 0002's thresholds with max_players 60 → 300 (mirrored in lib/rules/safety.ts).
create or replace function chase.k(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'max_players'        then 300
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

-- 0003's game rules with posts_max 15 → 40 (mirrored in lib/rules/game.ts).
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
    when 'posts_max'          then 40    -- 0013: room for 300 players
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

-- ───────────────────────── pure rules (twins in lib/rules/relay.ts) ─────────────────────────

create or replace function chase._relay_batons(p_members int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when coalesce(p_members, 0) <= 0 then 0
              else greatest(1, ceil(p_members / chase.k8('per_baton')))::int end;
$$;

-- Post (0-based) a team's i-th leg (0-based) runs to: team n starts at its own post.
create or replace function chase._relay_post(p_n int, p_leg int, p_k int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when coalesce(p_k, 0) <= 0 then null else (((p_n - 1) + p_leg) % p_k + p_k) % p_k end;
$$;

-- 0009 + Stafett.
create or replace function chase._is_team_round(p_round jsonb)
returns boolean
language sql
immutable
set search_path = chase, extensions, public
as $$
  select coalesce(p_round ->> 'mode' in ('flag', 'king', 'relay') or (p_round ->> 'team')::boolean, false);
$$;

-- 0007 + Stafett: no sprint / gathering pulling runners off the course.
create or replace function chase._ev_kinds(p_mode text, p_qr boolean, p_auto boolean)
returns text[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array_remove(array[
    case when p_mode is distinct from 'relay' then 'sprint' end,
    case when not p_auto or p_qr then 'mission' end,
    case when p_mode is distinct from 'relay' then 'gather' end,
    case when p_mode = 'posts' and not p_auto then 'golden' end,
    case when p_mode = 'tag' then 'storm' end,
    case when p_mode = 'tag' then 'blackout' end], null);
$$;

-- The n nearest of a jsonb array of {…, pos: {lat, lng}} to (lat, lng), flat-earth
-- distance (a few hundred metres: plenty). Elements without pos keep their order last.
create or replace function chase._nearest(p_items jsonb, p_lat double precision, p_lng double precision, p_n int)
returns jsonb
language sql
immutable
set search_path = chase, extensions, public
as $$
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb)
    from (select x, row_number() over (order by
                   case when p_lat is null or x -> 'pos' ->> 'lat' is null then null
                        else power((x -> 'pos' ->> 'lat')::float8 - p_lat, 2)
                           + power(((x -> 'pos' ->> 'lng')::float8 - p_lng) * cos(radians(p_lat)), 2) end nulls last,
                   i) as o
            from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality t(x, i)) q
   where o <= p_n;
$$;

-- ───────────────────────── plan: relay, fox ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_quiz(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_quiz;
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
  v_relay boolean := false;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'rounds') <> 'array' then
    return null;
  end if;
  -- The older layers know free/posts/tag/flag/king and convert/swap: relay is
  -- checked as a team 'free' round, fox as 'swap'.
  for i in 0 .. jsonb_array_length(p -> 'rounds') - 1 loop
    v_r := p -> 'rounds' -> i;
    if v_r ->> 'mode' = 'relay' then
      if v_r ? 'zone' and v_r -> 'zone' <> 'false'::jsonb and v_r -> 'zone' <> 'null'::jsonb then
        return null;                -- the posts and the base must stay reachable
      end if;
      if v_r ? 'team' and v_r -> 'team' not in ('true'::jsonb, 'null'::jsonb) then
        return null;                -- a relay is always a team round
      end if;
      v_in := jsonb_set(v_in, array['rounds', i::text], (v_r - 'zone') || '{"mode":"free","team":true}'::jsonb);
      v_relay := true;
    elsif v_r ->> 'mode' = 'tag' and v_r ->> 'variant' = 'fox' then
      v_in := jsonb_set(v_in, array['rounds', i::text, 'variant'], '"swap"'::jsonb);
    end if;
  end loop;
  v_base := chase._norm_plan_quiz(v_in);
  if v_base is null then
    return null;
  end if;
  for i in 0 .. jsonb_array_length(v_base -> 'rounds') - 1 loop
    v_r := p -> 'rounds' -> i;
    if v_r ->> 'mode' = 'relay' then
      v_base := jsonb_set(v_base, array['rounds', i::text], ((v_base -> 'rounds' -> i) - 'team') || '{"mode":"relay"}'::jsonb);
    elsif v_r ->> 'mode' = 'tag' and v_r ->> 'variant' = 'fox' then
      v_base := jsonb_set(v_base, array['rounds', i::text, 'variant'], '"fox"'::jsonb);
    end if;
  end loop;
  return v_base;
exception when others then
  return null;
end;
$$;

-- ───────────────────────── Sporing: roles ─────────────────────────

create or replace function chase._is_fox(p_session uuid)
returns boolean
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce(chase._round_mode(p_session) ->> 'mode' = 'tag' and chase._round_mode(p_session) ->> 'variant' = 'fox', false);
$$;

-- 0006 + Sporing: late joiners hunt; a missing fox is replaced by a random hunter.
create or replace function chase._tag_rebalance(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s   chase.sessions;
  v_id  uuid;
  v_fox boolean := chase._is_fox(p_session);
begin
  select * into v_s from chase.sessions where id = p_session;
  if v_s.status not in ('live', 'paused') or chase._round_mode(p_session) ->> 'mode' is distinct from 'tag' then
    return;
  end if;
  if v_fox then
    update chase.players
       set role = 'hunter', role_changed_at = now(), immune_until = null,
           catch_code = coalesce(catch_code, chase._new_catch_code(p_session)), catch_code_rotated_at = now()
     where session_id = p_session and status = 'active' and role = 'neutral';
    if not exists (select 1 from chase.players where session_id = p_session and status = 'active' and role = 'prey') then
      select p.id into v_id from chase.players p left join chase.player_live l on l.player_id = p.id
       where p.session_id = p_session and p.status = 'active' and p.role = 'hunter'
       order by (l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))) desc nulls last, random() limit 1;
      if v_id is not null then
        update chase.players
           set role = 'prey', role_changed_at = now(),
               immune_until = now() + make_interval(secs => chase.kt('immune_s')),
               catch_code = chase._new_catch_code(p_session), catch_code_rotated_at = now()
         where id = v_id;
        update chase.player_stats set current_survival_start = now(), surv_pts_stint = 0 where player_id = v_id;
        insert into chase.events (session_id, type, target_player_id, payload)
        values (p_session, 'tag_promote', v_id, '{"reason":"no_fox"}');
      end if;
    end if;
    return;
  end if;
  -- Neutral in a tag round (back from sitting out, joined late): prey with immunity.
  for v_id in select id from chase.players
               where session_id = p_session and status = 'active' and role = 'neutral' loop
    update chase.players
       set role = 'prey', role_changed_at = now(),
           immune_until = now() + make_interval(secs => chase.kt('immune_s')),
           catch_code = coalesce(catch_code, chase._new_catch_code(p_session)), catch_code_rotated_at = now()
     where id = v_id;
    update chase.player_stats set current_survival_start = now(), surv_pts_stint = 0 where player_id = v_id;
  end loop;
  -- Nobody hunting (hunters sat out / left): promote one prey.
  if not exists (select 1 from chase.players where session_id = p_session and status = 'active' and role = 'hunter') then
    select id into v_id from chase.players
     where session_id = p_session and status = 'active' and role = 'prey' order by random() limit 1;
    if v_id is not null then
      perform chase._tag_end_stint(v_id);
      update chase.players set role = 'hunter', role_changed_at = now(), immune_until = null where id = v_id;
      insert into chase.events (session_id, type, target_player_id, payload)
      values (p_session, 'tag_promote', v_id, '{"reason":"no_hunter"}');
    end if;
  end if;
end;
$$;

-- Round start of a Sporing round: the dealt ~15 % hunters become one fox + hunters.
create or replace function chase._fox_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_fox uuid;
  v_n   int;
begin
  select id into v_fox from chase.players
   where session_id = p_session and status = 'active' and role in ('hunter', 'prey')
   order by random() limit 1;
  if v_fox is null then
    return;
  end if;
  update chase.players set role = 'hunter', role_changed_at = p_at, immune_until = null
   where session_id = p_session and status = 'active' and role = 'prey' and id <> v_fox;
  update chase.players set role = 'prey', role_changed_at = p_at, immune_until = null where id = v_fox;
  update chase.player_stats st set current_survival_start = null, surv_pts_stint = 0
    from chase.players p where p.id = st.player_id and p.session_id = p_session and p.id <> v_fox;
  update chase.player_stats set current_survival_start = p_at, surv_pts_stint = 0 where player_id = v_fox;
  select count(*) into v_n from chase.players where session_id = p_session and status = 'active' and role = 'hunter';
  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'fox_roles', v_fox, jsonb_build_object('hunters', v_n));
end;
$$;

-- Every upkeep in a live Sporing round: ping the fox every 20 s, running or not.
create or replace function chase._fox_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if not chase._is_fox(p_session) then
    return;
  end if;
  update chase.player_live l
     set ping_pos = l.pos, ping_at = now(), ping_stealth = false
    from chase.players p
   where p.id = l.player_id and l.session_id = p_session and p.role = 'prey' and p.status = 'active'
     and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
     and (l.ping_at is null or l.ping_stealth or now() - l.ping_at >= make_interval(secs => chase.k8('fox_ping_s')));
end;
$$;

-- ───────────────────────── Stafett ─────────────────────────

create or replace function chase._relay_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_spots geography[];
  v_n     int;
begin
  select * into s from chase.sessions where id = p_session;
  if s.round_idx < 0 or s.plan -> 'rounds' -> s.round_idx ->> 'mode' is distinct from 'relay' then
    return;
  end if;
  v_n := (s.plan ->> 'teams')::int;
  v_spots := chase._team_spots(p_session, chase.k8('relay_posts')::int, s.assembly_point);
  update chase.rounds set state = state || jsonb_build_object('relay', jsonb_build_object(
           'base', chase._latlng(s.assembly_point), 'r', chase.k8('base_r_m'),
           'posts', (select coalesce(jsonb_agg(jsonb_build_object('n', o - 1, 'pos', chase._latlng(g)) order by o), '[]'::jsonb)
                       from unnest(v_spots) with ordinality u(g, o)),
           'legs', (select jsonb_object_agg(i::text, 0) from generate_series(1, v_n) i),
           'at', '{}'::jsonb))
   where session_id = p_session and idx = s.round_idx;
end;
$$;

-- Every upkeep in a live relay round (under the session lock, ≤ 1/s):
-- dropped batons, posts reached, legs finished at the base, new batons.
-- Rows of other players are locked first, in id order (ADR-025).
create or replace function chase._relay_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  r       chase.rounds;
  v_rel   jsonb;
  v_base  geography;
  v_posts geography[];
  v_k     int;
  v_ids   uuid[];
  v_pick  jsonb;
  v_legs  jsonb;
  v_id    uuid;
  v_fresh interval := make_interval(secs => chase.kt('fix_fresh_s'));
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null or s.round_idx < 0
     or s.plan -> 'rounds' -> s.round_idx ->> 'mode' is distinct from 'relay' then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.session_id is null or r.ended_at is not null or jsonb_typeof(r.state -> 'relay') <> 'object' then
    return;
  end if;
  v_rel := r.state -> 'relay';
  v_base := chase._pt((v_rel -> 'base' ->> 'lat')::float8, (v_rel -> 'base' ->> 'lng')::float8);
  select array_agg(chase._pt((x -> 'pos' ->> 'lat')::float8, (x -> 'pos' ->> 'lng')::float8) order by o)
    into v_posts from jsonb_array_elements(v_rel -> 'posts') with ordinality t(x, o);
  v_k := coalesce(cardinality(v_posts), 0);
  if v_k = 0 then
    return;
  end if;

  -- 1. Batons of players who left, sit out, lost their team or kept it too long
  --    (3 min: lost, stopped, phone in the pocket) go back. relay_since = now
  --    puts the slow runner last in the queue among those with as few legs.
  select array_agg(p.id order by p.id) into v_ids
    from chase.players p join chase.player_stats st on st.player_id = p.id
   where p.session_id = p_session and st.relay_post is not null
     and (p.status <> 'active' or p.role in ('sitting_out', 'referee') or p.team_id is null
          or st.relay_since < now() - make_interval(secs => chase.k8('baton_max_s')));
  if v_ids is not null then
    perform 1 from chase.players where id = any(v_ids) order by id for update;
    update chase.player_stats set relay_post = null, relay_back = false, relay_since = now() where player_id = any(v_ids);
    insert into chase.events (session_id, type, payload)
    values (p_session, 'relay_drop', jsonb_build_object('batons', cardinality(v_ids)));
  end if;

  -- 2. Runners at their post: +5, now back to the base.
  select array_agg(p.id order by p.id) into v_ids
    from chase.players p join chase.player_stats st on st.player_id = p.id join chase.player_live l on l.player_id = p.id
   where p.session_id = p_session and p.status = 'active' and st.relay_post is not null and not st.relay_back
     and st.relay_post < v_k
     and l.fix_at > now() - v_fresh and l.acc <= chase.k8('relay_max_acc_m')
     and ST_DWithin(l.pos, v_posts[st.relay_post + 1], greatest(chase.k8('relay_r_m'), l.acc));
  if v_ids is not null then
    perform 1 from chase.players where id = any(v_ids) order by id for update;
    update chase.player_stats
       set relay_back = true,
           points = points + chase.k8('leg_pts')::int, round_points = round_points + chase.k8('leg_pts')::int
     where player_id = any(v_ids);
    insert into chase.events (session_id, type, payload)
    values (p_session, 'relay_post', jsonb_build_object('runners', cardinality(v_ids)));
  end if;

  -- 3. Runners back at the base: one leg each, +10 to the team.
  select array_agg(p.id order by p.id) into v_ids
    from chase.players p join chase.player_stats st on st.player_id = p.id join chase.player_live l on l.player_id = p.id
   where p.session_id = p_session and p.status = 'active' and st.relay_post is not null and st.relay_back
     and l.fix_at > now() - v_fresh and l.acc <= chase.k('uncertain_acc_m')
     and ST_DWithin(l.pos, v_base, greatest(chase.k8('base_r_m'), l.acc));
  if v_ids is not null then
    perform 1 from chase.players where id = any(v_ids) order by id for update;
    select coalesce(jsonb_object_agg(t.n::text, c.cnt), '{}'::jsonb) into v_legs
      from (select team_id, count(*)::int as cnt from chase.players where id = any(v_ids) group by team_id) c
      join chase.teams t on t.id = c.team_id;
    update chase.teams t set points = t.points + chase.k8('leg_team_pts')::int * (v_legs ->> t.n::text)::int
     where t.session_id = p_session and v_legs ? t.n::text;
    v_rel := v_rel || jsonb_build_object(
      'legs', (select jsonb_object_agg(k, coalesce((v_rel -> 'legs' ->> k)::int, 0) + coalesce((v_legs ->> k)::int, 0))
                 from jsonb_object_keys(v_rel -> 'legs') k),
      'at', (v_rel -> 'at') || (select coalesce(jsonb_object_agg(k, now()), '{}'::jsonb) from jsonb_object_keys(v_legs) k));
    update chase.player_stats
       set relay_post = null, relay_back = false, relay_legs = relay_legs + 1, round_relay = round_relay + 1
     where player_id = any(v_ids);
    for v_id in select player_id from chase.player_stats
                 where player_id = any(v_ids) and relay_legs >= chase.k8('relay_badge_legs') and not 'relay' = any(badges)
                 order by player_id loop
      perform chase._award_badges(v_id, array['relay']);
    end loop;
    insert into chase.events (session_id, type, payload) values (p_session, 'relay_leg', jsonb_build_object('teams', v_legs));
  end if;

  -- 4. New batons: at the base first, then whoever has run least this round.
  with mem as (
    select p.id, p.team_id, t.n, st.relay_post, st.round_relay, st.relay_since,
           coalesce(l.fix_at > now() - v_fresh and ST_DWithin(l.pos, v_base, greatest(chase.k8('base_r_m'), l.acc)), false) as at_base
      from chase.players p
      join chase.teams t on t.id = p.team_id
      join chase.player_stats st on st.player_id = p.id
      left join chase.player_live l on l.player_id = p.id
     where p.session_id = p_session and p.status = 'active' and p.role not in ('sitting_out', 'referee') and t.n is not null),
  need as (
    select team_id, chase._relay_batons(count(*)::int) - count(relay_post)::int as k from mem group by team_id),
  cand as (
    select m.id, m.n, row_number() over (partition by m.team_id
             order by m.at_base desc, m.round_relay, m.relay_since nulls first, m.id) as rn
      from mem m where m.relay_post is null)
  select array_agg(c.id order by c.id), jsonb_agg(jsonb_build_object('id', c.id, 'n', c.n, 'rn', c.rn))
    into v_ids, v_pick
    from cand c join mem m on m.id = c.id join need d on d.team_id = m.team_id
   where c.rn <= d.k;
  if v_ids is not null then
    perform 1 from chase.players where id = any(v_ids) order by id for update;
    -- The i-th new baton of team n runs the team's next leg in its cycle.
    update chase.player_stats st
       set relay_post = chase._relay_post((x ->> 'n')::int,
                          coalesce((v_rel -> 'next' ->> (x ->> 'n'))::int, 0) + (x ->> 'rn')::int - 1, v_k),
           relay_back = false, relay_since = now()
      from jsonb_array_elements(v_pick) x
     where st.player_id = (x ->> 'id')::uuid;
    v_rel := v_rel || jsonb_build_object('next', coalesce(v_rel -> 'next', '{}'::jsonb) || (
               select jsonb_object_agg(n, coalesce((v_rel -> 'next' ->> n)::int, 0) + cnt)
                 from (select x ->> 'n' as n, count(*)::int as cnt from jsonb_array_elements(v_pick) x group by 1) q));
  end if;

  if v_rel is distinct from r.state -> 'relay' then
    update chase.rounds set state = state || jsonb_build_object('relay', v_rel)
     where session_id = p_session and idx = s.round_idx;
  end if;
end;
$$;

-- My part of the relay: my baton, my target, my team's runners.
create or replace function chase._relay_tick(p_player uuid, p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s     chase.sessions;
  v_p   chase.players;
  v_st  chase.player_stats;
  v_rel jsonb;
begin
  select * into s from chase.sessions where id = p_session;
  if s.status not in ('live', 'paused') or s.round_idx < 0
     or s.plan -> 'rounds' -> s.round_idx ->> 'mode' is distinct from 'relay' then
    return '{}'::jsonb;
  end if;
  select * into v_p from chase.players where id = p_player;
  if v_p.team_id is null or v_p.role = 'referee' then
    return '{}'::jsonb;
  end if;
  select state -> 'relay' into v_rel from chase.rounds where session_id = p_session and idx = s.round_idx;
  if v_rel is null then
    return '{}'::jsonb;
  end if;
  select * into v_st from chase.player_stats where player_id = p_player;
  return jsonb_build_object('relay', jsonb_build_object(
    'post', v_st.relay_post,
    'back', v_st.relay_back,
    'legs', v_st.round_relay,
    'target', case when v_st.relay_post is null then null
                   when v_st.relay_back then v_rel -> 'base'
                   else v_rel -> 'posts' -> v_st.relay_post::int -> 'pos' end,
    'runners', (select coalesce(jsonb_agg(jsonb_build_object('nickname', q.nickname, 'post', st.relay_post, 'back', st.relay_back)
                                          order by st.relay_since), '[]'::jsonb)
                  from chase.players q join chase.player_stats st on st.player_id = q.id
                 where q.team_id = v_p.team_id and q.status = 'active' and st.relay_post is not null)));
end;
$$;

-- ───────────────────────── hooks ─────────────────────────

do $$
begin
  if to_regprocedure('chase._mode_begin_p7(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _mode_begin_p7;
  end if;
  if to_regprocedure('chase._mode_finish_p7(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _mode_finish_p7;
  end if;
  if to_regprocedure('chase._mode_upkeep_p7(uuid)') is null then
    alter function chase._mode_upkeep_team(uuid) rename to _mode_upkeep_p7;
  end if;
  if to_regprocedure('chase._mode_tick_p7(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_p7;
  end if;
  if to_regprocedure('chase._round_view_p7(chase.sessions)') is null then
    alter function chase._round_view(chase.sessions) rename to _round_view_p7;
  end if;
end $$;

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  update chase.player_stats set round_relay = 0, relay_post = null, relay_back = false, relay_since = null
   where session_id = p_session and (round_relay <> 0 or relay_post is not null);
  perform chase._mode_begin_p7(p_session, p_at);
  if chase._is_fox(p_session) then
    perform chase._fox_begin(p_session, p_at);
  end if;
  perform chase._relay_begin(p_session, p_at);
end;
$$;

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s    chase.sessions;
  v_id uuid;
begin
  select * into s from chase.sessions where id = p_session;
  if chase._is_fox(p_session) then
    -- The fox at the whistle: +25 and «Rev» (0004's finish then banks its survival).
    for v_id in select id from chase.players where session_id = p_session and role = 'prey' and status = 'active' loop
      update chase.player_stats
         set points = points + chase.k8('fox_end_pts')::int, round_points = round_points + chase.k8('fox_end_pts')::int
       where player_id = v_id;
      perform chase._award_badges(v_id, array['fox']);
    end loop;
  elsif s.round_idx >= 0 and s.plan -> 'rounds' -> s.round_idx ->> 'mode' = 'relay' then
    update chase.player_stats st
       set team_acts = st.team_acts + st.round_relay, relay_post = null, relay_back = false
      from chase.players p
     where p.id = st.player_id and p.session_id = p_session and (st.round_relay > 0 or st.relay_post is not null);
    insert into chase.events (session_id, type, payload)
    values (p_session, 'relay_end', jsonb_build_object('legs', (
      select state -> 'relay' -> 'legs' from chase.rounds where session_id = p_session and idx = s.round_idx)));
  end if;
  perform chase._mode_finish_p7(p_session, p_at);
end;
$$;

create or replace function chase._mode_upkeep_team(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_upkeep_p7(p_session);
  perform chase._fox_upkeep(p_session);
  perform chase._relay_upkeep(p_session);
end;
$$;

-- 0011's throttled upkeep, now storing the team view per team.
create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_c jsonb;
begin
  if not chase._upkeep_due(p_session) then
    return;
  end if;
  perform chase._mode_upkeep_team(p_session);
  if exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    v_c := chase._team_cache_build(p_session);
    insert into chase.session_clock as c (session_id, team_cache, team_cache_at)
    values (p_session, jsonb_build_object('scores', v_c -> 'scores'), now())
    on conflict (session_id) do update set team_cache = excluded.team_cache, team_cache_at = excluded.team_cache_at;
    insert into chase.team_clock as c (team_id, session_id, view, at)
    select t.id, p_session, coalesce(v_c -> 'teams' -> (t.n::text), '{}'::jsonb), now()
      from chase.teams t where t.session_id = p_session and t.n is not null
    on conflict (team_id) do update set view = excluded.view, at = excluded.at;
  end if;
end;
$$;

-- 0011's team view: scores from the session row, my team from its own row,
-- the 20 nearest teammates.
create or replace function chase._team_tick(p_player uuid, p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_p     chase.players;
  v_t     chase.teams;
  v_sc    jsonb;
  v_tv    jsonb;
  v_c     jsonb;
  v_lat   double precision;
  v_lng   double precision;
  v_mine  int;
  v_out   jsonb;
begin
  if not exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    return '{}'::jsonb;
  end if;
  select * into v_p from chase.players where id = p_player;
  if v_p.role = 'referee' or v_p.status <> 'active' then
    return '{}'::jsonb;
  end if;
  if v_p.team_id is null then
    return chase._team_tick_full(p_player, p_session);   -- assigns me a team (rare)
  end if;
  select * into v_t from chase.teams where id = v_p.team_id;
  select * into s from chase.sessions where id = p_session;
  select c.team_cache -> 'scores' into v_sc from chase.session_clock c
   where c.session_id = p_session and c.team_cache_at > now() - interval '5 seconds';
  select c.view into v_tv from chase.team_clock c where c.team_id = v_t.id and c.at > now() - interval '5 seconds';
  if v_sc is null or v_tv is null then
    v_c := chase._team_cache_build(p_session);
    v_sc := v_c -> 'scores';
    v_tv := coalesce(v_c -> 'teams' -> (v_t.n::text), '{}'::jsonb);
  end if;
  select (x ->> 'points')::int into v_mine from jsonb_array_elements(v_sc) x where (x ->> 'n')::int = v_t.n;
  v_out := jsonb_build_object(
    'n', v_t.n, 'name', v_t.name, 'color', v_t.color, 'points', v_mine,
    'rank', 1 + (select count(*) from jsonb_array_elements(v_sc) x where (x ->> 'points')::int > v_mine),
    'of', jsonb_array_length(v_sc),
    'palette', (select jsonb_agg(jsonb_build_object('n', x -> 'n', 'name', x -> 'name', 'color', x -> 'color')
                                 order by (x ->> 'n')::int) from jsonb_array_elements(v_sc) x));
  if s.status in ('live', 'paused') and chase._is_team_round(s.plan -> 'rounds' -> s.round_idx) then
    select ST_Y(l.pos::geometry), ST_X(l.pos::geometry) into v_lat, v_lng from chase.player_live l where l.player_id = p_player;
    v_out := v_out || jsonb_build_object(
      'mates', chase._nearest((select coalesce(jsonb_agg(m), '[]'::jsonb)
                                 from jsonb_array_elements(v_tv -> 'mates') m
                                where m ->> 'nickname' <> v_p.nickname), v_lat, v_lng, chase.k8('mates_max')::int),
      'mates_total', greatest(0, coalesce(jsonb_array_length(v_tv -> 'mates'), 0) - 1),
      'msgs', (select coalesce(jsonb_agg(m || jsonb_build_object('me', m ->> 'nickname' = v_p.nickname)), '[]'::jsonb)
                 from jsonb_array_elements(v_tv -> 'msgs') m));
  end if;
  return jsonb_build_object('team', v_out);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_out  jsonb := coalesce(chase._mode_tick_p7(p_player, p_session, p_pos), '{}'::jsonb);
  v_role text;
  v_lat  double precision;
  v_lng  double precision;
  v_st   text;
begin
  if jsonb_typeof(v_out -> 'tag') = 'object' then
    if p_pos is not null then
      v_lat := ST_Y(p_pos::geometry);
      v_lng := ST_X(p_pos::geometry);
    end if;
    if jsonb_typeof(v_out -> 'tag' -> 'radar') = 'array' and jsonb_array_length(v_out -> 'tag' -> 'radar') > chase.k8('radar_max') then
      v_out := jsonb_set(v_out, '{tag,radar}', chase._nearest(v_out -> 'tag' -> 'radar', v_lat, v_lng, chase.k8('radar_max')::int));
    end if;
    if chase._is_fox(p_session) then
      select p.role, s.status into v_role, v_st
        from chase.players p join chase.sessions s on s.id = p.session_id where p.id = p_player;
      v_out := jsonb_set(v_out, '{tag,fox}', 'true'::jsonb);
      if v_role = 'prey' and v_st in ('live', 'paused') and p_pos is not null then
        v_out := jsonb_set(v_out, '{tag,hunter_pos}', chase._nearest((
          select coalesce(jsonb_agg(jsonb_build_object('pos', chase._latlng(l.pos))), '[]'::jsonb)
            from chase.player_live l join chase.players p on p.id = l.player_id
           where l.session_id = p_session and p.role = 'hunter' and p.status = 'active'
             and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
             and ST_DWithin(l.pos, p_pos, chase.k8('fox_radar_m'))), v_lat, v_lng, chase.k8('hunters_max')::int));
      end if;
    end if;
  end if;
  return v_out || chase._relay_tick(p_player, p_session);
end;
$$;

-- Round view: + the relay course and legs per team (live/paused only).
create or replace function chase._round_view(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when q.b is null then null else q.b || jsonb_build_object(
    'relay', (select (r.state -> 'relay') - 'next' - 'at'
                from chase.rounds r
               where r.session_id = s.id and r.idx = s.round_idx and jsonb_typeof(r.state -> 'relay') = 'object'
                 and r.ended_at is null and s.status in ('live', 'paused'))) end
    from (select chase._round_view_p7(s) as b) q;
$$;

-- ───────────────────────── «Avslutt»: the team caches hold positions ─────────────────────────
-- session_clock.team_cache (0011) and team_clock carry teammates' positions and
-- message positions. They are UNLOGGED, but rule 3 says positions go at the end
-- of the session, not 24 h later with the session row: delete them here.

do $$
begin
  if to_regprocedure('chase._end_session_p7(uuid)') is null then
    alter function chase._end_session(uuid) rename to _end_session_p7;
  end if;
end $$;

create or replace function chase._end_session(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._end_session_p7(p_session);
  delete from chase.team_clock where session_id = p_session;
  delete from chase.session_clock where session_id = p_session;
end;
$$;

-- Sessions that ended before this migration (0011 kept their cache).
delete from chase.session_clock c using chase.sessions s where s.id = c.session_id and s.status = 'ended';

-- ───────────────────────── catch: fox = swap ─────────────────────────

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

  if v_round ->> 'variant' in ('swap', 'fox') then
    -- Sisten / Sporing: roles swap; the old hunter is prey (the new fox) now, with immunity (no tag-back).
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
    'immune_until', case when v_round ->> 'variant' in ('swap', 'fox') then now() + make_interval(secs => chase.kt('immune_s')) end);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on chase.team_clock from public, anon, authenticated;
revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
