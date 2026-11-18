-- Assertions for 0020_practice_scoreo.sql. Runs in scripts/test-db.sh (upkeep on every advance).
-- Same ~100 × 100 m Oslo square as the other tests; the assembly point is its centre. now() is constant inside a DO block.
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
-- Two ticks at a post (claim needs two in a row).
create function pg_temp.claim(p_tag text, p_i int, p_post uuid) returns jsonb language plpgsql as $$
declare lat float8; lng float8; r jsonb;
begin
  select ST_Y(pos::geometry), ST_X(pos::geometry) into lat, lng from chase.posts where id = p_post;
  r := pg_temp.tick(p_tag, p_i, lat, lng);
  return pg_temp.tick(p_tag, p_i, lat, lng);
end $$;

-- ───────────────────────── pure rules (same vectors as test/scoreo.test.ts) ─────────────────────────
do $$
declare v jsonb;
begin
  assert array(select chase._so_value(d, 100) from unnest(array[0, 24.9, 25, 49.9, 50, 74.9, 75, 100, 150, -5]::float8[]) d) = array[10, 10, 20, 20, 30, 30, 40, 40, 40, 10], 'value bands';
  assert array(select chase._so_pen(l, b) from (values (0, 50), (-3, 50), (0.1, 50), (10, 50), (10.1, 50), (25, 50), (95, 50), (200, 30), (30, 0), (30, 7)) t(l, b)) = array[0, 0, 5, 5, 10, 15, 50, 30, 0, 7], 'penalty';
  assert chase._so_pen(null, 50) = 0, 'no lateness';
  assert chase.ks('so_posts') = 12 and chase.ks('so_return_s') = 120, 'constants';
  assert chase._ev_kinds('scoreo', false, true) = '{}'::text[], 'scoreo: no automatic events';
  assert chase._ev_kinds('scoreo', false, false) = array['mission'], 'scoreo: the teacher''s missions';
  assert chase._ev_kinds('posts', false, true) = array['sprint', 'gather'], 'posts unchanged';
  -- Plans (twin: normPlan).
  v := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":60,"practice":true},{"mode":"scoreo","duration_s":300},{"mode":"tag","variant":"swap","duration_s":60,"practice":true}]}');
  assert v -> 'rounds' -> 0 = '{"mode":"posts","duration_s":60,"practice":true}', 'practice posts: ' || v::text;
  assert v -> 'rounds' -> 1 = '{"mode":"scoreo","duration_s":300}' and not v ? 'teams', 'scoreo: ' || v::text;
  assert v -> 'rounds' -> 2 = '{"mode":"tag","variant":"swap","duration_s":60,"practice":true}', 'practice tag: ' || v::text;
  v := chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"practice":false},{"mode":"free","duration_s":300,"practice":null}]}');
  assert not (v -> 'rounds' -> 0 ? 'practice') and not (v -> 'rounds' -> 1 ? 'practice'), 'practice false is omitted';
  assert chase._norm_plan('{"rounds":[{"mode":"free","duration_s":60,"practice":true}]}') is null, 'practice only on posts/tag';
  assert chase._norm_plan('{"rounds":[{"mode":"scoreo","duration_s":300,"practice":true}]}') is null, 'no practice scoreo';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":60,"practice":true,"zone":true}]}') is null, 'no practice zone';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":60,"practice":true,"team":true}]}') is null, 'no practice team';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":60,"practice":"yes"}]}') is null, 'practice must be boolean';
  assert chase._norm_plan('{"rounds":[{"mode":"scoreo","duration_s":300,"zone":true}]}') is null, 'no zone on scoreo';
  assert chase._norm_plan('{"rounds":[{"mode":"scoreo","duration_s":300,"team":true}]}') is null, 'scoreo is individual';
  assert chase._norm_plan('{"rounds":[{"mode":"scoreo","duration_s":30}]}') is null, 'base limits still apply';
  -- Podium.
  v := chase._scoreo_podiums('[{"cat":"distance_m","entries":[]},{"cat":"points","entries":[]}]',
         '[{"id":"b","so":40},{"id":"a","so":40},{"id":"c","so":0},{"id":"d","so":10}]');
  assert v = '[{"cat":"distance_m","entries":[]},{"cat":"scoreo","entries":[{"id":"a","value":40},{"id":"b","value":40},{"id":"d","value":10}]},{"cat":"points","entries":[]}]', 'podium: ' || v::text;
  assert chase._scoreo_podiums('[{"cat":"points","entries":[]}]', '[{"id":"c","so":0}]') = '[{"cat":"points","entries":[]}]', 'no podium without points';
  raise notice '0020 pure rules: ok';
