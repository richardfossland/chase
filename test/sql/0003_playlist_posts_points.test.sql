-- Assertions for 0003_playlist_posts_points.sql. Runs in scripts/test-db.sh.
--
-- now() is frozen inside each DO block (one transaction), so "time passing"
-- is simulated by moving phase_ends_at / golden_at / anchors into the past.
-- Same ~100 × 100 m Oslo square as 0002. 1 m ≈ 0.00000898° lat, ≈ 0.00001793° lng.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.square() returns jsonb language sql as $$
  select '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}'::jsonb
$$;
create function pg_temp.assembly() returns jsonb language sql as
  $$ select '{"type":"Point","coordinates":[10.7509,59.91045]}'::jsonb $$;

-- Session with a playlist and N joined players (tokens 'tok-<tag>-<i>').
create function pg_temp.mk(p_tag text, p_plan jsonb, p_players int default 1, p_forbidden jsonb default null)
returns uuid language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null, pg_temp.square(), pg_temp.assembly(),
                            p_forbidden, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  for i in 1 .. p_players loop
    j := chase.join_session(r ->> 'pin', p_tag || '-' || i, pg_temp.h('tok-' || p_tag || '-' || i),
                            pg_temp.h('res-' || p_tag || '-' || i));
    assert (j ->> 'ok')::boolean, 'mk join: ' || j::text;
  end loop;
  return (r ->> 'session_id')::uuid;
end $$;

create function pg_temp.pid(p_tag text, p_i int) returns uuid language sql as
  $$ select id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-' || p_i) $$;

create function pg_temp.tick(p_tag text, p_i int, p_lat double precision, p_lng double precision, p_acc real default 5)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.h('tok-' || p_tag || '-' || p_i), p_lat, p_lng, p_acc)
$$;

create function pg_temp.host(p_tag text, p_action text, p_payload jsonb default '{}')
returns jsonb language sql as $$
  select chase.host_action((select session_id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-1')),
                           pg_temp.h('host-' || p_tag), p_action, p_payload)
$$;

-- Make the current phase due and advance.
create function pg_temp.due(p_session uuid) returns jsonb language sql as $$
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = p_session;
  select chase._advance(p_session);
$$;

-- ───────────────────────── plan validation ─────────────────────────
do $$
declare n jsonb; r jsonb; s uuid;
begin
  n := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":360},{"mode":"free","duration_s":60}]}');
  assert n = '{"rounds":[{"mode":"posts","duration_s":360},{"mode":"free","duration_s":60}],
               "countdown_s":10,"breather_s":60,"qr_posts":0}'::jsonb, 'defaults filled: ' || n::text;
  assert chase._norm_plan('{"rounds":[]}') is null, 'no rounds';
  assert chase._norm_plan('{"rounds":[{"mode":"bogus","duration_s":300}]}') is null, 'unknown mode';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":30}]}') is null, 'too short';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":99999}]}') is null, 'too long';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":"360"}]}') is null, 'string duration';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":360.5}]}') is null, 'fractional';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":360}],"breather_s":-1}') is null, 'breather < 0';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":360}],"qr_posts":13}') is null, 'too many qr';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":"x"}') is null, 'garbage';
  assert chase._norm_plan((select jsonb_build_object('rounds', jsonb_agg('{"mode":"free","duration_s":60}'::jsonb))
                             from generate_series(1, 11))) is null, '> 10 rounds';

  r := chase.create_session(pg_temp.h('pv'), null, pg_temp.square(), pg_temp.assembly(),
                            p_plan => '{"rounds":[{"mode":"bogus","duration_s":60}]}');
  assert r ->> 'error' = 'bad_plan', 'create rejects bad plan: ' || r::text;

  s := pg_temp.mk('qr0', '{"rounds":[{"mode":"posts","duration_s":360}],"qr_posts":6}', 1);
  assert (select count(*) from chase.posts where session_id = s and kind = 'physical_qr') = 6, '6 cards';
  assert (select count(distinct code) from chase.posts where session_id = s and code ~ '^[A-HJ-NP-Z2-9]{5}$') = 6,
         'codes: 5 unambiguous chars, distinct';
  assert (select array_agg(o.n order by o.n) from chase.posts o where o.session_id = s) = '{1,2,3,4,5,6}', 'cards numbered';
  assert (select bool_and(pos is null and round_idx = -1) from chase.posts where session_id = s), 'cards have no position';
  raise notice '0003 plan: ok';
