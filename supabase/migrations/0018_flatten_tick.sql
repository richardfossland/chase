-- Chase — 0018 — flat tick og host_snapshot (fase 10.1, ren refaktorering).
--
-- chase.tick og chase.host_snapshot var bygget som kjeder av wrappere, én per
-- migrasjon som la på noe (guardet rename + create or replace):
--
--   tick:          tick (0017, hotcold-anker) → _tick_voice (0015) → _tick_steps (0012)
--                  → _tick_base (0004, den egentlige logikken)
--   host_snapshot: host_snapshot (0015, voice) → _host_snapshot_teams (0015/0009)
--                  → _host_snapshot_ev (0009) → _host_snapshot_ceremony (0007)
--                  → _host_snapshot_base (0004/0006)
--
-- Hver wrapper leste økta og/eller spilleren på nytt og la et jsonb-fragment på
-- svaret. Nå er logikken inlinet i én funksjon hver: samme returform, samme
-- security definer, search_path og grants, og færre spørringer (økta leses én
-- gang; wrapperne leste sessions/players igjen for voice og skritt).
-- tick_batch (0014) og host_snapshot_svc (0014) kaller de offentlige navnene og
-- er uendret. Ingen TS-kode kaller mellomleddene.
--
-- Mellomleddene droppes helt nederst. Re-kjøring (test-db.sh og provision-shared
-- kjører ALLE migrasjoner på nytt i rekkefølge): 0002–0004 lager da en rå
-- 8-args tick og 3-args host_snapshot på nytt, 0006/0007/0009/0012/0015/0017 pakker
-- dem inn igjen (guardene gir dem nytt navn når mellomleddet mangler), og dette
-- skriptet lager den flate versjonen på nytt og dropper mellomleddene. Sluttilstanden
-- er altså den samme etter hver full kjøring.
--
-- VIKTIG: migrasjonene kan bare kjøres som HELE rekken i rekkefølge. 0004 og 0012 skal
-- aldri kjøres alene etter 0018: 0012 finner da ingen 8-args tick å gi nytt navn, og
-- lager en 9-args wrapper rundt den droppede _tick_base, så alle tick-kall feiler. Det
-- samme gjelder 0015/0017 alene (de pakker flat tick inn i en wrapper). Ved feil: kjør
-- hele rekken på nytt.
--
-- Funksjonene med flere lag i 0016 (create_session, _spawn_post, library_*, share_*,
-- claim_qr) er med vilje IKKE flatet her, se PR-beskrivelsen.

set search_path = chase, extensions, public;
set local lock_timeout = '3s';

-- ───────────────────────── tick (flat) ─────────────────────────

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
  v_r          jsonb;
  v_steps      int;
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

  v_r := coalesce(v_extra, '{}'::jsonb) || jsonb_build_object(
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

  -- ── skritteller (0012): klientens delta godtas med glatting. v_l er lest før upserten
  --    (steps røres ikke av den), så uten nye skritt trengs ingen ny spørring ──
  if coalesce(p_steps, 0) > 0 then
    update chase.player_live
       set steps = steps + chase._steps_accept(p_steps, extract(epoch from now() - steps_at)), steps_at = now()
     where player_id = p_player
    returning steps into v_steps;
  else
    v_steps := v_l.steps;
  end if;
  -- ── quiz (0012) ──
  v_r := v_r || chase._quiz_tick(p_player, v_s.id, v_r -> 'claimed');
  v_r := jsonb_set(v_r, '{stats,steps}', to_jsonb(coalesce(v_steps, 0)));
  -- ── talte varsler (0015): økt-innstillingen er allerede lest i v_s ──
  v_r := v_r || jsonb_build_object('voice', coalesce((v_s.settings ->> 'voice') = 'true', false));

  -- ── varmere/kaldere-anker (0017): bare i tag-runder og med god nøyaktighet (regel 3,
  --    ingen støyete baseline). Treffer bare når ankeret er >= 20 s gammelt og fixen er fersk. ──
  if v_r -> 'round' ->> 'mode' = 'tag' then
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

-- ───────────────────────── host_snapshot (flat) ─────────────────────────

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
  v_res     jsonb;
  v_ev      jsonb;
  v_mode    text;
  v_view    jsonb;
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

  v_res := jsonb_build_object(
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

  -- ── seremoni (0007) ──
  v_res := v_res || jsonb_build_object(
    'referee_awards', to_jsonb(v_s.best_referees),
    'ceremony', case when v_s.status = 'ceremony' then chase._ceremony_view(p_session, null) end);

  -- ── hendelser (0009) ──
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
  v_res := v_res || jsonb_build_object(
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

  -- ── lag (0009) ──
  v_res := v_res || jsonb_build_object(
    'teams', chase._team_scores(p_session),
    'team_of', (select coalesce(jsonb_object_agg(p.id, t.n), '{}'::jsonb)
                  from chase.players p join chase.teams t on t.id = p.team_id
                 where p.session_id = p_session and p.status = 'active'));

  -- ── talte varsler (0015): innstillingen ligger i den allerede leste v_s ──
  return v_res || jsonb_build_object('voice', coalesce((v_s.settings ->> 'voice') = 'true', false));
end;
$$;

-- ───────────────────────── drop mellomleddene ─────────────────────────
-- Etter at de flate funksjonene er laget; ingenting annet kaller dem.

drop function if exists chase._tick_voice(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int);
drop function if exists chase._tick_steps(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int);
drop function if exists chase._tick_base(uuid, text, double precision, double precision, real, real, timestamptz, uuid);
drop function if exists chase._host_snapshot_teams(uuid, text, boolean);
drop function if exists chase._host_snapshot_ev(uuid, text, boolean);
drop function if exists chase._host_snapshot_ceremony(uuid, text, boolean);
drop function if exists chase._host_snapshot_base(uuid, text, boolean);

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;

notify pgrst, 'reload schema';
