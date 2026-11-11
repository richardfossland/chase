-- Assertions for 0006_ceremony_overrides.sql. Runs in scripts/test-db.sh.
-- Same ~100 × 100 m Oslo square as the other tests.
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
create function pg_temp.tick(p_tag text, p_i int, p_speed real default null) returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), 59.91045, 10.7509, 5, p_speed)
$$;
create function pg_temp.act(p_session uuid, p_tag text, p_action text, p_payload jsonb default '{}') returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action, p_payload) $$;

-- ───────────────────────── pure: same vector as test/podiums.test.ts ─────────────────────────
do $$
declare rows jsonb; r jsonb;
begin
  rows := '[
    {"id":"a","points":100,"distance_m":1200,"active_s":900,"catches":3,"survival_s":50,"posts":4,"explorer":30,"comeback":20},
    {"id":"b","points":90,"distance_m":1500,"active_s":950,"catches":0,"survival_s":120,"posts":6,"explorer":10,"comeback":0},
    {"id":"c","points":80,"distance_m":800,"active_s":600,"catches":5,"survival_s":0,"posts":2,"explorer":25,"comeback":40},
    {"id":"d","points":10,"distance_m":100,"active_s":30,"catches":0,"survival_s":0,"posts":0,"explorer":2,"comeback":0},
    {"id":"e","points":0,"distance_m":0,"active_s":0,"catches":0,"survival_s":0,"posts":0,"explorer":0,"comeback":0}]';

  r := chase._podiums_from(rows, false);
  assert r -> 'podiums' = '[
    {"cat":"explorer","entries":[{"id":"a","value":30},{"id":"c","value":25},{"id":"b","value":10}]},
    {"cat":"comeback","entries":[{"id":"c","value":40},{"id":"a","value":20}]},
    {"cat":"posts","entries":[{"id":"b","value":6},{"id":"a","value":4},{"id":"c","value":2}]},
    {"cat":"survival_s","entries":[{"id":"b","value":120},{"id":"a","value":50}]},
    {"cat":"catches","entries":[{"id":"c","value":5},{"id":"a","value":3}]},
    {"cat":"active_s","entries":[{"id":"b","value":950},{"id":"a","value":900},{"id":"c","value":600}]},
    {"cat":"distance_m","entries":[{"id":"b","value":1500},{"id":"a","value":1200},{"id":"c","value":800}]},
    {"cat":"points","entries":[{"id":"a","value":100},{"id":"b","value":90},{"id":"c","value":80}]}]'::jsonb,
    'no spreading: ' || (r -> 'podiums')::text;

  r := chase._podiums_from(rows, true, '["r1"]');
  assert r -> 'podiums' = '[
    {"cat":"referee","entries":[{"id":"r1","value":null}]},
    {"cat":"explorer","entries":[{"id":"d","value":2}]},
    {"cat":"active_s","entries":[{"id":"d","value":30}]},
    {"cat":"distance_m","entries":[{"id":"b","value":1500},{"id":"a","value":1200},{"id":"c","value":800}]},
    {"cat":"points","entries":[{"id":"a","value":100},{"id":"b","value":90},{"id":"c","value":80}]}]'::jsonb,
    'spreading (max 2 each) + referee first: ' || (r -> 'podiums')::text;

  assert r -> 'best' = '{
    "a":{"cat":"points","share":20,"value":100},
    "b":{"cat":"distance_m","share":20,"value":1500},
    "c":{"cat":"catches","share":20,"value":5},
    "d":{"cat":"distance_m","share":null,"value":100},
    "e":{"cat":"joined","share":null,"value":null}}'::jsonb, 'best cards: ' || (r -> 'best')::text;
  assert chase._podiums_from('[]', true) = '{"podiums":[],"best":{}}', 'empty class';
  raise notice '0006 podiums + best: ok';
end $$;

