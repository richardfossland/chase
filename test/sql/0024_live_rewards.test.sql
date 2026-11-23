-- Assertions for 0024_live_rewards.sql: live streak and multiplier, silent time, reveal, survivor bonus only for the
-- live, lightning posts, team bonus, mark_away/away, signal loss unchanged. Runs in scripts/test-db.sh.
-- now() is constant inside a DO block: lv_at / fix_at / clocks are set by hand to simulate time.
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
create function pg_temp.place(p_tag text, p_i int, p_from geography, p_m float8, p_az float8 default 0) returns void language sql as $$
  update chase.player_live set pos = ST_Project(p_from, p_m, p_az)::geography, fix_at = now(), acc = 5
   where player_id = pg_temp.pid(p_tag, p_i)
$$;
-- Index of the first player (by number) with a role.
create function pg_temp.first_role(p_tag text, p_n int, p_role text, p_skip int default 0) returns int language sql as $$
  select i from generate_series(1, p_n) i
   where (select role from chase.players where id = pg_temp.pid(p_tag, i)) = p_role and i > p_skip
   order by i limit 1
$$;

-- ───────────────────────── pure rules (same vectors as test/live.test.ts) ─────────────────────────
do $$
begin
  assert array(select chase._live_mult(a) from unnest(array[0, 119.9, 120, 239, 240, 900]::float8[]) a) = array[1, 1, 1.25, 1.25, 1.5, 1.5]::numeric[], 'multiplier steps';
  assert array(select chase._live_next_s(a) from unnest(array[0, 100.2, 120, 239.5, 240]::float8[]) a) is not distinct from array[120, 20, 120, 1, null]::int[], 'next step';
  assert chase._live_bonus(10, 1.25, 0) = array[2, 0.5]::numeric[], 'bonus 10 @1.25';
  assert chase._live_bonus(3, 1.25, 0.5) = array[1, 0.25]::numeric[], 'bonus carries the fraction';
  assert chase._live_bonus(10, 1, 0) = array[0, 0]::numeric[], 'no bonus at x1';
  assert chase._live_bonus(-5, 1.5, 0.25) = array[0, 0.25]::numeric[], 'no bonus on a negative delta';
  assert chase._live_bonus(10, 1.5, 0) = array[5, 0]::numeric[], 'bonus 10 @1.5';
  assert chase.klv('gap_s') = 20 and chase.klv('reveal_s') = 20 and chase.kt('fix_fresh_s') = 20, 'gap = fresh = 20 s';
  raise notice '0024 pure rules: ok';
end $$;

-- ───────────────────────── Smittejakt: streak, multiplier, silent time, reveal, pause ─────────────────────────
do $$
declare
  s uuid; t jsonb; i int; v_h int; v_a int; v_b int; v_pts int; v_ctr geography := chase._pt(59.91045, 10.7509);
  v_start timestamptz; v_ids uuid[];
