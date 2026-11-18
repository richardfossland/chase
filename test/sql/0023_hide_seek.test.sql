-- Assertions for 0023_hide_seek.sql: Gjemsel (tag variant 'hide'). Runs in scripts/test-db.sh.
-- now() is constant inside a DO block: the release time, stillness and clocks are set by hand.
-- Same ~100 × 100 m Oslo square as the other tests; the assembly point is its centre.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.mk(p_tag text, p_plan jsonb, p_players int) returns uuid language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  for i in 1 .. p_players loop
    j := chase.join_session(r ->> 'pin', p_tag || '-' || i, pg_temp.h('tok-' || p_tag || '-' || i), pg_temp.h('res-' || p_tag || '-' || i));
    assert (j ->> 'ok')::boolean, 'mk join ' || i || ': ' || j::text;
  end loop;
  return (r ->> 'session_id')::uuid;
end $$;
create function pg_temp.pid(p_tag text, p_i int) returns uuid language sql as
  $$ select id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
create function pg_temp.tick(p_tag text, p_i int, p_lat float8 default 59.91045, p_lng float8 default 10.7509)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_lat, p_lng, 5)
$$;
create function pg_temp.act(p_session uuid, p_tag text, p_action text, p_payload jsonb default '{}') returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action, p_payload) $$;
create function pg_temp.hc(p_s uuid, p_tag text, p_i int, p_kind text) returns jsonb language sql as $$
  select chase.use_hotcold(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_s, p_kind)
$$;
create function pg_temp.catch(p_s uuid, p_tag text, p_i int, p_code text) returns jsonb language sql as $$
  select chase.catch(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_s, p_code)
$$;
create function pg_temp.place(p_tag text, p_i int, p_from geography, p_m float8, p_az float8 default 0) returns void language sql as $$
  update chase.player_live set pos = ST_Project(p_from, p_m, p_az)::geography, fix_at = now(), acc = 5
   where player_id = pg_temp.pid(p_tag, p_i)
$$;
-- The release moment, by hand.
create function pg_temp.release(p_s uuid, p_ago_s int) returns void language sql as $$
  update chase.rounds set state = jsonb_set(state, '{hide,release_at}', to_jsonb(now() - make_interval(secs => p_ago_s)))
   where session_id = p_s and idx = (select round_idx from chase.sessions where id = p_s)
$$;

-- ───────────────────────── pure rules (same vectors as test/hide.test.ts) ─────────────────────────
do $$
declare v jsonb; o real[];
begin
  assert array(select chase._hide_hunters(n) from unnest(array[0, 1, 2, 6, 7, 12, 13, 40, 300]) n) = array[1, 1, 1, 1, 2, 2, 3, 7, 50], 'hunters = ceil(n/6), at least 1';
  assert array(select chase._hide_points(s) from unnest(array[-5, 0, 59.9, 60, 119, 120, 305]::float8[]) s) = array[0, 0, 0, 10, 10, 20, 50], 'ten points per whole minute';
  assert chase._hide_released(null, now()) = false and chase._hide_released(now(), now()) and not chase._hide_released(now() + interval '1 s', now()), 'released';
  assert chase.kv('cooldown_s') = 30 and chase.kh('cooldown_s') = 60, 'cooldown shorter in Gjemsel';
  o := chase._hide_offset('abc');
  assert o[1] >= 0 and o[1] < 360 and o[2] between 20 and 70, 'offset range: ' || o::text;
  assert chase._hide_offset('abc') = o and chase._hide_offset('abd') <> o, 'offset is a pure function of the seed';
  assert (select bool_and(x[2] between 20 and 70 and x[1] >= 0 and x[1] < 360) from (select chase._hide_offset('s' || i) x from generate_series(1, 300) i) q), 'offset range, 300 seeds';
  -- Plans (twin: normPlan).
  v := chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300}]}');
  assert v -> 'rounds' -> 0 = '{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":75}', 'default head start: ' || coalesce(v::text, 'null');
  v := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":120},{"mode":"tag","variant":"hide","duration_s":240,"head_start_s":60},{"mode":"tag","variant":"convert","duration_s":120}]}');
  assert v -> 'rounds' -> 1 = '{"mode":"tag","variant":"hide","duration_s":240,"head_start_s":60}', 'head start 60: ' || coalesce(v::text, 'null');
  assert v -> 'rounds' -> 2 = '{"mode":"tag","variant":"convert","duration_s":120}', 'other tag rounds untouched';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":90}]}') -> 'rounds' -> 0 ->> 'head_start_s' = '90', 'head start 90';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":59}]}') is null, 'head start below 60';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":91}]}') is null, 'head start above 90';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":75.5}]}') is null, 'head start whole seconds';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":"75"}]}') is null, 'head start is a number';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":134,"head_start_s":75}]}') is null, 'round must run 60 s after the release';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":135,"head_start_s":75}]}') is not null, 'exactly 60 s after the release';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"zone":true}]}') is null, 'no zone';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"team":true}]}') is null, 'no team';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"practice":true}]}') is null, 'no practice Gjemsel';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"convert","duration_s":300,"head_start_s":75}]}') is null, 'head start only for Gjemsel';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"convert","duration_s":300,"practice":true}]}') is not null, 'practice Smittejakt still ok';
  -- Podium.
  v := chase._hide_podiums('[{"cat":"distance_m","entries":[]},{"cat":"scoreo","entries":[]},{"cat":"points","entries":[]}]',
         '[{"id":"b","hide":90},{"id":"a","hide":90},{"id":"c","hide":0},{"id":"d","hide":10}]');
  assert v = '[{"cat":"distance_m","entries":[]},{"cat":"hide","entries":[{"id":"a","value":90},{"id":"b","value":90},{"id":"d","value":10}]},{"cat":"scoreo","entries":[]},{"cat":"points","entries":[]}]', 'podium: ' || v::text;
  assert chase._hide_podiums('[{"cat":"points","entries":[]}]', '[{"id":"c","hide":0}]') = '[{"cat":"points","entries":[]}]', 'no podium without hiding';
  raise notice '0023 pure rules: ok';