-- ───────────────────────── ceremony flow + vote + summary ─────────────────────────
do $$
declare s uuid; r jsonb; t jsonb; n int; sm chase.session_summaries;
begin
  s := pg_temp.mk('cer6', '{"rounds":[{"mode":"free","duration_s":300},{"mode":"free","duration_s":300}],"countdown_s":0}', 3);
  perform pg_temp.act(s, 'cer6', 'start');
  perform pg_temp.tick('cer6', 1); perform pg_temp.tick('cer6', 2); perform pg_temp.tick('cer6', 3);
  update chase.player_stats set points = 50, round_points = 50, distance_m = 900, active_s = 400 where player_id = pg_temp.pid('cer6', 1);
  update chase.player_stats set points = 30, round_points = 30, distance_m = 1100, active_s = 500 where player_id = pg_temp.pid('cer6', 2);

  r := pg_temp.act(s, 'cer6', 'ceremony_start');
  assert r ->> 'error' = 'bad_state', 'no ceremony while live';
  -- Gather mid-round: the ceremony closes the round first.
  perform pg_temp.act(s, 'cer6', 'gather');
  r := pg_temp.act(s, 'cer6', 'ceremony_start');
  assert (r ->> 'ok')::boolean and r ->> 'status' = 'ceremony', 'ceremony starts from gathering: ' || r::text;
  assert (select ended_at is not null from chase.rounds where session_id = s and idx = 0), 'open round closed';
  assert (select per_round ? '0' from chase.player_stats where player_id = pg_temp.pid('cer6', 1)), 'round snapshotted';
  select jsonb_array_length(podiums) into n from chase.sessions where id = s;
  assert n >= 3, 'podiums frozen: ' || n;
  assert (select count(*) from chase.player_stats where session_id = s and best is not null) = 3, 'everyone has a card';

  t := pg_temp.tick('cer6', 1);
  assert t -> 'ceremony' ->> 'step' = '0' and jsonb_array_length(t -> 'ceremony' -> 'revealed') = 0, 'intro: nothing revealed';
  assert t -> 'ceremony' -> 'best' = 'null'::jsonb, 'card only after the podiums';
  perform pg_temp.act(s, 'cer6', 'ceremony_next');
  t := pg_temp.tick('cer6', 1);
  assert jsonb_array_length(t -> 'ceremony' -> 'revealed') = 1, 'one revealed';
  assert t -> 'ceremony' -> 'revealed' -> 0 -> 'entries' -> 0 ? 'nickname'
     and not (t -> 'ceremony' -> 'revealed' -> 0 -> 'entries' -> 0) ? 'id', 'nicknames, never ids';
  for i in 1 .. n + 3 loop perform pg_temp.act(s, 'cer6', 'ceremony_next'); end loop;
  assert (select ceremony_step from chase.sessions where id = s) = n + 1, 'step capped at podiums + 1';
  t := pg_temp.tick('cer6', 2);
  assert t -> 'ceremony' -> 'best' ->> 'cat' is not null, 'card shown at the end: ' || (t -> 'ceremony')::text;
  perform pg_temp.act(s, 'cer6', 'ceremony_back');
  assert (select ceremony_step from chase.sessions where id = s) = n, 'back';

  r := pg_temp.act(s, 'cer6', 'adjust_points', jsonb_build_object('player_id', pg_temp.pid('cer6', 1), 'delta', 5, 'reason', 'x'));
  assert r ->> 'error' = 'bad_state', 'podiums frozen: no adjusting in the ceremony';

  -- «Vil spille igjen»: counted once per phone, anonymous.
  r := chase.vote_again(pg_temp.pid('cer6', 1), pg_temp.h('tok-cer6-1'), s, true);
  assert (r ->> 'ok')::boolean, 'vote';
  r := chase.vote_again(pg_temp.pid('cer6', 1), pg_temp.h('tok-cer6-1'), s, false);
  assert (r ->> 'already')::boolean, 'second vote ignored';
  perform chase.vote_again(pg_temp.pid('cer6', 2), pg_temp.h('tok-cer6-2'), s, false);
  assert chase.vote_again(pg_temp.pid('cer6', 3), pg_temp.h('nope'), s, true) ->> 'error' = 'auth', 'auth';
  perform pg_temp.act(s, 'cer6', 'vote_again', '{"yes":true}');
  assert (select (again_yes, again_no, teacher_again) = (1, 1, true) from chase.sessions where id = s), 'counts';
  r := chase.host_snapshot(s, pg_temp.h('host-cer6'));
  assert r -> 'ceremony' -> 'again' = '{"yes":1,"no":1,"teacher":true}', 'teacher sees the count: ' || (r -> 'ceremony')::text;

  r := chase.end_session(s, pg_temp.h('host-cer6'), true);
  assert (r ->> 'ok')::boolean, 'end from the ceremony';
  select * into sm from chase.session_summaries order by created_at desc limit 1;
  assert sm.again_yes = 1 and sm.again_no = 1 and sm.teacher_again, 'anonymous summary keeps the counts';
  assert chase.vote_again(pg_temp.pid('cer6', 3), pg_temp.h('tok-cer6-3'), s, true) ->> 'error' = 'not_now', 'no voting after the end';
  raise notice '0006 ceremony + vote + summary: ok';