end $$;

-- ───────────────────────── countdown → live, spawn rules ─────────────────────────
do $$
declare s uuid; v jsonb; a jsonb; c int;
begin
  -- Forbidden zone over the east quarter of the square.
  s := pg_temp.mk('sp', '{"rounds":[{"mode":"posts","duration_s":360}]}', 1,
    '{"type":"Polygon","coordinates":[[[10.75135,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75135,59.9109],[10.75135,59.91]]]}');
  v := pg_temp.host('sp', 'start');
  assert v ->> 'status' = 'countdown' and (v -> 'round' ->> 'idx')::int = 0, 'start → countdown: ' || v::text;
  assert (select phase_ends_at from chase.sessions where id = s) = now() + interval '10 seconds', 'countdown 10 s';

  v := pg_temp.tick('sp', 1, 59.91045, 10.7509);
  assert v ->> 'status' = 'countdown' and v -> 'posts' = 'null'::jsonb, 'no posts in countdown';
  assert (v -> 'round' ->> 'mode') = 'posts' and (v -> 'round' ->> 'count')::int = 1, 'round view in countdown';

  a := pg_temp.due(s);
  assert (a ->> 'changed')::boolean, 'advance reports change';
  assert (select status from chase.sessions where id = s) = 'live', 'countdown → live';
  assert (select round_started_at from chase.sessions where id = s) = now() - interval '1 second',
         'round starts at the previous phase end (exact catch-up)';
  assert (select phase_ends_at from chase.sessions where id = s) = now() - interval '1 second' + interval '360 seconds',
         'round ends after duration';
  assert (select state ? 'golden_at' from chase.rounds where session_id = s and idx = 0), 'golden scheduled';
  assert (select (state ->> 'golden_at')::timestamptz between now() + interval '120 seconds' and now() + interval '234 seconds'
            from chase.rounds where session_id = s and idx = 0), 'golden in 35–65 % of the round';

  select count(*) into c from chase.posts where session_id = s and round_idx = 0;
  assert c = 3, '1 player → posts_min 3: ' || c;
  assert (select bool_and(ST_Covers(ST_Buffer(se.boundary, -9.5), o.pos))
            from chase.posts o join chase.sessions se on se.id = o.session_id where o.session_id = s and o.round_idx = 0),
         'posts ≥ 10 m inside the boundary';
  assert (select bool_and(not ST_DWithin(o.pos, se.forbidden, 9.5))
            from chase.posts o join chase.sessions se on se.id = o.session_id where o.session_id = s and o.round_idx = 0),
         'posts ≥ 10 m from forbidden zones';
  assert (select bool_and(o.value in (10, 20) and o.kind = 'normal' and o.expires_at is null)
            from chase.posts o where o.session_id = s and o.round_idx = 0), 'normal values';

  v := pg_temp.tick('sp', 1, 59.91045, 10.7509);
  assert jsonb_array_length(v -> 'posts') = 3, 'player sees the 3 posts';
  assert (v -> 'posts' -> 0) ? 'pos' and (v -> 'posts' -> 0) ? 'value', 'post fields';
  raise notice '0003 countdown + spawn: ok';
end $$;

-- Spacing: 16 players → 4 posts, all ≥ 30 m apart (the 80 × 80 m spawn area fits 4 easily).
do $$
declare s uuid; bad int;
begin
  s := pg_temp.mk('sp2', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 16);
  perform pg_temp.host('sp2', 'start');
  assert (select count(*) from chase.posts where session_id = s and round_idx = 0) = 4, '16 players → 4 posts';
  select count(*) into bad from chase.posts a join chase.posts b on a.id < b.id
   where a.session_id = s and b.session_id = s and ST_DWithin(a.pos, b.pos, 29.5);
  assert bad = 0, 'posts ≥ 30 m apart';
  raise notice '0003 spacing: ok';
end $$;

