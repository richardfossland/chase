-- Chase — 0015 — talte varsler (fase 9.3).
--
-- Læreren slår «Talte varsler» av eller på for hele økta. Verdien ligger som
-- boolean i sessions.settings -> 'voice' (settings fylles fra p_settings ved
-- opprettelse, 0002/0003/0010; mangler nøkkelen er den av). Tillegget er rent
-- additivt: en gammel klient ignorerer det nye feltet, og en gammel Worker som
-- ikke kjenner set_voice får aldri kalt det.
--
--   * chase.tick() pakkes inn (samme mønster som 0009): feltet `voice` legges på
--     hver vellykket visning. tick_batch (0014) kaller tick() per entry og får
--     dermed feltet uten egen endring.
--   * chase.host_snapshot() pakkes inn tilsvarende, så lærerpanelet kan vise bryteren.
--   * chase.set_voice(session, host_token_hash, on) endrer verdien midt i økta.
--     Bare sessions-raden berøres (ingen spillerrader), så ADR-025-rekkefølgen
--     er upåvirket. Ingen persondata, ingen nye kolonner.
--
-- Stemmen er et tillegg til lyd, vibrasjon og blink (CLAUDE.md regel 4); den
-- endrer ingen sikkerhetsvarsler på serveren.

set search_path = chase, extensions, public;

-- ───────────────────────── tick og snapshot: legg på voice ─────────────────────────
-- Migrasjonene kjøres to ganger i test-db.sh. Guardene gjør at en allerede
-- innpakket funksjon ikke gis nytt navn en gang til.

do $$
begin
  if to_regprocedure('chase._tick_steps(uuid,text,double precision,double precision,real,real,timestamptz,uuid,int)') is null then
    alter function chase.tick(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int)
      rename to _tick_steps;
  end if;
  if to_regprocedure('chase._host_snapshot_teams(uuid,text,boolean)') is null then
    alter function chase.host_snapshot(uuid, text, boolean) rename to _host_snapshot_teams;
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
  v_r jsonb := chase._tick_steps(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session, p_steps);
begin
  if not coalesce((v_r ->> 'ok')::boolean, false) then
    return v_r;
  end if;
  return v_r || jsonb_build_object('voice', coalesce(
    (select (s.settings ->> 'voice') = 'true'
       from chase.sessions s
      where s.id = coalesce(p_session, (select session_id from chase.players where id = p_player))), false));
end;
$$;

create or replace function chase.host_snapshot(
  p_session         uuid,
  p_host_token_hash text,
  p_include_geo     boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._host_snapshot_teams(p_session, p_host_token_hash, p_include_geo);
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  return v_r || jsonb_build_object('voice', coalesce(
    (select (s.settings ->> 'voice') = 'true' from chase.sessions s where s.id = p_session), false));
end;
$$;

-- ───────────────────────── host: slå talte varsler av/på ─────────────────────────

create or replace function chase.set_voice(p_session uuid, p_host_token_hash text, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions := chase._host_session(p_session, p_host_token_hash);
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  if p_on is null then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  update chase.sessions
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{voice}', to_jsonb(p_on), true)
   where id = p_session;
  insert into chase.events (session_id, type, payload)
  values (p_session, 'host:set_voice', jsonb_build_object('on', p_on));
  return jsonb_build_object('ok', true, 'voice', p_on);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
