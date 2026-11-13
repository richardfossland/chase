-- Chase — 0011 — less work per tick (ADR-028).
--
-- Prod 2026-11-13: the shared Supabase project runs on Nano (0.5 GB RAM,
-- swapping); a 40-player team round made every request wait 30–300 s.
-- Measured locally (pg_stat_user_functions, 40 bots, team posts + flag round):
-- 5.8 ms per tick, of which the per-session upkeep (_mode_upkeep: events, tag
-- pings, zone, teams, flags/hill) ran on 77 % of all ticks (~1.8 ms each) and
-- the per-player team view (_team_tick) cost 1.1 ms.
--
--   * Upkeep at most once per second per session (unlogged clock row → no WAL).
--     All upkeep rules are already functions of time with ≥ 5 s granularity.
--     The interval is the setting chase.upkeep_every_ms (default 1000); the
--     SQL tests run with 0 so their same-transaction ticks still upkeep.
--   * The team view (scores, teammates, messages) is built once per upkeep into
--     the same unlogged row; ticks read it (≤ 5 s old) instead of each player
--     aggregating the whole session. Outside a live round, or when the cache is
--     stale, the tick builds it on the fly without storing it (no row contention).

set search_path = chase, extensions, public;

create unlogged table if not exists chase.session_clock (
  session_id    uuid primary key references chase.sessions(id) on delete cascade,
  upkeep_at     timestamptz not null default '-infinity',
  team_cache    jsonb,
  team_cache_at timestamptz
);
alter table chase.session_clock enable row level security;   -- deny-all like every chase table

-- Due → claims the slot and returns true. Callers hold the session advisory lock.
create or replace function chase._upkeep_due(p_session uuid)
returns boolean
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_ms   int := coalesce(nullif(current_setting('chase.upkeep_every_ms', true), '')::int, 1000);
  v_due  boolean;
begin
  if v_ms <= 0 then
    return true;
  end if;
  insert into chase.session_clock as c (session_id, upkeep_at) values (p_session, now())
  on conflict (session_id) do update set upkeep_at = now()
   where c.upkeep_at <= now() - make_interval(secs => v_ms / 1000.0)
  returning true into v_due;
  return coalesce(v_due, false);
end;
$$;

-- Scores + per team: teammates (fresh fix) and messages (last 30 s).
create or replace function chase._team_cache_build(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select jsonb_build_object(
    'scores', chase._team_scores(p_session),
    'teams', coalesce((
      select jsonb_object_agg(t.n::text, jsonb_build_object(
        'mates', (select coalesce(jsonb_agg(jsonb_build_object('nickname', q.nickname, 'pos', chase._latlng(l.pos))
                                            order by q.nickname), '[]'::jsonb)
                    from chase.players q join chase.player_live l on l.player_id = q.id
                   where q.team_id = t.id and q.status = 'active' and q.role <> 'referee'
                     and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))),
        'msgs', (select coalesce(jsonb_agg(jsonb_build_object('nickname', q.nickname, 'kind', l.msg_kind,
                                                              'pos', chase._latlng(l.msg_pos), 'at', l.msg_at)
                                           order by l.msg_at desc), '[]'::jsonb)
                   from chase.players q join chase.player_live l on l.player_id = q.id
                  where q.team_id = t.id and q.status = 'active'
                    and l.msg_at > now() - make_interval(secs => chase.kl('msg_show_s')))))
        from chase.teams t where t.session_id = p_session and t.n is not null), '{}'::jsonb));
$$;

-- ───────────────────────── throttled upkeep + team cache ─────────────────────────

do $$
begin
  if to_regprocedure('chase._mode_upkeep_team(uuid)') is null then
    alter function chase._mode_upkeep(uuid) rename to _mode_upkeep_team;
  end if;
  if to_regprocedure('chase._team_tick_full(uuid,uuid)') is null then
    alter function chase._team_tick(uuid, uuid) rename to _team_tick_full;
  end if;
end $$;

create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if not chase._upkeep_due(p_session) then
    return;
  end if;
  perform chase._mode_upkeep_team(p_session);
  if exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    update chase.session_clock set team_cache = chase._team_cache_build(p_session), team_cache_at = now()
     where session_id = p_session;
  end if;
end;
$$;

-- Same view as 0009's _team_tick, from the cache when it is fresh.
create or replace function chase._team_tick(p_player uuid, p_session uuid)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_p     chase.players;
  v_t     chase.teams;
  v_c     jsonb;
  v_mine  int;
  v_out   jsonb;
begin
  if not exists (select 1 from chase.teams where session_id = p_session and n is not null) then
    return '{}'::jsonb;
  end if;
  select * into v_p from chase.players where id = p_player;
  if v_p.role = 'referee' or v_p.status <> 'active' then
    return '{}'::jsonb;
  end if;
  if v_p.team_id is null then
    return chase._team_tick_full(p_player, p_session);   -- assigns me a team (rare)
  end if;
  select * into v_t from chase.teams where id = v_p.team_id;
  select * into s from chase.sessions where id = p_session;
  select c.team_cache into v_c from chase.session_clock c
   where c.session_id = p_session and c.team_cache_at > now() - interval '5 seconds';
  if v_c is null then
    v_c := chase._team_cache_build(p_session);
  end if;
  select (x ->> 'points')::int into v_mine from jsonb_array_elements(v_c -> 'scores') x where (x ->> 'n')::int = v_t.n;
  v_out := jsonb_build_object(
    'n', v_t.n, 'name', v_t.name, 'color', v_t.color, 'points', v_mine,
    'rank', 1 + (select count(*) from jsonb_array_elements(v_c -> 'scores') x where (x ->> 'points')::int > v_mine),
    'of', jsonb_array_length(v_c -> 'scores'),
    'palette', (select jsonb_agg(jsonb_build_object('n', x -> 'n', 'name', x -> 'name', 'color', x -> 'color')
                                 order by (x ->> 'n')::int) from jsonb_array_elements(v_c -> 'scores') x));
  if s.status in ('live', 'paused') and chase._is_team_round(s.plan -> 'rounds' -> s.round_idx) then
    v_out := v_out || jsonb_build_object(
      'mates', (select coalesce(jsonb_agg(m), '[]'::jsonb)
                  from jsonb_array_elements(v_c -> 'teams' -> (v_t.n::text) -> 'mates') m
                 where m ->> 'nickname' <> v_p.nickname),
      'msgs', (select coalesce(jsonb_agg(m || jsonb_build_object('me', m ->> 'nickname' = v_p.nickname)), '[]'::jsonb)
                 from jsonb_array_elements(v_c -> 'teams' -> (v_t.n::text) -> 'msgs') m));
  end if;
  return jsonb_build_object('team', v_out);
end;
$$;

revoke all on chase.session_clock from public, anon, authenticated;
revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
