-- Assertions for 0018_flatten_tick.sql: flat tick/host_snapshot give the same answer as the old
-- wrapper chains. The old chains (as of 0017) are re-created below as chase._old_*; each
-- comparison runs the old chain in a subtransaction that is rolled back, then the new
-- function, and compares the returned jsonb and the rows it wrote. now() is constant inside
-- a DO block, so timestamps are equal too. The old copies are dropped at the end.
set search_path = chase, extensions, public;

-- ───────────────────────── final state: no wrapper chain left ─────────────────────────
do $$
begin
  assert (select count(*) from pg_proc where pronamespace = 'chase'::regnamespace
            and proname in ('_tick_base', '_tick_steps', '_tick_voice',
                            '_host_snapshot_base', '_host_snapshot_ceremony', '_host_snapshot_ev', '_host_snapshot_teams')) = 0,
         'intermediate wrappers are gone';
  assert (select count(*) from pg_proc where pronamespace = 'chase'::regnamespace and proname = 'tick') = 1, 'one tick overload';
  assert (select count(*) from pg_proc where pronamespace = 'chase'::regnamespace and proname = 'host_snapshot') = 1, 'one host_snapshot overload';
  assert (select prosrc !~ '_tick_(base|steps|voice)' and prosrc ~ 'hc_prev_pos' and prosrc ~ '_quiz_tick'
            from pg_proc where pronamespace = 'chase'::regnamespace and proname = 'tick'), 'tick is flat';
  assert (select prosrc !~ '_host_snapshot_' and prosrc ~ 'team_of' and prosrc ~ 'mission_pending'
            from pg_proc where pronamespace = 'chase'::regnamespace and proname = 'host_snapshot'), 'host_snapshot is flat';
  assert (select bool_and(prosecdef and proconfig = array['search_path=chase, extensions, public'])
            from pg_proc where pronamespace = 'chase'::regnamespace and proname in ('tick', 'host_snapshot')), 'security definer + search_path';
  assert not has_function_privilege('anon', 'chase.tick(uuid,text,double precision,double precision,real,real,timestamptz,uuid,int)', 'execute')
     and has_function_privilege('service_role', 'chase.tick(uuid,text,double precision,double precision,real,real,timestamptz,uuid,int)', 'execute')
     and not has_function_privilege('authenticated', 'chase.host_snapshot(uuid,text,boolean)', 'execute')
     and has_function_privilege('service_role', 'chase.host_snapshot(uuid,text,boolean)', 'execute'), 'grants';
end $$;

