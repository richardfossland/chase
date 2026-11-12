-- Assertions for 0009_teams_flag_king.sql. Runs in scripts/test-db.sh.
-- Same ~100 × 100 m Oslo square as the other tests. now() is constant inside
-- a DO block, so time is moved by editing the stored timestamps.
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
create function pg_temp.tok(p_tag text, p_i int) returns text language sql as
  $$ select pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
create function pg_temp.tick(p_tag text, p_i int, p_lat float8 default 59.91045, p_lng float8 default 10.7509, p_acc real default 5)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.tok(p_tag, p_i), p_lat, p_lng, p_acc)
$$;
create function pg_temp.act(p_session uuid, p_tag text, p_action text, p_payload jsonb default '{}') returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action, p_payload) $$;
create function pg_temp.team(p_tag text, p_i int) returns int language sql as
  $$ select t.n from chase.players p join chase.teams t on t.id = p.team_id where p.id = pg_temp.pid(p_tag, p_i) $$;
create function pg_temp.tpts(p_session uuid, p_n int) returns int language sql as
  $$ select points from chase.teams where session_id = p_session and n = p_n $$;
create function pg_temp.state(p_session uuid) returns jsonb language sql as $$
  select r.state from chase.rounds r join chase.sessions s on s.id = r.session_id and r.idx = s.round_idx where s.id = p_session
$$;
create function pg_temp.set_state(p_session uuid, p_key text, p_val jsonb) returns void language sql as $$
  update chase.rounds r set state = r.state || jsonb_build_object(p_key, p_val)
    from chase.sessions s where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx
$$;
create function pg_temp.next_phase(p_session uuid) returns void language sql as $$
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = p_session;
  select chase._advance(p_session);
$$;

