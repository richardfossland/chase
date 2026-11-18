-- Assertions for 0016_area_posts.sql. Runs in scripts/test-db.sh.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.square(p_dx float8 default 0) returns jsonb language sql as $$
  select jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(jsonb_build_array(
    jsonb_build_array(10.75 + p_dx, 59.91), jsonb_build_array(10.7518 + p_dx, 59.91), jsonb_build_array(10.7518 + p_dx, 59.9109),
    jsonb_build_array(10.75 + p_dx, 59.9109), jsonb_build_array(10.75 + p_dx, 59.91))))
$$;
create function pg_temp.assembly(p_dx float8 default 0) returns jsonb language sql as
  $$ select jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(10.7509 + p_dx, 59.91045)) $$;

-- ───────────────────────── pure: same vectors as test/area-posts.test.ts ─────────────────────────
do $$
begin
  assert chase._norm_posts('[{"lat":59.9100004,"lng":10.7509996,"name":"  Stor   eik ","qr":true,"code":"ab2cd"}]')
       = '[{"lat":59.91,"lng":10.751,"kind":"normal","qr":true,"name":"Stor eik","code":"AB2CD"}]', 'normalises';
  assert chase._norm_posts('[{"lat":59.91,"lng":10.75,"name":"   "}]') = '[{"lat":59.91,"lng":10.75,"kind":"normal","qr":false}]', 'blank name dropped';
  assert chase._norm_posts(null) = '[]' and chase._norm_posts('[]') = '[]', 'empty';
  assert chase._norm_posts('[{"lat":59.91,"lng":10.75,"code":"AB2CD"}]') = '[{"lat":59.91,"lng":10.75,"kind":"normal","qr":false}]', 'code ignored without qr';
  assert chase._norm_posts('{}') is null, 'not an array';
  assert chase._norm_posts('[{"lat":91,"lng":10}]') is null, 'lat range';
  assert chase._norm_posts('[{"lat":59,"lng":181}]') is null, 'lng range';
  assert chase._norm_posts('[{"lat":"59","lng":10}]') is null, 'lat not a number';
  assert chase._norm_posts('[{"lat":59,"lng":10,"kind":"fast"}]') is null, 'kind';
  assert chase._norm_posts(jsonb_build_array(jsonb_build_object('lat', 59, 'lng', 10, 'name', repeat('x', 41)))) is null, 'name length';
  assert chase._norm_posts('[{"lat":59,"lng":10,"qr":true}]') is null, 'qr needs code';
  assert chase._norm_posts('[{"lat":59,"lng":10,"qr":true,"code":"AB0CD"}]') is null, 'code alphabet';
  assert chase._norm_posts('[{"lat":59,"lng":10,"qr":true,"code":"AB2CD"},{"lat":59,"lng":10.1,"qr":true,"code":"ab2cd"}]') is null, 'code unique';
  assert chase._norm_posts((select jsonb_agg(jsonb_build_object('lat', 59, 'lng', 10)) from generate_series(1, 41))) is null, 'max 40';
  assert jsonb_array_length(chase._norm_posts((select jsonb_agg(jsonb_build_object('lat', 59, 'lng', 10)) from generate_series(1, 40)))) = 40, '40 ok';
  raise notice '0016 pure rules: ok';
end $$;

