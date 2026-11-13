-- Assertions for 0011_tick_load.sql: upkeep throttle + team cache.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

do $$
declare r jsonb; s uuid; j jsonb; p1 uuid; p2 uuid; t jsonb;
begin
  r := chase.create_session(pg_temp.h('host-tl'), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null,
    p_plan => '{"rounds":[{"mode":"posts","duration_s":300,"team":true}],"countdown_s":0,"teams":2}');
  s := (r ->> 'session_id')::uuid;
  p1 := (chase.join_session(r ->> 'pin', 'tl-1', pg_temp.h('tok-tl-1'), pg_temp.h('res-tl-1')) ->> 'player_id')::uuid;
  p2 := (chase.join_session(r ->> 'pin', 'tl-2', pg_temp.h('tok-tl-2'), pg_temp.h('res-tl-2')) ->> 'player_id')::uuid;
  perform chase.host_action(s, pg_temp.h('host-tl'), 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  update chase.players set team_id = (select id from chase.teams where session_id = s and n = 1) where id in (p1, p2);

  -- Throttle on (1 s): the first call claims the slot, the next ones in the same second do not.
  set local chase.upkeep_every_ms = 1000;
  delete from chase.session_clock where session_id = s;
  assert chase._upkeep_due(s), 'first is due';
  assert not chase._upkeep_due(s), 'same second: not due';
  update chase.session_clock set upkeep_at = now() - interval '2 seconds' where session_id = s;
  assert chase._upkeep_due(s), 'due again after 1 s';
  set local chase.upkeep_every_ms = 0;
  assert chase._upkeep_due(s) and chase._upkeep_due(s), 'off = always';

  -- Team view through the cache: teammate visible, my own nickname not among mates.
  perform chase.tick(p2, pg_temp.h('tok-tl-2'), 59.91045, 10.7509, 5);
  t := chase.tick(p1, pg_temp.h('tok-tl-1'), 59.91045, 10.7509, 5);
  assert (select team_cache_at from chase.session_clock where session_id = s) = now(), 'cache built by upkeep';
  assert t -> 'team' -> 'mates' @> '[{"nickname":"tl-2"}]' and not t -> 'team' -> 'mates' @> '[{"nickname":"tl-1"}]', 'mates: ' || (t -> 'team')::text;
  assert (t -> 'team' ->> 'of')::int = 2 and t -> 'team' ->> 'rank' is not null, 'scores from cache';
  perform chase.team_msg(p2, pg_temp.h('tok-tl-2'), s, 'come');
  t := chase.tick(p1, pg_temp.h('tok-tl-1'), 59.91045, 10.7509, 5);
  assert exists (select 1 from jsonb_array_elements(t -> 'team' -> 'msgs') m where m ->> 'nickname' = 'tl-2' and not (m ->> 'me')::boolean), 'msg via cache';
  t := chase.tick(p2, pg_temp.h('tok-tl-2'), 59.91045, 10.7509, 5);
  assert exists (select 1 from jsonb_array_elements(t -> 'team' -> 'msgs') m where (m ->> 'me')::boolean), 'own msg marked me';

  -- Stale cache → built on the fly, same answer.
  update chase.session_clock set team_cache = '{"scores":[],"teams":{}}', team_cache_at = now() - interval '1 minute' where session_id = s;
  t := chase._team_tick(p1, s);
  assert (t -> 'team' ->> 'of')::int = 2, 'stale cache ignored';
  assert not has_table_privilege('anon', 'chase.session_clock', 'select'), 'anon';
  raise notice '0011 tick load: ok';
end $$;