-- ───────────────────────── pure: same vectors as test/teams.test.ts ─────────────────────────
do $$
declare v jsonb;
begin
  assert array(select chase._team_snake(i, 2) from generate_series(0, 5) i) = array[1, 2, 2, 1, 1, 2], 'snake 2';
  assert array(select chase._team_snake(i, 3) from generate_series(0, 5) i) = array[1, 2, 3, 3, 2, 1], 'snake 3';
  assert array(select chase._team_snake(i, 4) from generate_series(0, 8) i) = array[1, 2, 3, 4, 4, 3, 2, 1, 1], 'snake 4';
  assert chase._team_majority(array[3, 1]) = 1, 'majority 3–1';
  assert chase._team_majority(array[2, 2]) is null, 'tie';
  assert chase._team_majority(array[0, 0]) is null, 'nobody';
  assert chase._team_majority(array[1, 2, 2]) is null, 'tie at the top';
  assert chase._team_majority(array[0, 3, 1, 0]) = 2, 'majority 0–3–1–0';
  assert chase._team_majority('{}'::int[]) is null, 'no teams';
  assert chase._team_pick(array[3, 2, 2], array[0, 50, 10]) = 3, 'smallest, then fewest points';
  assert chase._team_pick(array[2, 2], array[10, 10]) = 1, 'then lowest number';
  assert chase._team_pick(array[1, 2], array[99, 0]) = 1, 'size first';
  assert chase._is_team_round('{"mode":"flag"}') and chase._is_team_round('{"mode":"king"}')
     and chase._is_team_round('{"mode":"posts","team":true}') and not chase._is_team_round('{"mode":"posts"}')
     and not chase._is_team_round('{"mode":"tag"}') and not chase._is_team_round(null), 'team rounds';

  v := chase._team_podiums(
    '[{"cat":"posts","entries":[{"id":"a","value":4}]},{"cat":"points","entries":[{"id":"c","value":90}]}]',
    '[{"id":"t1","n":1,"points":50},{"id":"t2","n":2,"points":80}]',
    '[{"id":"a","teamplay":3},{"id":"b","teamplay":0},{"id":"c","teamplay":5},{"id":"d","teamplay":3}]');
  assert v = '[{"cat":"posts","entries":[{"id":"a","value":4}]},
               {"cat":"teamplay","entries":[{"id":"c","value":5},{"id":"a","value":3},{"id":"d","value":3}]},
               {"cat":"points","entries":[{"id":"c","value":90}]},
               {"cat":"team","entries":[{"id":"t2","value":80},{"id":"t1","value":50}]}]'::jsonb, 'podiums: ' || v::text;
  v := chase._team_podiums('[{"cat":"posts","entries":[{"id":"a","value":4}]}]',
    '[{"id":"t1","n":1,"points":10},{"id":"t2","n":2,"points":10}]', '[{"id":"a","teamplay":0}]');
  assert v = '[{"cat":"posts","entries":[{"id":"a","value":4}]},
               {"cat":"team","entries":[{"id":"t1","value":10},{"id":"t2","value":10}]}]'::jsonb, 'no teamplay, tie by n: ' || v::text;
  v := chase._team_podiums('[{"cat":"posts","entries":[]}]', '[{"id":"t1","n":1,"points":10}]', '[]');
  assert v = '[{"cat":"posts","entries":[]}]'::jsonb, 'one team: unchanged';

  -- Plan (twin: normPlan in lib/rules/game.ts).
  v := chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300}]}');
  assert v -> 'rounds' -> 0 = '{"mode":"flag","duration_s":300}' and v ->> 'teams' = '2', 'flag → teams 2: ' || v::text;
  v := chase._norm_plan('{"rounds":[{"mode":"king","duration_s":300}],"teams":4}');
  assert v -> 'rounds' -> 0 ->> 'mode' = 'king' and v ->> 'teams' = '4', 'king, 4 teams';
  v := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"team":true},{"mode":"tag","duration_s":300}],"teams":3}');
  assert v -> 'rounds' -> 0 ->> 'team' = 'true' and not v -> 'rounds' -> 1 ? 'team' and v ->> 'teams' = '3', 'team posts';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","duration_s":300,"team":true}]}') is null, 'tag stays individual';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300,"zone":true}]}') is null, 'no zone on flags';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300}],"teams":5}') is null, 'too many teams';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300}],"teams":1}') is null, 'one team';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300}],"teams":"2"}') is null, 'string';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"team":"yes"}]}') is null, 'team not boolean';
  v := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"team":false}],"teams":3}');
  assert not v ? 'teams' and not v -> 'rounds' -> 0 ? 'team', 'no team round → no teams';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":30}]}') is null, 'base limits still apply';
  v := chase._norm_plan('{"rounds":[{"mode":"king","duration_s":300}],"event_every_s":90}');
  assert v ->> 'event_every_s' = '90', 'older layers still run';
  raise notice '0009 pure rules: ok';
end $$;