begin
  s := pg_temp.mk('lv', '{"rounds":[{"mode":"tag","variant":"convert","duration_s":600}],"countdown_s":0}', 8);
  -- Lobby: the ring is not on and nothing is revealed.
  t := pg_temp.tick('lv', 1);
  assert (t -> 'live' ->> 'on')::boolean = false and (t -> 'live' ->> 'frozen')::boolean = false and t -> 'live' ->> 'mult' = '1'
     and not (t ? 'tag'), 'lobby: live.on false, no tag: ' || t::text;
  perform pg_temp.act(s, 'lv', 'start');
  perform chase._advance(s);
  for i in 1 .. 8 loop t := pg_temp.tick('lv', i); end loop;
  v_h := pg_temp.first_role('lv', 8, 'hunter');
  v_a := pg_temp.first_role('lv', 8, 'prey');
  v_b := pg_temp.first_role('lv', 8, 'prey', v_a);
  assert v_h is not null and v_a is not null and v_b is not null, 'roles dealt';
  t := pg_temp.tick('lv', v_h);
  assert (t -> 'live' ->> 'on')::boolean and t -> 'live' ->> 'mult' = '1' and (t -> 'live' ->> 'frozen')::boolean = false, 'live on: ' || (t -> 'live')::text;
  assert (select lv_base from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_h)), 'base follows points';

  -- Streak: x1 → x1.25 at 2 min → x1.5 at 4 min; breaks after a gap > 20 s.
  update chase.player_live set lv_acc_s = 119, lv_at = now() - interval '5 seconds' where player_id = pg_temp.pid('lv', v_h);
  t := pg_temp.tick('lv', v_h);
  assert t -> 'live' ->> 'mult' = '1.25' and (t -> 'live' ->> 'streak_s')::int = 124 and (t -> 'live' ->> 'next_s')::int = 116, 'x1.25 at 124 s: ' || (t -> 'live')::text;
  update chase.player_live set lv_acc_s = 236, lv_at = now() - interval '5 seconds' where player_id = pg_temp.pid('lv', v_h);
  t := pg_temp.tick('lv', v_h);
  assert t -> 'live' ->> 'mult' = '1.5' and (t -> 'live' ->> 'streak_s')::int = 241 and t -> 'live' -> 'next_s' = 'null'::jsonb, 'x1.5 at 241 s: ' || (t -> 'live')::text;
  update chase.player_live set lv_at = now() - interval '30 seconds' where player_id = pg_temp.pid('lv', v_h);
  t := pg_temp.tick('lv', v_h);
  assert t -> 'live' ->> 'mult' = '1' and (t -> 'live' ->> 'streak_s')::int = 0, 'gap 30 s breaks the streak: ' || (t -> 'live')::text;
  assert (select best_streak_s from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 241, 'best streak kept';
  -- Exactly the gap limit keeps it.
  update chase.player_live set lv_acc_s = 50, lv_at = now() - interval '20 seconds' where player_id = pg_temp.pid('lv', v_h);
  t := pg_temp.tick('lv', v_h);
  assert (t -> 'live' ->> 'streak_s')::int = 70, '20 s gap keeps the streak: ' || (t -> 'live')::text;

  -- Multiplier on points: 10 points at x1.25 = +2 (fraction .5 carried); the teacher adjustment is not multiplied.
  update chase.player_live set lv_acc_s = 130, lv_at = now() - interval '5 seconds' where player_id = pg_temp.pid('lv', v_h);
  update chase.player_stats set points = 50, round_points = 50, lv_base = 40, lv_frac = 0 where player_id = pg_temp.pid('lv', v_h);
  t := pg_temp.tick('lv', v_h);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 52
     and (select round_points from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 52
     and (select lv_base from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 52
     and (select lv_frac from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 0.5, 'bonus 2, base follows';
  assert (t -> 'stats' ->> 'points')::int = 52, 'the answer carries the bonus: ' || (t -> 'stats')::text;
  assert (pg_temp.act(s, 'lv', 'adjust_points', jsonb_build_object('player_id', pg_temp.pid('lv', v_h), 'delta', 10, 'reason', 'test')) ->> 'ok')::boolean, 'adjust ok';
  update chase.player_live set lv_at = now() - interval '5 seconds' where player_id = pg_temp.pid('lv', v_h);
  perform pg_temp.tick('lv', v_h);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_h)) = 62, 'adjustment is not multiplied';

  -- Silent time does not count for survival points: a prey silent for 60 s earns nothing for those 60 s.
  v_start := now() - interval '100 seconds';
  update chase.player_stats set current_survival_start = v_start, surv_pts_stint = 8, lv_base = points, lv_frac = 0 where player_id = pg_temp.pid('lv', v_a);
  update chase.player_live set lv_acc_s = 50, lv_at = now() - interval '60 seconds' where player_id = pg_temp.pid('lv', v_a);
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('lv', v_a);
  t := pg_temp.tick('lv', v_a);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_a)) = v_pts, 'no survival points for the silent minute';
  assert (select current_survival_start from chase.player_stats where player_id = pg_temp.pid('lv', v_a)) = now() - interval '40 seconds', 'survival clock moved forward by the silence';
  assert (t -> 'live' ->> 'streak_s')::int = 0 and (select best_streak_s from chase.player_stats where player_id = pg_temp.pid('lv', v_a)) = 50, 'streak reset, best kept';
  -- A live tick keeps paying (control): 20 s more of live time = +4.
  update chase.player_live set lv_at = now() - interval '10 seconds' where player_id = pg_temp.pid('lv', v_a);
  update chase.player_stats set current_survival_start = now() - interval '40 seconds', surv_pts_stint = 8 where player_id = pg_temp.pid('lv', v_a);
  perform pg_temp.tick('lv', v_a);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_a)) = v_pts, 'same instant: nothing new';
  update chase.player_stats set current_survival_start = now() - interval '60 seconds' where player_id = pg_temp.pid('lv', v_a);
  perform pg_temp.tick('lv', v_a);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('lv', v_a)) = v_pts + 4, 'live time pays +1/5 s';

  -- Reveal: a prey with no tick for 25 s shows to hunters (exact last position, salted id); 10 s does not.
  perform pg_temp.place('lv', v_a, v_ctr, 0);
  update chase.player_live set lv_at = now() - interval '25 seconds' where player_id = pg_temp.pid('lv', v_b);
  update chase.player_live set lv_at = now() where player_id = pg_temp.pid('lv', v_a);
  t := pg_temp.tick('lv', v_h);
  assert jsonb_array_length(t -> 'tag' -> 'revealed') >= 1 and (t -> 'tag' -> 'revealed' -> 0 ->> 'age_s')::int = 25
     and (t -> 'tag' -> 'revealed' -> 0 -> 'pos' ->> 'lat') is not null
     and length(t -> 'tag' -> 'revealed' -> 0 ->> 'id') = 8
     and not exists (select 1 from jsonb_array_elements(t -> 'tag' -> 'revealed') e where (e ->> 'age_s')::int < 20), 'revealed after 20 s: ' || (t -> 'tag' -> 'revealed')::text;
  assert (select count(*) from jsonb_array_elements(t -> 'tag' -> 'revealed') e where (e ->> 'age_s')::int = 25) = 1, 'exactly the silent one';
  assert not (pg_temp.tick('lv', v_a) -> 'tag' ? 'revealed'), 'prey never get the list';
  -- The reveal is not shown for the prey themselves, hunters get an empty list when nobody is silent.
  update chase.player_live set lv_at = now() where session_id = s;
  t := pg_temp.tick('lv', v_h);
  assert t -> 'tag' -> 'revealed' = '[]'::jsonb, 'nobody silent: []';

  -- hunter_close: hunter 20 m away = close; 45 m = near but not close; 80 m = neither.
  perform pg_temp.tick('lv', v_a);
  perform pg_temp.place('lv', v_h, v_ctr, 20, 90);
  t := pg_temp.tick('lv', v_a);
  assert (t -> 'tag' ->> 'hunter_near')::boolean and (t -> 'tag' ->> 'hunter_close')::boolean, '20 m: close: ' || (t -> 'tag')::text;
  perform pg_temp.place('lv', v_h, v_ctr, 45, 90);
  t := pg_temp.tick('lv', v_a);
  assert (t -> 'tag' ->> 'hunter_near')::boolean and not (t -> 'tag' ->> 'hunter_close')::boolean, '45 m: near, not close: ' || (t -> 'tag')::text;
  perform pg_temp.place('lv', v_h, v_ctr, 80, 90);
  t := pg_temp.tick('lv', v_a);
  assert not (t -> 'tag' ->> 'hunter_near')::boolean and not (t -> 'tag' ->> 'hunter_close')::boolean, '80 m: neither';
  assert not (pg_temp.tick('lv', v_h) -> 'tag' ? 'hunter_close'), 'hunters get no hunter_close';

  -- Pause: the streak is frozen, nothing is revealed, and after the resume the distance counts from the resume.
  update chase.player_live set lv_acc_s = 100, lv_at = now() where player_id = pg_temp.pid('lv', v_h);
  update chase.player_live set lv_at = now() - interval '300 seconds' where player_id = pg_temp.pid('lv', v_b);
  perform pg_temp.act(s, 'lv', 'pause');
  t := pg_temp.tick('lv', v_h);
  assert not (t -> 'live' ->> 'on')::boolean and (t -> 'live' ->> 'frozen')::boolean and (t -> 'live' ->> 'streak_s')::int = 100, 'paused: frozen, streak kept: ' || (t -> 'live')::text;
  assert t -> 'tag' -> 'revealed' = '[]'::jsonb, 'no reveal while paused';
  update chase.player_live set lv_at = now() - interval '500 seconds' where player_id = pg_temp.pid('lv', v_h);
  perform pg_temp.act(s, 'lv', 'resume');
  assert (select lv_at from chase.player_live where player_id = pg_temp.pid('lv', v_h)) = now(), 'resume: distance counts from now';
  t := pg_temp.tick('lv', v_h);
  assert (t -> 'live' ->> 'on')::boolean and (t -> 'live' ->> 'streak_s')::int = 100, 'streak survives the pause: ' || (t -> 'live')::text;
  assert t -> 'tag' -> 'revealed' = '[]'::jsonb, 'nobody revealed right after the resume';
  -- Breather (set by hand): frozen, no reveal.
  update chase.player_live set lv_at = now() - interval '300 seconds' where player_id = pg_temp.pid('lv', v_b);
  update chase.sessions set status = 'breather' where id = s;
  t := pg_temp.tick('lv', v_h);
  assert (t -> 'live' ->> 'frozen')::boolean and not (t -> 'live' ->> 'on')::boolean, 'breather: frozen';
  assert not (t -> 'tag' ? 'revealed') or t -> 'tag' -> 'revealed' = '[]'::jsonb, 'no reveal in the breather';
  update chase.sessions set status = 'live' where id = s;
  raise notice '0024 Smittejakt live: ok';
