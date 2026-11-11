-- Chase — 0006 — phase 3, part 3: ceremony, podiums, «ditt beste», overrides.
--
--   * Ceremony (owner's choice 2026-11-11): at the assembly point the teacher
--     presses «Start seremoni» (status gathering → ceremony). Podiums and every
--     player's «ditt beste»-kort are computed ONCE then and frozen. The teacher
--     reveals one podium per «Neste»; phones follow (tick/broadcast). After the
--     last podium everybody sees their card and can answer «vil spille igjen»
--     (anonymous count). «Avslutt» deletes as before.
--   * Podiums (PLAN §5.2): poeng, distanse, aktive min, fangster, overlevd
--     lengst, poster, utforsker, comeback (biggest gain in the last round) + the
--     teacher's manual «Beste dommer». Top 3, empty categories skipped.
--     Spreading rule: max 2 podiums per player (teacher can switch it off).
--     Pure function _podiums_from() = lib/rules/podiums.ts, same vectors.
--   * «Ditt beste»: the category where the player is in the smallest top share
--     (rounded up to 10 %, shown when ≤ 50 %); otherwise always something
--     positive (active minutes, metres, «var med»).
--   * Teacher overrides: points ± with a reason (logged), roles (jeger/bytte in
--     Smittejakt, dommer), «Beste dommer» award.
--   * Smittejakt fixes: whoever is neutral in a live tag round (back from
--     «sitter over», joined late) becomes prey with immunity; a round without
--     hunters promotes one prey. Sitting out ends a prey's survival stint.
--   * Speed flag: > 25 km/h for > 10 s → 'speed' alarm (lowest in the strip,
--     no automatic penalty, PLAN §5.1). No position stored with it.

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.sessions add column if not exists podiums         jsonb;
alter table chase.sessions add column if not exists ceremony_step   int;
alter table chase.sessions add column if not exists ceremony_spread boolean not null default true;
alter table chase.sessions add column if not exists again_yes       int not null default 0;
alter table chase.sessions add column if not exists again_no        int not null default 0;
alter table chase.sessions add column if not exists teacher_again   boolean;
alter table chase.sessions add column if not exists best_referees   uuid[] not null default '{}';
alter table chase.players add column if not exists voted_again boolean not null default false;
alter table chase.player_live add column if not exists fast_since timestamptz;
alter table chase.player_stats add column if not exists best jsonb;
alter table chase.session_summaries add column if not exists again_yes     int not null default 0;
alter table chase.session_summaries add column if not exists again_no      int not null default 0;
alter table chase.session_summaries add column if not exists teacher_again boolean;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/podiums.ts (test diffs them).

create or replace function chase.kc(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'podium_size'     then 3
    when 'max_podiums'     then 2       -- spreading rule
    when 'best_share_max'  then 50      -- «blant de X %» only up to this
    when 'adjust_max'      then 100     -- teacher ± points per action
    when 'speed_flag_mps'  then 6.95    -- 25 km/h
    when 'speed_flag_s'    then 10
  end::real;
$$;

-- ───────────────────────── podiums + best card (pure; twin in lib/rules/podiums.ts) ─────────────────────────
-- p_rows: [{id, points, distance_m, active_s, catches, survival_s, posts, explorer, comeback}]
-- p_referees: ["<id>", …] (manual «Beste dommer», in award order)
-- → {"podiums": [{"cat", "entries": [{"id", "value"}]}] in reveal order,
--    "best": {"<id>": {"cat", "share", "value"}}}

create or replace function chase._podiums_from(p_rows jsonb, p_spread boolean, p_referees jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_assign  text[] := array['points', 'distance_m', 'active_s', 'catches', 'survival_s', 'posts', 'explorer', 'comeback'];
  v_reveal  text[] := array['referee', 'explorer', 'comeback', 'posts', 'survival_s', 'catches', 'active_s', 'distance_m', 'points'];
  v_bestcat text[] := array['distance_m', 'active_s', 'points', 'posts', 'catches', 'survival_s', 'explorer'];
  v_count   jsonb := '{}'::jsonb;
  v_by      jsonb := '{}'::jsonb;
  v_entries jsonb;
  v_cat     text;
  v_r       jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_best    jsonb := '{}'::jsonb;
  v_n       int := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  v_mine    numeric;
  v_share   int;
  v_pick    jsonb;
begin
  foreach v_cat in array v_assign loop
    v_entries := '[]'::jsonb;
    for v_r in
      select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
       where coalesce((r ->> v_cat)::numeric, 0) > 0
       order by (r ->> v_cat)::numeric desc, (r ->> 'id') collate "C"
    loop
      exit when jsonb_array_length(v_entries) >= chase.kc('podium_size');
      continue when p_spread and coalesce((v_count ->> (v_r ->> 'id'))::int, 0) >= chase.kc('max_podiums');
      v_entries := v_entries || jsonb_build_object('id', v_r ->> 'id', 'value', (v_r ->> v_cat)::numeric);
      v_count := v_count || jsonb_build_object(v_r ->> 'id', coalesce((v_count ->> (v_r ->> 'id'))::int, 0) + 1);
    end loop;
    if jsonb_array_length(v_entries) > 0 then
      v_by := v_by || jsonb_build_object(v_cat, v_entries);
    end if;
  end loop;
  if jsonb_array_length(coalesce(p_referees, '[]'::jsonb)) > 0 then
    v_by := v_by || jsonb_build_object('referee', (
      select jsonb_agg(jsonb_build_object('id', x, 'value', null) order by o)
        from jsonb_array_elements_text(p_referees) with ordinality t(x, o) where o <= chase.kc('podium_size')));
  end if;
  foreach v_cat in array v_reveal loop
    if v_by ? v_cat then
      v_out := v_out || jsonb_build_object('cat', v_cat, 'entries', v_by -> v_cat);
    end if;
  end loop;

  -- «Ditt beste»: smallest top share (≥ my value counts as "with me"), rounded up to 10 %.
  for v_r in select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r loop
    v_pick := null;
    foreach v_cat in array v_bestcat loop
      v_mine := coalesce((v_r ->> v_cat)::numeric, 0);
      continue when v_mine <= 0;
      select (ceil(count(*) * 10.0 / v_n) * 10)::int into v_share
        from jsonb_array_elements(p_rows) q where coalesce((q ->> v_cat)::numeric, 0) >= v_mine;
      if v_pick is null or v_share < (v_pick ->> 'share')::int then
        v_pick := jsonb_build_object('cat', v_cat, 'share', v_share, 'value', v_mine);
      end if;
    end loop;
    if v_pick is null or (v_pick ->> 'share')::int > chase.kc('best_share_max') then
      v_pick := case
        when coalesce((v_r ->> 'active_s')::numeric, 0) >= 60
          then jsonb_build_object('cat', 'active_s', 'share', null, 'value', (v_r ->> 'active_s')::numeric)
        when coalesce((v_r ->> 'distance_m')::numeric, 0) >= 50
          then jsonb_build_object('cat', 'distance_m', 'share', null, 'value', (v_r ->> 'distance_m')::numeric)
        else jsonb_build_object('cat', 'joined', 'share', null, 'value', null) end;
    end if;
    v_best := v_best || jsonb_build_object(v_r ->> 'id', v_pick);
  end loop;
  return jsonb_build_object('podiums', v_out, 'best', v_best);
end;
$$;

-- The rows for one session: active players who played (not referees).
create or replace function chase._ceremony_rows(p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'points', st.points,
           'distance_m', round(st.distance_m)::int,
           'active_s', st.active_s,
           'catches', st.catches,
           'survival_s', st.longest_survival_s,
           'posts', st.posts,
           'explorer', greatest(cardinality(st.cells), st.explorer_n),
           'comeback', coalesce((
             select (st.per_round -> k.last ->> 'points')::int - (st.per_round -> k.prev ->> 'points')::int
               from (select max(x::int)::text as last, (max(x::int) - 1)::text as prev
                       from jsonb_object_keys(st.per_round) x) k
              where st.per_round ? k.prev), 0))), '[]'::jsonb)
    from chase.players p join chase.player_stats st on st.player_id = p.id
   where p.session_id = p_session and p.status = 'active' and p.role <> 'referee';
$$;

-- What a phone (p_player) or the teacher (null) sees of the ceremony.
create or replace function chase._ceremony_view(p_session uuid, p_player uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select jsonb_build_object(
    'step', s.ceremony_step,
    'total', jsonb_array_length(coalesce(s.podiums, '[]'::jsonb)),
    'spread', s.ceremony_spread,
    'revealed', coalesce((
      select jsonb_agg(jsonb_build_object('cat', pod ->> 'cat', 'entries', (
               select jsonb_agg(jsonb_build_object(
                        'place', e.o, 'nickname', pl.nickname, 'value', e.x -> 'value',
                        'me', p_player is not null and pl.id = p_player) order by e.o)
                 from jsonb_array_elements(pod -> 'entries') with ordinality e(x, o)
                 join chase.players pl on pl.id = (e.x ->> 'id')::uuid)) order by i)
        from jsonb_array_elements(s.podiums) with ordinality t(pod, i)
       where i <= s.ceremony_step), '[]'::jsonb),
    'best', case when p_player is not null and s.ceremony_step > jsonb_array_length(coalesce(s.podiums, '[]'::jsonb))
                 then (select st.best from chase.player_stats st where st.player_id = p_player) end,
    'on_podium', case when p_player is not null then exists (
                   select 1 from jsonb_array_elements(s.podiums) pod, jsonb_array_elements(pod -> 'entries') e
                    where (e ->> 'id')::uuid = p_player) end,
    'voted', case when p_player is not null then (select voted_again from chase.players where id = p_player) end,
    'again', case when p_player is null then jsonb_build_object('yes', s.again_yes, 'no', s.again_no, 'teacher', s.teacher_again) end)
  from chase.sessions s where s.id = p_session;
$$;

-- ───────────────────────── Smittejakt role fixes ─────────────────────────

create or replace function chase._tag_rebalance(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_s  chase.sessions;
  v_id uuid;
begin
  select * into v_s from chase.sessions where id = p_session;
  if v_s.status not in ('live', 'paused') or chase._round_mode(p_session) ->> 'mode' is distinct from 'tag' then
    return;
  end if;
  -- Neutral in a tag round (back from sitting out, joined late): prey with immunity.
  for v_id in select id from chase.players
               where session_id = p_session and status = 'active' and role = 'neutral' loop
    update chase.players
       set role = 'prey', role_changed_at = now(),
           immune_until = now() + make_interval(secs => chase.kt('immune_s')),
           catch_code = coalesce(catch_code, chase._new_catch_code(p_session)), catch_code_rotated_at = now()
     where id = v_id;
    update chase.player_stats set current_survival_start = now(), surv_pts_stint = 0 where player_id = v_id;
  end loop;
  -- Nobody hunting (hunters sat out / left): promote one prey.
  if not exists (select 1 from chase.players where session_id = p_session and status = 'active' and role = 'hunter') then
    select id into v_id from chase.players
     where session_id = p_session and status = 'active' and role = 'prey' order by random() limit 1;
    if v_id is not null then
      perform chase._tag_end_stint(v_id);
      update chase.players set role = 'hunter', role_changed_at = now(), immune_until = null where id = v_id;
      insert into chase.events (session_id, type, target_player_id, payload)
      values (p_session, 'tag_promote', v_id, '{"reason":"no_hunter"}');
    end if;
  end if;
end;
$$;

-- A prey stops being prey: bank the longest survival, stop the clock.
create or replace function chase._tag_end_stint(p_player uuid)
returns void
language sql
set search_path = chase, extensions, public
as $$
  update chase.player_stats
     set longest_survival_s = greatest(longest_survival_s,
           coalesce(extract(epoch from now() - current_survival_start)::int, 0)),
         current_survival_start = null, surv_pts_stint = 0
   where player_id = p_player;
$$;

-- ───────────────────────── hooks: + rebalance, speed flag, ceremony view ─────────────────────────

create or replace function chase._mode_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._tag_rebalance(p_session);
  perform chase._tag_upkeep(p_session);
  perform chase._zone_upkeep(p_session);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_status text;
  v_role   text;
  v_l      chase.player_live;
  v_out    jsonb;
begin
  select status into v_status from chase.sessions where id = p_session;
  select role into v_role from chase.players where id = p_player;
  select * into v_l from chase.player_live where player_id = p_player;

  -- Speed flag: reported speed over 25 km/h for 10 s with a usable fix (PLAN §5.1).
  if v_status not in ('lobby', 'ended') and v_role <> 'referee' then
    if coalesce(v_l.speed, 0) > chase.kc('speed_flag_mps') and coalesce(v_l.acc, 999) <= chase.kg('claim_max_acc_m') then
      update chase.player_live set fast_since = coalesce(fast_since, now()) where player_id = p_player
      returning * into v_l;
      if now() - v_l.fast_since >= make_interval(secs => chase.kc('speed_flag_s')) then
        perform chase._raise_alarm(p_session, p_player, 'speed', 1::smallint, null);
      end if;
    elsif v_l.fast_since is not null then
      update chase.player_live set fast_since = null where player_id = p_player;
    end if;
  end if;

  v_out := coalesce(chase._tag_tick(p_player, p_session, p_pos), '{}'::jsonb)
        || coalesce(chase._zone_tick(p_player, p_session, p_pos), '{}'::jsonb);
  if v_status = 'ceremony' then
    v_out := v_out || jsonb_build_object('ceremony', chase._ceremony_view(p_session, p_player));
  end if;
  return v_out;
end;
$$;

-- ───────────────────────── «vil spille igjen» (anonymous) ─────────────────────────

create or replace function chase.vote_again(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_yes        boolean)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p chase.players;
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if not exists (select 1 from chase.sessions where id = p_session and status = 'ceremony') then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  if v_p.voted_again then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  -- Only the count is kept; the flag just stops double votes and goes with the player.
  update chase.players set voted_again = true where id = p_player;
  update chase.sessions
     set again_yes = again_yes + case when p_yes then 1 else 0 end,
         again_no  = again_no  + case when p_yes then 0 else 1 end
   where id = p_session;
  return jsonb_build_object('ok', true);
end;
$$;

-- ───────────────────────── host actions: ceremony + overrides ─────────────────────────

do $$
begin
  if to_regprocedure('chase._host_action_base(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_base;
  end if;
  if to_regprocedure('chase._host_snapshot_base(uuid,text,boolean)') is null then
    alter function chase.host_snapshot(uuid, text, boolean) rename to _host_snapshot_base;
  end if;
end $$;

create or replace function chase.host_action(
  p_session         uuid,
  p_host_token_hash text,
  p_action          text,
  p_payload         jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_s      chase.sessions;
  v_pl     jsonb := coalesce(p_payload, '{}'::jsonb);
  v_target uuid;
  v_r      jsonb;
  v_res    jsonb;
  v_delta  int;
  v_reason text;
  v_role   text;
  v_tag    boolean;
  v_n      int;
begin
  if p_action not in ('ceremony_start', 'ceremony_next', 'ceremony_back', 'vote_again',
                      'adjust_points', 'set_role', 'referee_award') then
    v_r := chase._host_action_base(p_session, p_host_token_hash, p_action, p_payload);
    -- Sitting out ends a prey's survival stint; coming back is handled by _tag_rebalance.
    if (v_r ->> 'ok')::boolean and p_action = 'sit_out' and coalesce((v_pl ->> 'on')::boolean, true) then
      perform chase._tag_end_stint((v_pl ->> 'player_id')::uuid);
      perform chase._tag_rebalance(p_session);
    elsif (v_r ->> 'ok')::boolean and p_action = 'sit_out' then
      perform chase._tag_rebalance(p_session);
    end if;
    return v_r;
  end if;

  select * into v_s from chase.sessions
   where id = p_session and host_token_hash = p_host_token_hash
   for update;
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  if v_pl ? 'player_id' then
    v_target := (v_pl ->> 'player_id')::uuid;
    if not exists (select 1 from chase.players where id = v_target and session_id = p_session) then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
  end if;
  v_tag := v_s.status in ('live', 'paused') and chase._round_mode(p_session) ->> 'mode' = 'tag';

  case p_action
  when 'ceremony_start' then
    if v_s.status <> 'gathering' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    -- Gathered in the middle of a round: close it so its points count (at the freeze).
    if v_s.pre_gather_status = 'live' then
      perform chase._finish_round(p_session, coalesce(v_s.frozen_at, now()));
    end if;
    v_res := chase._podiums_from(chase._ceremony_rows(p_session),
                                 coalesce((v_pl ->> 'spread')::boolean, true), to_jsonb(v_s.best_referees));
    update chase.sessions
       set status = 'ceremony', podiums = v_res -> 'podiums', ceremony_step = 0,
           ceremony_spread = coalesce((v_pl ->> 'spread')::boolean, true),
           pre_gather_status = null, frozen_at = null, phase_ends_at = null
     where id = p_session;
    update chase.player_stats st set best = v_res -> 'best' -> (st.player_id::text)
     where st.session_id = p_session;

  when 'ceremony_next', 'ceremony_back' then
    if v_s.status <> 'ceremony' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    v_n := jsonb_array_length(coalesce(v_s.podiums, '[]'::jsonb));
    update chase.sessions
       set ceremony_step = greatest(0, least(v_n + 1, ceremony_step + case when p_action = 'ceremony_next' then 1 else -1 end))
     where id = p_session;

  when 'vote_again' then
    if v_s.status <> 'ceremony' or jsonb_typeof(v_pl -> 'yes') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    update chase.sessions set teacher_again = (v_pl ->> 'yes')::boolean where id = p_session;

  when 'adjust_points' then
    v_delta := (v_pl ->> 'delta')::int;
    v_reason := btrim(coalesce(v_pl ->> 'reason', ''));
    if v_target is null or v_delta is null or v_delta = 0 or abs(v_delta) > chase.kc('adjust_max')
       or char_length(v_reason) not between 1 and 80 then
      return jsonb_build_object('ok', false, 'error', 'bad_adjust');
    end if;
    if v_s.status = 'ceremony' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');   -- podiums are frozen
    end if;
    update chase.player_stats
       set points = greatest(0, points + v_delta),
           round_points = case when v_s.status in ('live', 'paused') then greatest(0, round_points + v_delta) else round_points end
     where player_id = v_target;

  when 'set_role' then
    v_role := v_pl ->> 'role';
    if v_target is null or v_role not in ('hunter', 'prey', 'referee', 'player') then
      return jsonb_build_object('ok', false, 'error', 'bad_role');
    end if;
    if v_s.status = 'ceremony' or (v_role in ('hunter', 'prey') and not v_tag) then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    if (select role from chase.players where id = v_target) = 'prey' and v_role <> 'prey' then
      perform chase._tag_end_stint(v_target);
    end if;
    if v_role = 'hunter' then
      update chase.players set role = 'hunter', role_changed_at = now(), immune_until = null,
             catch_code = coalesce(catch_code, chase._new_catch_code(p_session))
       where id = v_target;
    elsif v_role = 'prey' then
      update chase.players
         set role = 'prey', role_changed_at = now(),
             immune_until = now() + make_interval(secs => chase.kt('immune_s')),
             catch_code = coalesce(catch_code, chase._new_catch_code(p_session))
       where id = v_target and role <> 'prey';
      update chase.player_stats set current_survival_start = coalesce(current_survival_start, now())
       where player_id = v_target;
    elsif v_role = 'referee' then
      update chase.players set role = 'referee', immune_until = null where id = v_target;
      -- A referee is not in play: open alarms (except SOS) go quiet.
      update chase.alarms set resolved_at = coalesce(resolved_at, now())
       where player_id = v_target and kind <> 'sos' and resolved_at is null;
    else   -- back to playing: neutral; in a tag round _tag_rebalance makes them prey
      update chase.players set role = 'neutral' where id = v_target and role in ('referee', 'hunter', 'prey', 'neutral');
    end if;
    perform chase._tag_rebalance(p_session);

  when 'referee_award' then
    if v_target is null then
      return jsonb_build_object('ok', false, 'error', 'no_player');
    end if;
    if v_s.status = 'ceremony' then
      return jsonb_build_object('ok', false, 'error', 'bad_state');
    end if;
    if coalesce((v_pl ->> 'on')::boolean, true) then
      if cardinality(v_s.best_referees) >= chase.kc('podium_size') and not v_target = any(v_s.best_referees) then
        return jsonb_build_object('ok', false, 'error', 'full');
      end if;
      update chase.sessions
         set best_referees = case when v_target = any(best_referees) then best_referees else best_referees || v_target end
       where id = p_session;
    else
      update chase.sessions set best_referees = array_remove(best_referees, v_target) where id = p_session;
    end if;
  end case;

  insert into chase.events (session_id, type, target_player_id, payload)
  values (p_session, 'host:' || p_action, v_target, v_pl);

  select * into v_s from chase.sessions where id = p_session;
  return jsonb_build_object('ok', true, 'status', v_s.status, 'round', chase._round_view(v_s), 'server_now', now());
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
  v_r jsonb := chase._host_snapshot_base(p_session, p_host_token_hash, p_include_geo);
  v_s chase.sessions;
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  select * into v_s from chase.sessions where id = p_session;
  return v_r || jsonb_build_object(
    'referee_awards', to_jsonb(v_s.best_referees),
    'ceremony', case when v_s.status = 'ceremony' then chase._ceremony_view(p_session, null) end);
end;
$$;

-- ───────────────────────── end: + anonymous «vil spille igjen» in the summary ─────────────────────────
-- 0004's _end_session with the three again_* columns added to the summary.

create or replace function chase._end_session(p_session uuid)
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

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