end $$;

-- ───────────────────────── practice ─────────────────────────
do $$
declare s uuid; t jsonb; v_post uuid; st chase.player_stats;
begin
  s := pg_temp.mk('pr', '{"rounds":[{"mode":"posts","duration_s":60,"practice":true},{"mode":"posts","duration_s":60}],"countdown_s":0,"breather_s":0}', 2);
  perform pg_temp.act(s, 'pr', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  t := pg_temp.tick('pr', 1);
  assert (t -> 'round' ->> 'practice')::boolean, 'round view says practice: ' || (t -> 'round')::text;
  assert (select practice from chase.player_stats where player_id = pg_temp.pid('pr', 1)), 'stats flagged';
  assert (select count(*) from chase.posts where session_id = s and round_idx = 0) >= 3, 'posts exist';
  assert (select max(value) from chase.posts where session_id = s and round_idx = 0) = 0, 'practice posts are worth 0';
  select id into v_post from chase.posts where session_id = s and round_idx = 0 limit 1;
  t := pg_temp.claim('pr', 1, v_post);
  assert t -> 'claimed' ->> 'value' = '0', 'claim works, 0 p: ' || coalesce(t ->> 'claimed', 'null');
  select * into st from chase.player_stats where player_id = pg_temp.pid('pr', 1);
  assert st.points = 0 and st.round_points = 0 and st.posts = 0 and st.round_posts = 0 and cardinality(st.badges) = 0, 'nothing counted';
  -- Even a direct points source is frozen (movement, events, catches all go through player_stats).
  update chase.player_stats set points = points + 50, round_points = round_points + 50, posts = posts + 3 where player_id = pg_temp.pid('pr', 1);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('pr', 1)) = 0, 'points frozen';
  update chase.player_stats set quiz_right = 5, powerups = array['shield'], team_acts = 4, round_move_pts = 3, distance_m = distance_m + 10, active_s = active_s + 7
   where player_id = pg_temp.pid('pr', 1);
  select * into st from chase.player_stats where player_id = pg_temp.pid('pr', 1);
  assert st.quiz_right = 0 and cardinality(st.powerups) = 0 and st.team_acts = 0 and st.round_move_pts = 0, 'other point columns frozen too (whitelist)';
  assert st.distance_m >= 10 and st.active_s >= 7, 'movement still counts';
  assert chase.host_action(s, pg_temp.h('host-pr'), 'adjust_points', jsonb_build_object('player_id', pg_temp.pid('pr', 1), 'delta', 5, 'reason', 'x')) ->> 'error' = 'practice', 'no point adjustment in practice';
  assert chase.host_action(s, pg_temp.h('host-pr'), 'event_start', '{"kind":"sprint"}') ->> 'error' = 'practice', 'no events in practice';
  assert chase.host_action(s, pg_temp.h('host-pr') || 'x', 'adjust_points', '{}') ->> 'error' = 'auth', 'bad token still auth';
  -- A late joiner plays the practice round too.
  perform chase.join_session((select join_pin from chase.sessions where id = s), 'pr-late', pg_temp.h('tok-pr-late'), pg_temp.h('res-pr-late'));
  assert (select practice from chase.player_stats where player_id = (select id from chase.players where token_hash = pg_temp.h('tok-pr-late'))), 'late joiner flagged';
  -- Round 2: normal scoring.
  perform pg_temp.act(s, 'pr', 'next');
  perform chase._advance(s);
  assert (select round_idx from chase.sessions where id = s) = 1 and (select status from chase.sessions where id = s) = 'live', 'round 2 live';
  assert not (select practice from chase.player_stats where player_id = pg_temp.pid('pr', 1)), 'flag cleared';
  t := pg_temp.tick('pr', 1);
  assert not (t -> 'round' ->> 'practice')::boolean, 'round 2 is not practice';
  select id into v_post from chase.posts where session_id = s and round_idx = 1 and value > 0 limit 1;
  assert v_post is not null, 'real posts have value';
  t := pg_temp.claim('pr', 1, v_post);
  assert (t -> 'claimed' ->> 'value')::int >= 10, 'real claim: ' || coalesce(t ->> 'claimed', 'null');
  select * into st from chase.player_stats where player_id = pg_temp.pid('pr', 1);
  assert st.points >= 10 and st.posts = 1, 'counts now';
  assert (st.per_round -> '0' ->> 'points')::int = 0, 'practice round banked 0 p';
  raise notice '0020 practice: ok';
