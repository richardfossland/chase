-- Assertions for 0014_tick_batch.sql: batched ticks + token-free host snapshot.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- One tick entry as the session room sends it.
create function pg_temp.e(p uuid, tok text, lat double precision, lng double precision, ts timestamptz default null)
returns jsonb language sql as $$
  select jsonb_build_object('player', p, 'token_hash', pg_temp.h(tok), 'lat', lat, 'lng', lng, 'acc', 5,
                            'speed', null, 'client_ts', ts, 'steps', null)
$$;

create temp table t14 (k text primary key, v uuid);

-- Part 1: one transaction. Committed at the end so part 2 can lock rows from a second connection.
do $$
declare
  r jsonb; s uuid; s2 uuid; p1 uuid; p2 uuid; p3 uuid; q1 uuid; q2 uuid;
  b jsonb; one jsonb; x jsonb; big jsonb := '[]'::jsonb;
  poly jsonb := '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}';
  pt   jsonb :='{"type":"Point","coordinates":[10.7509,59.91045]}';
begin
  -- Session A: one long free round, stays live.
  r := chase.create_session(pg_temp.h('host-tb'), null, poly, pt, null,
    p_plan => '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}');
  s := (r ->> 'session_id')::uuid;
  p1 := (chase.join_session(r ->> 'pin', 'tb-1', pg_temp.h('tok-tb-1'), pg_temp.h('res-tb-1')) ->> 'player_id')::uuid;
  p2 := (chase.join_session(r ->> 'pin', 'tb-2', pg_temp.h('tok-tb-2'), pg_temp.h('res-tb-2')) ->> 'player_id')::uuid;
  p3 := (chase.join_session(r ->> 'pin', 'tb-3', pg_temp.h('tok-tb-3'), pg_temp.h('res-tb-3')) ->> 'player_id')::uuid;
  perform chase.host_action(s, pg_temp.h('host-tb'), 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'A live';

  -- Batch result per entry has the same shape as a lone tick().
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(p2, 'tok-tb-2', 59.91045, 10.7509),
                                             pg_temp.e(p1, 'tok-tb-1', 59.91045, 10.7509)));
  one := chase.tick(p3, pg_temp.h('tok-tb-3'), 59.91045, 10.7509, 5, null, null, s, null);
  assert (b ->> 'ok')::boolean and b ->> 'status' = 'live', 'batch ok: ' || b::text;
  assert jsonb_array_length(b -> 'results') = 2, 'two results';
  assert (b -> 'results' -> 0 ->> 'player')::uuid = least(p1, p2), 'player-id order';
  for x in select value from jsonb_array_elements(b -> 'results') loop
    assert (x -> 'r' ->> 'ok')::boolean, 'entry ok: ' || x::text;
    assert (select array_agg(k order by k) from jsonb_object_keys(x -> 'r') k)
         = (select array_agg(k order by k) from jsonb_object_keys(one) k), 'same keys as tick()';
  end loop;
  assert (select count(*) from chase.player_live where player_id in (p1, p2)) = 2, 'positions written';

  -- A bad token fails only its own entry.
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(p1, 'wrong', 59.91045, 10.7509),
                                             pg_temp.e(p2, 'tok-tb-2', 59.91045, 10.7509)));
  for x in select value from jsonb_array_elements(b -> 'results') loop
    if (x ->> 'player')::uuid = p1 then
      assert x -> 'r' ->> 'error' = 'auth', 'bad token → auth';
    else
      assert (x -> 'r' ->> 'ok')::boolean, 'neighbour unaffected';
    end if;
  end loop;

  -- Stale client_ts is rejected per entry, like tick().
  perform chase.tick_batch(s, jsonb_build_array(pg_temp.e(p3, 'tok-tb-3', 59.91045, 10.7509, '2026-11-14 10:00:02+00')));
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(p3, 'tok-tb-3', 59.91045, 10.7509, '2026-11-14 10:00:01+00')));
  assert b -> 'results' -> 0 -> 'r' ->> 'error' = 'stale', 'stale: ' || b::text;

  -- A player from another session is not ticked through this one.
  r := chase.create_session(pg_temp.h('host-tb2'), null, poly, pt, null,
    p_plan => '{"rounds":[{"mode":"free","duration_s":60},{"mode":"free","duration_s":60}],"countdown_s":0,"breather_s":30}');
  s2 := (r ->> 'session_id')::uuid;
  q1 := (chase.join_session(r ->> 'pin', 'tb-q1', pg_temp.h('tok-tb-q1'), pg_temp.h('res-tb-q1')) ->> 'player_id')::uuid;
  q2 := (chase.join_session(r ->> 'pin', 'tb-q2', pg_temp.h('tok-tb-q2'), pg_temp.h('res-tb-q2')) ->> 'player_id')::uuid;
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(q1, 'tok-tb-q1', 59.91045, 10.7509)));
  assert b -> 'results' -> 0 -> 'r' ->> 'error' = 'not_found', 'foreign player: ' || b::text;

  -- Request validation.
  assert chase.tick_batch(gen_random_uuid(), '[]') ->> 'error' = 'not_found', 'unknown session';
  assert chase.tick_batch(s, '{}') ->> 'error' = 'bad_request', 'not an array';
  for i in 1..51 loop big := big || jsonb_build_array(pg_temp.e(p1, 'tok-tb-1', 59.91045, 10.7509)); end loop;
  assert chase.tick_batch(s, big) ->> 'error' = 'too_many', 'cap 50';
  assert (chase.tick_batch(s, '[]') ->> 'ok')::boolean, 'empty batch still advances';

  -- Safety: a player far outside raises a host alert, aggregated on the batch.
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(p2, 'tok-tb-2', 59.9150, 10.7509),
                                             pg_temp.e(p1, 'tok-tb-1', 59.91045, 10.7509)));
  assert (b ->> 'alert_host')::boolean, 'alert_host aggregated: ' || b::text;
  assert exists (select 1 from chase.alarms where player_id = p2 and resolved_at is null), 'alarm open';

  -- Phase change inside the batch: hint_all from the batch's own _advance.
  perform chase.host_action(s2, pg_temp.h('host-tb2'), 'start');
  perform chase._advance(s2);
  assert (select status from chase.sessions where id = s2) = 'live', 'B live';
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s2;
  b := chase.tick_batch(s2, jsonb_build_array(pg_temp.e(q1, 'tok-tb-q1', 59.91045, 10.7509),
                                              pg_temp.e(q2, 'tok-tb-q2', 59.91045, 10.7509)));
  assert (b ->> 'hint_all')::boolean and b ->> 'status' = 'breather', 'hint_all on phase change: ' || b::text;

  -- Token-free host snapshot for the room.
  x := chase.host_snapshot_svc(s, false);
  assert not x ? 'error' and x ? 'players', 'host_snapshot_svc: ' || left(x::text, 200);
  assert chase.host_snapshot_svc(gen_random_uuid()) ->> 'error' = 'not_found', 'svc unknown session';

  -- Ended session: the room is told to close.
  perform chase.end_session(s2, pg_temp.h('host-tb2'), true);
  assert chase.tick_batch(s2, '[]') ->> 'error' = 'ended', 'ended';

  -- service_role only.
  assert not has_function_privilege('anon', 'chase.tick_batch(uuid,jsonb)', 'execute'), 'anon batch';
  assert not has_function_privilege('authenticated', 'chase.tick_batch(uuid,jsonb)', 'execute'), 'authenticated batch';
  assert not has_function_privilege('anon', 'chase.host_snapshot_svc(uuid,boolean)', 'execute'), 'anon svc';
  assert has_function_privilege('service_role', 'chase.tick_batch(uuid,jsonb)', 'execute'), 'service_role batch';

  insert into t14 values ('s', s), ('p1', p1), ('p2', p2);
  raise notice '0014 tick_batch: ok';