-- ───────────────────────── deal, move, late joiner ─────────────────────────
do $$
declare s uuid; r jsonb; j jsonb; c int[];
begin
  s := pg_temp.mk('tm', '{"rounds":[{"mode":"posts","duration_s":300,"team":true},{"mode":"flag","duration_s":300},{"mode":"king","duration_s":300}],"countdown_s":0,"teams":4}', 10);
  r := pg_temp.act(s, 'tm', 'team_set', '{"team":1}');
  assert r ->> 'error' = 'bad_team', 'no teams yet: ' || r::text;
  update chase.player_stats st set points = (select substring(p.nickname from 4)::int * 10 from chase.players p where p.id = st.player_id)
   where st.session_id = s;
  r := pg_temp.act(s, 'tm', 'teams_deal');
  assert (r ->> 'ok')::boolean, 'deal: ' || r::text;
  assert (select count(*) from chase.teams where session_id = s) = 4, '4 teams';
  select array_agg(k order by k) into c from (select count(*)::int k from chase.players where session_id = s group by team_id) q;
  assert c = array[2, 2, 3, 3], 'sizes differ by ≤ 1: ' || c::text;
  assert pg_temp.team('tm', 10) = 1 and pg_temp.team('tm', 9) = 2 and pg_temp.team('tm', 7) = 4
     and pg_temp.team('tm', 6) = 4 and pg_temp.team('tm', 3) = 1, 'snake on points';
  assert pg_temp.act(s, 'tm', 'teams_deal') ->> 'ok' = 'true', 'deal again in the lobby';
  assert pg_temp.team('tm', 10) = 1 and pg_temp.team('tm', 1) = 2, 'same points → same deal';

  r := pg_temp.act(s, 'tm', 'team_set', jsonb_build_object('player_id', pg_temp.pid('tm', 1), 'team', 3));
  assert (r ->> 'ok')::boolean and pg_temp.team('tm', 1) = 3, 'teacher moves p1';
  r := pg_temp.act(s, 'tm', 'team_set', jsonb_build_object('player_id', pg_temp.pid('tm', 1), 'team', 9));
  assert r ->> 'error' = 'bad_team', 'bad team';
  update chase.player_stats set points = 0 where session_id = s;

  -- Late joiner: smallest team (2 and 4 have 2; equal points → lowest number).
  j := chase.join_session((select join_pin from chase.sessions where id = s), 'tm-11', pg_temp.h('tok-tm-11'), pg_temp.h('res-tm-11'));
  assert (j ->> 'ok')::boolean, 'join 11';
  assert pg_temp.team('tm', 11) is null, 'no team before the first tick';
  j := pg_temp.tick('tm', 11);
  assert pg_temp.team('tm', 11) = 2, 'late joiner → team 2: ' || coalesce(pg_temp.team('tm', 11)::text, 'null');
  assert j -> 'team' ->> 'name' = 'Blå' and (j -> 'team' ->> 'of')::int = 4 and j -> 'team' ->> 'rank' = '1', 'phone team view: ' || (j -> 'team')::text;
  assert not j -> 'team' ? 'mates', 'no mates outside a team round';

  r := chase.host_snapshot(s, pg_temp.h('host-tm'));
  assert jsonb_array_length(r -> 'teams') = 4 and (r -> 'team_of' ->> pg_temp.pid('tm', 11)::text)::int = 2, 'snapshot teams';
  raise notice '0009 deal/move/late joiner: ok';
end $$;

