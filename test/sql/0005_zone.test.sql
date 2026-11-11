-- Assertions for 0005_zone.sql (krympende sone). Runs in scripts/test-db.sh.
-- Same ~100 × 100 m Oslo square. 1 m ≈ 0.00000898° lat, ≈ 0.00001793° lng.
-- Everything in one DO block shares now(), so "time passing" = moving stored
-- timestamps into the past.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.square() returns jsonb language sql as $$
  select '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}'::jsonb
$$;
create function pg_temp.assembly() returns jsonb language sql as
  $$ select '{"type":"Point","coordinates":[10.7509,59.91045]}'::jsonb $$;
create function pg_temp.mk(p_tag text, p_plan jsonb, p_players int) returns uuid language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null, pg_temp.square(), pg_temp.assembly(), null, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  for i in 1 .. p_players loop
    j := chase.join_session(r ->> 'pin', p_tag || '-' || i, pg_temp.h('tok-' || p_tag || '-' || i), pg_temp.h('res-' || p_tag || '-' || i));
    assert (j ->> 'ok')::boolean, 'mk join: ' || j::text;
  end loop;
  return (r ->> 'session_id')::uuid;
end $$;
create function pg_temp.pid(p_tag text, p_i int) returns uuid language sql as
  $$ select id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
-- Tick player i at an absolute lat/lng.
create function pg_temp.at(p_tag text, p_i int, p_lat double precision, p_lng double precision, p_acc real default 5)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_lat, p_lng, p_acc)
$$;
create function pg_temp.host(p_session uuid, p_tag text, p_action text) returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action) $$;
create function pg_temp.zone(p_session uuid) returns jsonb language sql as $$
  select r.state -> 'zone' from chase.rounds r join chase.sessions s on s.id = r.session_id and r.idx = s.round_idx
   where s.id = p_session
$$;
-- Move every phase time k (1-based) ≤ p_upto into the past, the rest stay.
create function pg_temp.reach(p_session uuid, p_upto int) returns void language sql as $$
  update chase.rounds r
     set state = jsonb_set(r.state, '{zone,at}', (
           select jsonb_agg(case when t.ord <= p_upto then to_jsonb(now() - interval '1 minute' * (10 - t.ord))
                                 else to_jsonb(t.x::timestamptz) end order by t.ord)
             from jsonb_array_elements_text(r.state -> 'zone' -> 'at') with ordinality t(x, ord)))
    from chase.sessions s
   where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx
$$;
-- The square's corner farthest from the zone centre (lat, lng).
create function pg_temp.far_corner(p_session uuid) returns double precision[] language sql as $$
  select array[c.lat, c.lng] from (values (59.91004, 10.75004), (59.91004, 10.75176), (59.91086, 10.75004), (59.91086, 10.75176)) c(lat, lng)
   order by ST_Distance(chase._pt(c.lat, c.lng), chase._zone_center(pg_temp.zone(p_session))) desc limit 1
$$;

-- ───────────────────────── pure maths: same vectors as test/zone.test.ts ─────────────────────────
do $$
declare z jsonb;
begin
  assert chase._zone_offsets(360) = array[90, 180, 270], 'offsets 360';
  assert chase._zone_offsets(90) = array[23, 45, 68], 'offsets 90 (half away from zero)';
  assert chase._zone_offsets(60) = array[15, 30, 45], 'offsets 60';
  assert chase._zone_radii(80, 10000) = array[80, 48.9, 39.9, 28.2]::float8[], 'radii 80/10000: ' || chase._zone_radii(80, 10000)::text;
  assert chase._zone_radii(30, 10000) = array[30, 30, 30, 28.2]::float8[], 'radii clamped to r0';
  assert chase._zone_radii(500, 100) = array[500, 20, 20, 20]::float8[], 'radii floor min_r';
  z := '{"r":[80,48.9,39.9,28.2],"at":["2026-11-11T10:01:30Z","2026-11-11T10:03:00Z","2026-11-11T10:04:30Z"]}';
  assert chase._zone_k(z, '2026-11-11T10:00:00Z') = 0 and chase._zone_r(z, '2026-11-11T10:00:00Z') = 80, 'phase 0';
  assert chase._zone_k(z, '2026-11-11T10:01:30Z') = 1 and chase._zone_r(z, '2026-11-11T10:01:30Z') = 48.9, 'phase 1 at the boundary';
  assert chase._zone_k(z, '2026-11-11T10:04:29Z') = 2, 'phase 2';
  assert chase._zone_k(z, '2026-11-11T11:00:00Z') = 3 and chase._zone_r(z, '2026-11-11T11:00:00Z') = 28.2, 'final';

  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"zone":true}]}') -> 'rounds' -> 0
         = '{"mode":"posts","duration_s":300,"zone":true}', 'zone kept';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","duration_s":300,"variant":"swap","zone":true}]}') -> 'rounds' -> 0 ->> 'zone' = 'true', 'tag + zone';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"zone":false}]}') -> 'rounds' -> 0
         = '{"mode":"posts","duration_s":300}', 'zone false dropped';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"zone":"yes"}]}') is null, 'zone must be boolean';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300,"zone":true}]}') is null, 'base rules still apply';
  raise notice '0005 maths + plan: ok';