end $$;

-- ───────────────────────── score-O ─────────────────────────
do $$
declare s uuid; t jsonb; v_p1 uuid; v_val int; v_max float8; st chase.player_stats; v_ends timestamptz;
begin
  s := pg_temp.mk('xso', '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}', 4);
  perform pg_temp.act(s, 'xso', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live: ' || (select status || ' ' || round_idx || ' ' || coalesce(phase_ends_at::text,'-') from chase.sessions where id = s);
  -- The phase runs through the return window.
  select phase_ends_at into v_ends from chase.sessions where id = s;
  assert extract(epoch from v_ends - (select started_at from chase.rounds where session_id = s and idx = 0)) = 300, 'phase = 180 + 120 s';
  assert (select count(*) from chase.posts where session_id = s) = 12, 'twelve posts';
  assert (select count(*) from chase.posts where session_id = s and claimed_by is not null) = 0, 'claimed_by unused';
  v_max := chase._so_maxd(s);
  assert v_max between 60 and 80, 'max distance ~71 m: ' || v_max;
  assert not exists (select 1 from chase.posts p join chase.sessions x on x.id = p.session_id
                      where p.session_id = s and p.value <> chase._so_value(ST_Distance(p.pos, x.assembly_point), v_max)), 'value follows the distance band';
  assert (select count(distinct value) from chase.posts where session_id = s) >= 2, 'different values';
  assert not exists (select 1 from chase.posts p join chase.sessions x on x.id = p.session_id
                      where p.session_id = s and ST_Distance(p.pos, x.assembly_point) < 20), 'none within 20 m of the assembly point';
  t := pg_temp.tick('xso', 1);
  assert t -> 'scoreo' ->> 'total' = '12' and t -> 'scoreo' ->> 'got' = '0' and jsonb_array_length(t -> 'scoreo' -> 'posts') = 12, 'view: ' || (t -> 'scoreo')::text;
  assert (t -> 'round' -> 'scoreo' ->> 'return_s') = '120' and (t -> 'round' ->> 'practice') = 'false', 'round view';
  assert (t -> 'scoreo' ->> 'past') = 'false', 'before the limit';

  -- Claims: each player once per post; others can take it too.
  select id, value into v_p1, v_val from chase.posts where session_id = s order by value desc limit 1;
  t := pg_temp.claim('xso', 1, v_p1);
  assert (t -> 'scoreo' -> 'claimed' ->> 'value')::int = v_val, 'claimed value: ' || (t -> 'scoreo')::text;
  assert t -> 'scoreo' ->> 'got' = '1' and jsonb_array_length(t -> 'scoreo' -> 'posts') = 11, 'post gone from my list';
  assert (t -> 'stats' ->> 'points')::int = v_val, 'points: ' || (t -> 'stats')::text;
  t := pg_temp.claim('xso', 1, v_p1);
  assert (t -> 'stats' ->> 'points')::int = v_val and t -> 'scoreo' ->> 'got' = '1', 'no second claim of the same post: ' || (t -> 'scoreo')::text || (t -> 'stats')::text;
  t := pg_temp.claim('xso', 2, v_p1);
  assert (t -> 'scoreo' -> 'claimed' ->> 'value')::int = v_val and jsonb_array_length(t -> 'scoreo' -> 'posts') = 11, 'another player takes the same post';
  assert (select count(*) from chase.post_claims where post_id = v_p1) = 2, 'two claims';

  -- Time limit: put the limit 60 s back (phase end = now + 60, return window 120).
  update chase.sessions set phase_ends_at = now() + interval '60 seconds' where id = s;
  t := pg_temp.tick('xso', 1, 59.9100, 10.7503);
  assert (t -> 'scoreo' ->> 'past') = 'true' and jsonb_array_length(t -> 'scoreo' -> 'posts') = 0, 'no posts after the limit';
  assert not (t -> 'scoreo' ->> 'arrived')::boolean, 'not in yet';
  perform chase._advance(s);
  assert (select (state -> 'so' ->> 'past_limit')::boolean from chase.rounds where session_id = s and idx = 0), 'limit frozen by the upkeep';
  -- … and arrives 60 s late: 6 started 10 s steps = 30 p, but never more than the round's points.
  t := pg_temp.tick('xso', 1);
  assert (t -> 'scoreo' ->> 'arrived')::boolean and (t -> 'scoreo' ->> 'late_s')::int = 60, 'arrived late: ' || (t -> 'scoreo')::text;
  assert (t -> 'scoreo' ->> 'penalty')::int = least(v_val, 30), 'penalty capped: ' || (t -> 'scoreo')::text;
  select * into st from chase.player_stats where player_id = pg_temp.pid('xso', 1);
  assert st.points = v_val - least(v_val, 30) and st.round_points = st.points, 'points reduced once: ' || st.points;
  t := pg_temp.tick('xso', 1);
  assert (select points from chase.player_stats where player_id = pg_temp.pid('xso', 1)) = st.points, 'penalty applied once';
  -- Player 2 was at the base before the limit: no penalty.
  update chase.player_stats set so_home_since = now() - interval '100 seconds' where player_id = pg_temp.pid('xso', 2);
  t := pg_temp.tick('xso', 2);
  assert (t -> 'scoreo' ->> 'arrived')::boolean and (t -> 'scoreo' ->> 'penalty')::int = 0 and (t -> 'scoreo' ->> 'late_s')::int = 0, 'in time: ' || (t -> 'scoreo')::text;
  assert (select points from chase.player_stats where player_id = pg_temp.pid('xso', 2)) = v_val, 'no deduction';
  -- Player 3 is at the base a while after the limit with zero points: penalty 0 whatever the lateness.
  t := pg_temp.tick('xso', 3);
  assert (t -> 'scoreo' ->> 'late_s')::int = 60 and (t -> 'scoreo' ->> 'penalty')::int = 0, 'nothing to lose';
  -- Player 4 never comes in (stays away): the whole round at the end. Give them points first.
  update chase.player_stats set points = 25, round_points = 25 where player_id = pg_temp.pid('xso', 4);
  perform pg_temp.tick('xso', 4, 59.9100, 10.7503);
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'still live: player 4 is out';
  update chase.sessions set phase_ends_at = now() where id = s;
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'gathering', 'playlist done → gathering';
  select * into st from chase.player_stats where player_id = pg_temp.pid('xso', 4);
  assert st.points = 0 and st.so_pen = 25 and st.so_late_s = 120, 'never in: the whole round: ' || st.points;
  t := pg_temp.tick('xso', 4);
  assert (t -> 'scoreo' ->> 'done')::boolean and t -> 'scoreo' ->> 'penalty' = '25', 'summary after the round: ' || (t -> 'scoreo')::text;
  assert not exists (select 1 from chase.player_stats where session_id = s and (so_home_since is not null or so_arrived_at is not null)), 'clocks cleared';
  assert (select so_pts from chase.player_stats where player_id = pg_temp.pid('xso', 2)) = v_val, 'so_pts banked';
  assert (select count(*) from chase.posts where session_id = s) = 0, 'posts gone';
  raise notice '0020 scoreo: ok';
end $$;

-- ───────────────────────── score-O: skipped early, early finish, ceremony ─────────────────────────
do $$
declare s uuid; v_post uuid; v_cat text[];
begin
  -- Teacher skips before the limit: nobody is penalised.
  s := pg_temp.mk('xs2', '{"rounds":[{"mode":"scoreo","duration_s":180},{"mode":"free","duration_s":60}],"countdown_s":0,"breather_s":30}', 2);
  perform pg_temp.act(s, 'xs2', 'start');
  perform chase._advance(s);
  select id into v_post from chase.posts where session_id = s limit 1;
  perform pg_temp.claim('xs2', 1, v_post);
  perform pg_temp.tick('xs2', 2, 59.9100, 10.7503);
  perform pg_temp.act(s, 'xs2', 'next');
  assert (select status from chase.sessions where id = s) = 'breather', 'skipped to the breather';
  assert (select so_pen from chase.player_stats where player_id = pg_temp.pid('xs2', 2)) = 0, 'no penalty when skipped early';
  assert (select so_pts from chase.player_stats where player_id = pg_temp.pid('xs2', 1)) > 0, 'so_pts';

  -- Everybody back after the limit: the round ends at once.
  s := pg_temp.mk('xs3', '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}', 2);
  perform pg_temp.act(s, 'xs3', 'start');
  perform chase._advance(s);
  update chase.sessions set phase_ends_at = now() + interval '60 seconds' where id = s;
  perform pg_temp.tick('xs3', 1);
  perform pg_temp.tick('xs3', 2);
  perform chase._advance(s);
  assert (select phase_ends_at <= now() from chase.sessions where id = s), 'everybody in: phase ends now';
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'gathering', 'round over';

  -- Ceremony: «Orienterer» before «Flest poeng».
  s := pg_temp.mk('xs4', '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}', 3);
  perform pg_temp.act(s, 'xs4', 'start');
  perform chase._advance(s);
  select id into v_post from chase.posts where session_id = s order by value desc limit 1;
  perform pg_temp.claim('xs4', 1, v_post);
  perform pg_temp.tick('xs4', 2);
  perform pg_temp.tick('xs4', 3);
  perform pg_temp.act(s, 'xs4', 'next');
  perform pg_temp.act(s, 'xs4', 'ceremony_start', '{"spread":false}');
  select array_agg(pod ->> 'cat' order by i) into v_cat from jsonb_array_elements((select podiums from chase.sessions where id = s)) with ordinality t(pod, i);
  assert 'scoreo' = any(v_cat), 'Orienterer podium: ' || v_cat::text;
  assert array_position(v_cat, 'scoreo') < array_position(v_cat, 'points'), 'before points: ' || v_cat::text;
  raise notice '0020 scoreo flow + ceremony: ok';
end $$;

-- ───────────────────────── score-O: pause, SOS, skip, fixed posts ─────────────────────────
do $$
declare s uuid; t jsonb; v_post uuid; v_val int; v_lim0 timestamptz; v_lim1 timestamptz; r jsonb;
begin
  -- Pause after the time limit: the pause is not lateness.
  s := pg_temp.mk('xp', '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}', 2);
  perform pg_temp.act(s, 'xp', 'start');
  perform chase._advance(s);
  select id, value into v_post, v_val from chase.posts where session_id = s order by value desc limit 1;
  perform pg_temp.claim('xp', 1, v_post);
  update chase.sessions set phase_ends_at = now() + interval '60 seconds' where id = s;
  perform pg_temp.tick('xp', 2, 59.9100, 10.7503);
  perform chase._advance(s);
  select (state -> 'so' ->> 'limit_at')::timestamptz into v_lim0 from chase.rounds where session_id = s and idx = 0;
  assert (select (state -> 'so' ->> 'past_limit')::boolean from chase.rounds where session_id = s and idx = 0), 'past the limit';
  perform pg_temp.act(s, 'xp', 'pause');
  assert (select status from chase.sessions where id = s) = 'paused', 'paused';
  t := pg_temp.tick('xp', 1);
  assert not (t -> 'scoreo' ->> 'arrived')::boolean, 'nobody arrives while paused';
  update chase.sessions set frozen_at = now() - interval '30 seconds' where id = s;   -- as if the pause began 30 s ago
  perform pg_temp.act(s, 'xp', 'resume');
  select (state -> 'so' ->> 'limit_at')::timestamptz into v_lim1 from chase.rounds where session_id = s and idx = 0;
  assert extract(epoch from v_lim1 - v_lim0) = 30, 'limit moved with the pause: ' || (v_lim1 - v_lim0);
  t := pg_temp.tick('xp', 1);
  assert (t -> 'scoreo' ->> 'late_s')::int = 30, 'late by 30 s, not 60: ' || (t -> 'scoreo')::text;

  -- Open SOS alarm: no penalty. Teacher skips after the limit: nobody is penalised.
  s := pg_temp.mk('xq', '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}', 3);
  perform pg_temp.act(s, 'xq', 'start');
  perform chase._advance(s);
  update chase.player_stats set points = 40, round_points = 40 where player_id in (pg_temp.pid('xq', 1), pg_temp.pid('xq', 2), pg_temp.pid('xq', 3));
  update chase.sessions set phase_ends_at = now() + interval '60 seconds' where id = s;
  perform pg_temp.tick('xq', 1, 59.9100, 10.7503);
  perform pg_temp.tick('xq', 2, 59.9100, 10.7503);
  perform pg_temp.tick('xq', 3, 59.9100, 10.7503);
  perform chase._advance(s);
  perform chase._raise_alarm(s, pg_temp.pid('xq', 1), 'sos', 2::smallint, null);
  t := pg_temp.tick('xq', 1);
  assert (t -> 'scoreo' ->> 'arrived')::boolean and (t -> 'scoreo' ->> 'penalty')::int = 0, 'SOS: no penalty on arrival: ' || (t -> 'scoreo')::text;
  perform chase._raise_alarm(s, pg_temp.pid('xq', 2), 'sos', 2::smallint, null);
  perform pg_temp.act(s, 'xq', 'next');
  assert (select status from chase.sessions where id = s) = 'gathering', 'ended by the teacher';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('xq', 2)) = 40, 'SOS: not penalised at the end';
  assert (select points from chase.player_stats where player_id = pg_temp.pid('xq', 3)) = 40, 'teacher ended the round after the limit: nobody is penalised';

  -- Fixed GPS posts replace the random ones (three or more).
  r := chase.create_session(pg_temp.h('host-xf'), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null,
    p_plan => '{"rounds":[{"mode":"scoreo","duration_s":180}],"countdown_s":0}',
    p_settings => '{"fixed_posts":[{"lat":59.9102,"lng":10.7503},{"lat":59.9107,"lng":10.7514},{"lat":59.9103,"lng":10.7515},{"lat":59.9106,"lng":10.7505,"qr":true,"code":"AB2CD"}]}'::jsonb);
  assert (r ->> 'ok')::boolean, 'create: ' || r::text;
  s := (r ->> 'session_id')::uuid;
  perform chase.join_session(r ->> 'pin', 'xf-1', pg_temp.h('tok-xf-1'), pg_temp.h('res-xf-1'));
  perform pg_temp.act(s, 'xf', 'start');
  perform chase._advance(s);
  assert (select count(*) from chase.posts where session_id = s and round_idx = 0 and kind = 'normal' and pos is not null) = 3, 'the three fixed GPS posts: ' || (select count(*) from chase.posts where session_id = s and round_idx = 0);
  assert (select count(*) from chase.posts where session_id = s and round_idx = 0 and pos is not null and ST_DWithin(pos, ST_SetSRID(ST_MakePoint(10.7514, 59.9107), 4326)::geography, 1)) = 1, 'at the teacher''s coordinates';
  raise notice '0020 pause, SOS, skip, fixed posts: ok';
end $$;