end $$;

-- ───────────────────────── survivor bonus only for the live (Smittejakt convert) ─────────────────────────
do $$
declare
  s uuid; i int; v_a int; v_b int; v_pa int; v_pb int;
begin
  s := pg_temp.mk('sv', '{"rounds":[{"mode":"tag","variant":"convert","duration_s":600}],"countdown_s":0}', 8);
  perform pg_temp.act(s, 'sv', 'start');
  perform chase._advance(s);
  for i in 1 .. 8 loop perform pg_temp.tick('sv', i); end loop;
  v_a := pg_temp.first_role('sv', 8, 'prey');
  v_b := pg_temp.first_role('sv', 8, 'prey', v_a);
  select points into v_pa from chase.player_stats where player_id = pg_temp.pid('sv', v_a);
  select points into v_pb from chase.player_stats where player_id = pg_temp.pid('sv', v_b);
  update chase.player_live set lv_at = now() - interval '60 seconds' where player_id = pg_temp.pid('sv', v_b);   -- locked at the end
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'gathering', 'round over';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('sv', v_a)) = v_pa + 25, 'live survivor +25';
  assert (select 'survivor' = any(badges) from chase.player_stats where player_id = pg_temp.pid('sv', v_a)), 'live survivor badge';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('sv', v_b)) = v_pb, 'locked survivor: no bonus';
  assert (select round_points from chase.player_stats where player_id = pg_temp.pid('sv', v_b)) = (select round_points from chase.player_stats where player_id = pg_temp.pid('sv', v_a)) - 25, 'round points follow';
  assert (select not 'survivor' = any(badges) from chase.player_stats where player_id = pg_temp.pid('sv', v_b)), 'locked survivor: no badge';
  assert (select lv_base from chase.player_stats where player_id = pg_temp.pid('sv', v_a)) = (select points from chase.player_stats where player_id = pg_temp.pid('sv', v_a)), 'base absorbs the round end';
  raise notice '0024 survivor bonus: ok';
