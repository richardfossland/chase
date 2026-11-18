-- Assertions for 0017_hotcold.sql: Snus og Termometer (varmere/kaldere).
-- now() is constant inside a DO block, so the cooldown and the anchor ages are set by hand.
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
create function pg_temp.tick(p_tag text, p_i int) returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), 59.91045, 10.7509, 5)
$$;
create function pg_temp.hc(p_s uuid, p_tag text, p_i int, p_kind text) returns jsonb language sql as $$
  select chase.use_hotcold(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_s, p_kind)
$$;
-- Put player i at `p_m` metres from `p_from` (azimuth 0 = north, pi = south), with a fresh fix.
create function pg_temp.place(p_tag text, p_i int, p_from geography, p_m float8, p_az float8 default 3.14159265) returns void language sql as $$
  update chase.player_live set pos = ST_Project(p_from, p_m, p_az)::geography, fix_at = now(), acc = 5
   where player_id = pg_temp.pid(p_tag, p_i)
$$;

-- ───────────────────────── pure: same vectors as test/hotcold.test.ts ─────────────────────────
do $$
begin
  assert array(select chase._sniff_answer(x) from unnest(array[0, 49, 50, 51, 200]::float8[]) x) = array[true, true, true, false, false], 'sniff';
  assert chase._thermo_answer(100, 80, 5) = 'warmer' and chase._thermo_answer(100, 120, 5) = 'colder', 'warmer/colder';
  assert chase._thermo_answer(100, 97, 5) = 'same' and chase._thermo_answer(100, 95, 5) = 'same' and chase._thermo_answer(100, 94, 5) = 'warmer', 'tie edge';
  assert chase._thermo_answer(100, 85, 20) = 'same' and chase._thermo_answer(100, 70, 20) = 'warmer' and chase._thermo_answer(100, 130, null) = 'colder', 'acc widens tie';
  assert chase._hc_check('sniff', 'tag', 'hunter') is null and chase._hc_check('thermo', 'tag', 'prey') is null, 'tag ok';
  assert chase._hc_check('thermo', 'posts', 'neutral') = 'not_useful' and chase._hc_check('sniff', 'tag', 'sitting_out') = 'not_useful'
     and chase._hc_check('sniff', 'tag', 'referee') = 'not_useful' and chase._hc_check('radar', 'tag', 'hunter') = 'bad_kind', 'checks';
  assert chase.kh('sniff_m') = 50 and chase.kh('cooldown_s') = 60, 'constants';
  raise notice '0017 pure rules: ok';
end $$;

-- ───────────────────────── Smittejakt: Snus, Termometer, nedkjøling ─────────────────────────
do $$
declare
  s uuid; r jsonb; v jsonb; i int; v_h int; v_p int; v_base geography; v_prey geography;
  v_keys_before text[]; v_keys_after text[];