end $$;

-- ───────────────────────── overrides ─────────────────────────
do $$
declare s uuid; r jsonb; p uuid;
begin
  s := pg_temp.mk('ovr6', '{"rounds":[{"mode":"free","duration_s":300}],"countdown_s":0}', 2);
  perform pg_temp.act(s, 'ovr6', 'start');
  p := pg_temp.pid('ovr6', 1);
  r := pg_temp.act(s, 'ovr6', 'adjust_points', jsonb_build_object('player_id', p, 'delta', 10, 'reason', 'Hjalp en medelev'));
  assert (r ->> 'ok')::boolean, 'adjust: ' || r::text;
  assert (select (points, round_points) = (10, 10) from chase.player_stats where player_id = p), '+10';
  assert exists (select 1 from chase.events where session_id = s and type = 'host:adjust_points'
                  and payload ->> 'reason' = 'Hjalp en medelev' and (payload ->> 'delta')::int = 10), 'logged with reason';
  perform pg_temp.act(s, 'ovr6', 'adjust_points', jsonb_build_object('player_id', p, 'delta', -50, 'reason', 'Juks'));
  assert (select points from chase.player_stats where player_id = p) = 0, 'never below 0';
  assert pg_temp.act(s, 'ovr6', 'adjust_points', jsonb_build_object('player_id', p, 'delta', 5)) ->> 'error' = 'bad_adjust', 'reason required';
  assert pg_temp.act(s, 'ovr6', 'adjust_points', jsonb_build_object('player_id', p, 'delta', 500, 'reason', 'x')) ->> 'error' = 'bad_adjust', 'capped';
  assert pg_temp.act(s, 'ovr6', 'set_role', jsonb_build_object('player_id', p, 'role', 'hunter')) ->> 'error' = 'bad_state', 'no hunter outside Smittejakt';

  -- Referee + «Beste dommer».
  r := pg_temp.act(s, 'ovr6', 'set_role', jsonb_build_object('player_id', p, 'role', 'referee'));
  assert (select role from chase.players where id = p) = 'referee', 'referee';
  perform pg_temp.act(s, 'ovr6', 'referee_award', jsonb_build_object('player_id', p));
  assert (select best_referees = array[p] from chase.sessions where id = s), 'award';
  assert chase.host_snapshot(s, pg_temp.h('host-ovr6')) -> 'referee_awards' = jsonb_build_array(p), 'award in snapshot';
  perform pg_temp.act(s, 'ovr6', 'referee_award', jsonb_build_object('player_id', p, 'on', false));
  assert (select best_referees = '{}' from chase.sessions where id = s), 'award removed';
  perform pg_temp.act(s, 'ovr6', 'set_role', jsonb_build_object('player_id', p, 'role', 'player'));
  assert (select role from chase.players where id = p) = 'neutral', 'back to playing';

  -- Speed flag: > 25 km/h for 10 s → 'speed' alarm, no position.
  perform pg_temp.tick('ovr6', 2, 9);
  assert (select fast_since = now() from chase.player_live where player_id = pg_temp.pid('ovr6', 2)), 'fast clock starts';
  assert not exists (select 1 from chase.alarms where player_id = pg_temp.pid('ovr6', 2) and kind = 'speed'), 'not yet';
  update chase.player_live set fast_since = now() - interval '11 seconds' where player_id = pg_temp.pid('ovr6', 2);
  perform pg_temp.tick('ovr6', 2, 9);
  assert exists (select 1 from chase.alarms where player_id = pg_temp.pid('ovr6', 2) and kind = 'speed' and pos is null and level = 1), 'speed flag';
  perform pg_temp.tick('ovr6', 2, 3);
  assert (select fast_since is null from chase.player_live where player_id = pg_temp.pid('ovr6', 2)), 'slow again resets';
  raise notice '0006 overrides + speed: ok';
