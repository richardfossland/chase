-- Chase — 0012 — phase 7: questions at posts, step counter, «Flest riktige» (PLAN §13 fase 7, ADR-029).
--
--   * Question packs: plan.quiz = 1..30 multiple-choice questions
--     {q, a: 2..4 answers, c: index of the right one}. Any Postjakt can carry
--     one — no code change per pack («Ferdig når»). Packs live in the library
--     (challenge_packs.kind = 'quiz') and travel with share links like the rest
--     of the plan.
--   * When a player takes a GPS post in a Postjakt round and has no open
--     question, the server gives the next one (each player starts at its own
--     offset, so neighbours rarely get the same). 60 s to answer; right = +10
--     and «Flest riktige»; wrong = nothing lost (rule 5) and the right answer
--     is shown. The phone never sees which answer is right before it answers.
--   * Step counter: the phone counts steps (DeviceMotion, opt-in) and sends the
--     new steps with its tick. The server caps them at 4 steps/s since the last
--     report and keeps the sum in player_live (UNLOGGED, gone at «Avslutt»).
--   * tick() is wrapped (new trailing p_steps), and so are _norm_plan,
--     library_get/save/delete; _team_ceremony is redefined with the quiz podium.

set search_path = chase, extensions, public;

alter table chase.challenge_packs add column if not exists kind text not null default 'missions'
  check (kind in ('missions', 'quiz'));
alter table chase.player_stats add column if not exists quiz_q      smallint;
alter table chase.player_stats add column if not exists quiz_until  timestamptz;
alter table chase.player_stats add column if not exists quiz_asked  int not null default 0;
alter table chase.player_stats add column if not exists quiz_right  int not null default 0;
alter table chase.player_live  add column if not exists steps       int not null default 0;
alter table chase.player_live  add column if not exists steps_at    timestamptz;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/quiz.ts (test diffs them).

create or replace function chase.kq(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'quiz_max'        then 30     -- questions per pack
    when 'q_min'           then 3
    when 'q_max'           then 200
    when 'answers_min'     then 2
    when 'answers_max'     then 4
    when 'answer_max'      then 80
    when 'quiz_s'          then 60     -- time to answer
    when 'quiz_pts'        then 10
    when 'steps_max_per_s' then 4      -- cap on reported steps
    when 'steps_gap_s'     then 2      -- assumed gap for the first report
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/quiz.ts) ─────────────────────────