-- Distance to players: a spawn avoids the 25 m around a player with a fresh fix.
do $$
declare s uuid; p uuid; near int;
begin
  s := pg_temp.mk('sp3', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 1);
  perform pg_temp.tick('sp3', 1, 59.91045, 10.7509);   -- lobby fix in the centre
  perform pg_temp.host('sp3', 'start');
  select count(*) into near from chase.posts o
   where o.session_id = s and ST_DWithin(o.pos, chase._pt(59.91045, 10.7509), 24.5);
  assert near = 0, 'no post within 25 m of the player: ' || near;
  raise notice '0003 player distance: ok';
end $$;

-- ───────────────────────── GPS claim ─────────────────────────
do $$
declare s uuid; po chase.posts; v jsonb; w jsonb; lat double precision; lng double precision;
begin
  s := pg_temp.mk('cl', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 2);
  perform pg_temp.host('cl', 'start');
  select * into po from chase.posts where session_id = s and round_idx = 0 order by value desc limit 1;
  lat := ST_Y(po.pos::geometry); lng := ST_X(po.pos::geometry);

  -- A poor fix never claims, even right on the post.
  v := pg_temp.tick('cl', 1, lat, lng, 30);
  v := pg_temp.tick('cl', 1, lat, lng, 30);
  assert v -> 'claimed' = 'null'::jsonb and v -> 'claim' = 'null'::jsonb, 'acc 30 m: no claim';

  -- Player 2 is 8 m away (inside 12 m) for one tick.
  w := pg_temp.tick('cl', 2, lat + 8 * 0.00000898, lng);
  assert (w -> 'claim' ->> 'hits')::int = 1 and (w -> 'claim' ->> 'post_id')::uuid = po.id, 'first hit: ' || w::text;

  -- Player 1: two consecutive good ticks → claim.
  v := pg_temp.tick('cl', 1, lat, lng);
  assert (v -> 'claim' ->> 'hits')::int = 1, 'p1 first hit';
  v := pg_temp.tick('cl', 1, lat + 3 * 0.00000898, lng);
  assert (v -> 'claimed' ->> 'post_id')::uuid = po.id and (v -> 'claimed' ->> 'value')::int = po.value,
         'p1 claims: ' || v::text;
  assert (v -> 'stats' ->> 'points')::int = po.value and (v -> 'stats' ->> 'posts')::int = 1, 'points + posts';
  assert v -> 'new_badges' ? 'first_post', 'first_post badge';
  assert (select claimed_by from chase.posts where id = po.id) = pg_temp.pid('cl', 1), 'claimed_by';
  assert (select count(*) from chase.post_claims where post_id = po.id) = 1, 'one claim row';
  assert (select payload ->> 'via' from chase.events where session_id = s and type = 'claim') = 'gps', 'claim event';
  assert not exists (select 1 from chase.events where session_id = s and type = 'claim' and payload ? 'pos'), 'no coordinates in events';

  -- Player 2's second tick: the post is gone, nothing happens.
  w := pg_temp.tick('cl', 2, lat + 8 * 0.00000898, lng);
  assert w -> 'claimed' = 'null'::jsonb and (w -> 'stats' ->> 'points')::int = 0, 'p2 gets nothing';
  assert not exists (select 1 from jsonb_array_elements(w -> 'posts') e where (e ->> 'id')::uuid = po.id), 'claimed post hidden';

  -- The next tick (anyone) tops the round back up to 3 open posts.
  assert (select count(*) from chase.posts where session_id = s and round_idx = 0 and claimed_by is null) = 3,
         'replacement spawned on the next advance';

  -- Claim progress resets when moving away.
  w := pg_temp.tick('cl', 2, 59.91045, 10.7509);
  assert (select claim_hits from chase.player_live where player_id = pg_temp.pid('cl', 2)) in (0, 1), 'progress tracks nearest';
  raise notice '0003 claim: ok';
end $$;

