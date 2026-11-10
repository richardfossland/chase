-- Assertions for 0004_tag.sql (Smittejakt). Runs in scripts/test-db.sh.
-- Same ~100 × 100 m Oslo square. 1 m ≈ 0.00000898° lat, ≈ 0.00001793° lng.
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
-- Tick player i at (dx, dy) metres from the centre.
create function pg_temp.at(p_tag text, p_i int, dx double precision, dy double precision, p_acc real default 5)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.tok(p_tag, p_i),
                    59.91045 + dy * 0.00000898, 10.7509 + dx * 0.00001793, p_acc)
$$;
create function pg_temp.host(p_session uuid, p_tag text, p_action text) returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action) $$;
-- First hunter / first prey (by nickname order).
create function pg_temp.role_i(p_tag text, p_role text, p_nth int default 1) returns int language sql as $$
  select split_part(nickname, '-', 2)::int from chase.players
   where session_id = (select session_id from chase.players where token_hash = pg_temp.tok(p_tag, 1)) and role = p_role
   order by nickname offset p_nth - 1 limit 1
$$;
create function pg_temp.code(p_tag text, p_i int) returns text language sql as
  $$ select catch_code from chase.players where id = pg_temp.pid(p_tag, p_i) $$;
create function pg_temp.catch(p_tag text, p_hunter int, p_code text) returns jsonb language sql as $$
  select chase.catch(pg_temp.pid(p_tag, p_hunter), pg_temp.tok(p_tag, p_hunter),
                     (select session_id from chase.players where id = pg_temp.pid(p_tag, 1)), p_code)
$$;

-- ───────────────────────── plan + roles ─────────────────────────
do $$
declare s uuid; n int;
begin
  assert chase._norm_plan('{"rounds":[{"mode":"tag","duration_s":300}]}') -> 'rounds' -> 0 ->> 'variant' = 'convert', 'default variant';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","duration_s":300,"variant":"swap"}]}') -> 'rounds' -> 0 ->> 'variant' = 'swap', 'swap';
  assert chase._norm_plan('{"rounds":[{"mode":"tag","duration_s":300,"variant":"bogus"}]}') is null, 'bad variant';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}]}') -> 'rounds' -> 0 = '{"mode":"posts","duration_s":300}', 'posts unchanged';

  s := pg_temp.mk('rl', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 10);
  perform pg_temp.host(s, 'rl', 'start');
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 2, '10 players → 2 hunters (15 %, rounded)';
  assert (select count(*) from chase.players where session_id = s and role = 'prey') = 8, '8 prey';
  assert (select count(distinct catch_code) from chase.players where session_id = s and catch_code ~ '^[0-9]{4}$') = 10, 'distinct 4-digit codes';
  assert (select count(*) from chase.player_stats st join chase.players p on p.id = st.player_id
           where p.session_id = s and p.role = 'prey' and st.current_survival_start = now()) = 8, 'prey survival clock starts';
  assert exists (select 1 from chase.events where session_id = s and type = 'tag_roles'), 'roles event';

  -- One player: still one hunter (nothing to catch, but no crash).
  s := pg_temp.mk('r1', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 1);
  perform pg_temp.host(s, 'r1', 'start');
  assert (select role from chase.players where session_id = s) = 'hunter', 'single player is hunter';

  -- Sitting out keeps out of the deal.
  s := pg_temp.mk('rs', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 3);
  perform chase.host_action(s, pg_temp.h('host-rs'), 'sit_out', jsonb_build_object('player_id', pg_temp.pid('rs', 3)));
  perform pg_temp.host(s, 'rs', 'start');
  assert (select role from chase.players where id = pg_temp.pid('rs', 3)) = 'sitting_out', 'sitting out not dealt';
  raise notice '0004 plan + roles: ok';
end $$;