end $$;

-- ───────────────────────── Gjemsel: silent time, reveal after the release, survivor bonus ─────────────────────────
do $$
declare
  s uuid; t jsonb; i int; v_h int; v_a int; v_b int; v_pa int; v_pb int; v_pts int;
begin
  s := pg_temp.mk('gj', '{"rounds":[{"mode":"tag","variant":"hide","duration_s":600,"head_start_s":75}],"countdown_s":0}', 12);
  perform pg_temp.act(s, 'gj', 'start');
  perform chase._advance(s);
  for i in 1 .. 12 loop perform pg_temp.tick('gj', i); end loop;
  v_h := pg_temp.first_role('gj', 12, 'hunter');
  v_a := pg_temp.first_role('gj', 12, 'prey');
  v_b := pg_temp.first_role('gj', 12, 'prey', v_a);
  -- Before the release nobody is revealed, even when silent.
  update chase.player_live set lv_at = now() - interval '25 seconds' where player_id = pg_temp.pid('gj', v_b);
  t := pg_temp.tick('gj', v_h);
  assert t -> 'tag' -> 'revealed' = '[]'::jsonb, 'Gjemsel: no reveal before the release: ' || (t -> 'tag')::text;
  -- Release 200 s ago; hider A has hidden 150 s, 60 s of them silent (paid 10 at the last tick).
  update chase.rounds set state = jsonb_set(state, '{hide,release_at}', to_jsonb(now() - interval '200 seconds')) where session_id = s and idx = 0;
  update chase.player_stats set hs_since = now() - interval '150 seconds', hs_pts = 10, lv_base = points where player_id = pg_temp.pid('gj', v_a);
  -- Silent for 60 s of them: no hiding points for the silent minute (clock moves forward by the 60 s).
  update chase.player_live set lv_acc_s = 10, lv_at = now() - interval '60 seconds' where player_id = pg_temp.pid('gj', v_a);
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('gj', v_a);
  perform pg_temp.tick('gj', v_a);
  assert (select hs_since from chase.player_stats where player_id = pg_temp.pid('gj', v_a)) = now() - interval '90 seconds', 'hide clock moved by the silence';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('gj', v_a)) = v_pts, 'only 90 s of hiding counts: the silent minute pays nothing';
  -- A silent hider is revealed to the hunter after the release; the exact position replaces the pling.
  update chase.player_live set lv_at = now() - interval '25 seconds', still_since = now() - interval '200 seconds',
         still_anchor = pos, fix_at = now() where player_id = pg_temp.pid('gj', v_b);
  t := pg_temp.tick('gj', v_h);
  assert (select count(*) from jsonb_array_elements(t -> 'tag' -> 'revealed') e where (e ->> 'age_s')::int = 25) = 1, 'Gjemsel: revealed after the release: ' || (t -> 'tag')::text;
  assert not exists (select 1 from jsonb_array_elements(t -> 'tag' -> 'hide' -> 'still') p
                      join jsonb_array_elements(t -> 'tag' -> 'revealed') r on r ->> 'id' = p ->> 'id'), 'the pling is replaced by the exact position';
  -- Survivor points only for the live hider at the end.
  perform pg_temp.tick('gj', v_a);
  update chase.player_stats set hs_since = now() - interval '100 seconds', hs_pts = 10, lv_base = points where player_id in (pg_temp.pid('gj', v_a), pg_temp.pid('gj', v_b));
  select points into v_pa from chase.player_stats where player_id = pg_temp.pid('gj', v_a);
  select points into v_pb from chase.player_stats where player_id = pg_temp.pid('gj', v_b);
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  perform chase._advance(s);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('gj', v_a)) = v_pa + 25, 'live hider +25';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('gj', v_b)) = v_pb, 'locked hider: no survivor points';
  raise notice '0024 Gjemsel: ok';
