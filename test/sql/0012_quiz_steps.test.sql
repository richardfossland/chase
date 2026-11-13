-- Assertions for 0012_quiz_steps.sql. Runs in scripts/test-db.sh.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- ───────────────────────── pure: same vectors as test/quiz.test.ts ─────────────────────────
do $$
declare v jsonb;
begin
  v := chase._quiz_norm('[{"q":"  Hva er  2+2? ","a":[" 4","5 "],"c":0}]');
  assert v = '[{"q":"Hva er 2+2?","a":["4","5"],"c":0}]', 'normalised: ' || v::text;
  assert chase._quiz_norm('[]') is null, 'empty';
  assert chase._quiz_norm('[{"q":"Hva?","a":["4"],"c":0}]') is null, 'one answer';
  assert chase._quiz_norm('[{"q":"Hva?","a":["a","b","c","d","e"],"c":0}]') is null, 'five answers';
  assert chase._quiz_norm('[{"q":"Hva?","a":["Ja","ja"],"c":0}]') is null, 'duplicate answers';
  assert chase._quiz_norm('[{"q":"Hva?","a":["a","b"],"c":2}]') is null, 'c out of range';
  assert chase._quiz_norm('[{"q":"Hva?","a":["a","b"],"c":0.5}]') is null, 'c not integer';
  assert chase._quiz_norm('[{"q":"Hv","a":["a","b"],"c":0}]') is null, 'question too short';
  assert chase._quiz_norm('[{"q":"Hva?","a":["a",3],"c":0}]') is null, 'answer not a string';
  assert chase._quiz_norm(to_jsonb(array(select jsonb_build_object('q', 'Spørsmål ' || i, 'a', jsonb_build_array('a', 'b'), 'c', 1)
                                          from generate_series(1, 31) i))) is null, 'max 30';
  assert array(select chase._quiz_pick(i, 3, 7) from generate_series(0, 3) i) = array[1, 2, 0, 1], 'pick';
  assert chase._quiz_pick(0, 3, -4) = 2, 'negative offset';
  assert chase._steps_accept(10, 2) = 8 and chase._steps_accept(5, 2) = 5 and chase._steps_accept(10, null) = 8
     and chase._steps_accept(-3, 2) = 0 and chase._steps_accept(10, 0) = 0, 'steps cap';
  v := chase._quiz_podiums('[{"cat":"posts","entries":[]},{"cat":"points","entries":[]}]',
                           '[{"id":"a","quiz":2},{"id":"b","quiz":0},{"id":"c","quiz":5}]');
  assert v = '[{"cat":"posts","entries":[]},{"cat":"quiz","entries":[{"id":"c","value":5},{"id":"a","value":2}]},{"cat":"points","entries":[]}]', 'podium: ' || v::text;
  assert chase._quiz_podiums('[{"cat":"posts","entries":[]}]', '[{"id":"a","quiz":0}]') = '[{"cat":"posts","entries":[]}]', 'nobody right';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"quiz":[{"q":"Hva?","a":["a","b"],"c":1}]}') -> 'quiz' -> 0 ->> 'c' = '1', 'plan keeps quiz';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"quiz":[{"q":"Hva?","a":["a"],"c":0}]}') is null, 'bad quiz → bad plan';
  assert not chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"quiz":[]}') ? 'quiz', 'empty = absent';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"missions":["Spurt 20 m"]}') ? 'missions', 'older layers still run';
  assert (select count(*) from pg_proc where proname = 'tick' and pronamespace = 'chase'::regnamespace) = 1, 'one tick, no overload';
  raise notice '0012 pure rules: ok';
end $$;