-- Questions: 1..30 of {q, a: [2..4 distinct texts], c}. Trimmed, single spaces. null = invalid.
create or replace function chase._quiz_norm(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_x   jsonb;
  v_q   text;
  v_a   jsonb;
  v_t   text;
  v_c   numeric;
  v_low text[];
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and chase.kq('quiz_max') then
    return null;
  end if;
  for v_x in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v_x) <> 'object' or jsonb_typeof(v_x -> 'q') <> 'string' or jsonb_typeof(v_x -> 'a') <> 'array'
       or jsonb_typeof(v_x -> 'c') <> 'number' then
      return null;
    end if;
    v_q := btrim(regexp_replace(v_x ->> 'q', '\s+', ' ', 'g'));
    if char_length(v_q) not between chase.kq('q_min') and chase.kq('q_max')
       or jsonb_array_length(v_x -> 'a') not between chase.kq('answers_min') and chase.kq('answers_max') then
      return null;
    end if;
    v_a := '[]'::jsonb;
    v_low := '{}';
    for v_t in select btrim(regexp_replace(e #>> '{}', '\s+', ' ', 'g')) from jsonb_array_elements(v_x -> 'a') e loop
      if v_t is null or char_length(v_t) not between 1 and chase.kq('answer_max') or lower(v_t) = any(v_low) then
        return null;
      end if;
      v_low := v_low || lower(v_t);
      v_a := v_a || to_jsonb(v_t);
    end loop;
    if (select bool_or(jsonb_typeof(e) <> 'string') from jsonb_array_elements(v_x -> 'a') e) then
      return null;
    end if;
    v_c := (v_x ->> 'c')::numeric;
    if v_c <> floor(v_c) or v_c < 0 or v_c >= jsonb_array_length(v_a) then
      return null;
    end if;
    v_out := v_out || jsonb_build_object('q', v_q, 'a', v_a, 'c', v_c::int);
  end loop;
  return v_out;
end;
$$;

-- The question a player gets: its own offset + how many it has had so far.
create or replace function chase._quiz_pick(p_asked int, p_n int, p_offset int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when p_n > 0 then ((p_offset % p_n) + p_n + p_asked) % p_n end;
$$;

-- Steps accepted from one report: at most steps_max_per_s × seconds since the last.
create or replace function chase._steps_accept(p_steps int, p_gap_s double precision)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select greatest(0, least(coalesce(p_steps, 0),
    ceil(greatest(0, coalesce(p_gap_s, chase.kq('steps_gap_s'))) * chase.kq('steps_max_per_s'))::int));
$$;

-- «Flest riktige» before Lagspiller / Poeng (else before Lagpall, else last).
create or replace function chase._quiz_podiums(p_podiums jsonb, p_rows jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_pod jsonb;
  v_out jsonb := '[]'::jsonb;
  v_p   jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', r ->> 'id', 'value', (r ->> 'quiz')::numeric)
                   order by (r ->> 'quiz')::numeric desc, (r ->> 'id') collate "C")
    into v_pod
    from (select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
           where coalesce((r ->> 'quiz')::numeric, 0) > 0
           order by (r ->> 'quiz')::numeric desc, (r ->> 'id') collate "C"
           limit chase.kc('podium_size')::int) q;
  if v_pod is null then
    return coalesce(p_podiums, '[]'::jsonb);
  end if;
  for v_p in select * from jsonb_array_elements(coalesce(p_podiums, '[]'::jsonb)) loop
    if v_pod is not null and v_p ->> 'cat' in ('teamplay', 'points', 'team') then
      v_out := v_out || jsonb_build_object('cat', 'quiz', 'entries', v_pod);
      v_pod := null;
    end if;
    v_out := v_out || v_p;
  end loop;
  if v_pod is not null then
    v_out := v_out || jsonb_build_object('cat', 'quiz', 'entries', v_pod);
  end if;
  return v_out;
end;
$$;

-- ───────────────────────── plan: quiz ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_lib(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_lib;
  end if;
end $$;

create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_base jsonb := chase._norm_plan_lib(p);
  v_q    jsonb;
begin
  if v_base is null then
    return null;
  end if;
  if p -> 'quiz' is null or p -> 'quiz' = 'null'::jsonb
     or (jsonb_typeof(p -> 'quiz') = 'array' and jsonb_array_length(p -> 'quiz') = 0) then
    return v_base;
  end if;
  v_q := chase._quiz_norm(p -> 'quiz');
  if v_q is null then
    return null;
  end if;
  return v_base || jsonb_build_object('quiz', v_q);
end;
$$;

-- ───────────────────────── per tick: the open question ─────────────────────────

create or replace function chase._quiz_tick(p_player uuid, p_session uuid, p_claimed jsonb)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s     chase.sessions;
  st    chase.player_stats;
  v_qz  jsonb;
  v_n   int;
  v_idx int;
  v_q   jsonb;
begin
  select * into s from chase.sessions where id = p_session;
  v_qz := s.plan -> 'quiz';
  if jsonb_typeof(v_qz) <> 'array' then
    return '{}'::jsonb;
  end if;
  v_n := jsonb_array_length(v_qz);
  select * into st from chase.player_stats where player_id = p_player;
  if st.player_id is null then
    return '{}'::jsonb;
  end if;
  if st.quiz_q is not null and (st.quiz_until <= now() or s.status not in ('live', 'paused')) then
    update chase.player_stats set quiz_q = null, quiz_until = null where player_id = p_player;
    st.quiz_q := null;
  end if;
  if st.quiz_q is null and p_claimed is not null and p_claimed <> 'null'::jsonb and s.status = 'live'
     and s.plan -> 'rounds' -> s.round_idx ->> 'mode' = 'posts' then
    v_idx := chase._quiz_pick(st.quiz_asked, v_n, abs(hashtext(p_player::text)));
    update chase.player_stats
       set quiz_q = v_idx, quiz_until = now() + make_interval(secs => chase.kq('quiz_s')), quiz_asked = quiz_asked + 1
     where player_id = p_player
    returning * into st;
  end if;
  if st.quiz_q is null then
    return '{}'::jsonb;
  end if;
  v_q := v_qz -> st.quiz_q::int;
  -- Never the right index: only the question, the answers and the deadline.
  return jsonb_build_object('quiz', jsonb_build_object('no', st.quiz_asked, 'q', v_q -> 'q', 'a', v_q -> 'a',
                                                       'until', st.quiz_until, 'right', st.quiz_right));
end;
$$;

-- A replay of 0002–0004 (test-db.sh runs every migration twice, provisioning
-- re-applies all) re-creates the 8-argument tick next to this 9-argument one.
-- That fresh copy becomes _tick_base, so there is never an overload.
do $$
begin
  if to_regprocedure('chase.tick(uuid,text,double precision,double precision,real,real,timestamptz,uuid)') is not null then
    if to_regprocedure('chase._tick_base(uuid,text,double precision,double precision,real,real,timestamptz,uuid)') is not null then
      drop function chase._tick_base(uuid, text, double precision, double precision, real, real, timestamptz, uuid);
    end if;
    alter function chase.tick(uuid, text, double precision, double precision, real, real, timestamptz, uuid)
      rename to _tick_base;
  end if;
end $$;

create or replace function chase.tick(
  p_player     uuid,
  p_token_hash text,
  p_lat        double precision,
  p_lng        double precision,
  p_acc        real,
  p_speed      real default null,
  p_client_ts  timestamptz default null,
  p_session    uuid default null,
  p_steps      int default null)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r  jsonb := chase._tick_base(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session);
  v_s  uuid;
  v_st int;
begin
  if not coalesce((v_r ->> 'ok')::boolean, false) then
    return v_r;
  end if;
  select session_id into v_s from chase.players where id = p_player;
  if coalesce(p_steps, 0) > 0 then
    update chase.player_live
       set steps = steps + chase._steps_accept(p_steps, extract(epoch from now() - steps_at)), steps_at = now()
     where player_id = p_player
    returning steps into v_st;
  else
    select steps into v_st from chase.player_live where player_id = p_player;
  end if;
  v_r := v_r || chase._quiz_tick(p_player, v_s, v_r -> 'claimed');
  if v_r ? 'stats' and jsonb_typeof(v_r -> 'stats') = 'object' then
    v_r := jsonb_set(v_r, '{stats,steps}', to_jsonb(coalesce(v_st, 0)));
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── player RPC: answer ─────────────────────────

create or replace function chase.quiz_answer(p_player uuid, p_token_hash text, p_session uuid, p_choice int)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p   chase.players;
  v_s   chase.sessions;
  st    chase.player_stats;
  v_q   jsonb;
  v_ok  boolean;
  v_new text[];
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_s from chase.sessions where id = p_session;
  select * into st from chase.player_stats where player_id = p_player for update;
  if st.quiz_q is null or st.quiz_until <= now() or v_s.status not in ('live', 'paused') then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  v_q := v_s.plan -> 'quiz' -> st.quiz_q::int;
  if p_choice is null or p_choice < 0 or p_choice >= jsonb_array_length(v_q -> 'a') then
    return jsonb_build_object('ok', false, 'error', 'bad_choice');
  end if;
  v_ok := p_choice = (v_q ->> 'c')::int;
  update chase.player_stats
     set quiz_q = null, quiz_until = null,
         quiz_right = quiz_right + v_ok::int,
         points = points + case when v_ok then chase.kq('quiz_pts')::int else 0 end,
         round_points = round_points + case when v_ok then chase.kq('quiz_pts')::int else 0 end
   where player_id = p_player;
  if v_ok then
    v_new := chase._award_badges(p_player, array['quiz']);
  end if;
  insert into chase.events (session_id, type, actor_player_id, payload)
  values (p_session, 'quiz_answer', p_player, jsonb_build_object('q', st.quiz_q, 'right', v_ok));
  return jsonb_build_object('ok', true, 'right', v_ok, 'answer', v_q -> 'a' -> ((v_q ->> 'c')::int),
                            'points', case when v_ok then chase.kq('quiz_pts')::int else 0 end,
                            'new_badges', to_jsonb(coalesce(v_new, '{}'::text[])));
end;
$$;

-- ───────────────────────── ceremony: + «Flest riktige» ─────────────────────────

create or replace function chase._team_ceremony(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  update chase.sessions s set podiums = chase._team_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'n', t.n, 'points', t.points)), '[]'::jsonb)
       from chase.teams t where t.session_id = p_session and t.n is not null),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'teamplay', st.team_acts + st.assists)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee' and p.team_id is not null))
   where s.id = p_session;
  update chase.sessions s set podiums = chase._quiz_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'quiz', st.quiz_right)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee'))
   where s.id = p_session;
