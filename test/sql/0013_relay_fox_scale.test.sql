-- Assertions for 0013_relay_fox_scale.sql. Runs in scripts/test-db.sh (upkeep on every advance).
-- Same ~100 × 100 m Oslo square as the other tests. now() is constant inside a DO block.
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
create function pg_temp.relay(p_session uuid) returns jsonb language sql as $$
  select r.state -> 'relay' from chase.rounds r join chase.sessions s on s.id = r.session_id and r.idx = s.round_idx where s.id = p_session
$$;

-- ───────────────────────── pure: same vectors as test/relay.test.ts ─────────────────────────
do $$
declare v jsonb;
begin
  assert array(select chase._relay_batons(x) from unnest(array[0, 1, 5, 6, 10, 11, 75]) x) = array[0, 1, 1, 2, 2, 3, 15], 'batons';
  assert array(select chase._relay_post(n, l, 5) from (values (1, 0), (2, 0), (4, 3), (1, 7), (3, -1)) t(n, l)) = array[0, 1, 1, 2, 1], 'cycle';
  assert chase._relay_post(1, 0, 0) is null, 'no posts';
  assert chase._is_team_round('{"mode":"relay"}') and not chase._is_team_round('{"mode":"tag","variant":"fox"}'), 'relay is a team round';
  assert chase._ev_kinds('relay', false, true) = '{}'::text[], 'relay: no automatic events';
  assert chase._ev_kinds('relay', false, false) = array['mission'], 'relay: the teacher''s missions';
  assert chase._ev_kinds('posts', false, true) = array['sprint', 'gather'], 'posts unchanged';
  assert chase.k('max_players') = 300 and chase.kg('posts_max') = 40, 'scale limits';
  v := chase._nearest('[{"n":1,"pos":{"lat":59.9105,"lng":10.751}},{"n":2,"pos":{"lat":59.9100,"lng":10.750}},{"n":3},{"n":4,"pos":{"lat":59.91046,"lng":10.7509}}]',
                      59.91045, 10.7509, 2);
  assert v = '[{"n":4,"pos":{"lat":59.91046,"lng":10.7509}},{"n":1,"pos":{"lat":59.9105,"lng":10.751}}]', 'nearest: ' || v::text;
  assert jsonb_array_length(chase._nearest('[{"n":1},{"n":2}]', null, null, 5)) = 2, 'no position: keep all';

  -- Plan (twin: normPlan).
  v := chase._norm_plan('{"rounds":[{"mode":"relay","duration_s":300}]}');
  assert v -> 'rounds' -> 0 = '{"mode":"relay","duration_s":300}' and v ->> 'teams' = '2', 'relay → teams 2: ' || v::text;
  v := chase._norm_plan('{"rounds":[{"mode":"relay","duration_s":300,"team":true},{"mode":"flag","duration_s":300}],"teams":3}');
  assert v -> 'rounds' -> 0 = '{"mode":"relay","duration_s":300}' and v ->> 'teams' = '3', 'relay + flag, 3 teams: ' || v::text;
  assert chase._norm_plan('{"rounds":[{"mode":"relay","duration_s":300,"zone":true}]}') is null, 'no zone on a relay';
  assert chase._norm_plan('{"rounds":[{"mode":"relay","duration_s":300,"team":false}]}') is null, 'relay is always teams';
  assert chase._norm_plan('{"rounds":[{"mode":"relay","duration_s":30}]}') is null, 'base limits still apply';
  v := chase._norm_plan('{"rounds":[{"mode":"tag","variant":"fox","duration_s":300}]}');
  assert v -> 'rounds' -> 0 = '{"mode":"tag","variant":"fox","duration_s":300}' and not v ? 'teams', 'fox: ' || v::text;
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"fox","duration_s":300,"team":true}]}') is null, 'fox stays individual';
  v := chase._norm_plan('{"rounds":[{"mode":"tag","variant":"fox","duration_s":300,"zone":true}]}');
  assert v -> 'rounds' -> 0 ->> 'zone' = 'true', 'fox + zone is fine';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","variant":"bogus","duration_s":300}]}') is null, 'unknown variant';
  raise notice '0013 pure rules: ok';