-- ───────────────────────── team posts round: fold into the team ─────────────────────────
do $$
declare s uuid := (select session_id from chase.players where id = pg_temp.pid('tm', 1)); v jsonb;
begin
  perform pg_temp.act(s, 'tm', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  assert (chase._round_view((select x from chase.sessions x where id = s)) ->> 'team')::boolean, 'round view: team round';
  assert pg_temp.act(s, 'tm', 'teams_deal') ->> 'error' = 'teams_locked', 'no re-deal once a team round started';
  update chase.player_stats set round_points = 0, round_posts = 0 where session_id = s;
  update chase.player_stats set round_points = 30, round_posts = 2 where player_id = pg_temp.pid('tm', 10);
  update chase.player_stats set round_points = 20 where player_id = pg_temp.pid('tm', 9);
  v := chase._team_scores(s);
  assert (v -> 0 ->> 'points')::int = 30 and (v -> 1 ->> 'points')::int = 20, 'live score: ' || v::text;
  perform pg_temp.next_phase(s);
  assert (select status from chase.sessions where id = s) = 'breather', 'breather';
  assert pg_temp.tpts(s, 1) = 30 and pg_temp.tpts(s, 2) = 20 and pg_temp.tpts(s, 3) = 0, 'folded';
  assert (select team_acts from chase.player_stats where player_id = pg_temp.pid('tm', 10)) = 2, 'team posts → Lagspiller';
  perform chase._team_finish(s, now());
  assert pg_temp.tpts(s, 1) = 30, 'once per round';
  v := chase._team_scores(s);
  assert (v -> 0 ->> 'points')::int = 30, 'no double count in the breather';
  raise notice '0009 team posts: ok';
end $$;

-- ───────────────────────── Flaggjakt ─────────────────────────
do $$
declare s uuid := (select session_id from chase.players where id = pg_temp.pid('tm', 1)); st jsonb; t jsonb; r jsonb; h0 timestamptz;
        p10 int; p3 int;
begin
  perform pg_temp.next_phase(s);   -- breather → countdown (0 s)
  perform chase._advance(s);       -- → live
  assert (select status from chase.sessions where id = s) = 'live' and (select round_idx from chase.sessions where id = s) = 1, 'flag round live';
  st := pg_temp.state(s);
  assert jsonb_array_length(st -> 'flags') = 5, '4 teams → 5 flags: ' || (st -> 'flags')::text;
  assert (select min(ST_Distance(chase._pt((a -> 'pos' ->> 'lat')::float8, (a -> 'pos' ->> 'lng')::float8),
                                 chase._pt((b -> 'pos' ->> 'lat')::float8, (b -> 'pos' ->> 'lng')::float8)))
            from jsonb_array_elements(st -> 'flags') a, jsonb_array_elements(st -> 'flags') b where a ->> 'n' < b ->> 'n') > 10, 'spread out';
  assert jsonb_array_length(chase._round_view((select x from chase.sessions x where id = s)) -> 'flags') = 5
     and not chase._round_view((select x from chase.sessions x where id = s)) -> 'flags' -> 0 ? 'paid', 'round view flags';

  -- One flag at the assembly point; team 1 (p10, p3) vs team 2 (p9).
  perform pg_temp.set_state(s, 'flags', '[{"n":1,"pos":{"lat":59.91045,"lng":10.7509},"owner":null,"held_since":null,"paid":0,"cap":null,"cap_since":null}]');
  update chase.player_stats set points = 0, round_points = 0 where session_id = s;
  update chase.player_live set fix_at = now() - interval '1 minute' where session_id = s;   -- earlier blocks' fixes
  perform pg_temp.tick('tm', 10);
  t := pg_temp.tick('tm', 3);
  perform pg_temp.tick('tm', 9);
  st := pg_temp.state(s);
  assert (st -> 'flags' -> 0 ->> 'cap')::int = 1 and st -> 'flags' -> 0 ->> 'owner' is null, 'team 1 is taking it: ' || (st -> 'flags')::text;
  assert jsonb_array_length(t -> 'team' -> 'mates') >= 1, 'teammates on the map in a team round';
  perform pg_temp.set_state(s, 'flags', jsonb_set(st -> 'flags', '{0,cap_since}', to_jsonb(now() - interval '11 seconds')));
  perform chase._team_upkeep(s);
  st := pg_temp.state(s);
  assert (st -> 'flags' -> 0 ->> 'owner')::int = 1 and st -> 'flags' -> 0 ->> 'cap' is null, 'captured: ' || (st -> 'flags')::text;
  select points into p10 from chase.player_stats where player_id = pg_temp.pid('tm', 10);
  select points into p3 from chase.player_stats where player_id = pg_temp.pid('tm', 3);
  assert p10 >= 10 and p3 >= 10, 'capturers +10';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('tm', 9)) < 10, 'the other team did not';
  assert (select 'flag' = any(badges) from chase.player_stats where player_id = pg_temp.pid('tm', 10)), 'flag badge';
  assert (select team_acts from chase.player_stats where player_id = pg_temp.pid('tm', 3)) = 1, 'capture → Lagspiller';
  assert exists (select 1 from chase.events where session_id = s and type = 'flag_capture'), 'event logged';

  -- Holding: every 30 s +5 to the team.
  perform pg_temp.set_state(s, 'flags', jsonb_set(st -> 'flags', '{0,held_since}', to_jsonb(now() - interval '61 seconds')));
  perform chase._team_upkeep(s);
  assert pg_temp.tpts(s, 1) = 30 + 10, 'two hold periods: ' || pg_temp.tpts(s, 1);
  perform chase._team_upkeep(s);
  assert pg_temp.tpts(s, 1) = 40, 'paid once';

  -- Team 2 outnumbers on the owned flag → it starts taking it.
  perform pg_temp.tick('tm', 4);
  perform pg_temp.tick('tm', 11);
  perform chase._team_upkeep(s);
  -- p10, p3 (team 1) vs p9, p4, p11 (team 2): team 2 leads.
  assert (pg_temp.state(s) -> 'flags' -> 0 ->> 'cap')::int = 2, 'team 2 contests: ' || (pg_temp.state(s) -> 'flags')::text;

  -- Pause: the clocks stop.
  h0 := (pg_temp.state(s) -> 'flags' -> 0 ->> 'held_since')::timestamptz;
  perform pg_temp.act(s, 'tm', 'pause');
  update chase.sessions set frozen_at = frozen_at - interval '20 seconds' where id = s;
  perform pg_temp.act(s, 'tm', 'resume');
  assert (pg_temp.state(s) -> 'flags' -> 0 ->> 'held_since')::timestamptz = h0 + interval '20 seconds', 'pause shifts held_since';

  -- Quick messages: my team only.
  r := chase.team_msg(pg_temp.pid('tm', 10), pg_temp.tok('tm', 10), s, 'come');
  assert (r ->> 'ok')::boolean, 'msg: ' || r::text;
  assert chase.team_msg(pg_temp.pid('tm', 10), pg_temp.tok('tm', 10), s, 'help') ->> 'error' = 'too_soon', 'rate limit';
  assert chase.team_msg(pg_temp.pid('tm', 3), pg_temp.tok('tm', 3), s, 'rocket') ->> 'error' = 'bad_kind', 'bad kind';
  assert chase.team_msg(pg_temp.pid('tm', 3), pg_temp.tok('tm', 9), s, 'ok') ->> 'error' = 'auth', 'auth';
  t := pg_temp.tick('tm', 3);
  assert exists (select 1 from jsonb_array_elements(t -> 'team' -> 'msgs') m where m ->> 'nickname' = 'tm-10' and m ->> 'kind' = 'come' and m -> 'pos' ? 'lat'), 'teammate sees it: ' || (t -> 'team')::text;
  t := pg_temp.tick('tm', 9);
  assert not exists (select 1 from jsonb_array_elements(t -> 'team' -> 'msgs') m where m ->> 'nickname' = 'tm-10'), 'other team does not';
  raise notice '0009 flag: ok';
