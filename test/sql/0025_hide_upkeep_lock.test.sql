-- Assertions for 0025_hide_upkeep_lock.sql: the Gjemsel upkeep takes FOR KEY SHARE on every player row (id order)
-- before it touches player_live (deadlock with tick's FOR UPDATE + FK re-check). Other modes take no locks.
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


-- Setup commits (own transactions), so the lock check below sees only the upkeep's row locks.
do $$
declare s uuid; t uuid; i int;
begin
  s := pg_temp.mk('dl', '{"rounds":[{"mode":"tag","variant":"hide","duration_s":600,"head_start_s":75}],"countdown_s":0}', 8);
  perform pg_temp.act(s, 'dl', 'start');
  perform chase._advance(s);
  for i in 1 .. 8 loop perform pg_temp.tick('dl', i); end loop;
  assert chase._is_hide(s), 'hide session';
  t := pg_temp.mk('dp', '{"rounds":[{"mode":"posts","duration_s":600}],"countdown_s":0}', 4);
  perform pg_temp.act(t, 'dp', 'start');
  perform chase._advance(t);
  for i in 1 .. 4 loop perform pg_temp.tick('dp', i); end loop;
end $$;

begin;
do $$
declare s uuid; t uuid; v_x text;
begin
  s := (select session_id from chase.players where id = pg_temp.pid('dl', 1));
  t := (select session_id from chase.players where id = pg_temp.pid('dp', 1));
  v_x := (txid_current() % 4294967296)::text;
  perform chase._mode_upkeep_team(t);
  assert not exists (select 1 from chase.players where session_id = t and xmax::text = v_x), 'Postjakt upkeep: no player row locks';
  perform chase._mode_upkeep_team(s);
  assert (select count(*) from chase.players where session_id = s and xmax::text = v_x)
       = (select count(*) from chase.players where session_id = s), 'Gjemsel upkeep: every player row locked (key share)';
  -- The pling reset (0023) still runs through the chain.
  assert not exists (select 1 from chase.player_live where session_id = s and ping_pos is not null), 'pling reset still applied';
  raise notice '0025 hide upkeep lock: ok';
end $$;
commit;
