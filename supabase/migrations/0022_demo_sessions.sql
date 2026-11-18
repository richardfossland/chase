-- 0022 Demo-økter («Prøv med boter», fase 10.6).
-- Additiv. Rører ikke tick eller host_snapshot.
--   * chase.demo_log + demo_gate() + demo_refund(): rate-limit per nøkkel (HMAC av IP / lærernøkkel) og tak på aktive demoer.
--   * _end_session_p7: sim-/demo-økter lager ikke anonymt sammendrag (de skal ikke telle i statistikk). Samme
--     funksjon som 0006, uendret bortsett fra vakten rundt insert, og uten sletting etterpå.
--   * purge_expired: demo-økter avsluttes etter 30 min, og demo_log ryddes. pg_cron kjører hvert 15. minutt,
--     så en demo lever 30–45 min.
-- Kjøres to ganger i test-db.sh: omdøping er vokted med to_regprocedure.

-- ───────────────────────── demo_log + demo_gate ─────────────────────────

create table if not exists chase.demo_log (
  id         bigint generated always as identity primary key,
  key_hash   text not null,
  created_at timestamptz not null default now()
);
create index if not exists demo_log_key_idx on chase.demo_log (key_hash, created_at);
alter table chase.demo_log enable row level security;   -- deny-all, som resten av chase

-- Slipper en demo gjennom og logger den, eller avviser. p_keys er hashede nøkler (IP og evt. lærernøkkel);
-- har en av dem brukt opp p_limit siste time, avvises den nye.
create or replace function chase.demo_gate(p_keys text[], p_limit int default 3, p_max_active int default 10)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_k text;
begin
  perform pg_advisory_xact_lock(hashtext('chase.demo_gate'));
  if p_keys is null or cardinality(p_keys) = 0 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  foreach v_k in array p_keys loop
    if (select count(*) from chase.demo_log
         where key_hash = v_k and created_at > now() - interval '1 hour') >= greatest(p_limit, 1) then
      return jsonb_build_object('ok', false, 'error', 'demo_limit');
    end if;
  end loop;
  if (select count(*) from chase.sessions
       where is_sim and status <> 'ended' and settings ->> 'demo' = 'true') >= greatest(p_max_active, 1) then
    return jsonb_build_object('ok', false, 'error', 'demo_busy');
  end if;
  foreach v_k in array p_keys loop
    insert into chase.demo_log (key_hash) values (v_k);
  end loop;
  return jsonb_build_object('ok', true);
end;
$$;

-- ───────────────────────── _end_session: ingen sammendrag for sim/demo ─────────────────────────
-- Bytter ut laget under 0013-wrapperen (_end_session_p7 = 0006-versjonen) med full logikk + is_sim-vakt.
-- Finnes ikke _end_session_p7 (0013 ikke kjørt) feiler migrasjonen ikke: 0013 kjører alltid først.

create or replace function chase._end_session_p7(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s     chase.sessions;
  v_first timestamptz;
begin
  select * into v_s from chase.sessions where id = p_session for update;
  if v_s.id is null or v_s.status = 'ended' then
    return;
  end if;
  select min(started_at) into v_first from chase.rounds where session_id = p_session;

  -- 0022: sim-/demo-økter gir ikke sammendrag.
  if not v_s.is_sim then
  insert into chase.session_summaries (teacher_id, duration_s, player_count, modes,
      total_distance_m, median_distance_m, median_active_s, active_histogram, catches_total,
      again_yes, again_no, teacher_again)
  select v_s.teacher_id,
         greatest(0, extract(epoch from now() - coalesce(v_first, now()) - v_s.pause_accum))::int,
         count(p.id),
         coalesce((select array_agg(distinct r.mode) from chase.rounds r where r.session_id = p_session), '{}'),
         coalesce(sum(st.distance_m), 0),
         coalesce(percentile_cont(0.5) within group (order by st.distance_m), 0),
         coalesce(percentile_cont(0.5) within group (order by st.active_s), 0)::int,
         coalesce((select jsonb_object_agg(b, n) from (
             select (floor(st2.active_s / 300) * 5)::int::text as b, count(*) as n
               from chase.player_stats st2 join chase.players p2 on p2.id = st2.player_id
              where st2.session_id = p_session and p2.role <> 'referee'
              group by 1) h), '{}'::jsonb),
         coalesce(sum(st.catches), 0),
         v_s.again_yes, v_s.again_no, v_s.teacher_again
    from chase.players p join chase.player_stats st on st.player_id = p.id
   where p.session_id = p_session and p.role <> 'referee' and p.status <> 'kicked';
  end if;

  delete from chase.player_live where session_id = p_session;
  delete from chase.posts where session_id = p_session;          -- cascades post_claims
  update chase.players set catch_code = null, immune_until = null where session_id = p_session;
  update chase.player_stats set explorer_n = cardinality(cells), cells = '{}' where session_id = p_session;
  update chase.alarms
     set pos = null, resolved_at = coalesce(resolved_at, now())
   where session_id = p_session;
  update chase.sessions
     set status = 'ended', ended_at = now(), teacher_phone = null, paused_at = null,
         phase_ends_at = null, frozen_at = null
   where id = p_session;
  insert into chase.events (session_id, type) values (p_session, 'session_ended');
end;
$$;

-- Angrer en logget demo (opprettelsen feilet): fjerner siste rad per nøkkel.
create or replace function chase.demo_refund(p_keys text[])
returns void
language sql
security definer
set search_path = chase, extensions, public
as $$
  delete from chase.demo_log d
   where d.id in (select max(l.id) from chase.demo_log l where l.key_hash = any(p_keys) group by l.key_hash)
$$;

-- ───────────────────────── purge_expired: demo 30 min + demo_log ─────────────────────────

do $$
begin
  if to_regprocedure('chase._purge_expired_p22()') is null then
    alter function chase.purge_expired() rename to _purge_expired_p22;
  end if;
end $$;

create or replace function chase.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r    jsonb := chase._purge_expired_p22();
  v_id   uuid;
  v_demo int := 0;
begin
  for v_id in
    select id from chase.sessions
     where is_sim and status <> 'ended' and settings ->> 'demo' = 'true'
       and created_at < now() - interval '30 minutes'
  loop
    perform chase._end_session(v_id);
    v_demo := v_demo + 1;
  end loop;
  delete from chase.demo_log where created_at < now() - interval '2 hours';
  return v_r || jsonb_build_object('demo_ended', v_demo);
end;
$$;

revoke all on chase.demo_log from public, anon, authenticated;
revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
