-- Chase — 0019 — øktrapport til læreren (fase 10.5).
--
-- Lese-RPC for lærerens utskriftsvennlige rapport. Den leverer det
-- lærerpanelet ikke allerede får i host_snapshot: starttidspunkt, rundene
-- (modus og planlagt lengde) og antall riktige quizsvar per elev. Resten
-- (aktive minutter, distanse, poster, fangster, merker) er aggregater fra
-- player_stats.
--
-- Personvern (CLAUDE.md regel 3, PLAN § 8): ingen posisjoner, ruter, kart,
-- tidslinjer eller spiller-id-er i svaret, bare kallenavn og tall. Funksjonen
-- skriver ingenting, og ingen nye kolonner eller tabeller er lagt til, så
-- slettetabellen i § 8 er uendret. Rapporten settes sammen i lærerens
-- nettleser og lagres ikke på serveren.
--
-- Rent additiv; rører ikke tick eller host_snapshot.

set search_path = chase, extensions, public;

create or replace function chase.session_report(p_session uuid, p_host_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s chase.sessions := chase._host_session(p_session, p_host_token_hash);
  v_start timestamptz;
  v_end   timestamptz;
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;

  select min(r.started_at), max(r.ended_at) into v_start, v_end
    from chase.rounds r where r.session_id = v_s.id and r.started_at is not null;
  v_end := coalesce(v_s.ended_at, now());

  return jsonb_build_object(
    'ok', true,
    'started_at', coalesce(v_start, v_s.created_at),
    -- Som _end_session: første rundestart til nå/slutt, minus pauser. null uten startet runde.
    'duration_s', case when v_start is null then null else
      greatest(0, extract(epoch from (v_end - v_start - v_s.pause_accum
        - coalesce(case when v_s.ended_at is null then now() - v_s.paused_at end, interval '0')))::int) end,
    'rounds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'idx', r.idx,
               'mode', r.mode,
               'variant', v_s.plan -> 'rounds' -> r.idx ->> 'variant',
               'practice', coalesce((v_s.plan -> 'rounds' -> r.idx ->> 'practice') = 'true', false),
               'duration_s', nullif(v_s.plan -> 'rounds' -> r.idx ->> 'duration_s', '')::int)
             order by r.idx)
        from chase.rounds r where r.session_id = v_s.id and r.started_at is not null), '[]'::jsonb),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'nickname', p.nickname,
               'active_s', st.active_s,
               'distance_m', round(st.distance_m)::int,
               'posts', st.posts,
               'catches', st.catches,
               'quiz_right', st.quiz_right,
               'badges', coalesce(cardinality(st.badges), 0),
               'sat_out', p.role = 'sitting_out')
             order by lower(p.nickname))
        from chase.players p join chase.player_stats st on st.player_id = p.id
       where p.session_id = v_s.id and p.status <> 'kicked' and p.role <> 'referee'), '[]'::jsonb));
end;
$$;

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