begin
  s := pg_temp.mk('hc', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 6);
  -- Not live yet.
  r := pg_temp.hc(s, 'hc', 1, 'sniff');
  assert r ->> 'error' = 'not_now', 'lobby → not_now: ' || r::text;
  perform chase.host_action(s, pg_temp.h('host-hc'), 'start', '{}');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  for i in 1 .. 6 loop perform pg_temp.tick('hc', i); end loop;

  select substring(nickname from 4)::int into v_p from chase.players where session_id = s and role = 'prey' order by nickname limit 1;
  select substring(nickname from 4)::int into v_h from chase.players where session_id = s and role = 'hunter' order by nickname limit 1;
  assert v_p is not null and v_h is not null, 'has both roles';

  -- tick still returns the same fields (voice from 0015, plus the rest).
  v := pg_temp.tick('hc', v_h);
  assert (v ->> 'ok')::boolean and v ? 'voice' and v ? 'status', 'tick shape: ' || v::text;
  select array_agg(k order by k) into v_keys_before from jsonb_object_keys(v) k;
  assert 'tag' = any (v_keys_before) and 'voice' = any (v_keys_before), 'tag+voice in tick';

  -- Anchors are set by the tick (one value, no log).
  assert (select hc_pos is not null and hc_at is not null from chase.player_live where player_id = pg_temp.pid('hc', v_h)), 'anchor set by tick';
  assert (select hc_prev_pos is null from chase.player_live where player_id = pg_temp.pid('hc', v_h)), 'no previous anchor yet';

  -- Everybody else is far away: put prey at known spots relative to the hunter.
  select pos::geography into v_base from chase.player_live where player_id = pg_temp.pid('hc', v_h);
  -- Move every other player 300 m away, then the prey close.
  for i in 1 .. 6 loop
    if i <> v_h then perform pg_temp.place('hc', i, v_base, 300, 0); end if;
  end loop;

  -- Snus at 49 m → yes.
  perform pg_temp.place('hc', v_p, v_base, 49, 0);
  r := pg_temp.hc(s, 'hc', v_h, 'sniff');
  assert (r ->> 'ok')::boolean and (r ->> 'near')::boolean and (r ->> 'range_m')::int = 50, 'snus 49 m: ' || r::text;
  assert r ->> 'cooldown_s' = '60', 'cooldown reported';
  assert not (r::text ~* '(lat|lng|pos|coordinates)'), 'no position in the answer';
  assert (select payload from chase.events where type = 'hotcold' and actor_player_id = pg_temp.pid('hc', v_h)) = '{"kind":"sniff"}', 'event has only the kind';

  -- Cooldown: a second call at once, for either tool.
  r := pg_temp.hc(s, 'hc', v_h, 'thermo');
  assert r ->> 'error' = 'cooldown' and (r ->> 'wait_s')::int = 60, 'cooldown: ' || r::text;
  update chase.player_live set hc_used_at = now() - interval '45 seconds' where player_id = pg_temp.pid('hc', v_h);
  r := pg_temp.hc(s, 'hc', v_h, 'sniff');
  assert r ->> 'error' = 'cooldown' and (r ->> 'wait_s')::int = 15, 'wait 15 s: ' || r::text;
  update chase.player_live set hc_used_at = now() - interval '61 seconds' where player_id = pg_temp.pid('hc', v_h);

  -- Snus at 51 m → no. The nearest prey counts (second prey, if any, is 300 m away).
  perform pg_temp.place('hc', v_p, v_base, 51, 0);
  r := pg_temp.hc(s, 'hc', v_h, 'sniff');
  assert (r ->> 'ok')::boolean and not (r ->> 'near')::boolean, 'snus 51 m: ' || r::text;
  update chase.player_live set hc_used_at = null where player_id = pg_temp.pid('hc', v_h);

  -- Termometer without a baseline.
  r := pg_temp.hc(s, 'hc', v_h, 'thermo');
  assert r ->> 'error' = 'no_baseline', 'no baseline yet: ' || r::text;
  -- A baseline that is too fresh (10 s) or too old (90 s) does not count either.
  update chase.player_live set hc_prev_pos = ST_Project(v_base, 100, 3.14159265)::geography, hc_prev_at = now() - interval '10 seconds'
   where player_id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'thermo') ->> 'error' = 'no_baseline', 'too fresh';
  update chase.player_live set hc_prev_at = now() - interval '90 seconds' where player_id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'thermo') ->> 'error' = 'no_baseline', 'too old';

  -- Prey 100 m north of the hunter's position now; hunter was 100 m further south 30 s ago (200 m) → warmer.
  select pos::geography into v_prey from chase.player_live where player_id = pg_temp.pid('hc', v_p);
  perform pg_temp.place('hc', v_p, v_base, 100, 0);
  update chase.player_live set hc_prev_pos = ST_Project(v_base, 100, 3.14159265)::geography, hc_prev_at = now() - interval '30 seconds'
   where player_id = pg_temp.pid('hc', v_h);
  r := pg_temp.hc(s, 'hc', v_h, 'thermo');
  assert (r ->> 'ok')::boolean and r ->> 'trend' = 'warmer' and r ->> 'kind' = 'thermo', 'warmer: ' || r::text;
  assert not (r::text ~* '(lat|lng|pos|coordinates)'), 'no position in the thermo answer';

  -- Colder: 30 s ago I was 100 m north of where I am now (prey 100 m north of now → was 0 m from prey).
  update chase.player_live set hc_used_at = null, hc_prev_pos = ST_Project(v_base, 100, 0)::geography, hc_prev_at = now() - interval '30 seconds'
   where player_id = pg_temp.pid('hc', v_h);
  r := pg_temp.hc(s, 'hc', v_h, 'thermo');
  assert r ->> 'trend' = 'colder', 'colder: ' || r::text;
  -- Same: old position 3 m from the present one.
  update chase.player_live set hc_used_at = null, hc_prev_pos = ST_Project(v_base, 3, 0)::geography, hc_prev_at = now() - interval '30 seconds'
   where player_id = pg_temp.pid('hc', v_h);
  r := pg_temp.hc(s, 'hc', v_h, 'thermo');
  assert r ->> 'trend' = 'same', 'same: ' || r::text;

  -- Prey uses it too: nearest hunter is the target.
  r := pg_temp.hc(s, 'hc', v_p, 'sniff');
  assert (r ->> 'ok')::boolean, 'prey snus: ' || r::text;
  -- ... the hunter is 51 m? No: 100 m away now → no.
  assert not (r ->> 'near')::boolean, 'prey sees hunter 100 m away: ' || r::text;

  -- Bad GPS: my own acc over 25 m → bad_acc; a target with acc over 25 m is skipped.
  update chase.player_live set hc_used_at = null, acc = 30 where player_id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'bad_acc', 'own bad acc';
  update chase.player_live set acc = 25 where player_id = pg_temp.pid('hc', v_h);
  assert (pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'ok')::boolean, 'acc 25 is fine';
  update chase.player_live set hc_used_at = null where player_id = pg_temp.pid('hc', v_h);
  update chase.player_live set acc = 30 where session_id = s and player_id <> pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'no_target', 'targets with bad acc skipped';
  update chase.player_live set acc = 5 where session_id = s;
  -- Fix 15 s old (fresh for tick, too old here): no_fix for me, no_target when it is the targets' fix.
  update chase.player_live set fix_at = now() - interval '15 seconds' where player_id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'no_fix', '15 s old own fix';
  update chase.player_live set fix_at = now() where player_id = pg_temp.pid('hc', v_h);
  update chase.player_live set fix_at = now() - interval '15 seconds' where session_id = s and player_id <> pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'no_target', '15 s old target fix';
  update chase.player_live set fix_at = now() where session_id = s;

  -- Stale target: nobody with a fresh fix → no_target.
  update chase.player_live set hc_used_at = null where player_id = pg_temp.pid('hc', v_h);
  update chase.player_live set fix_at = now() - interval '120 seconds' where player_id <> pg_temp.pid('hc', v_h) and session_id = s;
  r := pg_temp.hc(s, 'hc', v_h, 'sniff');
  assert r ->> 'error' = 'no_target', 'no_target: ' || r::text;
  -- No fresh own fix.
  update chase.player_live set fix_at = now() - interval '120 seconds' where player_id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'no_fix', 'no_fix';

  -- Auth.
  r := chase.use_hotcold(pg_temp.pid('hc', v_h), pg_temp.h('wrong'), s, 'sniff');
  assert r ->> 'error' = 'auth', 'bad token';
  r := chase.use_hotcold(pg_temp.pid('hc', v_h), pg_temp.h('tok-hc-' || v_h), gen_random_uuid(), 'sniff');
  assert r ->> 'error' = 'not_found', 'wrong session';
  assert pg_temp.hc(s, 'hc', v_h, 'radar') ->> 'error' = 'bad_kind', 'bad kind';

  -- Roles: a sitting-out player cannot use it.
  update chase.players set role = 'sitting_out' where id = pg_temp.pid('hc', v_h);
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'not_useful', 'sitting out';
  update chase.players set role = 'hunter' where id = pg_temp.pid('hc', v_h);

  -- Paused / frozen: not now.
  update chase.sessions set frozen_at = now() where id = s;
  assert pg_temp.hc(s, 'hc', v_h, 'sniff') ->> 'error' = 'not_now', 'frozen → not_now';
  update chase.sessions set frozen_at = null where id = s;

  -- Anchor rotation in tick: an anchor older than 20 s is pushed to «previous».
  update chase.player_live set fix_at = now(), hc_at = now() - interval '25 seconds',
         hc_pos = ST_Project(v_base, 77, 1.0)::geography, hc_prev_pos = null, hc_prev_at = null
   where player_id = pg_temp.pid('hc', v_h);
  perform pg_temp.tick('hc', v_h);
  assert (select hc_prev_at = now() - interval '25 seconds' and ST_Distance(hc_prev_pos, ST_Project(v_base, 77, 1.0)::geography) < 0.01
                 and hc_at = now() from chase.player_live where player_id = pg_temp.pid('hc', v_h)), 'anchor rotated';
  -- A young anchor (5 s) is left alone.
  update chase.player_live set hc_at = now() - interval '5 seconds' where player_id = pg_temp.pid('hc', v_h);
  perform pg_temp.tick('hc', v_h);
  assert (select hc_at = now() - interval '5 seconds' from chase.player_live where player_id = pg_temp.pid('hc', v_h)), 'young anchor kept';

  -- tick_batch still gives each entry the same view (incl. voice).
  v := chase.tick_batch(s, jsonb_build_array(jsonb_build_object('player', pg_temp.pid('hc', v_h), 'token_hash', pg_temp.h('tok-hc-' || v_h),
        'lat', 59.91045, 'lng', 10.7509, 'acc', 5, 'speed', null, 'client_ts', null, 'steps', null)));
  assert (v -> 'results' -> 0 -> 'r' ->> 'ok')::boolean and v -> 'results' -> 0 -> 'r' ? 'voice', 'tick_batch: ' || v::text;

  -- End of session deletes the anchors with player_live.
  assert (select count(*) from chase.player_live where session_id = s and hc_pos is not null) > 0, 'anchors exist before end';
  perform chase._end_session(s);
  assert (select count(*) from chase.player_live where session_id = s) = 0, 'player_live gone → anchors gone';
  raise notice '0017 Smittejakt: ok';
