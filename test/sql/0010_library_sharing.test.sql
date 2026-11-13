-- Assertions for 0010_library_sharing.sql. Runs in scripts/test-db.sh.
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
create function pg_temp.mk(p_teacher text, p_dx float8, p_plan jsonb) returns uuid language plpgsql as $$
declare r jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_teacher || p_dx || random()), pg_temp.h(p_teacher), pg_temp.square(p_dx),
                            pg_temp.assembly(p_dx), null, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk: ' || r::text;
  return (r ->> 'session_id')::uuid;
end $$;

-- ───────────────────────── pure: same vectors as test/library.test.ts ─────────────────────────
do $$
begin
  assert chase._norm_missions('["  10 burpees ", "Hopp  tau 30 s", "10 BURPEES"]') = '["10 burpees", "Hopp tau 30 s"]', 'trim, spaces, dedupe';
  assert chase._norm_missions('[]') is null, 'empty';
  assert chase._norm_missions('["a"]') is null, 'too short';
  assert chase._norm_missions(to_jsonb(array[repeat('x', 81)])) is null, 'too long';
  assert chase._norm_missions('["ok ok", 5]') is null, 'not a string';
  assert chase._norm_missions('"10 burpees"') is null, 'not an array';
  assert chase._norm_missions(to_jsonb(array(select 'Øvelse ' || i from generate_series(1, 13) i))) is null, 'max 12';
  assert jsonb_array_length(chase._norm_missions(to_jsonb(array(select 'Øvelse ' || i from generate_series(1, 12) i)))) = 12, '12 ok';
  assert chase._norm_name('  Skolegården   nord ') = 'Skolegården nord', 'name';
  assert chase._norm_name('   ') is null and chase._norm_name(repeat('x', 81)) is null, 'bad names';

  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"missions":["10 burpees"," 5 push-ups"]}') -> 'missions'
       = '["10 burpees", "5 push-ups"]', 'plan keeps missions';
  assert not chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"missions":[]}') ? 'missions', 'empty = absent';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"missions":["x"]}') is null, 'bad missions → bad plan';
  assert chase._norm_plan('{"rounds":[{"mode":"flag","duration_s":300}],"missions":["Spurt 20 m"]}') ->> 'teams' = '2', 'older layers still run';
  raise notice '0010 pure rules: ok';
end $$;

