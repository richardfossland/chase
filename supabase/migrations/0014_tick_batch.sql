-- Chase — 0014 — batched ticks for the session room (Durable Objects stage 1, ADR-031).
--
-- One Durable Object per session collects the players' latest fixes and calls
-- tick_batch about once a second instead of one tick() transaction per player
-- every 2 s. The game logic is untouched: every entry runs the existing
-- chase.tick() and gets exactly the personal view it would get alone.
--
--   * _advance runs once, before any player row is locked. When a phase is due
--     it takes every player row of the session in id order (ADR-025), so the
--     per-player ticks after it never wait on each other.
--   * Entries run in player-id order — the same order as the ADR-025 lock-all —
--     so two batches (or a batch and a phase change) cannot form a cycle.
--   * Routes that still write directly (catch locks hunter then prey, claim,
--     powerup, mission, quiz, host actions) may hold a row. lock_timeout 250 ms
--     plus one subtransaction per entry turns that into {"error":"busy"} for
--     that player only; the room retries the fix on its next flush.
--   * At most 50 entries per call: every entry is a subtransaction, and more than
--     64 subxids in one transaction overflows the snapshot cache and slows every
--     app on the shared database. The room sends larger sessions in chunks.
--   * hint_all is computed from the batch's own _advance (the entries' own
--     _advance calls see "not due" once the batch has advanced) or any entry's.
--   * Arguments are never logged: they are positions (CLAUDE.md rule 3).
--
-- host_snapshot_svc lets the room run the host snapshot without the teacher's
-- token, so signal-loss alarms and lazy phase changes happen server-side even
-- when no teacher screen is polling. service_role only, like everything here.

set search_path = chase, extensions, public;

create or replace function chase.tick_batch(p_session uuid, p_ticks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
set lock_timeout = '250ms'
as $$
declare
  v_status  text;
  v_adv     jsonb := '{"changed":false,"golden":false}'::jsonb;
  v_hint    boolean;
  v_alert   boolean := false;
  v_results jsonb := '[]'::jsonb;
  e         record;
  r         jsonb;
begin
  if p_ticks is null or jsonb_typeof(p_ticks) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  if jsonb_array_length(p_ticks) > 50 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  select status into v_status from chase.sessions where id = p_session;
  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended', 'server_now', now());
  end if;

  -- Advance once for the whole batch. If the lock-all of a due phase change
  -- cannot get a row in time, carry on: each entry's tick() tries again.
  begin
    v_adv := chase._advance(p_session);
  exception when lock_not_available or deadlock_detected then
    v_adv := '{"changed":false,"golden":false}'::jsonb;
  end;
  v_hint := coalesce((v_adv ->> 'changed')::boolean, false) or coalesce((v_adv ->> 'golden')::boolean, false);

  for e in
    select x.player, x.token_hash, x.lat, x.lng, x.acc, x.speed, x.client_ts, x.steps
      from jsonb_to_recordset(p_ticks)
           as x(player uuid, token_hash text, lat double precision, lng double precision,
                acc real, speed real, client_ts timestamptz, steps int)
     order by x.player
  loop
    if e.player is null then
      continue;
    end if;
    begin
      r := chase.tick(e.player, e.token_hash, e.lat, e.lng, e.acc, e.speed, e.client_ts, p_session, e.steps);
    exception
      when lock_not_available or deadlock_detected then
        r := jsonb_build_object('ok', false, 'error', 'busy');
      when others then
        -- sqlstate only: the message could echo an argument.
        raise warning 'chase.tick_batch: entry failed (%)', sqlstate;
        r := jsonb_build_object('ok', false, 'error', 'server');
    end;
    v_hint := v_hint or coalesce((r ->> 'hint_all')::boolean, false);
    v_alert := v_alert or coalesce((r ->> 'alert_host')::boolean, false);
    v_results := v_results || jsonb_build_array(jsonb_build_object('player', e.player, 'r', r));
  end loop;

  select status into v_status from chase.sessions where id = p_session;
  return jsonb_build_object('ok', true, 'server_now', now(), 'status', v_status,
                            'hint_all', v_hint, 'alert_host', v_alert, 'results', v_results);
end;
$$;

create or replace function chase.host_snapshot_svc(p_session uuid, p_include_geo boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_hash text;
begin
  select host_token_hash into v_hash from chase.sessions where id = p_session;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return chase.host_snapshot(p_session, v_hash, p_include_geo);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