-- Sitting out / lobby: no claims.
do $$
declare s uuid; po chase.posts; v jsonb;
begin
  s := pg_temp.mk('so', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 1);
  perform pg_temp.host('so', 'start');
  perform pg_temp.host('so', 'sit_out', jsonb_build_object('player_id', pg_temp.pid('so', 1)));
  select * into po from chase.posts where session_id = s limit 1;
  v := pg_temp.tick('so', 1, ST_Y(po.pos::geometry), ST_X(po.pos::geometry));
  v := pg_temp.tick('so', 1, ST_Y(po.pos::geometry), ST_X(po.pos::geometry));
  assert v -> 'claimed' = 'null'::jsonb, 'sitting out never claims';
  raise notice '0003 sit-out: ok';
end $$;

-- ───────────────────────── movement points + explorer ─────────────────────────
do $$
declare s uuid; p uuid; v jsonb;
begin
  s := pg_temp.mk('mv', '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}', 1);
  perform pg_temp.host('mv', 'start');
  p := pg_temp.pid('mv', 1);
  v := pg_temp.tick('mv', 1, 59.9101, 10.7505);
  update chase.player_live set last_good_at = last_good_at - interval '20 seconds' where player_id = p;
  v := pg_temp.tick('mv', 1, 59.9101 + 60 * 0.00000898, 10.7505);          -- 60 m in 20 s = 3 m/s
  assert (v -> 'stats' ->> 'points')::int = 1, '60 m → 1 movement point: ' || (v -> 'stats')::text;
  assert (select round_move_pts from chase.player_stats where player_id = p) = 1, 'round_move_pts';
  assert (select cardinality(cells) from chase.player_stats where player_id = p) = 2, 'two explorer cells';

  -- Cap: 20 per round.
  update chase.player_stats set round_distance_m = 990, round_move_pts = 19, points = 19 where player_id = p;
  update chase.player_live set last_good_at = last_good_at - interval '20 seconds' where player_id = p;
  v := pg_temp.tick('mv', 1, 59.9101, 10.7505);
  assert (v -> 'stats' ->> 'points')::int = 20, 'capped at 20: ' || (v -> 'stats')::text;
  raise notice '0003 movement points: ok';
end $$;

-- ───────────────────────── golden post ─────────────────────────
do $$
declare s uuid; g chase.posts; a jsonb; v jsonb;
begin
  s := pg_temp.mk('gd', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 1);
  perform pg_temp.host('gd', 'start');
  update chase.rounds set state = jsonb_build_object('golden_at', now() - interval '1 second') where session_id = s;
  a := chase._advance(s);
  assert (a ->> 'golden')::boolean, 'golden reported (broadcast hint)';
  select * into g from chase.posts where session_id = s and kind = 'golden';
  assert g.value = 50 and g.expires_at = now() + interval '60 seconds', 'golden 50 p, 60 s';
  assert (select (state ->> 'golden_done')::boolean from chase.rounds where session_id = s), 'only once';
  assert not (chase._advance(s) ->> 'golden')::boolean, 'no second golden';
  assert exists (select 1 from chase.events where session_id = s and type = 'golden'), 'golden event';

  v := pg_temp.tick('gd', 1, ST_Y(g.pos::geometry), ST_X(g.pos::geometry));
  v := pg_temp.tick('gd', 1, ST_Y(g.pos::geometry), ST_X(g.pos::geometry));
  assert v -> 'claimed' ->> 'kind' = 'golden' and v -> 'new_badges' ? 'golden', 'golden claim + badge: ' || v::text;

  -- An unclaimed golden post disappears when it expires.
  s := pg_temp.mk('gd2', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0}', 1);
  perform pg_temp.host('gd2', 'start');
  update chase.rounds set state = jsonb_build_object('golden_at', now() - interval '1 second') where session_id = s;
  perform chase._advance(s);
  update chase.posts set expires_at = now() - interval '1 second' where session_id = s and kind = 'golden';
  perform chase._advance(s);
  assert not exists (select 1 from chase.posts where session_id = s and kind = 'golden'), 'expired golden removed';
  -- Short rounds get no golden post.
  s := pg_temp.mk('gd3', '{"rounds":[{"mode":"posts","duration_s":90}],"countdown_s":0}', 1);
  perform pg_temp.host('gd3', 'start');
  assert not (select state ? 'golden_at' from chase.rounds where session_id = s), 'no golden in 90 s round';
  raise notice '0003 golden: ok';