end $$;

-- ───────────────────────── Konge på haugen + ceremony ─────────────────────────
do $$
declare s uuid := (select session_id from chase.players where id = pg_temp.pid('tm', 1)); st jsonb; v jsonb; n int; t3 int;
begin
  perform pg_temp.next_phase(s);   -- flag round → breather
  perform pg_temp.next_phase(s);   -- → countdown
  perform chase._advance(s);       -- → live
  assert (select round_idx from chase.sessions where id = s) = 2, 'king round';
  st := pg_temp.state(s);
  assert st -> 'hill' ->> 'no' = '1' and (st -> 'hill' ->> 'r')::int = 20, 'hill: ' || (st -> 'hill')::text;
  assert chase._team_scores(s) -> 0 ->> 'points' = (pg_temp.tpts(s, 1))::text, 'flag round paid';
  perform pg_temp.set_state(s, 'hill', (st -> 'hill') || jsonb_build_object('pos', '{"lat":59.91045,"lng":10.7509}'::jsonb, 'at', now(), 'per', 0));
  perform pg_temp.tick('tm', 8);    -- team 3
  perform pg_temp.tick('tm', 5);    -- team 3
  perform pg_temp.tick('tm', 7);    -- team 4
  update chase.player_live set fix_at = now() - interval '1 minute'
   where session_id = s and player_id not in (pg_temp.pid('tm', 8), pg_temp.pid('tm', 5), pg_temp.pid('tm', 7));
  t3 := pg_temp.tpts(s, 3);
  update chase.player_stats set round_points = 0 where session_id = s;
  perform pg_temp.set_state(s, 'hill', (pg_temp.state(s) -> 'hill') || jsonb_build_object('at', now() - interval '11 seconds'));
  perform chase._team_upkeep(s);
  st := pg_temp.state(s);
  assert (st -> 'hill' ->> 'holder')::int = 3 and st -> 'hill' ->> 'per' = '1', 'team 3 holds: ' || (st -> 'hill')::text;
  assert st -> 'hill' -> 'counts' = '[0, 0, 2, 1]'::jsonb, 'counts per team';
  assert pg_temp.tpts(s, 3) = t3 + 3, 'team +3';
  assert (select round_points from chase.player_stats where player_id = pg_temp.pid('tm', 8)) = 1
     and (select round_hill from chase.player_stats where player_id = pg_temp.pid('tm', 5)) = 1
     and (select round_points from chase.player_stats where player_id = pg_temp.pid('tm', 7)) = 0, 'holders +1';
  perform chase._team_upkeep(s);
  assert pg_temp.tpts(s, 3) = t3 + 3, 'once per period';
  perform pg_temp.set_state(s, 'hill', (pg_temp.state(s) -> 'hill') || jsonb_build_object('next_at', now() - interval '1 second'));
  perform chase._team_upkeep(s);
  st := pg_temp.state(s);
  assert st -> 'hill' ->> 'no' = '2' and st -> 'hill' -> 'pos' <> '{"lat":59.91045,"lng":10.7509}'::jsonb
     and st -> 'hill' ->> 'holder' is null, 'the hill moved: ' || (st -> 'hill')::text;
  assert (chase._round_view((select x from chase.sessions x where id = s)) -> 'hill') ? 'next_at', 'round view hill';

  -- Last round → gathering → ceremony: Lagspiller before Poeng, Lagpall last.
  perform pg_temp.next_phase(s);
  assert (select status from chase.sessions where id = s) = 'gathering', 'gathering';
  v := pg_temp.act(s, 'tm', 'ceremony_start');
  assert (v ->> 'ok')::boolean, 'ceremony: ' || v::text;
  select podiums into v from chase.sessions where id = s;
  n := jsonb_array_length(v);
  assert v -> (n - 1) ->> 'cat' = 'team' and jsonb_array_length(v -> (n - 1) -> 'entries') = 4, 'Lagpall last: ' || v::text;
  assert exists (select 1 from jsonb_array_elements(v) x where x ->> 'cat' = 'teamplay'), 'Lagspiller';
  assert (select o from jsonb_array_elements(v) with ordinality t(x, o) where x ->> 'cat' = 'teamplay')
       < (select o from jsonb_array_elements(v) with ordinality t(x, o) where x ->> 'cat' = 'points'), 'before Poeng';
  update chase.sessions set ceremony_step = n where id = s;
  v := chase._ceremony_view(s, pg_temp.pid('tm', 10));
  assert v -> 'revealed' -> (n - 1) -> 'entries' -> 0 ->> 'color' like '#%', 'team colour';
  assert exists (select 1 from jsonb_array_elements(v -> 'revealed' -> (n - 1) -> 'entries') e
                  where e ->> 'nickname' = 'Rød' and (e ->> 'me')::boolean), 'my team is marked';
  assert jsonb_array_length(v -> 'revealed' -> (n - 1) -> 'entries') = 4, 'every team shown';

  assert not has_function_privilege('anon', 'chase.team_msg(uuid,text,uuid,text)', 'execute'), 'anon';
  assert not has_function_privilege('authenticated', 'chase._teams_deal(uuid)', 'execute'), 'authenticated';
  perform chase.end_session(s, pg_temp.h('host-tm'), true);
  assert not exists (select 1 from chase.player_live where session_id = s), 'messages gone with player_live';
  raise notice '0009 king + ceremony: ok';
end $$;