end $$;

-- ───────────────────────── Sporing: reven er målet ─────────────────────────
do $$
declare s uuid; r jsonb; v_fox int; v_h int; i int; v_base geography;
begin
  s := pg_temp.mk('hf', '{"rounds":[{"mode":"tag","variant":"fox","duration_s":300}],"countdown_s":0}', 5);
  perform chase.host_action(s, pg_temp.h('host-hf'), 'start', '{}');
  perform chase._advance(s);
  for i in 1 .. 5 loop perform pg_temp.tick('hf', i); end loop;
  select substring(nickname from 4)::int into v_fox from chase.players where session_id = s and role = 'prey';
  v_h := case when v_fox = 1 then 2 else 1 end;
  select pos::geography into v_base from chase.player_live where player_id = pg_temp.pid('hf', v_h);
  for i in 1 .. 5 loop
    if i <> v_h then perform pg_temp.place('hf', i, v_base, 200, 0); end if;
  end loop;
  perform pg_temp.place('hf', v_fox, v_base, 30, 0);
  r := pg_temp.hc(s, 'hf', v_h, 'sniff');
  assert (r ->> 'near')::boolean, 'hunter finds the fox: ' || r::text;
  -- The fox's target is the nearest hunter (this one, 30 m away).
  r := pg_temp.hc(s, 'hf', v_fox, 'sniff');
  assert (r ->> 'near')::boolean, 'fox finds the nearest hunter: ' || r::text;
  perform chase._end_session(s);
  raise notice '0017 Sporing: ok';
end $$;

-- ───────────────────────── andre moduser: avvist ─────────────────────────
do $$
declare s uuid; r jsonb;
begin
  s := pg_temp.mk('hp', '{"rounds":[{"mode":"free","duration_s":300}],"countdown_s":0}', 2);
  perform chase.host_action(s, pg_temp.h('host-hp'), 'start', '{}');
  perform chase._advance(s);
  perform pg_temp.tick('hp', 1);
  r := pg_temp.hc(s, 'hp', 1, 'sniff');
  assert r ->> 'error' = 'not_useful', 'free round: ' || r::text;
  perform chase._end_session(s);
  raise notice '0017 other modes: ok';
end $$;
