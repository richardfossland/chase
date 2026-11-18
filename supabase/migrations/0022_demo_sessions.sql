-- 0022 Demo-økter («Prøv med boter», fase 10.6).
-- Additiv. Rører ikke tick, host_snapshot eller tabeller tickene bruker.
--   * chase.demo_log + chase.demo_gate(): rate-limit per nøkkel (IP / lærernøkkel, hashet) og tak på aktive demoer.
--   * join_session: en demo-økt (is_sim og settings.demo = true) tar høyst 30 spillere (20 boter + noen få ekte).
--   * _end_session: sim-/demo-økter legger ikke igjen anonymt sammendrag (de skal ikke telle i statistikk).
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
create or replace function chase.demo_gate(p_keys text[], p_limit int default 3, p_max_active int default 40)
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

-- ───────────────────────── join_session: tak i demo-økter ─────────────────────────

do $$
begin
  if to_regprocedure('chase._join_session_p22(text,text,text,text,text)') is null then
    alter function chase.join_session(text, text, text, text, text) rename to _join_session_p22;
  end if;
end $$;

create or replace function chase.join_session(
  p_pin              text,
  p_nickname         text,
  p_token_hash       text,
  p_resume_code_hash text,
  p_device_id        text default null)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
begin
  if exists (
    select 1 from chase.sessions s
     where s.join_pin = p_pin and s.status <> 'ended' and s.is_sim and s.settings ->> 'demo' = 'true'
       and (select count(*) from chase.players p where p.session_id = s.id) >= 30
  ) then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  return chase._join_session_p22(p_pin, p_nickname, p_token_hash, p_resume_code_hash, p_device_id);
end;
$$;

-- ───────────────────────── _end_session: ingen sammendrag for sim/demo ─────────────────────────

do $$
begin
  if to_regprocedure('chase._end_session_p22(uuid)') is null then
    alter function chase._end_session(uuid) rename to _end_session_p22;
  end if;
end $$;

create or replace function chase._end_session(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_before uuid[];
  v_sim    boolean;
begin
  select is_sim into v_sim from chase.sessions where id = p_session;
  if coalesce(v_sim, false) then
    select coalesce(array_agg(id), '{}') into v_before from chase.session_summaries;
  end if;
  perform chase._end_session_p22(p_session);
  if coalesce(v_sim, false) then
    delete from chase.session_summaries where id <> all (v_before);
  end if;
end;
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