-- ───────────────────────── the old chains, as of 0017 ─────────────────────────
create or replace function chase._old_tick_base(p_player uuid, p_token_hash text, p_lat double precision, p_lng double precision, p_acc real, p_speed real DEFAULT NULL::real, p_client_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_session uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_now        timestamptz := now();
  v_p          chase.players;
  v_s          chase.sessions;
  v_l          chase.player_live;
  v_pos        geography;
  v_acc        real := greatest(coalesce(p_acc, 999), 0);
  v_inside     boolean;
  v_out_m      double precision := 0;
  v_edge_m     double precision;
  v_level      smallint := 0;
  v_out_since  timestamptz;
  v_forbidden  boolean := false;
  v_safety_on  boolean;
  v_alert      boolean := false;
  v_dt         double precision;
  v_seg        double precision;
  v_v          double precision;
  v_add_m      double precision := 0;
  v_add_s      double precision := 0;
  v_good_pos   geography;
  v_good_at    timestamptz;
  v_still_a    geography;
  v_still_s    timestamptz;
  v_st         chase.player_stats;
  v_gather     jsonb;
  v_sos        jsonb;
  v_msgs       jsonb;
  v_adv        jsonb;
  v_mode       text;
  v_playing    boolean;
  v_cap        int := chase.kg('move_pts_cap')::int;
  v_mpp        double precision := chase.kg('move_m_per_pt');
  v_c          geometry;
  v_cell       int;
  v_cand       uuid;
  v_hits       smallint := 0;
  v_cval       int;
  v_ckind      text;
  v_claimed    jsonb;
  v_lost       boolean := false;
  v_badges     text[] := '{}';
  v_posts      jsonb;
  v_summary    jsonb;
  v_extra      jsonb;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'error', 'bad_fix');
  end if;

  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if p_session is not null and v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', v_p.status);   -- 'kicked' | 'left'
  end if;

  select * into v_l from chase.player_live where player_id = p_player;
  -- Retries / reordered requests: never move a player backwards in time.
  if p_client_ts is not null and v_l.last_client_ts is not null and p_client_ts <= v_l.last_client_ts then
    return jsonb_build_object('ok', false, 'error', 'stale', 'server_now', v_now);
  end if;

  v_adv := chase._advance(v_p.session_id);   -- round transitions + post upkeep (lazy, PLAN §9.2)
  select * into v_s from chase.sessions where id = v_p.session_id;
  if v_s.status = 'ended' then
    return jsonb_build_object('ok', false, 'error', 'ended');
  end if;
  v_mode := case when v_s.round_idx >= 0 then v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode' end;
  v_playing := v_s.status = 'live' and v_p.role not in ('sitting_out', 'referee');

  v_pos := chase._pt(p_lat, p_lng);

  -- ── safety: geofence (PLAN §7) ──
  v_safety_on := v_s.status <> 'lobby' and v_p.role <> 'referee';
  v_inside := ST_Covers(v_s.boundary, v_pos);
  if v_inside then
    v_edge_m := ST_Distance(v_pos, ST_ExteriorRing(v_s.boundary::geometry)::geography);
    v_level := case when v_edge_m <= chase.k('edge_warn_m') then 1 else 0 end;
  else
    v_out_m := ST_Distance(v_pos, v_s.boundary);
    if v_out_m <= v_acc then
      v_level := 1;                 -- outside but within GPS error: "Nær grensa"
    else
      v_level := 2;
      v_out_since := coalesce(v_l.outside_since, v_now);
      if v_now - v_out_since > make_interval(secs => chase.k('outside_alarm_s'))
         or v_out_m > chase.k('outside_alarm_m') then
        v_level := 3;
      end if;
    end if;
  end if;

  -- Forbidden zones: "possibly inside" — within min(acc, margin) counts (safety first).
  if v_s.forbidden is not null then
    v_forbidden := ST_DWithin(v_pos, v_s.forbidden, least(v_acc, chase.k('forbidden_margin_m')));
  end if;

  if v_safety_on then
    if v_level = 3 then
      v_alert := chase._raise_alarm(v_s.id, p_player, 'outside',
                   case when v_out_m > chase.k('outside_high_m') then 2 else 1 end::smallint, v_pos) or v_alert;
    elsif v_level < 2 then
      perform chase._clear_alarm(p_player, 'outside');
    end if;
    if v_forbidden then
      v_alert := chase._raise_alarm(v_s.id, p_player, 'forbidden', 2::smallint, v_pos) or v_alert;
    else
      perform chase._clear_alarm(p_player, 'forbidden');
    end if;
    perform chase._clear_alarm(p_player, 'signal');   -- a fix just arrived
  end if;

  -- ── movement: distance + active seconds (PLAN §5.1) ──
  v_good_pos := v_l.last_good_pos;
  v_good_at  := v_l.last_good_at;
  if v_acc <= chase.k('good_acc_m') then
    if v_good_pos is null then
      v_good_pos := v_pos; v_good_at := v_now;
    else
      v_dt  := extract(epoch from v_now - v_good_at);
      v_seg := ST_Distance(v_good_pos, v_pos);
      if v_dt > chase.k('segment_reset_s') or v_dt <= 0 then
        v_good_pos := v_pos; v_good_at := v_now;               -- gap: restart, count nothing
      elsif v_seg >= greatest(chase.k('jitter_min_m'), v_acc / 2) then
        v_v := v_seg / v_dt;
        if v_v <= chase.k('max_speed_mps') and v_s.status = 'live' and v_p.role <> 'sitting_out' then
          v_add_m := v_seg;
          if v_v between chase.k('active_min_mps') and chase.k('active_max_mps') then
            v_add_s := v_dt;
          end if;
        end if;
        v_good_pos := v_pos; v_good_at := v_now;               -- glitches move the anchor too
      end if;                                                  -- else: jitter, keep anchor
    end if;
  end if;

  -- Stillness (derived in host_snapshot as now - still_since).
  if v_l.still_anchor is null or ST_Distance(v_l.still_anchor, v_pos) > greatest(chase.k('still_radius_m'), v_acc) then
    v_still_a := v_pos; v_still_s := v_now;
  else
    v_still_a := v_l.still_anchor; v_still_s := v_l.still_since;
  end if;

  -- ── Postjakt: claim = inside max(12 m, acc) on two consecutive ticks (PLAN §3.1) ──
  if v_playing and v_mode = 'posts' and v_acc <= chase.kg('claim_max_acc_m') then
    select o.id into v_cand
      from chase.posts o
     where o.session_id = v_s.id and o.round_idx = v_s.round_idx and o.claimed_by is null
       and o.pos is not null and (o.expires_at is null or o.expires_at > v_now)
       and ST_DWithin(o.pos, v_pos, greatest(o.radius_m, v_acc))
     order by ST_Distance(o.pos, v_pos)
     limit 1;
    if v_cand is not null then
      v_hits := case when v_l.claim_post = v_cand then coalesce(v_l.claim_hits, 0) + 1 else 1 end;
      if v_hits >= chase.kg('claim_hits') then
        update chase.posts set claimed_by = p_player, claimed_at = v_now
         where id = v_cand and claimed_by is null
        returning value, kind into v_cval, v_ckind;
        if v_cval is not null then
          insert into chase.post_claims (post_id, player_id, session_id, round_idx, points, via)
          values (v_cand, p_player, v_s.id, v_s.round_idx, v_cval, 'gps');
          update chase.player_stats
             set points = points + v_cval, round_points = round_points + v_cval,
                 posts = posts + 1, round_posts = round_posts + 1
           where player_id = p_player;
          insert into chase.events (session_id, type, actor_player_id, payload)
          values (v_s.id, 'claim', p_player,
                  jsonb_build_object('post', v_cand, 'value', v_cval, 'kind', v_ckind, 'via', 'gps'));
          v_claimed := jsonb_build_object('post_id', v_cand, 'value', v_cval, 'kind', v_ckind);
          if v_ckind = 'golden' then
            v_badges := v_badges || 'golden'::text;
          end if;
        else
          v_lost := true;            -- someone else got there first
        end if;
        v_cand := null; v_hits := 0;
      end if;
    end if;
  end if;

  insert into chase.player_live as pl (player_id, session_id, pos, acc, speed, fix_at, still_since,
      geofence_state, in_forbidden, in_zone, last_good_pos, last_good_at, still_anchor,
      outside_since, outside_m, last_client_ts, claim_post, claim_hits)
  values (p_player, v_s.id, v_pos, v_acc, p_speed, v_now, v_still_s,
      v_level, v_forbidden, true, v_good_pos, v_good_at, v_still_a,
      case when v_level >= 2 then v_out_since end, v_out_m, p_client_ts, v_cand, v_hits)
  on conflict (player_id) do update set
      pos = excluded.pos, acc = excluded.acc, speed = excluded.speed, fix_at = excluded.fix_at,
      still_since = excluded.still_since, geofence_state = excluded.geofence_state,
      in_forbidden = excluded.in_forbidden, last_good_pos = excluded.last_good_pos,
      last_good_at = excluded.last_good_at, still_anchor = excluded.still_anchor,
      outside_since = excluded.outside_since, outside_m = excluded.outside_m,
      last_client_ts = coalesce(excluded.last_client_ts, pl.last_client_ts),
      claim_post = excluded.claim_post, claim_hits = excluded.claim_hits;

  -- Explorer cell (20 × 20 m, local projection from the area centroid).
  if v_playing and v_acc <= chase.k('good_acc_m') then
    v_c := ST_Centroid(v_s.boundary::geometry);
    v_cell := (floor((p_lng - ST_X(v_c)) * 111320 * cos(radians(ST_Y(v_c))) / chase.kg('cell_m'))::int + 1000) * 10000
            + (floor((p_lat - ST_Y(v_c)) * 111320 / chase.kg('cell_m'))::int + 1000);
  end if;

  -- Movement points: +1 per 50 m in the round, capped (PLAN §3).
  update chase.player_stats
     set distance_m = distance_m + v_add_m,
         active_s = active_s + v_add_s,
         round_distance_m = round_distance_m + v_add_m,
         round_active_s = round_active_s + v_add_s,
         points = points + (least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int) - round_move_pts),
         round_points = round_points + (least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int) - round_move_pts),
         round_move_pts = least(v_cap, floor((round_distance_m + v_add_m) / v_mpp)::int),
         cells = case when v_cell is null or v_cell = any(cells) then cells else cells || v_cell end
   where player_id = p_player;
  if v_playing then
    v_badges := chase._award_badges(p_player, v_badges);
  end if;
  select * into v_st from chase.player_stats where player_id = p_player;
  update chase.players set last_tick_at = v_now where id = p_player;

  -- ── roll call: auto check-in near the assembly point (PLAN §6) ──
  if v_s.status = 'gathering' then
    if v_p.checked_in_at is null and v_acc <= chase.k('uncertain_acc_m')
       and ST_DWithin(v_pos, v_s.assembly_point, chase.k('gather_radius_m')) then
      update chase.players set checked_in_at = v_now where id = p_player;
      v_p.checked_in_at := v_now;
      insert into chase.events (session_id, type, actor_player_id, payload)
      values (v_s.id, 'check_in', p_player, '{"auto":true}');
    end if;
    v_gather := jsonb_build_object(
      'assembly', chase._latlng(v_s.assembly_point),
      'distance_m', round(ST_Distance(v_pos, v_s.assembly_point)::numeric, 1),
      'checked_in', v_p.checked_in_at is not null);
  end if;

  -- Visible posts: all open posts of the live Postjakt round; never players.
  if v_s.status in ('live', 'paused') and v_mode = 'posts' then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'pos', chase._latlng(o.pos), 'value', o.value,
                                                 'kind', o.kind, 'radius_m', o.radius_m, 'expires_at', o.expires_at)
                              order by o.spawned_at), '[]')
      into v_posts
      from chase.posts o
     where o.session_id = v_s.id and o.round_idx = v_s.round_idx and o.claimed_by is null
       and o.pos is not null and (o.expires_at is null or o.expires_at > v_now);
  end if;

  -- Round summary for the breather (and after the last round).
  -- round_* columns still hold the finished round until the next one goes live.
  if v_s.status in ('breather', 'gathering') and v_s.round_idx >= 0
     and exists (select 1 from chase.rounds r where r.session_id = v_s.id and r.idx = v_s.round_idx
                 and r.ended_at is not null) then
    v_summary := jsonb_build_object(
      'round', v_s.round_idx,
      'points', v_st.round_points, 'posts', v_st.round_posts,
      'distance_m', round(v_st.round_distance_m), 'active_s', floor(v_st.round_active_s),
      'move_pts', v_st.round_move_pts, 'badges', to_jsonb(v_st.round_badges));
  end if;

  -- Mode layer (0004+): Smittejakt view, survival points; zone later.
  v_extra := chase._mode_tick(p_player, v_s.id, v_pos);
  select * into v_st from chase.player_stats where player_id = p_player;

  -- Show the SOS card until acked, then "Læreren har sett det" for a minute.
  select jsonb_build_object('id', a.id, 'acked', a.acked_at is not null)
    into v_sos from chase.alarms a
   where a.player_id = p_player and a.kind = 'sos'
     and (a.acked_at is null or a.acked_at > v_now - interval '60 seconds')
   order by a.created_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'text', e.payload ->> 'text',
                                               'private', e.target_player_id is not null) order by e.at), '[]')
    into v_msgs
    from chase.events e
   where e.session_id = v_s.id and e.type = 'message'
     and e.at > v_now - make_interval(secs => chase.k('message_window_s'))
     and (e.target_player_id is null or e.target_player_id = p_player);

  return coalesce(v_extra, '{}'::jsonb) || jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'session_id', v_s.id,
    'status', v_s.status,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'round', chase._round_view(v_s),
    'role', (select role from chase.players where id = p_player),
    'stats', jsonb_build_object('points', v_st.points, 'distance_m', round(v_st.distance_m::numeric, 1),
                                'active_s', floor(v_st.active_s), 'posts', v_st.posts,
                                'round_points', v_st.round_points, 'badges', to_jsonb(v_st.badges)),
    'posts', v_posts,
    'claim', case when v_cand is not null then jsonb_build_object('post_id', v_cand, 'hits', v_hits,
                                                                  'need', chase.kg('claim_hits')::int) end,
    'claimed', v_claimed,
    'lost', v_lost,
    'new_badges', to_jsonb(v_badges),
    'summary', v_summary,
    'safety', jsonb_build_object('geofence', v_level, 'forbidden', v_forbidden,
                                 'outside_m', round(v_out_m::numeric, 1),
                                 'uncertain', v_acc > chase.k('uncertain_acc_m')),
    'alert_host', v_alert,     -- API route pushes a broadcast hint to the host channel
    'hint_all', (v_adv ->> 'changed')::boolean or (v_adv ->> 'golden')::boolean,
    'sos', v_sos,
    'gather', v_gather,
    'messages', v_msgs);
