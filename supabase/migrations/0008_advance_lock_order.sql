-- Chase — 0008 — lock order at phase changes (deadlock fix, ADR-025).
--
-- Prod sim 2026-11-11 (after 0007): 40P01 «deadlock detected» right at round
-- start. A tick takes its own rows in the order players → player_live →
-- player_stats. The phase change (_advance → _begin_round / _finish_round and
-- the mode hooks) updated player_stats for everybody and THEN player_live, so
-- it could hold stats(Y) while tick Y held live(Y) and waited for stats(Y).
-- Same class as the unexplained 500s at the tag → gathering change (ADR-021);
-- 0007's _ev_begin added one more such update and made it frequent.
--
-- Fix: whoever wins the session lock and is about to change phase first locks
-- every player row of the session (id order). Every tick holds its own players
-- row before it touches player_live / player_stats, so once the phase change
-- has all player rows, no tick can be half-way and the cycle cannot form.
-- Ticks that lose the try-lock never wait for player rows other than their own.

set search_path = chase, extensions, public;

do $$
begin
  if to_regprocedure('chase._advance_base(uuid)') is null then
    alter function chase._advance(uuid) rename to _advance_base;
  end if;
end $$;

create or replace function chase._advance(p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s chase.sessions;
begin
  select * into s from chase.sessions where id = p_session;
  if s.id is not null and s.status in ('countdown', 'live', 'breather') and s.frozen_at is null
     and s.phase_ends_at is not null and s.phase_ends_at <= now()
     and chase._lock_session(p_session) then          -- re-entrant: _advance_base takes it again
    perform 1 from chase.players where session_id = p_session order by id for update;
  end if;
  return chase._advance_base(p_session);
end;
$$;

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