end;
$$;

-- ───────────────────────── library: question packs ─────────────────────────

do $$
begin
  if to_regprocedure('chase._library_get_base(text)') is null then
    alter function chase.library_get(text) rename to _library_get_base;
  end if;
  if to_regprocedure('chase._library_save_base(text,text,uuid,text,jsonb)') is null then
    alter function chase.library_save(text, text, uuid, text, jsonb) rename to _library_save_base;
  end if;
  if to_regprocedure('chase._library_delete_base(text,text,uuid)') is null then
    alter function chase.library_delete(text, text, uuid) rename to _library_delete_base;
  end if;
end $$;

create or replace function chase.library_get(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._library_get_base(p_key_hash);
begin
  if not coalesce((v_r ->> 'known')::boolean, false) then
    return v_r || jsonb_build_object('quizzes', '[]'::jsonb);
  end if;
  return v_r || jsonb_build_object(
    'packs', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'items', c.items)
                                        order by c.last_used_at desc), '[]'::jsonb)
                from chase.challenge_packs c join chase.teachers t on t.id = c.teacher_id
               where t.key_hash = p_key_hash and c.kind = 'missions'),
    'quizzes', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'items', c.items)
                                          order by c.last_used_at desc), '[]'::jsonb)
                  from chase.challenge_packs c join chase.teachers t on t.id = c.teacher_id
                 where t.key_hash = p_key_hash and c.kind = 'quiz'));