end $$;

-- ───────────────────────── round start, view, penalty ─────────────────────────
do $$
declare s uuid; z jsonb; t jsonb; c double precision[]; st chase.player_stats; v_inner geography;
begin
  s := pg_temp.mk('zp', '{"rounds":[{"mode":"free","duration_s":360,"zone":true}],"countdown_s":0}', 2);
  perform pg_temp.host(s, 'zp', 'start');
  z := pg_temp.zone(s);
  assert z is not null, 'zone state at round start';
  assert jsonb_array_length(z -> 'r') = 4 and jsonb_array_length(z -> 'at') = 3, 'r[0..3], 3 phase times';
  assert (z -> 'at' ->> 0)::timestamptz = now() + interval '90 seconds', 'phase 1 at D/4';
  assert (z -> 'r' ->> 3)::float8 between 27 and 29.5, 'final ≈ 25 % of ~10 000 m²: ' || (z -> 'r' ->> 3);
  -- The final circle (≈ 28 m) fits: centre at least that far inside the edge (± rounding).
  v_inner := ST_Buffer((select boundary from chase.sessions where id = s), -27);
  assert ST_Covers(v_inner, chase._zone_center(z)), 'centre far enough inside';
  assert (z -> 'r' ->> 0)::float8 >= ST_Distance(chase._zone_center(z), chase._pt(59.91, 10.75)), 'r0 covers the corners';

  -- Phase 0 covers everything: a corner is inside, view is in the tick.
  c := pg_temp.far_corner(s);
  t := pg_temp.at('zp', 1, c[1], c[2]);
  assert (t -> 'zone' ->> 'inside')::boolean, 'phase 0 = whole area: ' || (t -> 'zone')::text;
  assert t -> 'round' -> 'zone' -> 'r' is not null and (t -> 'round' ->> 'zoned')::boolean, 'round view carries the zone';
  assert not (t -> 'round' -> 'zone') ? 'paid', 'bookkeeping not exposed';

  -- Final phase: the far corner is outside.
  perform pg_temp.reach(s, 3);
  update chase.rounds set state = jsonb_set(state, '{zone,paid}', '3') where session_id = s;
  update chase.player_stats set points = 10, round_points = 10 where player_id = pg_temp.pid('zp', 1);
  t := pg_temp.at('zp', 1, c[1], c[2]);
  assert not (t -> 'zone' ->> 'inside')::boolean, 'far corner outside the final circle';
  select * into st from chase.player_stats where player_id = pg_temp.pid('zp', 1);
  assert st.zone_out_since = now() and st.round_points = 10, 'first tick outside: clock starts, nothing taken yet';
  update chase.player_stats set zone_out_since = now() - interval '10 seconds' where player_id = pg_temp.pid('zp', 1);
  t := pg_temp.at('zp', 1, c[1], c[2]);
  select * into st from chase.player_stats where player_id = pg_temp.pid('zp', 1);
  assert st.round_points = 7 and st.points = 7 and st.round_zone_pen = 3 and st.zone_pen_stint = 3, '10 s outside → −3: ' || row_to_json(st)::text;
  assert (t -> 'zone' ->> 'pen')::int = 3, 'pen in the view';
  t := pg_temp.at('zp', 1, c[1], c[2]);
  select * into st from chase.player_stats where player_id = pg_temp.pid('zp', 1);
  assert st.round_points = 7, 'same clock, no double charge';
  update chase.player_stats set zone_out_since = now() - interval '100 seconds' where player_id = pg_temp.pid('zp', 1);
  perform pg_temp.at('zp', 1, c[1], c[2]);
  select * into st from chase.player_stats where player_id = pg_temp.pid('zp', 1);
  assert st.round_points = 0 and st.points = 0 and st.round_zone_pen = 10, 'never below 0 for the round: ' || row_to_json(st)::text;

  -- Back inside: clock resets.
  t := pg_temp.at('zp', 1, (z -> 'c' ->> 'lat')::float8, (z -> 'c' ->> 'lng')::float8);
  assert (t -> 'zone' ->> 'inside')::boolean and (t -> 'zone' ->> 'dist_m')::int <= 1, 'centre is inside';
  select * into st from chase.player_stats where player_id = pg_temp.pid('zp', 1);
  assert st.zone_out_since is null and st.zone_pen_stint = 0, 'inside resets the clock';

  -- Bad GPS: benefit of the doubt, no penalty.
  update chase.player_stats set points = 5, round_points = 5 where player_id = pg_temp.pid('zp', 2);
  t := pg_temp.at('zp', 2, c[1], c[2], 60);
  assert (t -> 'zone' ->> 'inside')::boolean, 'acc 60 m counts as inside';
  -- Sitting out: no penalty.
  perform chase.host_action(s, pg_temp.h('host-zp'), 'sit_out', jsonb_build_object('player_id', pg_temp.pid('zp', 2)));
  update chase.player_stats set zone_out_since = now() - interval '30 seconds' where player_id = pg_temp.pid('zp', 2);
  perform pg_temp.at('zp', 2, c[1], c[2]);
  assert (select round_points from chase.player_stats where player_id = pg_temp.pid('zp', 2)) = 5, 'sitting out pays nothing';
  raise notice '0005 start + view + penalty: ok';
