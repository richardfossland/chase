-- Assertions for 0001_schema.sql. Runs in scripts/test-db.sh.
set search_path = chase, extensions, public;

do $$
declare
  v_n        int;
  v_teacher  uuid;
  v_session  uuid;
  v_player   uuid;
  v_square   geography;
begin
  -- PostGIS is reachable and health() works.
  assert (chase.health() ->> 'schema') = 'chase', 'health() schema';
  assert (chase.health() ->> 'postgis') is not null, 'health() postgis version';

  -- Every chase table has RLS enabled.
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'chase' and c.relkind = 'r' and not c.relrowsecurity;
  assert v_n = 0, format('%s chase table(s) without RLS', v_n);

  -- No RLS policies at all (deny-all model).
  select count(*) into v_n from pg_policies where schemaname = 'chase';
  assert v_n = 0, 'chase must have no RLS policies (deny-all)';

  -- anon/authenticated cannot even see the schema.
  assert not has_schema_privilege('anon', 'chase', 'USAGE'), 'anon must not use schema chase';
  assert not has_schema_privilege('authenticated', 'chase', 'USAGE'), 'authenticated must not use schema chase';
  assert has_schema_privilege('service_role', 'chase', 'USAGE'), 'service_role uses schema chase';
  assert not has_function_privilege('anon', 'chase.health()', 'EXECUTE'), 'anon must not execute chase fns';
  assert has_function_privilege('service_role', 'chase.health()', 'EXECUTE'), 'service_role executes chase fns';

  -- player_live is UNLOGGED (never in WAL/backups — PLAN §8).
  assert (select relpersistence from pg_class where oid = 'chase.player_live'::regclass) = 'u',
    'player_live must be UNLOGGED';

  -- Smoke: a ~100 m square session, a player, a live position inside it.
  v_square := ST_GeogFromText(
    'POLYGON((10.75 59.91, 10.7518 59.91, 10.7518 59.9109, 10.75 59.9109, 10.75 59.91))');
  insert into chase.teachers (key_hash) values ('k1') returning id into v_teacher;
  insert into chase.sessions (join_pin, host_token_hash, teacher_id, boundary, assembly_point)
    values ('123456', 'h1', v_teacher, v_square, ST_GeogFromText('POINT(10.7509 59.91045)'))
    returning id into v_session;
  insert into chase.players (session_id, nickname, token_hash, resume_code_hash)
    values (v_session, 'Lyn', 't1', 'r1') returning id into v_player;
  insert into chase.player_live (player_id, session_id, pos, acc, fix_at)
    values (v_player, v_session, ST_GeogFromText('POINT(10.7509 59.91045)'), 8, now());

  assert ST_Covers(v_square, (select pos from chase.player_live where player_id = v_player)),
    'player should be inside the area';
  assert abs(ST_Distance(ST_GeogFromText('POINT(10.75 59.91)'),
                         ST_GeogFromText('POINT(10.7518 59.91)')) - 100) < 2,
    'geography distance ~100 m';

  -- Active PIN uniqueness, but reusable once ended.
  begin
    insert into chase.sessions (join_pin, host_token_hash, boundary, assembly_point)
      values ('123456', 'h2', v_square, ST_GeogFromText('POINT(10.7509 59.91045)'));
    assert false, 'duplicate active PIN should fail';
  exception when unique_violation then null;
  end;
  update chase.sessions set status = 'ended', ended_at = now() where id = v_session;
  insert into chase.sessions (join_pin, host_token_hash, boundary, assembly_point)
    values ('123456', 'h3', v_square, ST_GeogFromText('POINT(10.7509 59.91045)'));

  -- Nickname unique per session (case-insensitive) among active players.
  begin
    insert into chase.players (session_id, nickname, token_hash, resume_code_hash)
      values (v_session, 'lyn', 't2', 'r2');
    assert false, 'duplicate nickname should fail';
  exception when unique_violation then null;
  end;

  -- Deleting a session cascades away everything, including live positions.
  delete from chase.sessions where id = v_session;
  assert not exists (select 1 from chase.player_live where session_id = v_session), 'cascade player_live';
  assert not exists (select 1 from chase.players where session_id = v_session), 'cascade players';

  raise notice '0001 schema: ALL ASSERTIONS PASSED';
end $$;

-- Leave the DB clean for the next test file.
truncate chase.sessions, chase.teachers cascade;
