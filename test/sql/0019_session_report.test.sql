-- Assertions for 0019_session_report.sql: øktrapport (kun aggregater per kallenavn).
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

do $$
declare
  r jsonb; s uuid; p1 uuid; p2 uuid; p3 uuid;
  poly jsonb := '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}';
  pt   jsonb := '{"type":"Point","coordinates":[10.7509,59.91045]}';
  plan jsonb := '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}';
begin
  r := chase.create_session(pg_temp.h('host-r1'), null, poly, pt, null, p_plan => plan);
  s := (r ->> 'session_id')::uuid;
  p1 := (chase.join_session(r ->> 'pin', 'Zeta', pg_temp.h('tok-r-1'), pg_temp.h('res-r-1')) ->> 'player_id')::uuid;
  p2 := (chase.join_session(r ->> 'pin', 'alfa', pg_temp.h('tok-r-2'), pg_temp.h('res-r-2')) ->> 'player_id')::uuid;
  p3 := (chase.join_session(r ->> 'pin', 'Dommer', pg_temp.h('tok-r-3'), pg_temp.h('res-r-3')) ->> 'player_id')::uuid;
  update chase.players set role = 'referee' where id = p3;
  perform chase.host_action(s, pg_temp.h('host-r1'), 'start');
  update chase.player_stats set active_s = 600, distance_m = 1234.6, posts = 3, catches = 1, quiz_right = 2, badges = '{a,b}' where player_id = p1;
  update chase.player_stats set active_s = 120, distance_m = 10, quiz_right = 0 where player_id = p2;

  r := chase.session_report(s, pg_temp.h('host-r1'));
  assert (r ->> 'ok')::boolean, 'ok: ' || r::text;
  assert jsonb_array_length(r -> 'players') = 2, 'referee excluded: ' || r::text;
  assert r -> 'players' -> 0 ->> 'nickname' = 'alfa', 'alphabetical (case-insensitive): ' || r::text;
  assert (r -> 'players' -> 1 ->> 'distance_m')::int = 1235 and (r -> 'players' -> 1 ->> 'quiz_right')::int = 2
     and (r -> 'players' -> 1 ->> 'badges')::int = 2 and (r -> 'players' -> 1 ->> 'posts')::int = 3, 'values: ' || r::text;
  assert r -> 'rounds' -> 0 ->> 'mode' = 'free' and (r -> 'rounds' -> 0 ->> 'duration_s')::int = 600, 'rounds: ' || r::text;
  assert (r ->> 'duration_s')::int >= 0 and r ? 'started_at', 'duration';
  -- Privacy: no ids, positions or geometry in the answer.
  assert r::text !~* '"(lat|lng|pos|geo|coordinates|player_id|id)"', 'no positions/ids: ' || r::text;

  r := chase.session_report(s, pg_temp.h('nope'));
  assert (r ->> 'ok')::boolean is not true and r ->> 'error' = 'auth', 'bad token → auth';

  raise notice '0019 session_report: ok';
end $$;