end $$;

-- ───────────────────────── Postjakt: lightning posts ─────────────────────────
do $$
declare
  s uuid; t jsonb; i int; v_f chase.posts; v_lat float8; v_lng float8; v_pts int; v_adv jsonb; v_at timestamptz;
begin
  s := pg_temp.mk('fl', '{"rounds":[{"mode":"posts","duration_s":900}],"countdown_s":0}', 4);
  perform pg_temp.act(s, 'fl', 'start');
  perform chase._advance(s);
  for i in 1 .. 4 loop perform pg_temp.tick('fl', i); end loop;
  assert (select state ? 'flash_at' from chase.rounds where session_id = s and idx = 0), 'flash_at initialised at the round start';
  assert not exists (select 1 from chase.posts where session_id = s and kind = 'flash'), 'no lightning post yet';
  v_at := (select (state ->> 'flash_at')::timestamptz from chase.rounds where session_id = s and idx = 0);
  assert v_at between now() + interval '69 seconds' and now() + interval '111 seconds', 'first lightning post in 70–110 s: ' || v_at::text;

  -- Due: one appears (hint_all), 30 s, 25 points, 30–90 m from a live player, next one moved ~90 s on.
  update chase.rounds set state = jsonb_set(state, '{flash_at}', to_jsonb(now() - interval '1 second')) where session_id = s and idx = 0;
  v_adv := chase._advance(s);
  assert (v_adv ->> 'golden')::boolean, 'hint_all on a lightning post: ' || v_adv::text;
  select * into v_f from chase.posts where session_id = s and kind = 'flash';
  assert v_f.id is not null and v_f.value = 25 and v_f.claimed_by is null and v_f.expires_at = now() + interval '30 seconds', 'flash post: ' || coalesce(v_f::text, 'none');
  assert ST_Covers((select boundary from chase.sessions where id = s), v_f.pos), 'inside the area';
  assert (select min(ST_Distance(l.pos, v_f.pos)) from chase.player_live l where l.session_id = s) <= 90.5, 'within 90 m of a live player';
  assert (select (state ->> 'flash_at')::timestamptz from chase.rounds where session_id = s and idx = 0) between now() + interval '69 seconds' and now() + interval '111 seconds', 'next one in ~90 s';
  assert (select count(*) from chase.posts where session_id = s and kind = 'flash') = 1, 'only one';
  v_adv := chase._advance(s);
  assert (select count(*) from chase.posts where session_id = s and kind = 'flash') = 1, 'not again before the time';

  -- The tick shows it (kind + expires_at), and the host snapshot too.
  t := pg_temp.tick('fl', 1);
  assert exists (select 1 from jsonb_array_elements(t -> 'posts') p where p ->> 'kind' = 'flash' and p ->> 'expires_at' is not null and (p ->> 'value')::int = 25), 'tick posts[] has the flash post: ' || (t -> 'posts')::text;
  assert exists (select 1 from jsonb_array_elements(chase.host_snapshot(s, pg_temp.h('host-fl')) -> 'posts') p where p ->> 'kind' = 'flash'), 'host sees it';

  -- Claim like any post (two consecutive ticks inside).
  select ST_Y(v_f.pos::geometry), ST_X(v_f.pos::geometry) into v_lat, v_lng;
  select points into v_pts from chase.player_stats where player_id = pg_temp.pid('fl', 2);
  for i in 1 .. 3 loop
    t := pg_temp.tick('fl', 2, v_lat, v_lng);
    exit when t -> 'claimed' is not null and t -> 'claimed' <> 'null'::jsonb;
  end loop;
  assert t -> 'claimed' ->> 'kind' = 'flash' and (t -> 'claimed' ->> 'value')::int = 25, 'flash claimed: ' || t::text;
  assert (select points from chase.player_stats where player_id = pg_temp.pid('fl', 2)) = v_pts + 25, 'worth 25';
  assert (select claimed_by from chase.posts where id = v_f.id) = pg_temp.pid('fl', 2), 'claimed_by';

  -- Expiry: an unclaimed flash past its time is gone at the next upkeep.
  insert into chase.posts (session_id, round_idx, pos, radius_m, value, kind, expires_at)
  values (s, 0, chase._pt(59.91045, 10.7509), 12, 25, 'flash', now() - interval '1 second');
  perform chase._advance(s);
  assert (select count(*) from chase.posts where session_id = s and kind = 'flash' and claimed_by is null) = 0, 'expired flash is removed';
  -- Pause moves the schedule and the post time (rule 6).
  perform pg_temp.act(s, 'fl', 'pause');
  v_at := (select (state ->> 'flash_at')::timestamptz from chase.rounds where session_id = s and idx = 0);
  update chase.sessions set frozen_at = now() - interval '40 seconds' where id = s;
  perform pg_temp.act(s, 'fl', 'resume');
  assert (select (state ->> 'flash_at')::timestamptz from chase.rounds where session_id = s and idx = 0) = v_at + interval '40 seconds', 'pause shifts flash_at';
  raise notice '0024 lightning posts: ok';