-- ───────────────────────── autosave + library ─────────────────────────
do $$
declare r jsonb; s uuid; v_a uuid; v_p uuid; n int;
begin
  r := chase.library_get(pg_temp.h('lib-a'));
  assert (r ->> 'ok')::boolean and not (r ->> 'known')::boolean and jsonb_array_length(r -> 'areas') = 0, 'unknown key';

  s := pg_temp.mk('lib-a', 0, '{"rounds":[{"mode":"posts","duration_s":300}]}');
  r := chase.library_get(pg_temp.h('lib-a'));
  assert (r ->> 'known')::boolean, 'known after a session';
  assert jsonb_array_length(r -> 'areas') = 1 and r -> 'areas' -> 0 ->> 'kind' = 'recent', 'area autosaved: ' || (r -> 'areas')::text;
  assert r -> 'areas' -> 0 -> 'boundary' ->> 'type' = 'Polygon' and (r -> 'areas' -> 0 -> 'assembly') ? 'lat'
     and (r -> 'areas' -> 0 ->> 'area_m2')::int > 500, 'area DTO';
  assert jsonb_array_length(r -> 'plans') = 1 and r -> 'plans' -> 0 -> 'plan' -> 'rounds' -> 0 ->> 'mode' = 'posts', 'plan autosaved';
  assert r -> 'plans' -> 0 -> 'plan' = (select plan from chase.sessions where id = s), 'plan round-trips';

  -- Same area + plan again: touched, not duplicated.
  perform pg_temp.mk('lib-a', 0, '{"rounds":[{"mode":"posts","duration_s":300}]}');
  select count(*) into n from chase.areas a join chase.teachers t on t.id = a.teacher_id where t.key_hash = pg_temp.h('lib-a');
  assert n = 1, 'no duplicate area';
  select count(*) into n from chase.plans a join chase.teachers t on t.id = a.teacher_id where t.key_hash = pg_temp.h('lib-a');
  assert n = 1, 'no duplicate plan';

  -- Six different areas: only 5 recent kept.
  for i in 1 .. 6 loop
    perform pg_temp.mk('lib-a', i * 0.01, jsonb_build_object('rounds', jsonb_build_array(jsonb_build_object('mode', 'free', 'duration_s', 60 * (i + 1)))));
  end loop;
  r := chase.library_get(pg_temp.h('lib-a'));
  assert jsonb_array_length(r -> 'areas') = 5 and jsonb_array_length(r -> 'plans') = 5, 'recent capped at 5: ' || jsonb_array_length(r -> 'areas');

  -- Keep one under a name (recent → saved), then it is never trimmed.
  v_a := (r -> 'areas' -> 4 ->> 'id')::uuid;
  r := chase.library_save(pg_temp.h('lib-a'), 'area', v_a, '  Skolegården ', null);
  assert (r ->> 'ok')::boolean, 'keep: ' || r::text;
  assert (select kind || '/' || name from chase.areas where id = v_a) = 'saved/Skolegården', 'kept and named';
  perform pg_temp.mk('lib-a', 0.2, '{"rounds":[{"mode":"free","duration_s":120}]}');
  assert exists (select 1 from chase.areas where id = v_a), 'saved survives trimming';

  -- New items.
  r := chase.library_save(pg_temp.h('lib-a'), 'area', null, 'Skogen',
         jsonb_build_object('boundary', pg_temp.square(0.05), 'assembly', pg_temp.assembly(0.05)));
  assert (r ->> 'ok')::boolean, 'save area';
  assert chase.library_save(pg_temp.h('lib-a'), 'area', null, 'Feil',
         jsonb_build_object('boundary', pg_temp.square(0.05), 'assembly', pg_temp.assembly(0.2))) ->> 'error' = 'assembly_far', 'area checks';
  r := chase.library_save(pg_temp.h('lib-a'), 'plan', null, 'Lagtime', '{"rounds":[{"mode":"flag","duration_s":300}],"missions":["10 burpees"]}');
  assert (r ->> 'ok')::boolean, 'save plan';
  v_p := (r ->> 'id')::uuid;
  assert (select settings ->> 'teams' from chase.plans where id = v_p) = '2', 'plan normalised';
  assert chase.library_save(pg_temp.h('lib-a'), 'plan', null, 'Feil', '{"rounds":[]}') ->> 'error' = 'bad_plan', 'bad plan';
  r := chase.library_save(pg_temp.h('lib-a'), 'pack', null, 'Styrke', '{"items":["10 knebøy","10 armhevinger"]}');
  assert (r ->> 'ok')::boolean, 'save pack';
  assert chase.library_save(pg_temp.h('lib-a'), 'pack', null, 'Feil', '{"items":[]}') ->> 'error' = 'bad_pack', 'bad pack';
  assert chase.library_save(pg_temp.h('lib-a'), 'pack', null, ' ', '{"items":["ok ok"]}') ->> 'error' = 'bad_name', 'bad name';
  assert chase.library_save(pg_temp.h('lib-a'), 'rocket', null, 'x', '{}') ->> 'error' = 'bad_kind', 'bad kind';

  -- Someone else cannot touch it.
  assert chase.library_save(pg_temp.h('lib-b'), 'plan', v_p, 'Mitt nå', null) ->> 'error' = 'not_found', 'other teacher: rename';
  assert chase.library_delete(pg_temp.h('lib-b'), 'plan', v_p) ->> 'error' = 'not_found', 'other teacher: delete';
  assert chase.library_delete(pg_temp.h('lib-a'), 'area', v_a) ->> 'ok' = 'true', 'delete own';
  assert not exists (select 1 from chase.areas where id = v_a), 'deleted';
  raise notice '0010 autosave/library: ok';
end $$;