end $$;

-- ───────────────────────── phase bonus, Sonemester, pause ─────────────────────────
do $$
declare s uuid; z jsonb; c double precision[]; a uuid; b uuid; at2 timestamptz;
begin
  s := pg_temp.mk('zb', '{"rounds":[{"mode":"free","duration_s":360,"zone":true}],"countdown_s":0}', 2);
  perform pg_temp.host(s, 'zb', 'start');
  z := pg_temp.zone(s);
  c := pg_temp.far_corner(s);
  a := pg_temp.pid('zb', 1); b := pg_temp.pid('zb', 2);
  perform pg_temp.at('zb', 1, (z -> 'c' ->> 'lat')::float8, (z -> 'c' ->> 'lng')::float8);
  perform pg_temp.at('zb', 2, c[1], c[2]);
  update chase.player_stats set points = 0, round_points = 0 where session_id = s;

  perform pg_temp.reach(s, 1);
  perform chase._zone_upkeep(s);
  assert (select round_points from chase.player_stats where player_id = a) = 5, 'inside at the phase change: +5';
  assert (select round_zone_hits from chase.player_stats where player_id = a) = 1, 'hit counted';
  -- r1 ≈ 49 m: the far corner (≥ 60 m from any allowed centre) is outside it.
  assert (select round_points from chase.player_stats where player_id = b) = 0, 'outside: no bonus';
  assert (pg_temp.zone(s) ->> 'paid')::int = 1, 'paid';
  assert (select count(*) from chase.events where session_id = s and type = 'zone_shrink') = 1, 'one shrink event';
  perform chase._zone_upkeep(s);
  assert (select round_points from chase.player_stats where player_id = a) = 5, 'idempotent';

  -- Pause 30 s before phase 2: phase times move by 30 s, reached ones stay.
  at2 := (pg_temp.zone(s) -> 'at' ->> 1)::timestamptz;
  perform pg_temp.host(s, 'zb', 'pause');
  update chase.sessions set frozen_at = frozen_at - interval '30 seconds' where id = s;
  perform pg_temp.host(s, 'zb', 'resume');
  assert (pg_temp.zone(s) -> 'at' ->> 1)::timestamptz = at2 + interval '30 seconds', 'pause shifts future phase times';
  assert (pg_temp.zone(s) -> 'at' ->> 0)::timestamptz < now(), 'reached phase stays reached';

  -- Phases 2 and 3 at once (catch-up): +10 more, all three hits → Sonemester.
  perform pg_temp.reach(s, 3);
  perform chase._zone_upkeep(s);
  assert (select round_points from chase.player_stats where player_id = a) = 15, 'catch-up pays every phase';
  assert (select 'zone_master' = any(badges) from chase.player_stats where player_id = a), 'Sonemester';
  assert not (select 'zone_master' = any(badges) from chase.player_stats where player_id = b), 'no Sonemester outside';
  raise notice '0005 bonus + badge + pause: ok';
end $$;

-- ───────────────────────── posts inside the circle, no zone otherwise ─────────────────────────
do $$
declare s uuid; z jsonb; t jsonb; n int;
begin
  s := pg_temp.mk('zo', '{"rounds":[{"mode":"posts","duration_s":360,"zone":true}],"countdown_s":0}', 12);
  perform pg_temp.host(s, 'zo', 'start');
  z := pg_temp.zone(s);
  select count(*) into n from chase.posts where session_id = s;
  assert n >= 3, 'posts spawned';
  assert not exists (select 1 from chase.posts where session_id = s
                      and not ST_DWithin(pos, chase._zone_center(z), (z -> 'r' ->> 1)::float8)), 'posts inside the next circle';
  perform pg_temp.reach(s, 3);
  perform chase._zone_upkeep(s);
  assert not exists (select 1 from chase.posts where session_id = s and claimed_by is null
                      and not ST_DWithin(pos, chase._zone_center(z), (z -> 'r' ->> 3)::float8)), 'posts outside the final circle removed';

  s := pg_temp.mk('zn', '{"rounds":[{"mode":"free","duration_s":360}],"countdown_s":0}', 1);
  perform pg_temp.host(s, 'zn', 'start');
  t := pg_temp.at('zn', 1, 59.91045, 10.7509);
  assert not t ? 'zone' and t -> 'round' -> 'zone' = 'null'::jsonb and not (t -> 'round' ->> 'zoned')::boolean, 'no zone without the flag';
  raise notice '0005 posts + off: ok';
end $$;