-- ───────────────────────── question at a post, answer, steps, ceremony ─────────────────────────
do $$
declare r jsonb; s uuid; pid uuid; t jsonb; a jsonb; q jsonb; v_post uuid; right_i int;
begin
  r := chase.create_session(pg_temp.h('host-qz'), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null,
    p_plan => '{"rounds":[{"mode":"posts","duration_s":300}],"countdown_s":0,
                "quiz":[{"q":"Hva er 2+2?","a":["4","5"],"c":0},{"q":"Hovedstaden i Norge?","a":["Bergen","Oslo","Tromsø"],"c":1}]}');
  s := (r ->> 'session_id')::uuid;
  pid := (chase.join_session(r ->> 'pin', 'qz', pg_temp.h('tok-qz'), pg_temp.h('res-qz')) ->> 'player_id')::uuid;
  perform chase.host_action(s, pg_temp.h('host-qz'), 'start');
  perform chase._advance(s);

  t := chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5);
  assert not t ? 'quiz' and (t -> 'stats' ->> 'steps')::int = 0, 'no question before a post';
  assert chase.quiz_answer(pid, pg_temp.h('tok-qz'), s, 0) ->> 'error' = 'not_now', 'nothing to answer';

  -- Put an open post under the player and claim it (two hits).
  select id into v_post from chase.posts where session_id = s and round_idx = 0 and claimed_by is null limit 1;
  update chase.posts set pos = chase._pt(59.91045, 10.7509) where id = v_post;
  perform chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5);
  update chase.player_live set claim_post = v_post, claim_hits = 1, fix_at = now() - interval '3 seconds' where player_id = pid;
  t := chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5, p_steps => 6);
  assert t -> 'claimed' is not null and t -> 'claimed' <> 'null'::jsonb, 'post claimed: ' || coalesce(t -> 'claimed', 'null')::text;
  q := t -> 'quiz';
  assert q is not null and q ? 'q' and jsonb_array_length(q -> 'a') >= 2 and not q ? 'c', 'question shown, no answer key: ' || coalesce(q::text, 'null');
  assert (t -> 'stats' ->> 'steps')::int between 1 and 6, 'steps counted (capped): ' || (t -> 'stats' ->> 'steps');
  t := chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5);
  assert t -> 'quiz' ->> 'q' = q ->> 'q', 'question stays until answered';

  right_i := case when q ->> 'q' = 'Hva er 2+2?' then 0 else 1 end;
  assert chase.quiz_answer(pid, pg_temp.h('tok-qz'), s, 9) ->> 'error' = 'bad_choice', 'bad choice';
  a := chase.quiz_answer(pid, pg_temp.h('tok-qz'), s, right_i);
  assert (a ->> 'right')::boolean and (a ->> 'points')::int = 10 and a ? 'answer', 'right: ' || a::text;
  assert (select quiz_right from chase.player_stats where player_id = pid) = 1, 'counted';
  assert (select 'quiz' = any(badges) from chase.player_stats where player_id = pid), 'badge';
  assert chase.quiz_answer(pid, pg_temp.h('tok-qz'), s, right_i) ->> 'error' = 'not_now', 'only once';
  t := chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5);
  assert not t ? 'quiz', 'closed after the answer';

  -- Expired questions close by themselves.
  update chase.player_stats set quiz_q = 0, quiz_until = now() - interval '1 second' where player_id = pid;
  t := chase.tick(pid, pg_temp.h('tok-qz'), 59.91045, 10.7509, 5);
  assert not t ? 'quiz' and (select quiz_q from chase.player_stats where player_id = pid) is null, 'expired';

  -- Ceremony: «Flest riktige».
  update chase.sessions set phase_ends_at = now() - interval '1 second' where id = s;
  perform chase._advance(s);
  r := chase.host_action(s, pg_temp.h('host-qz'), 'ceremony_start');
  assert (r ->> 'ok')::boolean, 'ceremony: ' || r::text;
  assert exists (select 1 from chase.sessions x, jsonb_array_elements(x.podiums) p where x.id = s and p ->> 'cat' = 'quiz'), 'quiz podium';
  assert not has_function_privilege('anon', 'chase.quiz_answer(uuid,text,uuid,int)', 'execute'), 'anon';
  raise notice '0012 quiz/steps: ok';
end $$;

-- ───────────────────────── library: question packs ─────────────────────────
do $$
declare r jsonb; v_id uuid;
begin
  r := chase.library_save(pg_temp.h('lib-q'), 'quiz', null, 'Gangetabellen', '{"items":[{"q":"3 × 4?","a":["12","14"],"c":0}]}');
  assert (r ->> 'ok')::boolean, 'save quiz: ' || r::text;
  v_id := (r ->> 'id')::uuid;
  assert chase.library_save(pg_temp.h('lib-q'), 'quiz', null, 'Feil', '{"items":[]}') ->> 'error' = 'bad_quiz', 'bad quiz';
  perform chase.library_save(pg_temp.h('lib-q'), 'pack', null, 'Styrke', '{"items":["10 knebøy"]}');
  r := chase.library_get(pg_temp.h('lib-q'));
  assert jsonb_array_length(r -> 'quizzes') = 1 and r -> 'quizzes' -> 0 ->> 'name' = 'Gangetabellen', 'quizzes listed';
  assert jsonb_array_length(r -> 'packs') = 1 and r -> 'packs' -> 0 ->> 'name' = 'Styrke', 'mission packs apart';
  assert chase.library_delete(pg_temp.h('lib-q'), 'quiz', v_id) ->> 'ok' = 'true', 'delete quiz';
  assert jsonb_array_length(chase.library_get(pg_temp.h('lib-q')) -> 'quizzes') = 0, 'gone';
  raise notice '0012 library quizzes: ok';
end $$;