end;
$$;

create or replace function chase.library_save(p_key_hash text, p_kind text, p_id uuid, p_name text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t    uuid;
  v_name text := chase._norm_name(p_name);
  v_q    jsonb;
  v_id   uuid;
begin
  if p_kind <> 'quiz' then
    return chase._library_save_base(p_key_hash, p_kind, p_id, p_name, p_data);
  end if;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'bad_name');
  end if;
  if p_id is null and p_data is null then
    return jsonb_build_object('ok', false, 'error', 'bad_data');
  end if;
  if p_data is not null then
    v_q := chase._quiz_norm(p_data -> 'items');
    if v_q is null then
      return jsonb_build_object('ok', false, 'error', 'bad_quiz');
    end if;
  end if;
  v_t := chase._teacher(p_key_hash, p_id is null);
  if v_t is null then
    return jsonb_build_object('ok', false, 'error', case when p_id is null then 'auth' else 'not_found' end);
  end if;
  if p_id is null then
    if (select count(*) from chase.challenge_packs where teacher_id = v_t) >= chase.kb('saved_max') then
      return jsonb_build_object('ok', false, 'error', 'full');
    end if;
    insert into chase.challenge_packs (teacher_id, name, kind, items) values (v_t, v_name, 'quiz', v_q) returning id into v_id;
  else
    update chase.challenge_packs set name = v_name, items = coalesce(v_q, items), updated_at = now(), last_used_at = now()
     where id = p_id and teacher_id = v_t and kind = 'quiz' returning id into v_id;
  end if;
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function chase.library_delete(p_key_hash text, p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
begin
  return chase._library_delete_base(p_key_hash, case when p_kind = 'quiz' then 'pack' else p_kind end, p_id);
end;
$$;

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
