-- Assertions for 0008_advance_lock_order.sql. The concurrency itself is
-- exercised by the prod/local sim; here: the wrapper is in place and phase
-- changes still run through it.
set search_path = chase, extensions, public;

do $$
declare r jsonb; s uuid;
begin
  assert to_regprocedure('chase._advance_base(uuid)') is not null, 'base kept';
  assert (select prosrc like '%_advance_base%' from pg_proc where oid = 'chase._advance(uuid)'::regprocedure), 'wrapper calls base';
  r := chase.create_session(encode(sha256('host-lk8'::bytea), 'hex'), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null,
    p_plan => '{"rounds":[{"mode":"free","duration_s":60}],"countdown_s":0}');
  s := (r ->> 'session_id')::uuid;
  perform chase.join_session(r ->> 'pin', 'lk8', encode(sha256('tok-lk8'::bytea), 'hex'), encode(sha256('res-lk8'::bytea), 'hex'));
  perform chase.host_action(s, encode(sha256('host-lk8'::bytea), 'hex'), 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'countdown → live through the wrapper';
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  assert (chase._advance(s) ->> 'changed')::boolean, 'live → gathering (last round)';
  assert (select status from chase.sessions where id = s) = 'gathering', 'playlist done';
  assert not has_function_privilege('anon', 'chase._advance(uuid)', 'execute'), 'anon';
  raise notice '0008 lock order wrapper: ok';
end $$;