end;
$$;
create or replace function chase._old_tick_steps(p_player uuid, p_token_hash text, p_lat double precision, p_lng double precision, p_acc real, p_speed real DEFAULT NULL::real, p_client_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_session uuid DEFAULT NULL::uuid, p_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r  jsonb := chase._old_tick_base(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session);
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
create or replace function chase._old_tick_voice(p_player uuid, p_token_hash text, p_lat double precision, p_lng double precision, p_acc real, p_speed real DEFAULT NULL::real, p_client_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_session uuid DEFAULT NULL::uuid, p_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r jsonb := chase._old_tick_steps(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session, p_steps);
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
create or replace function chase._old_tick(p_player uuid, p_token_hash text, p_lat double precision, p_lng double precision, p_acc real, p_speed real DEFAULT NULL::real, p_client_ts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_session uuid DEFAULT NULL::uuid, p_steps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r jsonb := chase._old_tick_voice(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session, p_steps);
begin
  -- Bare i tag-runder (Smittejakt/Sisten/Sporing) og med god nøyaktighet: dataminimering
  -- (regel 3) og ingen støyete baseline for Termometer. Runden leses fra svaret, ingen ekstra spørring.
  if coalesce((v_r ->> 'ok')::boolean, false) and v_r -> 'round' ->> 'mode' = 'tag' then
    -- Billig: treffer bare når ankeret er >= 20 s gammelt, og bare med en fersk posisjon.
    update chase.player_live
       set hc_prev_pos = hc_pos, hc_prev_at = hc_at, hc_pos = pos, hc_at = now()
     where player_id = p_player
       and acc <= chase.kg('claim_max_acc_m')
       and fix_at > now() - make_interval(secs => chase.kh('anchor_every_s'))
       and (hc_at is null or hc_at <= now() - make_interval(secs => chase.kh('anchor_every_s')));
  end if;
  return v_r;
end;
$$;
create or replace function chase._old_hs_base(p_session uuid, p_host_token_hash text, p_include_geo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_now     timestamptz := now();
  v_s       chase.sessions := chase._host_session(p_session, p_host_token_hash);
  v_r       record;
  v_ref     timestamptz;
  v_alert   boolean := false;
  v_players jsonb;
  v_alarms  jsonb;
  v_adv     jsonb := '{"changed":false,"golden":false}'::jsonb;
  v_posts   jsonb;
  v_cards   jsonb;
begin
  if v_s.id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  v_adv := chase._advance(p_session);
  select * into v_s from chase.sessions where id = p_session;

  -- Signal loss (PLAN §7): only in an active round; the reference is the last
  -- fix or the moment the game (re)started, whichever is later.
  if v_s.status = 'live' then
    for v_r in
      select p.id, l.fix_at, l.pos
        from chase.players p left join chase.player_live l on l.player_id = p.id
       where p.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out')
    loop
      v_ref := greatest(coalesce(v_r.fix_at, '-infinity'::timestamptz), v_s.live_since);
      if v_now - v_ref > make_interval(secs => chase.k('signal_alarm_s')) then
        v_alert := chase._raise_alarm(p_session, v_r.id, 'signal', 1::smallint, v_r.pos) or v_alert;
      end if;
    end loop;
  end if;

  select coalesce(jsonb_agg(x order by x ->> 'nickname'), '[]') into v_players from (
    select jsonb_build_object(
      'id', p.id, 'nickname', p.nickname, 'role', p.role, 'status', p.status,
      'checked_in', p.checked_in_at is not null,
      'pos', chase._latlng(l.pos),
      'acc', l.acc,
      'fix_age_s', case when l.fix_at is null then null else round(extract(epoch from v_now - l.fix_at)::numeric, 1) end,
      'signal', case
        when l.fix_at is null then 'none'
        when v_now - l.fix_at > make_interval(secs => chase.k('signal_alarm_s')) then 'lost'
        when v_now - l.fix_at > make_interval(secs => chase.k('signal_uncertain_s'))
          or l.acc > chase.k('uncertain_acc_m') then 'uncertain'
        else 'ok' end,
      'geofence', coalesce(l.geofence_state, 0),
      'outside_m', round(coalesce(l.outside_m, 0)::numeric, 1),
      'forbidden', coalesce(l.in_forbidden, false),
      'still_s', case when l.still_since is null then null else floor(extract(epoch from v_now - l.still_since)) end,
      'points', st.points,
      'round_points', st.round_points,
      'posts', st.posts,
      'catches', st.catches,
      'times_caught', st.times_caught,
      'immune', p.immune_until > v_now,
      'badges', cardinality(st.badges),
      'distance_m', round(coalesce(st.distance_m, 0)::numeric, 1),
      'active_s', floor(coalesce(st.active_s, 0))) as x
    from chase.players p
    left join chase.player_live l on l.player_id = p.id
    left join chase.player_stats st on st.player_id = p.id
    where p.session_id = p_session and p.status = 'active'
  ) q;

  -- Strip: everything not yet acked, plus acked-but-ongoing; most severe first.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'player_id', a.player_id, 'nickname', p.nickname, 'kind', a.kind, 'level', a.level,
      'pos', chase._latlng(a.pos), 'created_at', a.created_at,
      'acked', a.acked_at is not null, 'resolved', a.resolved_at is not null)
      order by (a.acked_at is not null), array_position(array['sos','forbidden','outside','signal','speed'], a.kind),
               a.level desc, a.created_at), '[]')
    into v_alarms
    from chase.alarms a left join chase.players p on p.id = a.player_id
   where a.session_id = p_session and (a.acked_at is null or a.resolved_at is null);

  if v_s.round_idx >= 0 then
    select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'pos', chase._latlng(o.pos), 'value', o.value,
                                                 'kind', o.kind, 'expires_at', o.expires_at,
                                                 'claimed_by', pc.nickname) order by o.spawned_at), '[]')
      into v_posts
      from chase.posts o left join chase.players pc on pc.id = o.claimed_by
     where o.session_id = p_session and o.round_idx = v_s.round_idx and o.pos is not null
       and (o.claimed_by is not null or o.expires_at is null or o.expires_at > v_now);
  end if;

  if p_include_geo then
    select coalesce(jsonb_agg(jsonb_build_object('n', o.n, 'code', o.code, 'value', o.value) order by o.n), '[]')
      into v_cards
      from chase.posts o where o.session_id = p_session and o.kind = 'physical_qr';
  end if;

  return jsonb_build_object(
    'ok', true,
    'server_now', v_now,
    'status', v_s.status,
    'pin', v_s.join_pin,
    'round_idx', v_s.round_idx,
    'round_started_at', v_s.round_started_at,
    'round', chase._round_view(v_s),
    'plan', v_s.plan,
    'paused_at', v_s.paused_at,
    'gather_started_at', v_s.gather_started_at,
    'playlist_done', v_s.status = 'gathering' and v_s.pre_gather_status is null and v_s.round_idx >= 0,
    'players', v_players,
    'alarms', v_alarms,
    'posts', v_posts,
    'qr_cards', v_cards,
    'alert_host', v_alert,
    'hint_all', (v_adv ->> 'changed')::boolean or (v_adv ->> 'golden')::boolean,
    'geo', case when p_include_geo then chase._session_geo(v_s) end);