end $$;

-- ───────────────────────── a Gjemsel round ─────────────────────────
do $$
declare
  s uuid; t jsonb; r jsonb; v_h int[] := '{}'; v_p int[] := '{}'; i int; v_base geography; v_anchor geography;
  v_pts int; v_ctr geography; v_code text; v_still jsonb; v_rel timestamptz; v_start timestamptz; v_cat text[];
begin
  s := pg_temp.mk('hd', '{"rounds":[{"mode":"tag","variant":"hide","duration_s":300,"head_start_s":75}],"countdown_s":0}', 12);
  assert (select count(*) from chase.rounds where session_id = s) = 0, 'no round yet';
  perform pg_temp.act(s, 'hd', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  for i in 1 .. 12 loop perform pg_temp.tick('hd', i); end loop;

  -- Roles: ceil(12 / 6) = 2 hunters, 10 hiders.
  for i in 1 .. 12 loop
    if (select role from chase.players where id = pg_temp.pid('hd', i)) = 'hunter' then v_h := v_h || i; else v_p := v_p || i; end if;
  end loop;
  assert cardinality(v_h) = 2 and cardinality(v_p) = 10, 'two hunters, ten hiders: ' || v_h::text;

  -- Release = round start + 75 s; the round view says so (live).
  select started_at, (state -> 'hide' ->> 'release_at')::timestamptz into v_start, v_rel from chase.rounds where session_id = s and idx = 0;
  assert extract(epoch from v_rel - v_start) = 75, 'release 75 s after the start';
  t := pg_temp.tick('hd', v_h[1]);
  assert t -> 'round' ->> 'variant' = 'hide' and (t -> 'round' -> 'hide' ->> 'head_start_s')::int = 75 and t -> 'round' -> 'hide' ->> 'release_at' is not null
     and (t -> 'round' -> 'hide' ->> 'cooldown_s')::int = 30, 'round view: ' || (t -> 'round')::text;
  assert (t -> 'tag' -> 'hide' ->> 'released')::boolean = false and (t -> 'tag' -> 'hide' -> 'still') = '[]', 'hunter: not released: ' || (t -> 'tag')::text;
  assert (t -> 'tag' ->> 'prey_near')::int = 0, 'no «Bytte i nærheten» in Gjemsel';
  t := pg_temp.tick('hd', v_p[1]);
  assert not (t -> 'tag' -> 'hide' ? 'still') and t -> 'tag' ->> 'code' is not null, 'hider: code, no pling list: ' || (t -> 'tag')::text;

  -- Before the release: no catch, no Snus/Termometer; hiders cannot use them at all; no events.
  v_code := (select catch_code from chase.players where id = pg_temp.pid('hd', v_p[1]));
  select pos::geography into v_base from chase.player_live where player_id = pg_temp.pid('hd', v_h[1]);
  perform pg_temp.place('hd', v_p[1], v_base, 5, 0);
  r := pg_temp.catch(s, 'hd', v_h[1], v_code);
  assert r ->> 'error' = 'not_yet', 'catch before the release: ' || r::text;
  assert (select role from chase.players where id = pg_temp.pid('hd', v_p[1])) = 'prey', 'still a hider';
  assert pg_temp.hc(s, 'hd', v_h[1], 'sniff') ->> 'error' = 'not_yet', 'Snus before the release';
  assert pg_temp.hc(s, 'hd', v_h[1], 'thermo') ->> 'error' = 'not_yet', 'Termometer before the release';
  assert pg_temp.hc(s, 'hd', v_p[1], 'sniff') ->> 'error' = 'not_useful', 'hiders cannot use the tools';
  assert pg_temp.act(s, 'hd', 'event_start', '{"kind":"sprint"}') ->> 'error' = 'hide', 'no events in Gjemsel';
  assert pg_temp.catch(s, 'hd', v_p[2], v_code) ->> 'error' = 'not_hunter', 'a hider cannot catch (unchanged)';
  update chase.player_stats set powerups = array['radar'] where player_id = pg_temp.pid('hd', v_h[1]);
  assert chase.use_powerup(pg_temp.pid('hd', v_h[1]), pg_temp.h('tok-hd-' || v_h[1]), s, 'radar') ->> 'error' = 'not_useful', 'no radar power-up in Gjemsel';
  assert (select powerups from chase.player_stats where player_id = pg_temp.pid('hd', v_h[1])) = array['radar'], 'the power-up is not spent';

  -- Hiders earn nothing before the release.
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2]);
  update chase.player_stats set hs_since = now() - interval '200 seconds' where player_id = pg_temp.pid('hd', v_p[2]);
  perform pg_temp.tick('hd', v_p[2]);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) = v_pts, 'no hiding points before the release';

  -- ── Release ──
  perform pg_temp.release(s, 1);
  update chase.player_stats set hs_since = now() - interval '130 seconds' where player_id = pg_temp.pid('hd', v_p[2]);
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2]);
  t := pg_temp.tick('hd', v_p[2]);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) >= v_pts + 20
     and (select hs_pts from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) = 20, 'two full minutes = 20 p';
  perform pg_temp.tick('hd', v_p[2]);
  assert (select hs_pts from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) = 20, 'not paid twice';
  assert (select current_survival_start is null from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])), '0004 accrual stays off';

  -- No radar ping of hiders (upkeep pings them in Smittejakt).
  for i in 1 .. 12 loop perform pg_temp.tick('hd', i); end loop;
  perform chase._advance(s);
  assert not exists (select 1 from chase.player_live where session_id = s and ping_pos is not null), 'no radar pings in Gjemsel';
  t := pg_temp.tick('hd', v_h[1]);
  assert (t -> 'tag' -> 'radar') = '[]'::jsonb, 'hunter radar is empty: ' || (t -> 'tag')::text;
  assert (t -> 'tag' -> 'hide' ->> 'released')::boolean, 'released';

  -- Snus works now, 30 s cooldown (not 60).
  for i in 1 .. 12 loop if i <> v_h[1] then perform pg_temp.place('hd', i, v_base, 300, 1); end if; end loop;
  perform pg_temp.place('hd', v_p[1], v_base, 40, 0);
  r := pg_temp.hc(s, 'hd', v_h[1], 'sniff');
  assert (r ->> 'ok')::boolean and (r ->> 'near')::boolean and (r ->> 'cooldown_s')::int = 30, 'snus after the release: ' || r::text;
  r := pg_temp.hc(s, 'hd', v_h[1], 'thermo');
  assert r ->> 'error' = 'cooldown' and (r ->> 'wait_s')::int = 30, 'cooldown 30: ' || r::text;
  update chase.player_live set hc_used_at = now() - interval '31 seconds' where player_id = pg_temp.pid('hd', v_h[1]);
  r := pg_temp.hc(s, 'hd', v_h[1], 'sniff');
  assert (r ->> 'ok')::boolean, 'ready again after 31 s (60 s in Smittejakt): ' || r::text;

  -- Stillness pling: 100 s still → a circle around a shifted point, never the position.
  v_anchor := (select pos::geography from chase.player_live where player_id = pg_temp.pid('hd', v_p[3]));
  perform pg_temp.place('hd', v_p[3], v_base, 120, 2);
  select pos::geography into v_anchor from chase.player_live where player_id = pg_temp.pid('hd', v_p[3]);
  update chase.player_live set still_anchor = pos, still_since = now() - interval '60 seconds' where player_id = pg_temp.pid('hd', v_p[3]);
  t := pg_temp.tick('hd', v_h[1]);
  assert t -> 'tag' -> 'hide' -> 'still' = '[]'::jsonb, '60 s still: no pling: ' || (t -> 'tag' -> 'hide')::text;
  update chase.player_live set still_since = now() - interval '100 seconds', fix_at = now() where player_id = pg_temp.pid('hd', v_p[3]);
  t := pg_temp.tick('hd', v_h[1]);
  v_still := t -> 'tag' -> 'hide' -> 'still';
  assert jsonb_array_length(v_still) = 1, 'one pling: ' || v_still::text;
  assert (v_still -> 0 ->> 'r_m')::int = 100 and (v_still -> 0 ->> 'age_s')::int = 10, 'radius 100, 10 s over: ' || v_still::text;
  v_ctr := ST_SetSRID(ST_MakePoint((v_still -> 0 -> 'pos' ->> 'lng')::float8, (v_still -> 0 -> 'pos' ->> 'lat')::float8), 4326)::geography;
  assert ST_Distance(v_ctr, v_anchor) between 19 and 71, 'centre shifted 20–70 m from the hider: ' || ST_Distance(v_ctr, v_anchor);
  assert ST_Distance(v_ctr, v_anchor) < 100, 'the hider is inside the circle';
  assert not (v_still::text like '%' || pg_temp.pid('hd', v_p[3])::text || '%'), 'no player id in the pling';
  -- Stable while the stillness lasts (no averaging out).
  assert (pg_temp.tick('hd', v_h[1]) -> 'tag' -> 'hide' -> 'still') = v_still, 'same pling on the next tick';
  -- Hiders get no pling list; the teacher view is unchanged (host_snapshot carries still_s as before).
  assert not (pg_temp.tick('hd', v_p[1]) -> 'tag' -> 'hide' ? 'still'), 'hiders do not get plings';
  -- Moving ends it.
  update chase.player_live set still_anchor = null, still_since = now() where player_id = pg_temp.pid('hd', v_p[3]);
  assert pg_temp.tick('hd', v_h[1]) -> 'tag' -> 'hide' -> 'still' = '[]'::jsonb, 'moving ends the pling';

  -- Catch after the release: GPS ≤ 30 m + code; the hider becomes a hunter (no permanent out), +15.
  perform pg_temp.place('hd', v_p[1], v_base, 5, 0);
  perform pg_temp.place('hd', v_h[1], v_base, 0, 0);
  update chase.player_stats set hs_since = now() - interval '95 seconds' where player_id = pg_temp.pid('hd', v_p[1]);
  v_code := (select catch_code from chase.players where id = pg_temp.pid('hd', v_p[1]));
  r := pg_temp.catch(s, 'hd', v_h[1], v_code);
  assert (r ->> 'ok')::boolean, 'catch: ' || r::text;
  assert (select role from chase.players where id = pg_temp.pid('hd', v_p[1])) = 'hunter', 'the caught hider hunts now';
  assert (select hide_best_s from chase.player_stats where player_id = pg_temp.pid('hd', v_p[1])) between 94 and 96
     and (select hs_since from chase.player_stats where player_id = pg_temp.pid('hd', v_p[1])) is null, 'time hidden banked';
  assert (select catches from chase.player_stats where player_id = pg_temp.pid('hd', v_h[1])) = 1, 'hunter counted';
  assert (select status from chase.sessions where id = s) = 'live', 'round goes on while hiders remain';

  -- Pause: the release and hiding clocks move with the pause (rule 6).
  select (state -> 'hide' ->> 'release_at')::timestamptz into v_rel from chase.rounds where session_id = s and idx = 0;
  perform pg_temp.release(s, 60);
  select (state -> 'hide' ->> 'release_at')::timestamptz into v_rel from chase.rounds where session_id = s and idx = 0;
  update chase.sessions set frozen_at = now() - interval '30 seconds' where id = s;
  perform chase._unfreeze(s);
  assert (select (state -> 'hide' ->> 'release_at')::timestamptz from chase.rounds where session_id = s and idx = 0) = v_rel, 'a past release does not move';
  assert (select hs_since from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) > now() - interval '110 seconds', 'hiding clock moved by the pause';
  perform pg_temp.release(s, -20);
  select (state -> 'hide' ->> 'release_at')::timestamptz into v_rel from chase.rounds where session_id = s and idx = 0;
  update chase.sessions set frozen_at = now() - interval '30 seconds' where id = s;
  perform chase._unfreeze(s);
  assert (select (state -> 'hide' ->> 'release_at')::timestamptz from chase.rounds where session_id = s and idx = 0) = v_rel + interval '30 seconds', 'a future release moves with the pause';
  perform pg_temp.release(s, 1);

  -- Round end: the hiders still free get +25 and their time; ceremony: «Mestergjemmer» before «Flest poeng».
  update chase.player_stats set hs_since = now() - interval '200 seconds' where player_id = pg_temp.pid('hd', v_p[2]);
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2]);
  update chase.sessions set phase_ends_at = now() where id = s;
  perform chase._advance(s);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) = v_pts + 25, 'survivors +25';
  assert (select hide_best_s from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2])) between 199 and 201, 'best hiding time: ' || (select hide_best_s from chase.player_stats where player_id = pg_temp.pid('hd', v_p[2]));
  assert (select count(*) from chase.player_stats where session_id = s and (hs_since is not null or hs_pts <> 0)) = 0, 'hide clocks cleared';
  assert (select status from chase.sessions where id = s) = 'gathering', 'round over: ' || (select status from chase.sessions where id = s);
  perform pg_temp.act(s, 'hd', 'ceremony_start', '{"spread":false}');
  select array_agg(pod ->> 'cat' order by ord) into v_cat from jsonb_array_elements((select podiums from chase.sessions where id = s)) with ordinality t(pod, ord);
  assert 'hide' = any(v_cat) and array_position(v_cat, 'hide') < array_position(v_cat, 'points'), 'Mestergjemmer before points: ' || v_cat::text;
  raise notice '0023 Gjemsel round: ok';