end $$;

-- Part 2: a row held by another transaction (a catch in flight) → that entry is
-- "busy" after lock_timeout, the others go through. Needs dblink; skipped without it.
do $$
declare
  s uuid := (select v from t14 where k = 's');
  p1 uuid := (select v from t14 where k = 'p1');
  p2 uuid := (select v from t14 where k = 'p2');
  b jsonb; x jsonb; t0 timestamptz;
  v_host text := nullif(current_setting('chase.test_dblink_host', true), '');
begin
  if v_host is null then
    raise notice '0014 busy: skipped (no chase.test_dblink_host)';
    return;
  end if;
  begin
    create extension if not exists dblink with schema extensions;
  exception when others then
    raise notice '0014 busy: skipped (no dblink: %)', sqlerrm;
    return;
  end;
  perform extensions.dblink_connect('tb_lock', format('host=%s dbname=postgres user=postgres password=postgres', v_host));
  perform extensions.dblink_exec('tb_lock', 'begin');
  perform * from extensions.dblink('tb_lock', format('select 1 from chase.players where id = %L for update', p2)) as t(x int);

  t0 := clock_timestamp();
  b := chase.tick_batch(s, jsonb_build_array(pg_temp.e(p1, 'tok-tb-1', 59.91045, 10.7509),
                                             pg_temp.e(p2, 'tok-tb-2', 59.91045, 10.7509)));
  assert clock_timestamp() - t0 < interval '2 seconds', 'did not hang';
  for x in select value from jsonb_array_elements(b -> 'results') loop
    if (x ->> 'player')::uuid = p2 then
      assert x -> 'r' ->> 'error' = 'busy', 'locked → busy: ' || x::text;
    else
      assert (x -> 'r' ->> 'ok')::boolean, 'unlocked player ticks: ' || x::text;
    end if;
  end loop;

  perform extensions.dblink_exec('tb_lock', 'rollback');
  perform extensions.dblink_disconnect('tb_lock');
  raise notice '0014 busy: ok';
end $$;