end $$;

-- ───────────────────────── team bonus (Flaggjakt) ─────────────────────────
do $$
declare
  s uuid; i int; v_pos geography := chase._pt(59.91045, 10.7509); v_t1 uuid; v_t2 uuid; v_ids uuid[];
begin
  s := pg_temp.mk('t24', '{"rounds":[{"mode":"flag","duration_s":600}],"teams":2,"countdown_s":0}', 6);
  perform pg_temp.act(s, 't24', 'start');
  perform chase._advance(s);
  for i in 1 .. 6 loop perform pg_temp.tick('t24', i); end loop;
  select id into v_t1 from chase.teams where session_id = s and n = 1;
  select id into v_t2 from chase.teams where session_id = s and n = 2;
  assert (select lv_base from chase.teams where id = v_t1) = 0, 'team base starts at the points';
  -- Everybody live: +25 % on the team's own points (flag hold): 40 → 50.
  update chase.teams set points = points + 40 where id = v_t1;
  perform chase._advance(s);
  assert (select points from chase.teams where id = v_t1) = 50 and (select lv_base from chase.teams where id = v_t1) = 50, 'team bonus when all live: ' || (select points from chase.teams where id = v_t1);
  -- One team-2 member silent: no bonus, and the stretch is not banked for later.
  update chase.player_live set fix_at = now() - interval '30 seconds'
   where player_id = (select id from chase.players where team_id = v_t2 order by id limit 1);
  update chase.teams set points = points + 40 where id = v_t2;
  perform chase._advance(s);
  assert (select points from chase.teams where id = v_t2) = 40 and (select lv_base from chase.teams where id = v_t2) = 40, 'no team bonus when one is silent';
  update chase.player_live set fix_at = now() where session_id = s;
  perform chase._advance(s);
  assert (select points from chase.teams where id = v_t2) = 40, 'earlier stretch not paid retroactively';
  -- Only live players can take or hold a post: _team_in needs a fix <= 20 s old.
  update chase.player_live set pos = v_pos, fix_at = now(), acc = 5 where session_id = s;
  update chase.player_live set fix_at = now() - interval '30 seconds'
   where player_id = (select id from chase.players where team_id = v_t1 order by id limit 1);
  v_ids := chase._team_in(s, v_pos, 50, 1);
  assert cardinality(v_ids) = (select count(*) from chase.players where team_id = v_t1) - 1
     and not (select id from chase.players where team_id = v_t1 order by id limit 1) = any(v_ids), 'a silent player is not «in»';
  assert array_length(chase._team_counts(s, v_pos, 50), 1) = 2, 'counts per team';
  assert (chase._team_counts(s, v_pos, 50))[1] = cardinality(v_ids), 'counts agree (silent excluded)';
  raise notice '0024 team bonus: ok';