end $$;

-- ───────────────────────── Sporing ─────────────────────────
do $$
declare s uuid; t jsonb; v_fox int; v_h int; r jsonb; v_code text; v_old uuid; v_pts int;
begin
  s := pg_temp.mk('fx', '{"rounds":[{"mode":"tag","variant":"fox","duration_s":300}],"countdown_s":0}', 8);
  perform pg_temp.act(s, 'fx', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  assert (select count(*) from chase.players where session_id = s and role = 'prey') = 1, 'one fox';
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 7, 'seven hunters';
  select substring(nickname from 4)::int into v_fox from chase.players where session_id = s and role = 'prey';
  v_h := case when v_fox = 1 then 2 else 1 end;
  assert (select current_survival_start is not null from chase.player_stats where player_id = pg_temp.pid('fx', v_fox)), 'fox clock runs';
  assert (select count(*) from chase.player_stats st join chase.players p on p.id = st.player_id
           where p.session_id = s and p.role = 'hunter' and st.current_survival_start is not null) = 0, 'hunters have no clock';

  -- Everybody reports; the fox runs fast (no stealth for the fox).
  for i in 1 .. 8 loop
    perform pg_temp.tick('fx', i, 59.91045 + i * 0.00002, 10.7509);
  end loop;
  update chase.player_live set speed = 5, ping_at = null where player_id = pg_temp.pid('fx', v_fox);
  perform chase._advance(s);
  t := pg_temp.tick('fx', v_h);
  assert (t -> 'tag' ->> 'fox')::boolean and jsonb_array_length(t -> 'tag' -> 'radar') = 1, 'hunter sees the fox: ' || (t -> 'tag')::text;
  assert not (t -> 'tag' -> 'radar' -> 0 ->> 'stealth')::boolean, 'no stealth for the fox';
  t := pg_temp.tick('fx', v_fox, 59.91045 + v_fox * 0.00002, 10.7509);
  assert jsonb_array_length(t -> 'tag' -> 'hunter_pos') = 7 and (t -> 'tag' ->> 'hunters')::int = 7, 'fox sees all hunters: ' || (t -> 'tag')::text;

  -- Catch: the catcher becomes the fox, with immunity.
  select catch_code into v_code from chase.players where id = pg_temp.pid('fx', v_fox);
  r := chase.catch(pg_temp.pid('fx', v_h), pg_temp.h('tok-fx-' || v_h), s, v_code);
  assert (r ->> 'ok')::boolean and r ->> 'immune_until' is not null and not (r ->> 'last')::boolean, 'catch: ' || r::text;
  assert (select role from chase.players where id = pg_temp.pid('fx', v_h)) = 'prey', 'catcher is the fox';
  assert (select role from chase.players where id = pg_temp.pid('fx', v_fox)) = 'hunter', 'old fox hunts';
  assert (select count(*) from chase.players where session_id = s and role = 'prey') = 1, 'still one fox';

  -- The fox sits out: a hunter takes over. A late joiner hunts.
  update chase.players set role = 'sitting_out' where id = pg_temp.pid('fx', v_h);
  perform chase._tag_rebalance(s);
  assert (select count(*) from chase.players where session_id = s and role = 'prey' and status = 'active') = 1, 'new fox';
  r := chase.join_session((select join_pin from chase.sessions where id = s), 'fx-9', pg_temp.h('tok-fx-9'), pg_temp.h('res-fx-9'));
  perform pg_temp.tick('fx', 9);
  assert (select role from chase.players where id = pg_temp.pid('fx', 9)) = 'hunter', 'late joiner hunts';

  -- Whistle: the fox gets +25 and «Rev».
  select id into v_old from chase.players where session_id = s and role = 'prey' and status = 'active';
  select points into v_pts from chase.player_stats where player_id = v_old;
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  perform chase._advance(s);
  assert (select points from chase.player_stats where player_id = v_old) >= v_pts + 25, 'fox bonus';
  assert (select 'fox' = any(badges) from chase.player_stats where player_id = v_old), 'badge «Rev»';
  assert (select count(*) from chase.players where session_id = s and role in ('hunter', 'prey')) = 0, 'roles back to neutral';
  raise notice '0013 fox: ok';
end $$;

-- ───────────────────────── Stafett ─────────────────────────
do $$
declare s uuid; rel jsonb; t jsonb; v_run uuid; v_i int; v_n int; v_post int; v_pos jsonb; v_tp int; v_pts int; v_next uuid;
begin
  s := pg_temp.mk('sf', '{"rounds":[{"mode":"relay","duration_s":300}],"countdown_s":0,"teams":2}', 12);
  perform pg_temp.act(s, 'sf', 'start');
  perform chase._advance(s);
  for i in 1 .. 12 loop
    perform pg_temp.tick('sf', i);           -- everybody at the base
  end loop;
  perform chase._advance(s);
  rel := pg_temp.relay(s);
  assert jsonb_array_length(rel -> 'posts') = 5 and rel -> 'legs' = '{"1":0,"2":0}', 'course: ' || rel::text;
  assert (select count(*) from chase.teams where session_id = s) = 2, 'teams dealt';
  assert (select count(*) from chase.player_stats where session_id = s and relay_post is not null) = 4, '2 batons per team of 6';
  assert (select array_agg(st.relay_post order by st.relay_post) from chase.player_stats st join chase.players p on p.id = st.player_id
           join chase.teams tm on tm.id = p.team_id where p.session_id = s and tm.n = 1 and st.relay_post is not null) = array[0, 1]::smallint[], 'team 1 starts at post 0';
  assert (select array_agg(st.relay_post order by st.relay_post) from chase.player_stats st join chase.players p on p.id = st.player_id
           join chase.teams tm on tm.id = p.team_id where p.session_id = s and tm.n = 2 and st.relay_post is not null) = array[1, 2]::smallint[], 'team 2 starts at post 1';

  -- One runner of team 1 to its post …
  select p.id, substring(p.nickname from 4)::int, st.relay_post, tm.n into v_run, v_i, v_post, v_n
    from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
   where p.session_id = s and tm.n = 1 and st.relay_post is not null order by st.relay_post limit 1;
  t := pg_temp.tick('sf', v_i);
  assert (t -> 'relay' ->> 'post')::int = v_post and not (t -> 'relay' ->> 'back')::boolean
     and t -> 'relay' -> 'target' = rel -> 'posts' -> v_post -> 'pos', 'runner view: ' || (t -> 'relay')::text;
  assert jsonb_array_length(t -> 'relay' -> 'runners') = 2 and t -> 'round' -> 'relay' ? 'posts', 'runners + course on the phone';
  v_pos := rel -> 'posts' -> v_post -> 'pos';
  select points into v_pts from chase.player_stats where player_id = v_run;
  perform pg_temp.tick('sf', v_i, (v_pos ->> 'lat')::float8, (v_pos ->> 'lng')::float8);
  perform chase._advance(s);
  assert (select relay_back from chase.player_stats where player_id = v_run), 'post reached';
  assert (select points from chase.player_stats where player_id = v_run) = v_pts + 5, '+5 to the runner';
  t := pg_temp.tick('sf', v_i, (v_pos ->> 'lat')::float8, (v_pos ->> 'lng')::float8);
  assert t -> 'relay' -> 'target' = rel -> 'base', 'now back to the base';

  -- … and back to the base: a leg for team 1, the baton moves on.
  select points into v_tp from chase.teams where session_id = s and n = 1;
  perform pg_temp.tick('sf', v_i);
  perform chase._advance(s);
  rel := pg_temp.relay(s);
  assert rel -> 'legs' ->> '1' = '1' and rel -> 'legs' ->> '2' = '0', 'one leg: ' || (rel -> 'legs')::text;
  assert (select points from chase.teams where session_id = s and n = 1) = v_tp + 10, '+10 to the team';
  assert (select relay_post is null and round_relay = 1 from chase.player_stats where player_id = v_run), 'baton handed over';
  assert (select count(*) from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
           where p.session_id = s and tm.n = 1 and st.relay_post is not null) = 2, 'team 1 still has 2 batons';
  select p.id into v_next from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
   where p.session_id = s and tm.n = 1 and st.relay_post = 2;
  assert v_next is not null and v_next <> v_run, 'next runner takes the next post (2)';

  -- Third leg → badge «Stafett»; a runner who leaves drops the baton.
  update chase.player_stats set relay_legs = 2, relay_back = true, relay_post = 0 where player_id = v_run;
  perform pg_temp.tick('sf', v_i);
  perform chase._advance(s);
  assert (select 'relay' = any(badges) from chase.player_stats where player_id = v_run), 'badge after 3 legs';
  update chase.players set status = 'left' where id = v_next;
  perform chase._advance(s);
  assert (select relay_post is null from chase.player_stats where player_id = v_next), 'baton dropped';
  assert (select count(*) from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
           where p.session_id = s and tm.n = 1 and st.relay_post is not null and p.status = 'active') = 1, '5 left → 1 baton';

  -- A baton held over 3 min moves on to someone else.
  select p.id into v_next from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
   where p.session_id = s and tm.n = 1 and st.relay_post is not null and p.status = 'active';
  update chase.player_stats set relay_since = now() - interval '181 seconds' where player_id = v_next;
  perform chase._advance(s);
  assert (select relay_post is null from chase.player_stats where player_id = v_next), 'slow baton taken back';
  assert (select count(*) from chase.player_stats st join chase.players p on p.id = st.player_id join chase.teams tm on tm.id = p.team_id
           where p.session_id = s and tm.n = 1 and st.relay_post is not null and p.status = 'active' and p.id <> v_next) = 1, 'and given to a teammate';

  -- Whistle: legs count for «Lagspiller», batons cleared.
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  perform chase._advance(s);
  assert (select team_acts >= 2 from chase.player_stats where player_id = v_run), 'legs → teamplay';
  assert (select count(*) from chase.player_stats where session_id = s and relay_post is not null) = 0, 'batons cleared';
  assert exists (select 1 from chase.events where session_id = s and type = 'relay_end'), 'relay_end event';
  raise notice '0013 relay: ok';
end $$;

-- ───────────────────────── 300 players, team view of a big team ─────────────────────────
do $$
declare s uuid; j jsonb; t jsonb;
begin
  s := pg_temp.mk('bg', '{"rounds":[{"mode":"free","duration_s":300,"team":true}],"countdown_s":0,"teams":2}', 300);
  j := chase.join_session((select join_pin from chase.sessions where id = s), 'bg-301', pg_temp.h('tok-bg-301'), pg_temp.h('res-bg-301'));
  assert j ->> 'error' = 'full', '301st: ' || j::text;
  perform pg_temp.act(s, 'bg', 'start');
  perform chase._advance(s);
  for i in 1 .. 60 loop
    perform pg_temp.tick('bg', i, 59.9101 + i * 0.00001, 10.7505);
  end loop;
  perform chase._advance(s);
  t := pg_temp.tick('bg', 1, 59.91011, 10.7505);
  assert jsonb_array_length(t -> 'team' -> 'mates') = 20, '20 nearest mates: ' || jsonb_array_length(t -> 'team' -> 'mates');
  assert (t -> 'team' ->> 'mates_total')::int = (
           select count(*) - 1 from chase.players q join chase.player_live l on l.player_id = q.id
            where q.team_id = (select team_id from chase.players where id = pg_temp.pid('bg', 1))
              and l.fix_at > now() - interval '20 seconds'), 'mates_total: ' || (t -> 'team' ->> 'mates_total');
  assert exists (select 1 from chase.team_clock where session_id = s), 'per-team cache';
  -- «Avslutt»: the caches (teammates' positions) go with the live positions.
  perform chase._end_session(s);
  assert not exists (select 1 from chase.team_clock where session_id = s)
     and not exists (select 1 from chase.session_clock where session_id = s), 'team caches deleted at the end';
  raise notice '0013 scale: ok';
end $$;