end $$;

-- ───────────────────────── everybody found ends the round; Smittejakt unchanged ─────────────────────────
do $$
declare s uuid; v_h int; v_p int; v_base geography; r jsonb; t jsonb;
begin
  s := pg_temp.mk('hd2', '{"rounds":[{"mode":"tag","variant":"hide","duration_s":300}],"countdown_s":0}', 2);
  perform pg_temp.act(s, 'hd2', 'start');
  perform chase._advance(s);
  perform pg_temp.tick('hd2', 1);
  perform pg_temp.tick('hd2', 2);
  select substring(nickname from 5)::int into v_h from chase.players where session_id = s and role = 'hunter';
  select substring(nickname from 5)::int into v_p from chase.players where session_id = s and role = 'prey';
  assert v_h is not null and v_p is not null, 'one hunter, one hider';
  perform pg_temp.release(s, 5);
  select pos::geography into v_base from chase.player_live where player_id = pg_temp.pid('hd2', v_h);
  perform pg_temp.place('hd2', v_p, v_base, 3, 0);
  r := pg_temp.catch(s, 'hd2', v_h, (select catch_code from chase.players where id = pg_temp.pid('hd2', v_p)));
  assert (r ->> 'ok')::boolean and (r ->> 'last')::boolean, 'the last hider found: ' || r::text;
  assert (select status from chase.sessions where id = s) = 'gathering', 'all found: the round is over';

  -- A plain Smittejakt round: no hide key, no 'not_yet', 60 s cooldown, radar as before.
  s := pg_temp.mk('hd3', '{"rounds":[{"mode":"tag","variant":"convert","duration_s":300}],"countdown_s":0}', 6);
  perform pg_temp.act(s, 'hd3', 'start');
  perform chase._advance(s);
  t := pg_temp.tick('hd3', 1);
  assert not (t -> 'tag' ? 'hide') and coalesce(t -> 'round' -> 'hide', 'null'::jsonb) = 'null'::jsonb, 'no hide data in Smittejakt: ' || (t -> 'tag')::text;
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 1, 'Smittejakt: ~15 % hunters (1 of 6)';
  assert pg_temp.act(s, 'hd3', 'event_start', '{"kind":"sprint"}') ->> 'error' is distinct from 'hide', 'events as before';
  raise notice '0023 Smittejakt unchanged: ok';
end $$;