end $$;

-- ───────────────────────── playlist: round → breather → … → gathering ─────────────────────────
do $$
declare s uuid; p uuid; v jsonb; snap jsonb;
begin
  s := pg_temp.mk('pl', '{"rounds":[{"mode":"posts","duration_s":120},{"mode":"posts","duration_s":120},{"mode":"free","duration_s":60}],
                          "countdown_s":10,"breather_s":60}', 1);
  p := pg_temp.pid('pl', 1);
  perform pg_temp.host('pl', 'start');
  perform pg_temp.due(s);                                   -- countdown → round 0
  update chase.player_stats set round_points = 37, points = 37, round_posts = 2 where player_id = p;
  perform pg_temp.due(s);                                   -- round 0 → breather
  assert (select status from chase.sessions where id = s) = 'breather', 'breather';
  assert (select ended_at from chase.rounds where session_id = s and idx = 0) is not null, 'round 0 ended';
  assert not exists (select 1 from chase.posts where session_id = s and round_idx = 0 and claimed_by is null), 'open posts removed';
  assert (select per_round -> '0' ->> 'points' from chase.player_stats where player_id = p) = '37', 'per_round snapshot';
  v := pg_temp.tick('pl', 1, 59.91045, 10.7509);
  assert v ->> 'status' = 'breather' and (v -> 'summary' ->> 'points')::int = 37 and (v -> 'summary' ->> 'posts')::int = 2,
         'summary in breather: ' || coalesce(v -> 'summary', 'null')::text;
  assert v -> 'posts' = 'null'::jsonb, 'no posts in breather';
  assert (v -> 'round' -> 'next' ->> 'mode') = 'posts', 'next round shown';

  perform pg_temp.due(s);                                   -- breather → countdown 1
  assert (select status || ':' || round_idx from chase.sessions where id = s) = 'countdown:1', 'countdown round 1';
  perform pg_temp.due(s);                                   -- → live round 1
  assert (select round_points from chase.player_stats where player_id = p) = 0, 'round stats reset';
  assert (select points from chase.player_stats where player_id = p) = 37, 'session points kept';
  assert (select count(*) from chase.posts where session_id = s and round_idx = 1) = 3, 'fresh posts for round 1';

  -- Catch-up: the whole rest of the playlist overdue in one go (server was idle).
  update chase.sessions set phase_ends_at = now() - interval '200 seconds' where id = s;
  v := chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'gathering', 'catch-up to the end: gathering';
  assert (select ended_at from chase.rounds where session_id = s and idx = 2) = now() - interval '200 seconds' + interval '60 seconds' + interval '10 seconds' + interval '60 seconds',
         'exact timeline in catch-up';
  assert exists (select 1 from chase.events where session_id = s and type = 'playlist_done'), 'playlist_done event';
  snap := chase.host_snapshot(s, pg_temp.h('host-pl'));
  assert (snap ->> 'playlist_done')::boolean and snap ->> 'status' = 'gathering', 'snapshot: playlist done';
  assert pg_temp.host('pl', 'end_gather') ->> 'error' = 'bad_state', 'nothing to go back to';
  assert pg_temp.host('pl', 'next') ->> 'error' = 'bad_state', 'no next after the list';
  assert (select checked_in_at from chase.players where id = p) is null, 'roll call reset';
  raise notice '0003 playlist: ok';
end $$;

-- breather_s 0: straight to the next countdown.
do $$
declare s uuid;
begin
  s := pg_temp.mk('nb', '{"rounds":[{"mode":"free","duration_s":60},{"mode":"free","duration_s":60}],"countdown_s":0,"breather_s":0}', 1);
  perform pg_temp.host('nb', 'start');
  perform pg_temp.due(s);
  assert (select status || ':' || round_idx from chase.sessions where id = s) = 'live:1', 'no breather, no countdown';
  raise notice '0003 zero breather: ok';
end $$;