-- ───────────────────────── library: save, get, autosave, share, copy ─────────────────────────
do $$
declare r jsonb; v_a uuid; v_code text; s uuid; k text := pg_temp.h('posts-a');
begin
  r := chase.library_save(k, 'area', null, 'Skolegården',
         jsonb_build_object('boundary', pg_temp.square(), 'assembly', pg_temp.assembly(),
           'posts', '[{"lat":59.9103,"lng":10.7505,"name":"Flaggstang"},{"lat":59.9106,"lng":10.7512,"kind":"golden","qr":true,"code":"AB2CD"}]'::jsonb));
  assert (r ->> 'ok')::boolean, 'save area with posts: ' || r::text;
  v_a := (r ->> 'id')::uuid;
  r := chase.library_get(k);
  assert jsonb_array_length(r -> 'areas' -> 0 -> 'posts') = 2 and r -> 'areas' -> 0 -> 'posts' -> 1 ->> 'code' = 'AB2CD', 'library_get returns posts';

  assert chase.library_save(k, 'area', null, 'Feil',
         jsonb_build_object('boundary', pg_temp.square(), 'assembly', pg_temp.assembly(), 'posts', '[{"lat":60.5,"lng":10.7505}]'::jsonb)) ->> 'error' = 'bad_posts', 'post outside boundary';
  assert chase.library_save(k, 'area', null, 'Feil',
         jsonb_build_object('boundary', pg_temp.square(), 'assembly', pg_temp.assembly(), 'posts', '[{"lat":59.9103,"lng":10.75,"qr":true}]'::jsonb)) ->> 'error' = 'bad_posts', 'qr without code';

  -- Rename + keep leaves posts alone; update without posts key leaves them alone.
  r := chase.library_save(k, 'area', v_a, 'Skolegården 2', null);
  assert (r ->> 'ok')::boolean and jsonb_array_length((select posts from chase.areas where id = v_a)) = 2, 'rename keeps posts';
  r := chase.library_save(k, 'area', v_a, 'Skolegården 3', jsonb_build_object('boundary', pg_temp.square(), 'assembly', pg_temp.assembly()));
  assert jsonb_array_length((select posts from chase.areas where id = v_a)) = 2, 'update without posts key keeps posts';

  -- Share carries the posts, copy brings them into the new library.
  perform chase.library_save(k, 'plan', null, 'Plan', '{"rounds":[{"mode":"posts","duration_s":300}]}');
  r := chase.share_create(k, (select id from chase.plans where teacher_id = (select id from chase.teachers where key_hash = k) limit 1), v_a, 'Med poster');
  assert (r ->> 'ok')::boolean, 'share: ' || r::text;
  v_code := r ->> 'code';
  assert jsonb_array_length(chase.share_get(v_code) -> 'area' -> 'posts') = 2, 'share_get returns posts';
  r := chase.share_copy(pg_temp.h('posts-b'), v_code);
  assert (r ->> 'ok')::boolean, 'copy: ' || r::text;
  assert (select posts -> 1 ->> 'code' from chase.areas where id = (r ->> 'area_id')::uuid) = 'AB2CD', 'copy brings posts';
  -- Share without area has no area posts and plan-only share still works.
  r := chase.share_create(k, (select id from chase.plans where teacher_id = (select id from chase.teachers where key_hash = k) limit 1), null, null);
  r := chase.share_get(r ->> 'code');
  assert r -> 'area' = 'null'::jsonb, 'plan only: ' || r::text;
  raise notice '0016 library: ok';
end $$;