-- ───────────────────────── visibility ─────────────────────────
do $$
declare s uuid; h int; p1 int; p2 int; v jsonb;
begin
  s := pg_temp.mk('vi', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 6);
  perform pg_temp.host(s, 'vi', 'start');
  h := pg_temp.role_i('vi', 'hunter'); p1 := pg_temp.role_i('vi', 'prey', 1); p2 := pg_temp.role_i('vi', 'prey', 2);

  perform pg_temp.at('vi', p1, 20, 0);    -- 20 m from centre
  perform pg_temp.at('vi', p2, -40, 0);   -- 40 m the other way
  v := pg_temp.at('vi', h, 0, 0);
  assert (v -> 'tag' ->> 'prey_near')::int = 1, 'one prey within 30 m: ' || (v -> 'tag')::text;
  assert jsonb_array_length(v -> 'tag' -> 'radar') >= 2, 'radar pings for prey with a fix';
  assert not (v -> 'tag') ? 'hunter_near', 'hunters do not get the prey ring';
  assert v -> 'tag' ->> 'code' ~ '^[0-9]{4}$', 'everyone in the round sees own code';

  v := pg_temp.at('vi', p1, 20, 0);
  assert (v -> 'tag' ->> 'hunter_near')::boolean, 'prey 20 m from a hunter sees the ring';
  assert not (v -> 'tag') ? 'radar', 'prey never get positions';
  v := pg_temp.at('vi', p2, -40, 0);
  assert (v -> 'tag' ->> 'hunter_near')::boolean, 'prey 40 m away still within 60 m';
  v := pg_temp.at('vi', p2, -45, 40);
  assert not (v -> 'tag' ->> 'hunter_near')::boolean, 'prey > 60 m: no ring';

  -- Ping cadence: no new ping before 30 s; a still prey is pinged after 10 s; a runner gets stealth.
  update chase.player_live set ping_at = now() - interval '12 seconds', still_since = now() - interval '20 seconds'
   where player_id = pg_temp.pid('vi', p1);
  update chase.player_live set ping_at = now() - interval '12 seconds', still_since = now()
   where player_id = pg_temp.pid('vi', p2);
  perform chase._mode_upkeep(s);
  assert (select ping_at = now() from chase.player_live where player_id = pg_temp.pid('vi', p1)), 'still prey pinged after 10 s';
  assert (select ping_at < now() from chase.player_live where player_id = pg_temp.pid('vi', p2)), 'moving prey waits for 30 s';
  update chase.player_live set ping_at = now() - interval '31 seconds', speed = 3, pos = chase._pt(59.9101, 10.7501)
   where player_id = pg_temp.pid('vi', p2);
  perform chase._mode_upkeep(s);
  assert (select ping_stealth and not ST_DWithin(ping_pos, chase._pt(59.9101, 10.7501), 5)
            from chase.player_live where player_id = pg_temp.pid('vi', p2)), 'running > 2 m/s: stealth, old ping kept';
  raise notice '0004 visibility: ok';
end $$;

-- ───────────────────────── catch: failures ─────────────────────────
do $$
declare s uuid; h int; p1 int; p2 int;
begin
  s := pg_temp.mk('cf', '{"rounds":[{"mode":"free","duration_s":300},{"mode":"tag","duration_s":300}],"countdown_s":0,"breather_s":0}', 6);
  perform pg_temp.host(s, 'cf', 'start');
  assert pg_temp.catch('cf', 1, '1234') ->> 'error' = 'not_now', 'free round: not now';
  perform pg_temp.host(s, 'cf', 'next');
  assert (select status || ':' || round_idx from chase.sessions where id = s) = 'live:1', 'tag round live';
  h := pg_temp.role_i('cf', 'hunter'); p1 := pg_temp.role_i('cf', 'prey', 1); p2 := pg_temp.role_i('cf', 'prey', 2);

  perform pg_temp.at('cf', h, 0, 0);
  perform pg_temp.at('cf', p1, 10, 0);
  perform pg_temp.at('cf', p2, 0, -45);
  assert pg_temp.catch('cf', p1, pg_temp.code('cf', p2)) ->> 'error' = 'not_hunter', 'prey cannot catch';
  assert pg_temp.catch('cf', h, '0000') ->> 'error' in ('bad_code'), 'unknown code';
  assert pg_temp.catch('cf', h, pg_temp.code('cf', p2)) ->> 'error' = 'too_far', '45 m > max(30, 10) → too far';
  -- Poor accuracy widens the radius (accA + accB), capped at 50 m.
  perform pg_temp.at('cf', p2, 0, -45, 30);
  assert pg_temp.catch('cf', h, pg_temp.code('cf', p2)) ->> 'error' = 'too_far', 'acc 5 + 30 = 35 m < 45 m';
  perform pg_temp.at('cf', p2, 0, -45, 45);
  assert (pg_temp.catch('cf', h, pg_temp.code('cf', p2)) ->> 'ok')::boolean, 'acc 5 + 45 → capped 50 m ≥ 45 m: caught';
  perform pg_temp.at('cf', p1, 10, 0);
  perform pg_temp.at('cf', h, 0, 0);
  update chase.player_live set fix_at = now() - interval '25 seconds' where player_id = pg_temp.pid('cf', p1);
  assert pg_temp.catch('cf', h, pg_temp.code('cf', p1)) ->> 'error' = 'no_fix', 'stale prey fix';
  perform pg_temp.at('cf', p1, 10, 0);
  update chase.players set immune_until = now() + interval '5 seconds' where id = pg_temp.pid('cf', p1);
  assert pg_temp.catch('cf', h, pg_temp.code('cf', p1)) ->> 'error' = 'immune', 'immune prey';
  assert (select count(*) from chase.events where session_id = s and type = 'catch_fail') >= 5, 'failed attempts logged';
  assert not exists (select 1 from chase.events where session_id = s and type like 'catch%' and payload ? 'pos'), 'no coordinates';
  raise notice '0004 catch failures: ok';
