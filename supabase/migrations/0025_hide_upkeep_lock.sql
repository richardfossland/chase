-- 0025 — Gjemsel: vedlikeholdet låser spillerradene før det rører player_live (vranglås fra 0023)
--
-- Funn 2026-11-26 (A/B-måling, 300 boter, Gjemsel): 70 vranglåser på én runde uten 0024, 1 med (tidsavhengig).
-- Syklusen:
--   * Tick A vinner sesjonslåsen (pg_try_advisory_xact_lock) og kjører vedlikeholdet (høyst 1/s). 0004 plinger
--     byttene (update player_live), og 0023 nuller plingen igjen (update player_live … where ping_pos is not null).
--     Den ANDRE oppdateringen av en rad som allerede er endret i samme transaksjon, sjekker fremmednøkkelen på nytt:
--     SELECT 1 FROM players … FOR KEY SHARE.
--   * Tick B holder sin egen players-rad FOR UPDATE (tick linje 54) og står i upserten av egen player_live-rad, som A
--     allerede har endret. B venter på A, A venter på B (KEY SHARE mot FOR UPDATE) → 40P01.
-- Retting: før vedlikeholdet i en Gjemsel-økt tar vi FOR KEY SHARE på alle spillerradene i id-rekkefølge (ADR-025).
-- Da har vi ikke rørt noen player_live-rad ennå, så ticks som holder sin rad, venter ikke på oss og kommer i mål;
-- deretter går FK-sjekkene uten venting. Ticks prøver bare sesjonslåsen (ikke-blokkerende), så de venter aldri på
-- noe vedlikeholdet holder. Bare Gjemsel: det er der radene oppdateres to ganger (andre moduser: uendret kostnad).
-- Mønster som 0023/0024: guardet omdøping + ny ytterste wrapper. Flat tick/host_snapshot røres ikke.

set lock_timeout = '3s';

do $$
begin
  if to_regprocedure('chase._mode_upkeep_dl(uuid)') is null then
    alter function chase._mode_upkeep_team(uuid) rename to _mode_upkeep_dl;
  end if;
end $$;

-- Caller holds the session lock (_advance_base → _mode_upkeep, throttled by _upkeep_due).
create or replace function chase._mode_upkeep_team(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if chase._is_hide(p_session) then
    -- Lock order (ADR-025): session first, then every player row in id order — before any player_live write.
    perform 1 from chase.players where session_id = p_session order by id for key share;
  end if;
  perform chase._mode_upkeep_dl(p_session);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;

notify pgrst, 'reload schema';