end $$;

-- ───────────────────────── 🔒 mark_away / away, signal loss unchanged ─────────────────────────
do $$
declare
  s uuid; t jsonb; i int; v_snap jsonb; v_row jsonb; v_hh text := pg_temp.h('host-aw');
begin
  s := pg_temp.mk('aw', '{"rounds":[{"mode":"posts","duration_s":900}],"countdown_s":0}', 3);
  perform pg_temp.act(s, 'aw', 'start');
  perform chase._advance(s);
  for i in 1 .. 3 loop perform pg_temp.tick('aw', i); end loop;
  assert chase.mark_away(s, pg_temp.h('wrong')) ->> 'error' = 'auth', 'mark_away: wrong token';
  assert chase.mark_away(gen_random_uuid(), pg_temp.h('tok-aw-1')) ->> 'error' = 'auth', 'mark_away: wrong session';
  assert not has_function_privilege('anon', 'chase.mark_away(uuid,text)', 'execute')
     and has_function_privilege('service_role', 'chase.mark_away(uuid,text)', 'execute'), 'mark_away grants';
  -- Not away before the page says so (the plain snapshot has no such key).
  v_snap := chase.host_snapshot_svc(s);
  assert (select bool_and((p ->> 'away')::boolean = false and p -> 'away_s' = 'null'::jsonb) from jsonb_array_elements(v_snap -> 'players') p), 'nobody away: ' || (v_snap -> 'players')::text;
  assert not (chase.host_snapshot(s, v_hh) -> 'players' -> 0 ? 'away'), 'host_snapshot itself is unchanged';
  -- Player 1 hides the page 12 s after the last fix.
  update chase.player_live set fix_at = now() - interval '12 seconds' where player_id = pg_temp.pid('aw', 1);
  assert (chase.mark_away(s, pg_temp.h('tok-aw-1')) ->> 'ok')::boolean, 'mark_away ok';
  v_snap := chase.host_snapshot_away(s, v_hh);
  select p into v_row from jsonb_array_elements(v_snap -> 'players') p where p ->> 'id' = pg_temp.pid('aw', 1)::text;
  assert (v_row ->> 'away')::boolean and (v_row ->> 'away_s')::int = 0, 'away in host_snapshot_away: ' || v_row::text;
  v_snap := chase.host_snapshot_svc(s);
  select p into v_row from jsonb_array_elements(v_snap -> 'players') p where p ->> 'id' = pg_temp.pid('aw', 1)::text;
  assert (v_row ->> 'away')::boolean, 'away in host_snapshot_svc';
  assert (select count(*) from jsonb_array_elements(v_snap -> 'players') p where (p ->> 'away')::boolean) = 1, 'only that one';
  assert chase.host_snapshot_away(s, pg_temp.h('wrong')) ->> 'error' = 'auth', 'wrong host token';
  -- A new fix clears it.
  update chase.player_live set away_at = now() - interval '1 second' where player_id = pg_temp.pid('aw', 1);
  perform pg_temp.tick('aw', 1);
  v_snap := chase.host_snapshot_svc(s);
  assert (select count(*) from jsonb_array_elements(v_snap -> 'players') p where (p ->> 'away')::boolean) = 0, 'a new fix clears away';

  -- Signal loss is untouched: raised after 60 s (not 20), with or without 🔒.
  update chase.sessions set live_since = now() - interval '300 seconds' where id = s;
  update chase.player_live set fix_at = now() - interval '45 seconds' where player_id = pg_temp.pid('aw', 2);
  perform chase.mark_away(s, pg_temp.h('tok-aw-2'));
  v_snap := chase.host_snapshot_away(s, v_hh);
  assert not exists (select 1 from jsonb_array_elements(v_snap -> 'alarms') a where a ->> 'kind' = 'signal'), 'no signal alarm at 45 s';
  update chase.player_live set fix_at = now() - interval '61 seconds' where player_id = pg_temp.pid('aw', 2);
  update chase.player_live set away_at = now() where player_id = pg_temp.pid('aw', 2);
  v_snap := chase.host_snapshot_away(s, v_hh);
  assert exists (select 1 from jsonb_array_elements(v_snap -> 'alarms') a where a ->> 'kind' = 'signal' and a ->> 'player_id' = pg_temp.pid('aw', 2)::text), 'signal alarm after 60 s (also with 🔒): ' || (v_snap -> 'alarms')::text;
  assert (v_snap ->> 'alert_host')::boolean, 'alert_host';
  assert exists (select 1 from jsonb_array_elements(v_snap -> 'players') p where p ->> 'id' = pg_temp.pid('aw', 2)::text and (p ->> 'away')::boolean and p ->> 'signal' = 'lost'), 'lost + away on the same player';
  raise notice '0024 away + signal: ok';
end $$;