-- ───────────────────────── teacher: pause, gather, next, extend ─────────────────────────
do $$
declare s uuid; e0 timestamptz; v jsonb;
begin
  s := pg_temp.mk('tc', '{"rounds":[{"mode":"posts","duration_s":360},{"mode":"free","duration_s":60}],"countdown_s":0}', 1);
  perform pg_temp.host('tc', 'start');
  update chase.rounds set state = jsonb_build_object('golden_at', now() + interval '100 seconds') where session_id = s;
  select phase_ends_at into e0 from chase.sessions where id = s;

  perform pg_temp.host('tc', 'pause');
  assert (select frozen_at from chase.sessions where id = s) = now(), 'pause freezes';
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;   -- would be due …
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'paused', '… but a frozen session never advances';
  update chase.sessions set phase_ends_at = e0, frozen_at = now() - interval '100 seconds',
                            paused_at = now() - interval '100 seconds' where id = s;
  perform pg_temp.host('tc', 'resume');
  assert (select phase_ends_at from chase.sessions where id = s) = e0 + interval '100 seconds', 'resume shifts the round end';
  assert (select (state ->> 'golden_at')::timestamptz from chase.rounds where session_id = s and idx = 0)
         = now() + interval '200 seconds', 'resume shifts the golden post too';
  assert (select frozen_at from chase.sessions where id = s) is null, 'unfrozen';

  -- Gather mid-round freezes; end_gather resumes the round.
  perform pg_temp.host('tc', 'gather');
  assert (select status || ':' || pre_gather_status from chase.sessions where id = s) = 'gathering:live', 'gather from live';
  update chase.sessions set frozen_at = now() - interval '30 seconds' where id = s;
  perform pg_temp.host('tc', 'end_gather');
  assert (select status from chase.sessions where id = s) = 'live', 'back to live';
  assert (select phase_ends_at from chase.sessions where id = s) = e0 + interval '130 seconds', 'gather time not lost';

  v := pg_temp.host('tc', 'extend', '{"seconds":60}');
  assert (v ->> 'ok')::boolean and (select phase_ends_at from chase.sessions where id = s) = e0 + interval '190 seconds', 'extend +60';
  assert pg_temp.host('tc', 'extend', '{"seconds":5}') ->> 'error' = 'bad_seconds', 'extend bounds';
  v := pg_temp.host('tc', 'next');
  assert v ->> 'status' = 'breather', 'next ends the round: ' || v::text;
  assert pg_temp.host('tc', 'extend') ->> 'error' = 'bad_state', 'no extend in breather';
  v := pg_temp.host('tc', 'next');
  assert v ->> 'status' = 'live' and (v -> 'round' ->> 'idx')::int = 1, 'next skips breather (+ 0 s countdown)';
  raise notice '0003 teacher controls: ok';
end $$;

-- ───────────────────────── physical QR posts ─────────────────────────
do $$
declare s uuid; c text; v jsonb;
begin
  s := pg_temp.mk('qr', '{"rounds":[{"mode":"free","duration_s":60},{"mode":"posts","duration_s":360}],"countdown_s":0,"qr_posts":3}', 2);
  select code into c from chase.posts where session_id = s and n = 2;
  v := chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('tok-qr-1'), s, c);
  assert v ->> 'error' = 'not_now', 'lobby: not now';
  perform pg_temp.host('qr', 'start');
  assert chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('tok-qr-1'), s, c) ->> 'error' = 'not_now', 'free round: not now';
  perform pg_temp.due(s);   -- free → breather
  perform pg_temp.due(s);   -- breather → countdown(0) … → live posts
  assert (select status || ':' || round_idx from chase.sessions where id = s) = 'live:1', 'in posts round';

  assert chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('tok-qr-1'), s, 'ZZZZZ') ->> 'error' = 'bad_code', 'bad code';
  assert chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('nope'), s, c) ->> 'error' = 'auth', 'bad token';
  v := chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('tok-qr-1'), s, lower(c) || ' ');
  assert (v ->> 'ok')::boolean and (v ->> 'value')::int = 20 and (v ->> 'first')::boolean and (v ->> 'n')::int = 2,
         'first scanner: 15 + 5 (code case/space tolerant): ' || v::text;
  assert v -> 'new_badges' ? 'qr' and v -> 'new_badges' ? 'first_post', 'qr badges';
  v := chase.claim_qr(pg_temp.pid('qr', 1), pg_temp.h('tok-qr-1'), s, c);
  assert (v ->> 'already')::boolean and (v ->> 'value')::int = 0, 'once per round per player';
  v := chase.claim_qr(pg_temp.pid('qr', 2), pg_temp.h('tok-qr-2'), s, c);
  assert (v ->> 'value')::int = 15 and not (v ->> 'first')::boolean, 'second scanner: 15';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('qr', 1)) = 20, 'points';
  assert (select qr_cards from (select chase.host_snapshot(s, pg_temp.h('host-qr'), true) -> 'qr_cards' as qr_cards) x)
         @> jsonb_build_array(jsonb_build_object('n', 2, 'code', c)), 'cards in the print snapshot';
  assert chase.host_snapshot(s, pg_temp.h('host-qr')) -> 'qr_cards' = 'null'::jsonb, 'cards not in the poll snapshot';
  raise notice '0003 qr: ok';