-- ───────────────────────── share links ─────────────────────────
do $$
declare r jsonb; v_p uuid; v_a uuid; v_code text; v_code2 text; c jsonb;
begin
  select id into v_p from chase.plans where name = 'Lagtime';
  select a.id into v_a from chase.areas a where a.name = 'Skogen';
  assert chase.share_create(pg_temp.h('lib-b'), v_p, null, null) ->> 'error' = 'not_found', 'only my own plan';
  r := chase.share_create(pg_temp.h('lib-a'), v_p, v_a, 'Lagtime i skogen');
  assert (r ->> 'ok')::boolean and r ->> 'code' ~ '^[A-HJ-NP-Z2-9]{8}$', 'share: ' || r::text;
  v_code := r ->> 'code';
  v_code2 := chase.share_create(pg_temp.h('lib-a'), v_p, null, null) ->> 'code';

  r := chase.share_get(lower(v_code));
  assert (r ->> 'ok')::boolean and r ->> 'name' = 'Lagtime i skogen' and r -> 'plan' -> 'rounds' -> 0 ->> 'mode' = 'flag', 'preview';
  assert r -> 'area' -> 'boundary' ->> 'type' = 'Polygon' and not r ? 'teacher_id', 'area shared, nothing about the teacher';
  assert chase.share_get(v_code2) -> 'area' = 'null'::jsonb, 'plan only';
  assert chase.share_get('NOPE2345') ->> 'error' = 'not_found', 'unknown code';

  c := chase.share_copy(pg_temp.h('lib-c'), v_code);
  assert (c ->> 'ok')::boolean and c ->> 'area_id' is not null, 'copy: ' || c::text;
  r := chase.library_get(pg_temp.h('lib-c'));
  assert (r ->> 'known')::boolean and r -> 'plans' -> 0 ->> 'name' = 'Lagtime i skogen' and r -> 'plans' -> 0 ->> 'kind' = 'saved'
     and jsonb_array_length(r -> 'areas') = 1, 'copy lands in the new library';
  assert r -> 'plans' -> 0 -> 'plan' -> 'missions' = '["10 burpees"]', 'missions come along';
  assert (chase.share_get(v_code) ->> 'copies')::int = 1, 'copy counted';
  perform chase.share_copy(pg_temp.h('lib-a'), v_code);
  assert (chase.share_get(v_code) ->> 'copies')::int = 1, 'own copy not counted';

  r := chase.library_get(pg_temp.h('lib-a'));
  assert jsonb_array_length(r -> 'shares') = 2 and (r -> 'shares' -> 0) ? 'has_area', 'shares listed';
  assert chase.share_revoke(pg_temp.h('lib-c'), v_code) ->> 'error' = 'not_found', 'only the owner revokes';
  assert chase.share_revoke(pg_temp.h('lib-a'), lower(v_code)) ->> 'ok' = 'true', 'revoke';
  assert chase.share_get(v_code) ->> 'error' = 'not_found', 'gone after revoke';
  assert exists (select 1 from chase.plans p join chase.teachers t on t.id = p.teacher_id
                  where t.key_hash = pg_temp.h('lib-c') and p.name = 'Lagtime i skogen'), 'copies stay';
  raise notice '0010 share links: ok';
end $$;

-- ───────────────────────── own missions in a session ─────────────────────────
do $$
declare s uuid; r jsonb; j jsonb; t jsonb; pid uuid;
begin
  r := chase.create_session(pg_temp.h('host-mis'), null, pg_temp.square(), pg_temp.assembly(), null,
         p_plan => '{"rounds":[{"mode":"free","duration_s":300}],"countdown_s":0,"missions":["Spurt til flaggstanga","20 sprellemenn"]}');
  s := (r ->> 'session_id')::uuid;
  j := chase.join_session(r ->> 'pin', 'mis', pg_temp.h('tok-mis'), pg_temp.h('res-mis'));
  pid := (j ->> 'player_id')::uuid;
  perform chase.host_action(s, pg_temp.h('host-mis'), 'start');
  perform chase._advance(s);
  r := chase.host_action(s, pg_temp.h('host-mis'), 'event_start', '{"kind":"mission"}');
  assert (r ->> 'ok')::boolean, 'mission started: ' || r::text;
  assert (select r2.state -> 'ev' ->> 'mission_text' from chase.rounds r2 where r2.session_id = s and r2.idx = 0)
         in ('Spurt til flaggstanga', '20 sprellemenn'), 'own mission drawn';
  t := chase.tick(pid, pg_temp.h('tok-mis'), 59.91045, 10.7509, 5);
  assert t -> 'event' ->> 'mission_text' in ('Spurt til flaggstanga', '20 sprellemenn'), 'phone sees it: ' || (t -> 'event')::text;
  r := chase.host_snapshot(s, pg_temp.h('host-mis'));
  assert r -> 'event' ->> 'mission_text' is not null, 'teacher sees it';
  raise notice '0010 own missions: ok';
end $$;

-- ───────────────────────── purge + privileges ─────────────────────────
do $$
declare r jsonb;
begin
  update chase.teachers set last_seen_at = now() - interval '400 days' where key_hash = pg_temp.h('lib-c');
  r := chase.purge_expired();
  assert (r ->> 'teachers')::int >= 1 and r ? 'deleted', 'purge: ' || r::text;
  assert not exists (select 1 from chase.teachers where key_hash = pg_temp.h('lib-c')), 'idle library gone';
  assert not exists (select 1 from chase.plans where name = 'Lagtime i skogen' and teacher_id not in (select id from chase.teachers)), 'cascade';
  assert not has_function_privilege('anon', 'chase.share_get(text)', 'execute'), 'anon: share_get';
  assert not has_function_privilege('authenticated', 'chase.library_get(text)', 'execute'), 'authenticated: library_get';
  assert not has_table_privilege('anon', 'chase.shares', 'select'), 'anon: shares table';
  raise notice '0010 purge/privileges: ok';
end $$;