end $$;

-- ───────────────────────── catch: convert ─────────────────────────
do $$
declare s uuid; h int; h2 int; p1 int; p2 int; old text; v jsonb;
begin
  -- 12 players → 2 hunters, 10 prey.
  s := pg_temp.mk('cv', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 12);
  perform pg_temp.host(s, 'cv', 'start');
  h := pg_temp.role_i('cv', 'hunter', 1); h2 := pg_temp.role_i('cv', 'hunter', 2); p1 := pg_temp.role_i('cv', 'prey', 1);
  perform pg_temp.at('cv', h, 0, 0);
  perform pg_temp.at('cv', h2, 0, 20);     -- second hunter 20 m from the prey → assist
  perform pg_temp.at('cv', p1, 8, 5);
  old := pg_temp.code('cv', p1);
  v := pg_temp.catch('cv', h, old);
  assert (v ->> 'ok')::boolean and (v ->> 'points')::int = 15 and v ->> 'variant' = 'convert', 'catch ok: ' || v::text;
  assert v -> 'new_badges' ? 'first_catch', 'first_catch badge';
  assert (select role from chase.players where id = pg_temp.pid('cv', p1)) = 'hunter', 'prey converted';
  assert pg_temp.code('cv', p1) <> old, 'code rotated';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('cv', h)) = 15, 'hunter +15';
  assert (select (points, assists) = (5, 1) from chase.player_stats where player_id = pg_temp.pid('cv', h2)), 'assist +5';
  assert (select times_caught from chase.player_stats where player_id = pg_temp.pid('cv', p1)) = 1, 'times_caught';
  assert pg_temp.catch('cv', h, old) ->> 'error' = 'bad_code', 'old code is dead';
  assert exists (select 1 from chase.events where session_id = s and type = 'catch'), 'catch event';

  -- Catch everyone else → the last one gets +25 and the round ends.
  for p2 in select split_part(nickname, '-', 2)::int from chase.players where session_id = s and role = 'prey' order by nickname loop
    perform pg_temp.at('cv', p2, 5, 5);
    perform pg_temp.at('cv', h, 0, 0);
    v := pg_temp.catch('cv', h, pg_temp.code('cv', p2));
    assert (v ->> 'ok')::boolean, 'catch ' || p2 || ': ' || v::text;
  end loop;
  assert (v ->> 'last')::boolean, 'last prey flagged';
  assert (select status from chase.sessions where id = s) = 'gathering', 'all hunters → round (and playlist) over';
  assert (select badges @> '{survivor}' from chase.player_stats where player_id = pg_temp.pid('cv', p2)), 'last survivor badge';
  assert (select count(*) from chase.players where session_id = s and role in ('hunter', 'prey')) = 0, 'roles reset after round';
  assert (select catches from chase.player_stats where player_id = pg_temp.pid('cv', h)) >= 5, 'catches counted';
  assert (select badges @> '{catches_5}' from chase.player_stats where player_id = pg_temp.pid('cv', h)), 'catches_5 badge';
  raise notice '0004 convert: ok';
end $$;