end $$;

-- ───────────────────────── snapshot ─────────────────────────
do $$
declare s uuid; snap jsonb;
begin
  s := pg_temp.mk('sn', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":10}', 1);
  perform pg_temp.host('sn', 'start');
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  snap := chase.host_snapshot(s, pg_temp.h('host-sn'));
  assert snap ->> 'status' = 'live' and (snap ->> 'hint_all')::boolean, 'snapshot advances + hints: ' || (snap ->> 'status');
  assert jsonb_array_length(snap -> 'posts') = 3 and (snap -> 'round' ->> 'mode') = 'posts', 'teacher sees posts';
  assert (snap -> 'players' -> 0) ? 'round_points', 'round points per player';
  raise notice '0003 snapshot: ok';
end $$;

-- ───────────────────────── end_session wipes posts, claims, cells ─────────────────────────
do $$
declare s uuid; p uuid; po chase.posts;
begin
  s := pg_temp.mk('en', '{"rounds":[{"mode":"posts","duration_s":360}],"countdown_s":0,"qr_posts":2}', 1);
  p := pg_temp.pid('en', 1);
  perform pg_temp.host('en', 'start');
  select * into po from chase.posts where session_id = s and kind = 'normal' limit 1;
  perform pg_temp.tick('en', 1, ST_Y(po.pos::geometry), ST_X(po.pos::geometry));
  perform pg_temp.tick('en', 1, ST_Y(po.pos::geometry), ST_X(po.pos::geometry));
  assert exists (select 1 from chase.post_claims where player_id = p), 'claimed before end';
  assert (select cardinality(cells) from chase.player_stats where player_id = p) >= 1, 'cells before end';
  assert (chase.end_session(s, pg_temp.h('host-en'), true) ->> 'ok')::boolean, 'end';
  assert not exists (select 1 from chase.posts where session_id = s), 'posts deleted';
  assert not exists (select 1 from chase.post_claims where session_id = s), 'claims deleted';
  assert (select cells = '{}' and explorer_n >= 1 from chase.player_stats where player_id = p), 'cells wiped, count kept';
  assert (select phase_ends_at is null and frozen_at is null from chase.sessions where id = s), 'clock cleared';
  assert (select duration_s >= 0 from chase.session_summaries order by created_at desc limit 1), 'summary';
  raise notice '0003 end: ok';
end $$;

-- ───────────────────────── privileges ─────────────────────────
do $$
begin
  assert not has_function_privilege('anon', 'chase.claim_qr(uuid,text,uuid,text)', 'execute'), 'anon: no claim_qr';
  assert not has_function_privilege('authenticated', 'chase._advance(uuid)', 'execute'), 'authenticated: no _advance';
  assert has_function_privilege('service_role', 'chase.claim_qr(uuid,text,uuid,text)', 'execute'), 'service_role: claim_qr';
  assert not has_table_privilege('anon', 'chase.post_claims', 'select'), 'anon: no post_claims';
  assert (select relrowsecurity from pg_class where oid = 'chase.post_claims'::regclass), 'post_claims has RLS';
  raise notice '0003 privileges: ALL ASSERTIONS PASSED';
end $$;