-- ───────────────────────── session: autosave + fixed posts ─────────────────────────
do $$
declare r jsonb; s uuid; k text := pg_temp.h('posts-c'); v_id uuid;
begin
  -- Bad lists are refused before anything is created.
  r := chase.create_session(pg_temp.h('host-p0'), k, pg_temp.square(), pg_temp.assembly(), null,
         p_settings => '{"fixed_posts":[{"lat":60.5,"lng":10.7505}]}'::jsonb);
  assert r ->> 'error' = 'bad_posts', 'outside: ' || r::text;
  assert not exists (select 1 from chase.sessions where host_token_hash = pg_temp.h('host-p0')), 'nothing created';

  r := chase.create_session(pg_temp.h('host-p1'), k, pg_temp.square(), pg_temp.assembly(), null,
         p_plan => '{"rounds":[{"mode":"posts","duration_s":300}],"qr_posts":2}',
         p_settings => '{"fixed_posts":[{"lat":59.9103,"lng":10.7505,"name":"Flaggstang"},{"lat":59.9106,"lng":10.7512,"qr":true,"code":"AB2CD"},{"lat":59.9104,"lng":10.7515,"kind":"golden"}]}'::jsonb);
  assert (r ->> 'ok')::boolean, 'create: ' || r::text;
  s := (r ->> 'session_id')::uuid;

  -- Autosave stores the posts with the area.
  r := chase.library_get(k);
  assert jsonb_array_length(r -> 'areas' -> 0 -> 'posts') = 3, 'autosaved posts: ' || (r -> 'areas' -> 0 -> 'posts')::text;

  -- The qr post is a physical card with its stable code; plan.qr_posts counts all cards.
  assert (select count(*) from chase.posts where session_id = s and kind = 'physical_qr') = 3, 'cards: 1 fixed + 2 random';
  assert (select n from chase.posts where session_id = s and code = 'AB2CD') = 2, 'fixed card keeps its list number';
  assert (select count(distinct n) from chase.posts where session_id = s and kind = 'physical_qr') = 3, 'card numbers unique';
  assert (select (plan ->> 'qr_posts')::int from chase.sessions where id = s) = 3, 'plan.qr_posts raised';

  -- GPS posts are spawned from the list.
  v_id := chase._spawn_post(s, 0, 'normal');
  assert v_id is not null, 'spawn fixed';
  assert ST_DWithin((select pos from chase.posts where id = v_id), ST_SetSRID(ST_MakePoint(10.7505, 59.9103), 4326)::geography, 1), 'at the fixed spot';
  assert chase._spawn_post(s, 0, 'normal') is null, 'only one normal GPS post, already open';
  v_id := chase._spawn_post(s, 0, 'golden');
  assert (select kind from chase.posts where id = v_id) = 'golden'
     and ST_DWithin((select pos from chase.posts where id = v_id), ST_SetSRID(ST_MakePoint(10.7515, 59.9104), 4326)::geography, 1), 'golden from the list';
  -- Once claimed (no longer open) the spot can be used again.
  update chase.posts set claimed_by = null, claimed_at = now() where session_id = s and kind = 'normal';
  -- (still unclaimed in this test: simulate claim by removing it)
  delete from chase.posts where session_id = s and kind = 'normal';
  assert chase._spawn_post(s, 0, 'normal') is not null, 'respawn after claim';

  -- Same area again with no posts key: area posts untouched.
  perform chase.create_session(pg_temp.h('host-p2'), k, pg_temp.square(), pg_temp.assembly(), null);
  assert jsonb_array_length((chase.library_get(k) -> 'areas' -> 0 -> 'posts')) = 3, 'absent key leaves posts';
  -- Explicit empty list clears them.
  perform chase.create_session(pg_temp.h('host-p3'), k, pg_temp.square(), pg_temp.assembly(), null, p_settings => '{"fixed_posts":[]}'::jsonb);
  assert jsonb_array_length((chase.library_get(k) -> 'areas' -> 0 -> 'posts')) = 0, 'empty list clears';
  raise notice '0016 session: ok';
end $$;

-- ───────────────────────── no fixed posts: as before ─────────────────────────
do $$
declare r jsonb; s uuid; v_id uuid; v_n int;
begin
  r := chase.create_session(pg_temp.h('host-p4'), null, pg_temp.square(), pg_temp.assembly(), null,
         p_plan => '{"rounds":[{"mode":"posts","duration_s":300}]}');
  s := (r ->> 'session_id')::uuid;
  v_id := chase._spawn_post(s, 0, 'normal');
  assert v_id is not null and ST_Covers((select boundary from chase.sessions where id = s), (select pos::geometry::geography from chase.posts where id = v_id)), 'random spawn inside';
  -- Only golden fixed posts: normal posts stay random, golden comes from the list.
  r := chase.create_session(pg_temp.h('host-p5'), null, pg_temp.square(), pg_temp.assembly(), null,
         p_plan => '{"rounds":[{"mode":"posts","duration_s":300}]}',
         p_settings => '{"fixed_posts":[{"lat":59.9104,"lng":10.7515,"kind":"golden"}]}'::jsonb);
  s := (r ->> 'session_id')::uuid;
  assert chase._spawn_post(s, 0, 'normal') is not null, 'random normal when the list has none';
  assert not has_function_privilege('anon', 'chase.create_session(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,boolean)', 'execute'), 'anon: create_session';
  raise notice '0016 fallback: ok';
end $$;