end $$;

-- ───────────────────────── Smittejakt roles: set_role, sit-out, late join ─────────────────────────
do $$
declare s uuid; h uuid; q uuid; j jsonb; v_pin text;
begin
  s := pg_temp.mk('trl6', '{"rounds":[{"mode":"tag","duration_s":300,"variant":"swap"}],"countdown_s":0}', 5);
  perform pg_temp.act(s, 'trl6', 'start');
  select id into h from chase.players where session_id = s and role = 'hunter';
  select id into q from chase.players where session_id = s and role = 'prey' order by nickname limit 1;

  -- Teacher swaps two roles.
  perform pg_temp.act(s, 'trl6', 'set_role', jsonb_build_object('player_id', q, 'role', 'hunter'));
  perform pg_temp.act(s, 'trl6', 'set_role', jsonb_build_object('player_id', h, 'role', 'prey'));
  assert (select role from chase.players where id = q) = 'hunter', 'prey → hunter';
  assert (select role = 'prey' and immune_until > now() from chase.players where id = h), 'hunter → prey with immunity';
  assert (select current_survival_start = now() from chase.player_stats where player_id = h), 'survival clock starts';

  -- The only hunter sits out: a prey is promoted.
  perform pg_temp.act(s, 'trl6', 'sit_out', jsonb_build_object('player_id', q));
  assert (select role from chase.players where id = q) = 'sitting_out', 'sitting out';
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 1, 'a prey was promoted';
  assert exists (select 1 from chase.events where session_id = s and type = 'tag_promote'), 'promotion logged';
  -- Back from sitting out: prey with immunity, not a broken «neutral».
  perform pg_temp.act(s, 'trl6', 'sit_out', jsonb_build_object('player_id', q, 'on', false));
  assert (select role = 'prey' and immune_until > now() and catch_code is not null from chase.players where id = q), 'back as prey';

  -- Late joiner during the tag round becomes prey on the next upkeep.
  select join_pin into v_pin from chase.sessions where id = s;
  j := chase.join_session(v_pin, 'trl6-late', pg_temp.h('tok-trl6-late'), pg_temp.h('res-trl6-late'));
  assert (j ->> 'ok')::boolean, 'late join: ' || j::text;
  perform pg_temp.tick('trl6', 1);
  assert (select role from chase.players where token_hash = pg_temp.h('tok-trl6-late')) = 'prey', 'late joiner is prey';
  raise notice '0006 tag roles: ok';
end $$;

do $$
begin
  assert not has_function_privilege('anon', 'chase.vote_again(uuid,text,uuid,boolean)', 'execute'), 'anon cannot vote';
  assert not has_function_privilege('anon', 'chase._podiums_from(jsonb,boolean,jsonb)', 'execute'), 'anon cannot compute';
  assert has_function_privilege('service_role', 'chase.vote_again(uuid,text,uuid,boolean)', 'execute'), 'service role votes';
  raise notice '0006 privileges: ALL ASSERTIONS PASSED';
end $$;