-- ───────────────────────── catch: swap + immunity ─────────────────────────
do $$
declare s uuid; h int; p1 int; v jsonb;
begin
  s := pg_temp.mk('sw', '{"rounds":[{"mode":"tag","duration_s":300,"variant":"swap"}],"countdown_s":0}', 6);
  perform pg_temp.host(s, 'sw', 'start');
  h := pg_temp.role_i('sw', 'hunter'); p1 := pg_temp.role_i('sw', 'prey', 1);
  perform pg_temp.at('sw', h, 0, 0);
  perform pg_temp.at('sw', p1, 5, 0);
  v := pg_temp.catch('sw', h, pg_temp.code('sw', p1));
  assert (v ->> 'ok')::boolean and (v ->> 'immune_until')::timestamptz = now() + interval '20 seconds', 'swap: old hunter immune 20 s';
  assert (select role from chase.players where id = pg_temp.pid('sw', h)) = 'prey', 'hunter → prey';
  assert (select role from chase.players where id = pg_temp.pid('sw', p1)) = 'hunter', 'prey → hunter';
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 1, 'hunter count constant';
  -- No tag-back.
  perform pg_temp.at('sw', p1, 5, 0);
  perform pg_temp.at('sw', h, 0, 0);
  assert pg_temp.catch('sw', p1, pg_temp.code('sw', h)) ->> 'error' = 'immune', 'no tag-back while immune';
  v := pg_temp.at('sw', h, 0, 0);
  assert v -> 'tag' ->> 'immune_until' is not null and v ->> 'role' = 'prey', 'immunity in the view';
  assert (select current_survival_start = now() from chase.player_stats where player_id = pg_temp.pid('sw', h)), 'new prey survival clock';
  raise notice '0004 swap: ok';
end $$;

-- ───────────────────────── survival points, finish, pause ─────────────────────────
do $$
declare s uuid; h int; p1 int; v jsonb; u timestamptz;
begin
  s := pg_temp.mk('su', '{"rounds":[{"mode":"tag","duration_s":300},{"mode":"free","duration_s":60}],"countdown_s":0}', 6);
  perform pg_temp.host(s, 'su', 'start');
  h := pg_temp.role_i('su', 'hunter'); p1 := pg_temp.role_i('su', 'prey', 1);
  update chase.player_stats set current_survival_start = now() - interval '26 seconds' where player_id = pg_temp.pid('su', p1);
  v := pg_temp.at('su', p1, 0, 0);
  assert (v -> 'stats' ->> 'points')::int = 5, '26 s survived → +5: ' || (v -> 'stats')::text;
  v := pg_temp.at('su', p1, 0, 0);
  assert (v -> 'stats' ->> 'points')::int = 5, 'not counted twice';

  -- Pause shifts survival start and immunity.
  update chase.players set immune_until = now() + interval '10 seconds' where id = pg_temp.pid('su', p1);
  perform pg_temp.host(s, 'su', 'pause');
  update chase.sessions set frozen_at = now() - interval '60 seconds', paused_at = now() - interval '60 seconds' where id = s;
  perform pg_temp.host(s, 'su', 'resume');
  assert (select immune_until from chase.players where id = pg_temp.pid('su', p1)) = now() + interval '70 seconds', 'immunity shifted by pause';
  assert (select current_survival_start from chase.player_stats where player_id = pg_temp.pid('su', p1))
         = now() - interval '26 seconds' + interval '60 seconds', 'survival clock shifted by pause';

  -- Round over with prey alive (convert): +25 for survivors, longest survival kept.
  update chase.player_stats set current_survival_start = now() - interval '100 seconds' where player_id = pg_temp.pid('su', p1);
  update chase.sessions set phase_ends_at = now() where id = s;
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) in ('breather', 'countdown', 'live'), 'round over';
  assert (select longest_survival_s >= 99 from chase.player_stats where player_id = pg_temp.pid('su', p1)), 'longest survival';
  assert (select points >= 30 and badges @> '{survivor}' from chase.player_stats where player_id = pg_temp.pid('su', p1)), 'survivor +25';
  assert (select per_round -> '0' ->> 'points' from chase.player_stats where player_id = pg_temp.pid('su', p1))::int >= 30,
         'survivor points in the round summary';
  raise notice '0004 survival + finish: ok';
end $$;

-- ───────────────────────── end + privileges ─────────────────────────
do $$
declare s uuid;
begin
  s := pg_temp.mk('ten', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 3);
  perform pg_temp.host(s, 'ten', 'start');
  assert (chase.end_session(s, pg_temp.h('host-ten'), true) ->> 'ok')::boolean, 'end';
  assert not exists (select 1 from chase.players where session_id = s and (catch_code is not null or immune_until is not null)), 'codes wiped';
  assert not has_function_privilege('anon', 'chase.catch(uuid,text,uuid,text)', 'execute'), 'anon: no catch';
  assert has_function_privilege('service_role', 'chase.catch(uuid,text,uuid,text)', 'execute'), 'service_role: catch';
  raise notice '0004 end + privileges: ALL ASSERTIONS PASSED';
end $$;