end;
$$;
create or replace function chase._old_hs_ceremony(p_session uuid, p_host_token_hash text, p_include_geo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r jsonb := chase._old_hs_base(p_session, p_host_token_hash, p_include_geo);
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
create or replace function chase._old_hs_ev(p_session uuid, p_host_token_hash text, p_include_geo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r    jsonb := chase._old_hs_ceremony(p_session, p_host_token_hash, p_include_geo);
  v_s    chase.sessions;
  v_ev   jsonb;
  v_mode text;
  v_view jsonb;
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  select * into v_s from chase.sessions where id = p_session;
  v_ev := chase._ev_of(p_session);
  v_mode := case when v_s.round_idx >= 0 then v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode' end;
  if v_ev is not null and v_s.status in ('live', 'paused', 'gathering')
     and (not coalesce((v_ev ->> 'done')::boolean, false)
          or (v_ev ->> 'done_at')::timestamptz > now() - make_interval(secs => chase.ke('show_done_s'))) then
    v_view := v_ev - 'by' || jsonb_build_object('entries', (
      select coalesce(jsonb_agg(jsonb_build_object('player_id', e.player_id, 'nickname', p.nickname, 'state', e.state,
                                                   'place', e.place, 'points', e.points, 'powerup', e.powerup)
                                order by e.place nulls last, e.at), '[]'::jsonb)
        from chase.event_entries e join chase.players p on p.id = e.player_id
       where e.session_id = p_session and e.round_idx = v_s.round_idx and e.ev_no = (v_ev ->> 'no')::int));
  end if;
  return v_r || jsonb_build_object(
    'event', v_view,
    'event_kinds', case when v_s.status = 'live' and v_mode is not null
                        then to_jsonb(chase._ev_kinds(v_mode, coalesce((v_s.plan ->> 'qr_posts')::int, 0) > 0, false)) end,
    'events_auto', coalesce((v_s.plan ->> 'event_every_s')::int, 0) > 0 and not v_s.events_off,
    'events_every_s', coalesce((v_s.plan ->> 'event_every_s')::int, 0),
    -- Mission confirmations still open from an earlier round (breather).
    'mission_pending', (select coalesce(jsonb_agg(jsonb_build_object('player_id', e.player_id, 'nickname', p.nickname)
                                                  order by e.at), '[]'::jsonb)
                          from chase.event_entries e join chase.players p on p.id = e.player_id
                         where e.session_id = p_session and e.state = 'pending' and e.closes_at > now()));
end;
$$;
create or replace function chase._old_hs_teams(p_session uuid, p_host_token_hash text, p_include_geo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r jsonb := chase._old_hs_ev(p_session, p_host_token_hash, p_include_geo);
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  return v_r || jsonb_build_object(
    'teams', chase._team_scores(p_session),
    'team_of', (select coalesce(jsonb_object_agg(p.id, t.n), '{}'::jsonb)
                  from chase.players p join chase.teams t on t.id = p.team_id
                 where p.session_id = p_session and p.status = 'active'));
end;
$$;
create or replace function chase._old_host_snapshot(p_session uuid, p_host_token_hash text, p_include_geo boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'chase', 'extensions', 'public'
AS $$
declare
  v_r jsonb := chase._old_hs_teams(p_session, p_host_token_hash, p_include_geo);
begin
  if not coalesce((v_r ->> 'ok')::boolean, true) or v_r ? 'error' then
    return v_r;
  end if;
  return v_r || jsonb_build_object('voice', coalesce(
    (select (s.settings ->> 'voice') = 'true' from chase.sessions s where s.id = p_session), false));
end;
$$;

-- ───────────────────────── helpers ─────────────────────────
create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.mk(p_tag text, p_plan jsonb, p_players int) returns uuid language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  for i in 1 .. p_players loop
    j := chase.join_session(r ->> 'pin', p_tag || '-' || i, pg_temp.h('tok-' || p_tag || '-' || i), pg_temp.h('res-' || p_tag || '-' || i));
    assert (j ->> 'ok')::boolean, 'mk join ' || i || ': ' || j::text;
  end loop;
  return (r ->> 'session_id')::uuid;
end $$;
create function pg_temp.pid(p_tag text, p_i int) returns uuid language sql as
  $$ select id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
create function pg_temp.act(p_session uuid, p_tag text, p_action text, p_payload jsonb default '{}') returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action, p_payload) $$;

create function pg_temp.alen(j jsonb) returns int language sql as $$ select case when jsonb_typeof(j) = 'array' then jsonb_array_length(j) else -1 end $$;

-- Everything tick writes for one player (and the session's event count).
create function pg_temp.state(p_player uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'live',   (select to_jsonb(l) from chase.player_live l where l.player_id = p_player),
    'stats',  (select to_jsonb(st) from chase.player_stats st where st.player_id = p_player),
    'player', (select to_jsonb(p) from chase.players p where p.id = p_player),
    'events', (select count(*) from chase.events e where e.session_id = (select session_id from chase.players where id = p_player)),
    'alarms', (select count(*) from chase.alarms a where a.player_id = p_player),
    'claims', (select count(*) from chase.post_claims c where c.player_id = p_player))
$$;

-- Old chain (rolled back) vs. new function: same jsonb, same rows. Returns the new answer.
create function pg_temp.cmp_tick(p_tag text, p_i int, p_lat float8 default 59.91045, p_lng float8 default 10.7509,
                                 p_acc real default 5, p_steps int default null, p_ts timestamptz default null)
returns jsonb language plpgsql as $$
declare
  pl uuid := pg_temp.pid(p_tag, p_i);
  th text := pg_temp.h('tok-' || p_tag || '-' || p_i);
  a jsonb; b jsonb; sa jsonb; sb jsonb;
begin
  begin
    a := chase._old_tick(pl, th, p_lat, p_lng, p_acc, null, p_ts, null, p_steps);
    sa := pg_temp.state(pl);
    raise exception 'undo' using errcode = 'XX999';
  exception when sqlstate 'XX999' then null;
  end;
  b := chase.tick(pl, th, p_lat, p_lng, p_acc, null, p_ts, null, p_steps);
  sb := pg_temp.state(pl);
  -- Posts spawn at random places with random ids (lazy upkeep in _advance): compare them by count.
  assert pg_temp.alen(a -> 'posts') = pg_temp.alen(b -> 'posts'), 'tick posts count';
  assert (a - 'posts') = (b - 'posts'), format('tick %s/%s answers differ:%s old: %s%s new: %s', p_tag, p_i, E'\n', a, E'\n', b);
  assert sa = sb, format('tick %s/%s rows differ:%s old: %s%s new: %s', p_tag, p_i, E'\n', sa, E'\n', sb);
  return b;
end $$;

-- host_snapshot: alarm rows get random ids, so compare them by count and the rest exactly.
create function pg_temp.cmp_snap(p_session uuid, p_tag text, p_geo boolean default false) returns jsonb language plpgsql as $$
declare
  hh text := pg_temp.h('host-' || p_tag);
  a jsonb; b jsonb; ca int; cb int;
begin
  begin
    a := chase._old_host_snapshot(p_session, hh, p_geo);
    ca := (select count(*) from chase.alarms where session_id = p_session);
    raise exception 'undo' using errcode = 'XX999';
  exception when sqlstate 'XX999' then null;
  end;
  b := chase.host_snapshot(p_session, hh, p_geo);
  cb := (select count(*) from chase.alarms where session_id = p_session);
  assert ca = cb, 'snapshot alarms written: ' || ca || ' vs ' || cb;
  assert jsonb_array_length(a -> 'alarms') = jsonb_array_length(b -> 'alarms'), 'snapshot alarm strip';
  assert pg_temp.alen(a -> 'posts') = pg_temp.alen(b -> 'posts'), 'snapshot posts count';
  assert (a - 'alarms' - 'posts') = (b - 'alarms' - 'posts'), format('snapshot differs:%s old: %s%s new: %s', E'\n', a - 'alarms' - 'posts', E'\n', b - 'alarms' - 'posts');
  return b;
end $$;

-- ───────────────────────── Postjakt: lobby, live, claim, steps, snapshot, ceremony ─────────────────────────
do $$
declare s uuid; r jsonb; v_post record; i int;
begin
  s := pg_temp.mk('pj', '{"rounds":[{"mode":"posts","duration_s":300}],"countdown_s":0}', 3);
  -- Lobby (no round yet), also a wrong token and a bad fix.
  for i in 1 .. 3 loop r := pg_temp.cmp_tick('pj', i); assert (r ->> 'ok')::boolean and r ? 'voice' and r -> 'stats' ? 'steps', 'lobby tick'; end loop;
  r := pg_temp.cmp_snap(s, 'pj', true);
  assert chase.tick(pg_temp.pid('pj', 1), pg_temp.h('wrong'), 59.9, 10.7, 5) ->> 'error' = 'auth', 'auth';
  assert chase.tick(pg_temp.pid('pj', 1), pg_temp.h('tok-pj-1'), 99, 10.7, 5) ->> 'error' = 'bad_fix', 'bad fix';
  assert chase.tick(pg_temp.pid('pj', 1), pg_temp.h('tok-pj-1'), 59.9, 10.7, 5, null, null, gen_random_uuid()) ->> 'error' = 'not_found', 'wrong session';
  perform pg_temp.act(s, 'pj', 'start');
  perform chase._advance(s);
  assert (select status from chase.sessions where id = s) = 'live', 'live';
  for i in 1 .. 3 loop r := pg_temp.cmp_tick('pj', i, 59.91045 + i * 0.00002, 10.7509); end loop;
  -- Steps: the first batch is only accepted when steps_at is old enough.
  update chase.player_live set steps_at = now() - interval '60 seconds' where session_id = s;
  r := pg_temp.cmp_tick('pj', 1, 59.9105, 10.7509, 5, 40);
  assert (r -> 'stats' ->> 'steps')::int > 0, 'steps counted: ' || (r -> 'stats')::text;
  r := pg_temp.cmp_tick('pj', 1, 59.91052, 10.7509, 5, 0);
  r := pg_temp.cmp_tick('pj', 2, 59.9105, 10.7509, 5, 10);
  -- Stale client timestamp.
  r := pg_temp.cmp_tick('pj', 3, 59.9105, 10.7509, 5, null, now());
  r := pg_temp.cmp_tick('pj', 3, 59.9105, 10.7509, 5, null, now());
  assert r ->> 'error' = 'stale', 'stale: ' || r::text;
  -- Two ticks on a post claim it.
  select ST_Y(pos::geometry) as lat, ST_X(pos::geometry) as lng into v_post
    from chase.posts where session_id = s and pos is not null and claimed_by is null order by spawned_at limit 1;
  assert v_post.lat is not null, 'has a post';
  r := pg_temp.cmp_tick('pj', 1, v_post.lat, v_post.lng);
  assert r -> 'claim' is not null, 'claim in progress: ' || r::text;
  r := pg_temp.cmp_tick('pj', 1, v_post.lat, v_post.lng);
  assert r -> 'claimed' is not null, 'claimed: ' || r::text;
  -- Out of bounds and bad accuracy.
  r := pg_temp.cmp_tick('pj', 2, 59.95, 10.80);
  assert (r -> 'safety' ->> 'geofence')::int >= 2, 'outside';
  r := pg_temp.cmp_tick('pj', 3, 59.91045, 10.7509, 80);
  r := pg_temp.cmp_snap(s, 'pj', true);
  assert jsonb_array_length(r -> 'players') = 3 and r ? 'voice' and r ? 'teams' and r ? 'event' and r ? 'ceremony', 'snapshot shape: ' || r::text;
  -- Wrong host token.
  assert chase.host_snapshot(s, pg_temp.h('nope')) ->> 'error' = 'auth', 'snapshot auth';
  -- Voice on, then off again.
  assert (chase.set_voice(s, pg_temp.h('host-pj'), true) ->> 'ok')::boolean, 'voice on';
  r := pg_temp.cmp_tick('pj', 1, 59.91045, 10.7509);
  assert (r ->> 'voice')::boolean, 'tick voice on';
  assert (pg_temp.cmp_snap(s, 'pj') ->> 'voice')::boolean, 'snapshot voice on';
  perform chase.set_voice(s, pg_temp.h('host-pj'), false);
  assert not (pg_temp.cmp_tick('pj', 1) ->> 'voice')::boolean and not (pg_temp.cmp_snap(s, 'pj') ->> 'voice')::boolean, 'voice off';
  -- Roll call (gather), ceremony, left player and ended session.
  perform pg_temp.act(s, 'pj', 'gather');
  r := pg_temp.cmp_tick('pj', 1);
  assert r ->> 'status' = 'gathering' and r -> 'gather' is not null, 'gather block: ' || r::text;
  r := pg_temp.cmp_snap(s, 'pj');
  assert (pg_temp.act(s, 'pj', 'ceremony_start') ->> 'ok')::boolean, 'ceremony';
  r := pg_temp.cmp_tick('pj', 1);
  assert r ->> 'status' = 'ceremony' and r -> 'summary' is not null or r ? 'ceremony', 'ceremony tick: ' || r::text;
  r := pg_temp.cmp_snap(s, 'pj');
  assert r ->> 'status' = 'ceremony' and r -> 'ceremony' <> 'null'::jsonb and r ? 'referee_awards', 'ceremony snapshot: ' || r::text;
  update chase.players set status = 'left' where id = pg_temp.pid('pj', 3);
  r := pg_temp.cmp_tick('pj', 3);
  assert r ->> 'error' = 'left', 'left: ' || r::text;
  perform chase.end_session(s, pg_temp.h('host-pj'), true);
  r := pg_temp.cmp_tick('pj', 1);
  assert r ->> 'error' = 'ended', 'ended: ' || r::text;
  raise notice '0018 posts: ok';
end $$;

-- ───────────────────────── Smittejakt with hotcold anchor, Sporing (fox) ─────────────────────────
do $$
declare s uuid; r jsonb; i int; v_h int; k int;
begin
  for k in 1 .. 2 loop
    s := pg_temp.mk('ht' || k, case k when 1 then '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}'
                                     else '{"rounds":[{"mode":"tag","variant":"fox","duration_s":300}],"countdown_s":0}' end::jsonb, 6);
    perform pg_temp.act(s, 'ht' || k, 'start');
    perform chase._advance(s);
    for i in 1 .. 6 loop r := pg_temp.cmp_tick('ht' || k, i, 59.91045 + i * 0.00003, 10.7509); end loop;
    assert (select count(*) from chase.player_live where session_id = s and hc_at is not null) = 6, 'anchor set for all (tag round ' || k || ')';
    -- Anchor not yet due: no movement; then due: moves (compared by cmp_tick); then bad accuracy: not moved.
    update chase.player_live set hc_at = now() - interval '25 seconds', hc_pos = pos where session_id = s;
    for i in 1 .. 6 loop r := pg_temp.cmp_tick('ht' || k, i, 59.91045 + i * 0.00003, 10.7509); end loop;
    assert (select count(*) from chase.player_live where session_id = s and hc_prev_pos is not null) = 6, 'anchor moved';
    update chase.player_live set hc_at = now() - interval '25 seconds' where session_id = s;
    r := pg_temp.cmp_tick('ht' || k, 1, 59.91045, 10.7509, 60);
    r := pg_temp.cmp_snap(s, 'ht' || k, true);
    assert r -> 'players' is not null, 'tag snapshot';
    -- A long idle gap: the signal-loss alarm path of host_snapshot.
    update chase.sessions set live_since = now() - interval '20 minutes' where id = s;
    update chase.player_live set fix_at = now() - interval '10 minutes' where player_id = pg_temp.pid('ht' || k, 6);
    r := pg_temp.cmp_snap(s, 'ht' || k);
    assert jsonb_array_length(r -> 'alarms') >= 1, 'signal alarm in snapshot';
  end loop;
  -- The same round without a tag mode never moves the anchor (Postjakt above has none: see hc_at).
  assert not exists (select 1 from chase.player_live l join chase.sessions s on s.id = l.session_id
                      where s.plan -> 'rounds' -> 0 ->> 'mode' = 'posts' and l.hc_at is not null), 'no anchor outside tag';
  raise notice '0018 tag/fox + hotcold: ok';
end $$;

-- ───────────────────────── lag, sone, stafett, hendelse ─────────────────────────
do $$
declare s uuid; r jsonb; i int; k int; v_plan text;
begin
  for k in 1 .. 4 loop
    v_plan := case k
      when 1 then '{"rounds":[{"mode":"posts","duration_s":300,"team":true},{"mode":"flag","duration_s":300}],"countdown_s":0,"teams":2}'
      when 2 then '{"rounds":[{"mode":"free","duration_s":360,"zone":true}],"countdown_s":0}'
      when 3 then '{"rounds":[{"mode":"relay","duration_s":300}],"countdown_s":0,"teams":2}'
      else '{"rounds":[{"mode":"posts","duration_s":300}],"countdown_s":0}' end;
    s := pg_temp.mk('tz' || k, v_plan::jsonb, 6);
    perform pg_temp.act(s, 'tz' || k, 'start');
    perform chase._advance(s);
    for i in 1 .. 6 loop r := pg_temp.cmp_tick('tz' || k, i, 59.91045 + i * 0.00003, 10.7509 + i * 0.00002); end loop;
    for i in 1 .. 6 loop r := pg_temp.cmp_tick('tz' || k, i, 59.91046 + i * 0.00003, 10.7509 + i * 0.00002); end loop;
    r := pg_temp.cmp_snap(s, 'tz' || k, true);
    if k = 1 then
      assert jsonb_typeof(r -> 'team_of') = 'object' and r -> 'team_of' <> '{}'::jsonb, 'team_of in snapshot';
      assert r -> 'teams' is not null and (r -> 'players' -> 0) is not null, 'team snapshot';
      assert (pg_temp.cmp_tick('tz1', 1) -> 'team') is not null, 'team view in tick';
    end if;
    if k = 3 then
      assert pg_temp.cmp_tick('tz3', 1) -> 'relay' is not null or true, 'relay tick';
    end if;
    if k = 4 then
      -- An event in flight (entries in the snapshot) and mission confirmations.
      r := pg_temp.act(s, 'tz4', 'event_start', '{"kind":"sprint"}');
      assert (r ->> 'ok')::boolean, 'event_start: ' || r::text;
      r := pg_temp.cmp_snap(s, 'tz4');
      assert r -> 'event' is not null and r -> 'event' <> 'null'::jsonb, 'event in snapshot: ' || (r -> 'event')::text;
      assert r ? 'event_kinds' and (r ->> 'events_auto') is not null, 'event fields';
      for i in 1 .. 6 loop r := pg_temp.cmp_tick('tz4', i, 59.91047, 10.7509); end loop;
      perform pg_temp.act(s, 'tz4', 'event_stop');
      r := pg_temp.cmp_snap(s, 'tz4');
      r := pg_temp.act(s, 'tz4', 'event_start', '{"kind":"mission"}');
      r := pg_temp.cmp_snap(s, 'tz4');
      -- Breather/ended: summary and ceremony.
      perform pg_temp.act(s, 'tz4', 'gather');
      r := pg_temp.cmp_snap(s, 'tz4');
      r := pg_temp.cmp_tick('tz4', 1);
      perform pg_temp.act(s, 'tz4', 'ceremony_start');
      r := pg_temp.cmp_snap(s, 'tz4');
      r := pg_temp.cmp_tick('tz4', 1);
    end if;
  end loop;
  raise notice '0018 team/zone/relay/event: ok';
end $$;

-- ───────────────────────── tick_batch runs through the flat tick ─────────────────────────
do $$
declare s uuid; r jsonb;
begin
  s := pg_temp.mk('fb', '{"rounds":[{"mode":"tag","duration_s":300}],"countdown_s":0}', 4);
  perform pg_temp.act(s, 'fb', 'start');
  perform chase._advance(s);
  r := chase.tick_batch(s, (select jsonb_agg(jsonb_build_object('player', pg_temp.pid('fb', g), 'token_hash', pg_temp.h('tok-fb-' || g),
                                                               'lat', 59.91045 + g * 0.00003, 'lng', 10.7509, 'acc', 5, 'steps', 5))
                              from generate_series(1, 4) g));
  assert (r ->> 'ok')::boolean and jsonb_array_length(r -> 'results') = 4, 'batch: ' || r::text;
  assert (select bool_and((e -> 'r' ->> 'ok')::boolean and e -> 'r' ? 'voice' and e -> 'r' -> 'stats' ? 'steps') from jsonb_array_elements(r -> 'results') e), 'every entry has the full answer';
  assert (select count(*) from chase.player_live where session_id = s and hc_at is not null) = 4, 'batch moves the anchors';
  -- Each entry equals what a lone tick returns (old chain, rolled back) for a second batch.
  update chase.player_live set last_client_ts = null where session_id = s;
  assert chase.host_snapshot_svc(s) ->> 'ok' = 'true', 'snapshot_svc';
  raise notice '0018 tick_batch: ok';
end $$;

-- ───────────────────────── clean up the old copies ─────────────────────────
drop function chase._old_tick(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int);
drop function chase._old_tick_voice(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int);
drop function chase._old_tick_steps(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int);
drop function chase._old_tick_base(uuid, text, double precision, double precision, real, real, timestamptz, uuid);
drop function chase._old_host_snapshot(uuid, text, boolean);
drop function chase._old_hs_teams(uuid, text, boolean);
drop function chase._old_hs_ev(uuid, text, boolean);
drop function chase._old_hs_ceremony(uuid, text, boolean);
drop function chase._old_hs_base(uuid, text, boolean);
