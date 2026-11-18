-- Chase — 0023 — Gjemsel (fase 10.9, PLAN § 13). Nummer 0021 brukes ikke.
--
-- Gjemsel er en VARIANT av Smittejakt (mode 'tag', variant 'hide'), på samme måte som
-- Sporing (fox, 0013). Det gjenbruker mest mulig: roller, fangstkoder, catch() (GPS ≤ ~30 m + kode/QR,
-- «convert»-grenen: den fangede blir jeger, ingen permanent utslagning, runden slutter når alle er funnet),
-- tilleggspoeng for fangst/assist, Snus/Termometer (0017), rollerebalansering for sene innmeldte, øktlås og pause.
-- Planen: {"mode":"tag","variant":"hide","duration_s":300,"head_start_s":75}.
--
--   * Roller: få jegere, ceil(n/6) (minst 1), resten gjemmere (_hide_hunters, TS-tvilling lib/rules/hide.ts).
--     Base-delingen fra 0004 (~15 %) justeres av _hide_begin (flytter tilfeldige spillere mellom rollene).
--   * Forsprang: plan.head_start_s 60–90 s (standard 75). Slipp-tidspunktet `release_at` = rundestart +
--     forsprang ligger i rounds.state.hide (absolutt tid; pause flytter det, regel 6). Før slipp kan
--     jegerne verken fange (catch → 'not_yet') eller bruke Snus/Termometer ('not_yet'); ingen straff, de står
--     bare ved møteplassen. Runden må vare minst forsprang + 60 s (ellers bad_plan).
--   * Etter slipp: gjemmerne er usynlige for jegerne. Radar-pinget fra 0004 slås av (ping_pos nulles i
--     hver upkeep) og «Bytte i nærheten» (prey_near) settes til 0 for jegerne, så Snus (50 m ja/nei) og
--     Termometer (varmere/kaldere) er hjelpemidlene. Nedkjøling i Gjemsel: kv('cooldown_s') = 30 s (mot 60 s).
--     Bare jegere kan bruke dem i Gjemsel (gjemmere: not_useful).
--   * Stillstandspling (bevegelsesprinsippet, PLAN § 1 punkt 2): en gjemmer som har stått innenfor
--     still_radius (10 m, 0002) i ≥ kv('still_s') = 90 s gir jegerne et «pling»: en sirkel med radius
--     kv('still_r_m') = 100 m rundt en TILFELDIG FORSKJØVET posisjon (20–70 m fra stillstandsankeret,
--     retning og avstand fra md5(spiller-id || still_since), stabil så lenge stillstanden varer, så
--     gjentatte tick ikke kan midles ut). Sirkelen inneholder alltid den ekte posisjonen, men gir aldri eksakt
--     posisjon. Plinget BEREGNES i _mode_tick ved visning fra player_live.still_anchor/still_since
--     (UNLOGGED, finnes fra før); den forskjøvne posisjonen lagres ikke, og id-en er en hash, ikke spiller-id.
--     Plinget forsvinner når gjemmeren flytter seg mer enn 10 m.
--   * Poeng: gjemmere kv('pts_per_min') = 10 per hele minutt overlevd etter slipp (player_stats.hs_since/hs_pts,
--     regnet i _mode_tick; base-opptjeningen +1/5 s fra 0004 er slått av ved å holde current_survival_start
--     tom i Gjemsel), + survivor_pts (25) til de som ikke er funnet ved rundeslutt (som convert). Jegere:
--     +15 per fangst og +5 assist (uendret). Pall «Mestergjemmer» = lengste tid uoppdaget (hide_best_s).
--   * Ingen sone, lag eller prøverunde sammen med Gjemsel (_norm_plan avviser dem; prøverunde i
--     veiviseren gir en Smittejakt-prøve). Ingen automatiske hendelser og ingen event_start
--     (sprint/samling/storm ødelegger gjemmingen): host_action → 'hide', _ev_upkeep hopper over.
--   * Geofence/SOS/signaltap/stillstandsvarsler til læreren er uendret (regel 4); læreren ser alle som vanlig.
--
-- Personvern (regel 3): ingen ny posisjonskolonne. hs_since/hs_pts/hide_best_s er tider og tall uten posisjon.
-- Stillstandsplinget bruker still_anchor (finnes fra 0002, slettes sammen med player_live ved «Avslutt»).
--
-- Additiv: nye kolonner har standardverdi; gammel Worker mot ny DB ser bare ekstra nøkler (`hide`) i svarene.
-- tick/host_snapshot (flate, 0018) er IKKE rørt. Guardede rename-wrappere (migrasjonen kjøres to ganger i
-- test-db.sh): _norm_plan, _mode_begin, _mode_finish, _mode_upkeep_team, _mode_tick, _round_view,
-- _unfreeze, _ev_upkeep, host_action, use_powerup, catch (→ _catch_hide). Omdefinert i sin helhet: use_hotcold, _team_ceremony.

set search_path = chase, extensions, public;

-- ───────────────────────── schema ─────────────────────────

alter table chase.player_stats add column if not exists hs_since    timestamptz;
alter table chase.player_stats add column if not exists hs_pts      int not null default 0;
alter table chase.player_stats add column if not exists hide_best_s int not null default 0;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/hide.ts (test/hide.test.ts diffs them).

create or replace function chase.kv(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'head_min_s'        then 60    -- head start for the hiders: teacher picks 60–90 s …
    when 'head_max_s'        then 90
    when 'head_default_s'    then 75    -- … default
    when 'min_after_head_s'  then 60    -- a round must run at least this long after the release
    when 'hunters_div'       then 6     -- hunters = ceil(players / 6), at least 1
    when 'cooldown_s'        then 30    -- Snus/Termometer cooldown in Gjemsel (0017: 60 s elsewhere)
    when 'pts_per_min'       then 10    -- hider: points per full minute survived after the release
    when 'still_s'           then 90    -- a hider standing still this long «plings» for the hunters
    when 'still_r_m'         then 100   -- radius of the pling circle
    when 'still_off_min_m'   then 20    -- the circle's centre is shifted this far …
    when 'still_off_max_m'   then 70    -- … to this far (always < radius: the hider is inside, never at the centre)
    when 'still_max'         then 25    -- the nearest plings a hunter gets
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/hide.ts) ─────────────────────────

create or replace function chase._hide_hunters(p_players int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$ select greatest(1, ceil(greatest(coalesce(p_players, 0), 0) / chase.kv('hunters_div')))::int; $$;

-- Points for p_s seconds hidden after the release (whole minutes).
create or replace function chase._hide_points(p_s double precision)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$ select (floor(greatest(coalesce(p_s, 0), 0) / 60) * chase.kv('pts_per_min'))::int; $$;

-- The hunters may act from the release on.
create or replace function chase._hide_released(p_release timestamptz, p_now timestamptz)
returns boolean
language sql
immutable
set search_path = chase, extensions, public
as $$ select p_release is not null and p_now >= p_release; $$;

-- Shift of a pling centre from the stillness anchor: bearing 0–359° and distance 20–70 m from a seed string
-- (md5 of player id + still_since). Pure: same seed, same shift.
create or replace function chase._hide_offset(p_seed text)
returns real[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array[
    ((('x' || substr(md5(p_seed), 1, 8))::bit(32)::bigint) % 360)::real,
    (chase.kv('still_off_min_m') + ((('x' || substr(md5(p_seed), 9, 8))::bit(32)::bigint) % (chase.kv('still_off_max_m') - chase.kv('still_off_min_m') + 1)::bigint))::real];
$$;

-- «Mestergjemmer» right before Orienterer / Flest riktige / Lagspiller / Flest poeng / Lagpall (else last).
-- p_rows: [{id, hide}] (seconds undiscovered). Same shape as _scoreo_podiums (0020).
create or replace function chase._hide_podiums(p_podiums jsonb, p_rows jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_pod jsonb;
  v_out jsonb := '[]'::jsonb;
  v_p   jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', r ->> 'id', 'value', (r ->> 'hide')::numeric)
                   order by (r ->> 'hide')::numeric desc, (r ->> 'id') collate "C")
    into v_pod
    from (select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
           where coalesce((r ->> 'hide')::numeric, 0) > 0
           order by (r ->> 'hide')::numeric desc, (r ->> 'id') collate "C"
           limit chase.kc('podium_size')::int) q;
  if v_pod is null then
    return coalesce(p_podiums, '[]'::jsonb);
  end if;
  for v_p in select * from jsonb_array_elements(coalesce(p_podiums, '[]'::jsonb)) loop
    if v_pod is not null and v_p ->> 'cat' in ('scoreo', 'quiz', 'teamplay', 'points', 'team') then
      v_out := v_out || jsonb_build_object('cat', 'hide', 'entries', v_pod);
      v_pod := null;
    end if;
    v_out := v_out || v_p;
  end loop;
  if v_pod is not null then
    v_out := v_out || jsonb_build_object('cat', 'hide', 'entries', v_pod);
  end if;
  return v_out;
end;
$$;

create or replace function chase._is_hide(p_session uuid)
returns boolean
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce(r ->> 'mode' = 'tag' and r ->> 'variant' = 'hide', false) from (select chase._round_mode(p_session) as r) q;
$$;

-- ───────────────────────── plan ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_hs(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_hs;
  end if;
end $$;

-- The older layers know convert/swap/fox: a hide round is checked as 'convert' without head_start_s,
-- and both are put back on the normalised plan. No zone, no team, no practice round.
create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_in    jsonb := p;
  v_base  jsonb;
  v_r     jsonb;
  v_idx   int[] := '{}';
  v_heads int[] := '{}';
  v_head  numeric;
  v_dur   numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'rounds') <> 'array' then
    return null;
  end if;
  for i in 0 .. jsonb_array_length(p -> 'rounds') - 1 loop
    v_r := p -> 'rounds' -> i;
    if jsonb_typeof(v_r) = 'object' and v_r ->> 'mode' = 'tag' and v_r ->> 'variant' = 'hide' then
      if coalesce(v_r -> 'zone', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb)
         or coalesce(v_r -> 'team', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb)
         or coalesce(v_r -> 'practice', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb) then
        return null;
      end if;
      if jsonb_typeof(v_r -> 'head_start_s') is not null and jsonb_typeof(v_r -> 'head_start_s') <> 'null' then
        if jsonb_typeof(v_r -> 'head_start_s') <> 'number' then
          return null;
        end if;
        v_head := (v_r ->> 'head_start_s')::numeric;
      else
        v_head := chase.kv('head_default_s');
      end if;
      if v_head <> floor(v_head) or v_head not between chase.kv('head_min_s') and chase.kv('head_max_s') then
        return null;
      end if;
      if jsonb_typeof(v_r -> 'duration_s') = 'number' then
        v_dur := (v_r ->> 'duration_s')::numeric;
        if v_dur < v_head + chase.kv('min_after_head_s') then
          return null;
        end if;
      end if;
      v_in := jsonb_set(v_in, array['rounds', i::text], (v_r - 'head_start_s') || '{"variant":"convert"}'::jsonb);
      v_idx := v_idx || i;
      v_heads := v_heads || v_head::int;
    elsif jsonb_typeof(v_r) = 'object' and v_r ? 'head_start_s' then
      return null;                   -- the head start belongs to Gjemsel only
    end if;
  end loop;
  v_base := chase._norm_plan_hs(v_in);
  if v_base is null then
    return null;
  end if;
  for k in 1 .. coalesce(cardinality(v_idx), 0) loop
    v_base := jsonb_set(v_base, array['rounds', v_idx[k]::text, 'variant'], '"hide"'::jsonb);
    v_base := jsonb_set(v_base, array['rounds', v_idx[k]::text, 'head_start_s'], to_jsonb(v_heads[k]));
  end loop;
  return v_base;
exception when others then
  return null;
end;
$$;

-- ───────────────────────── round lifecycle ─────────────────────────

-- Round start of a Gjemsel round: right number of hunters, the release time, the hiders' survival clock.
create or replace function chase._hide_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_head  int;
  v_rel   timestamptz;
  v_n     int;
  v_h     int;
  v_want  int;
begin
  select * into s from chase.sessions where id = p_session;
  v_head := coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'head_start_s')::int, chase.kv('head_default_s')::int);
  v_rel := p_at + make_interval(secs => v_head);
  update chase.rounds
     set state = state || jsonb_build_object('hide', jsonb_build_object('release_at', v_rel, 'head_start_s', v_head))
   where session_id = p_session and idx = s.round_idx;

  -- Few hunters: 0004 dealt ~15 %; move random players between the roles up to ceil(n / 6).
  select count(*), count(*) filter (where role = 'hunter') into v_n, v_h
    from chase.players where session_id = p_session and status = 'active' and role in ('hunter', 'prey');
  v_want := chase._hide_hunters(v_n);
  if v_n > 1 and v_h < v_want then
    update chase.players set role = 'hunter', role_changed_at = p_at
     where id in (select id from chase.players where session_id = p_session and status = 'active' and role = 'prey'
                   order by random() limit least(v_want - v_h, v_n - 1));
  elsif v_h > v_want then
    update chase.players set role = 'prey', role_changed_at = p_at
     where id in (select id from chase.players where session_id = p_session and status = 'active' and role = 'hunter'
                   order by random() limit v_h - v_want);
  end if;

  -- Own survival clock (per minute after the release); 0004's +1/5 s accrual stays off (current_survival_start empty).
  update chase.player_stats st
     set hs_since = case when p.role = 'prey' then v_rel end, hs_pts = 0, current_survival_start = null, surv_pts_stint = 0
    from chase.players p
   where p.id = st.player_id and p.session_id = p_session;
end;
$$;

do $$
begin
  if to_regprocedure('chase._mode_begin_hs(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _mode_begin_hs;
  end if;
  if to_regprocedure('chase._mode_finish_hs(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _mode_finish_hs;
  end if;
  if to_regprocedure('chase._mode_upkeep_hs(uuid)') is null then
    alter function chase._mode_upkeep_team(uuid) rename to _mode_upkeep_hs;
  end if;
  if to_regprocedure('chase._mode_tick_hs(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_hs;
  end if;
  if to_regprocedure('chase._round_view_hs(chase.sessions)') is null then
    alter function chase._round_view(chase.sessions) rename to _round_view_hs;
  end if;
  if to_regprocedure('chase._unfreeze_hs(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_hs;
  end if;
  if to_regprocedure('chase._ev_upkeep_hs(uuid)') is null then
    alter function chase._ev_upkeep(uuid) rename to _ev_upkeep_hs;
  end if;
  if to_regprocedure('chase._host_action_hs(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_hs;
  end if;
  if to_regprocedure('chase._catch_hide(uuid,text,uuid,text)') is null then
    alter function chase.catch(uuid, text, uuid, text) rename to _catch_hide;
  end if;
  if to_regprocedure('chase._use_powerup_hs(uuid,text,uuid,text)') is null then
    alter function chase.use_powerup(uuid, text, uuid, text) rename to _use_powerup_hs;
  end if;
end $$;

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_begin_hs(p_session, p_at);
  if chase._is_hide(p_session) then
    perform chase._hide_begin(p_session, p_at);
  else
    -- Not Gjemsel: nothing of the hide clock lives on (cheap, narrow).
    update chase.player_stats set hs_since = null, hs_pts = 0 where session_id = p_session and (hs_since is not null or hs_pts <> 0);
  end if;
end;
$$;

-- Round end (called before 0004's finish resets the roles): the hiders still free get survivor_pts and
-- their time becomes «Mestergjemmer» material.
create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_id uuid;
begin
  if chase._is_hide(p_session) then
    for v_id in select p.id from chase.players p join chase.player_stats st on st.player_id = p.id
                 where p.session_id = p_session and p.role = 'prey' and p.status = 'active' and st.hs_since is not null loop
      update chase.player_stats
         set points = points + chase.kt('survivor_pts')::int, round_points = round_points + chase.kt('survivor_pts')::int,
             hide_best_s = greatest(hide_best_s, floor(greatest(0, extract(epoch from p_at - hs_since)))::int)
       where player_id = v_id;
      perform chase._award_badges(v_id, array['survivor']);
    end loop;
    update chase.player_stats set hs_since = null, hs_pts = 0 where session_id = p_session and (hs_since is not null or hs_pts <> 0);
  end if;
  perform chase._mode_finish_hs(p_session, p_at);
end;
$$;

-- Upkeep (≤ 1/s, under the session lock): no radar pings of hiders; late joiners get the hide clock.
create or replace function chase._mode_upkeep_team(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_rel timestamptz;
begin
  perform chase._mode_upkeep_hs(p_session);
  if not chase._is_hide(p_session) then
    return;
  end if;
  -- 0004's upkeep just pinged the prey; Gjemsel has no radar (the pling is derived at view time).
  update chase.player_live set ping_pos = null, ping_at = null, ping_stealth = false
   where session_id = p_session and ping_pos is not null;
  -- A late joiner (prey via _tag_rebalance, current_survival_start set) starts hiding now.
  select (r.state -> 'hide' ->> 'release_at')::timestamptz into v_rel
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx where s.id = p_session;
  update chase.player_stats st
     set hs_since = greatest(st.current_survival_start, coalesce(v_rel, st.current_survival_start)), hs_pts = 0,
         current_survival_start = null, surv_pts_stint = 0
    from chase.players p
   where p.id = st.player_id and st.session_id = p_session and st.current_survival_start is not null and p.role = 'prey';
end;
$$;

-- ───────────────────────── per-tick view ─────────────────────────

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_out    jsonb := coalesce(chase._mode_tick_hs(p_player, p_session, p_pos), '{}'::jsonb);
  v_role   text;
  v_status text;
  v_frozen timestamptz;
  v_rel    timestamptz;
  v_rel_ok boolean;
  v_still  jsonb := '[]'::jsonb;
begin
  -- Only Gjemsel gets past here (0004's view already carries the variant: no extra query for other modes).
  if v_out -> 'tag' ->> 'variant' is distinct from 'hide' then
    return v_out;
  end if;
  select p.role, s.status, s.frozen_at, (r.state -> 'hide' ->> 'release_at')::timestamptz
    into v_role, v_status, v_frozen, v_rel
    from chase.players p join chase.sessions s on s.id = p.session_id
    left join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where p.id = p_player;
  v_rel_ok := chase._hide_released(v_rel, coalesce(v_frozen, now()));

  -- Hider: points per full minute hidden after the release (own clock; 0004's +1/5 s is off).
  if v_status = 'live' and v_role = 'prey' and v_frozen is null and v_rel_ok then
    update chase.player_stats
       set points = points + chase._hide_points(extract(epoch from now() - hs_since)) - hs_pts,
           round_points = round_points + chase._hide_points(extract(epoch from now() - hs_since)) - hs_pts,
           hs_pts = chase._hide_points(extract(epoch from now() - hs_since))
     where player_id = p_player and hs_since is not null and hs_since <= now()
       and chase._hide_points(extract(epoch from now() - hs_since)) > hs_pts;
  end if;

  -- Hunter: no «Bytte i nærheten» (the tools are the help); the plings of long-standing hiders after the release.
  if v_role = 'hunter' and v_status in ('live', 'paused') and jsonb_typeof(v_out -> 'tag') = 'object' then
    v_out := jsonb_set(v_out, '{tag,prey_near}', '0'::jsonb);
    if v_rel_ok and p_pos is not null then
      select coalesce(jsonb_agg(jsonb_build_object('id', c.pid, 'pos', chase._latlng(c.centre), 'r_m', chase.kv('still_r_m')::int,
                                                   'age_s', c.age_s) order by c.d), '[]'::jsonb)
        into v_still
        from (select left(md5(l.player_id::text || l.still_since::text), 8) as pid,
                     ST_Project(l.still_anchor, x.o[2], radians(x.o[1]))::geography as centre,
                     floor(extract(epoch from now() - l.still_since) - chase.kv('still_s'))::int as age_s,
                     ST_Distance(l.still_anchor, p_pos) as d
                from chase.player_live l join chase.players q on q.id = l.player_id
                cross join lateral (select chase._hide_offset(l.player_id::text || l.still_since::text) as o) x
               where l.session_id = p_session and q.role = 'prey' and q.status = 'active'
                 and l.still_anchor is not null and l.still_since is not null
                 and l.still_since <= now() - make_interval(secs => chase.kv('still_s'))
                 and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
               order by ST_Distance(l.still_anchor, p_pos)
               limit chase.kv('still_max')::int) c;
    end if;
  end if;
  if jsonb_typeof(v_out -> 'tag') = 'object' then
    v_out := jsonb_set(v_out, '{tag,hide}', jsonb_build_object(
      'release_at', v_rel, 'released', v_rel_ok, 'cooldown_s', chase.kv('cooldown_s')::int)
      || case when v_role = 'hunter' then jsonb_build_object('still', v_still) else '{}'::jsonb end);
  end if;
  return v_out;
end;
$$;

-- Round view: + the head start and the release time (all clients; release_at only while live/paused).
create or replace function chase._round_view(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when q.b is null then null else q.b || jsonb_build_object(
    'hide', case when s.plan -> 'rounds' -> s.round_idx ->> 'variant' = 'hide' then jsonb_build_object(
        'head_start_s', coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'head_start_s')::int, chase.kv('head_default_s')::int),
        'release_at', (select r.state -> 'hide' -> 'release_at' from chase.rounds r
                        where r.session_id = s.id and r.idx = s.round_idx and s.status in ('live', 'paused')),
        'cooldown_s', chase.kv('cooldown_s')::int) end) end
    from (select chase._round_view_hs(s) as b) q;
$$;

-- Pause does not count as head start or hiding time (rule 6).
create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_f timestamptz;
begin
  select s.frozen_at into v_f from chase.sessions s where s.id = p_session;
  perform chase._unfreeze_hs(p_session);
  if v_f is not null then
    update chase.rounds r
       set state = jsonb_set(r.state, '{hide,release_at}', to_jsonb((r.state -> 'hide' ->> 'release_at')::timestamptz + (now() - v_f)))
      from chase.sessions s
     where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx and s.round_idx >= 0
       and (r.state -> 'hide' ->> 'release_at')::timestamptz > v_f;
    update chase.player_stats set hs_since = hs_since + (now() - v_f)
     where session_id = p_session and hs_since is not null;
  end if;
end;
$$;

-- No automatic events in Gjemsel (sprint/gathering/role storm would break the hiding).
create or replace function chase._ev_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if chase._is_hide(p_session) then
    return;
  end if;
  perform chase._ev_upkeep_hs(p_session);
end;
$$;

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
begin
  if p_action = 'event_start'
     and exists (select 1 from chase.sessions s where s.id = p_session and s.host_token_hash = p_host_token_hash and s.status in ('live', 'paused'))
     and chase._is_hide(p_session) then
    return jsonb_build_object('ok', false, 'error', 'hide');
  end if;
  return chase._host_action_hs(p_session, p_host_token_hash, p_action, p_payload);
end;
$$;

-- The radar power-up (0007, kept from an earlier round) shows every opponent's exact position for a few seconds:
-- not in Gjemsel, where the hiders are invisible. Other power-ups are untouched.
create or replace function chase.use_powerup(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_kind       text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
begin
  if p_kind = 'radar' and chase._is_hide(p_session)
     and exists (select 1 from chase.players p where p.id = p_player and p.token_hash = p_token_hash and p.session_id = p_session) then
    return jsonb_build_object('ok', false, 'error', 'not_useful');
  end if;
  return chase._use_powerup_hs(p_player, p_token_hash, p_session, p_kind);
end;
$$;

-- ───────────────────────── catch: not before the release ─────────────────────────

create or replace function chase.catch(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_code       text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_rel timestamptz;
  v_r   jsonb;
  v_prey uuid;
begin
  -- Hunters wait for the release (live clock, rule 6): 'not_yet' before it.
  select (r.state -> 'hide' ->> 'release_at')::timestamptz into v_rel
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.status = 'live' and s.frozen_at is null and s.round_idx >= 0
     and s.plan -> 'rounds' -> s.round_idx ->> 'variant' = 'hide'
     and exists (select 1 from chase.players p where p.id = p_player and p.token_hash = p_token_hash and p.session_id = p_session and p.role = 'hunter');
  if v_rel is not null and not chase._hide_released(v_rel, now()) then
    return jsonb_build_object('ok', false, 'error', 'not_yet');
  end if;
  v_r := chase._catch_hide(p_player, p_token_hash, p_session, p_code);
  if coalesce((v_r ->> 'ok')::boolean, false) and v_rel is not null then
    -- The caught hider's time undiscovered counts for «Mestergjemmer»; the points earned so far stay.
    v_prey := (v_r ->> 'prey_id')::uuid;
    update chase.player_stats
       set hide_best_s = greatest(hide_best_s, floor(greatest(0, extract(epoch from now() - hs_since)))::int), hs_since = null, hs_pts = 0
     where player_id = v_prey and hs_since is not null;
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── Snus / Termometer in Gjemsel ─────────────────────────
-- 0017's use_hotcold in full + Gjemsel: hunters only, not before the release, 30 s cooldown.

create or replace function chase.use_hotcold(
  p_player     uuid,
  p_token_hash text,
  p_session    uuid,
  p_kind       text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_p      chase.players;
  v_s      chase.sessions;
  v_l      chase.player_live;
  v_mode   text;
  v_hide   boolean;
  v_rel    timestamptz;
  v_cool   real := chase.kh('cooldown_s');
  v_err    text;
  v_ev     jsonb;
  v_want   text;
  v_tpos   geography;
  v_d_now  double precision;
  v_d_then double precision;
  v_left   double precision;
  v_ans    jsonb;
begin
  select * into v_p from chase.players where id = p_player and token_hash = p_token_hash for update;
  if v_p.id is null or v_p.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  if v_p.session_id <> p_session then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  perform chase._advance(p_session);
  select * into v_s from chase.sessions where id = p_session;
  select * into v_p from chase.players where id = p_player;
  if v_s.status <> 'live' or v_s.frozen_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_now');
  end if;
  v_mode := v_s.plan -> 'rounds' -> v_s.round_idx ->> 'mode';
  v_err := chase._hc_check(p_kind, v_mode, v_p.role);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  -- Gjemsel: only hunters search, and only after the release.
  v_hide := v_mode = 'tag' and v_s.plan -> 'rounds' -> v_s.round_idx ->> 'variant' = 'hide';
  if v_hide then
    if v_p.role <> 'hunter' then
      return jsonb_build_object('ok', false, 'error', 'not_useful');
    end if;
    select (r.state -> 'hide' ->> 'release_at')::timestamptz into v_rel
      from chase.rounds r where r.session_id = p_session and r.idx = v_s.round_idx;
    if not chase._hide_released(v_rel, now()) then
      return jsonb_build_object('ok', false, 'error', 'not_yet');
    end if;
    v_cool := chase.kv('cooldown_s');
  end if;
  -- Blackout (0007) slår av jegernes radar; da gir ikke dette verktøyet den tilbake.
  v_ev := chase._ev_of(p_session);
  if v_p.role = 'hunter' and v_ev ->> 'kind' = 'blackout' and not coalesce((v_ev ->> 'done')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'blackout');
  end if;

  select * into v_l from chase.player_live where player_id = p_player;
  if v_l.player_id is null or v_l.fix_at < now() - make_interval(secs => chase.kh('fresh_s')) then
    return jsonb_build_object('ok', false, 'error', 'no_fix');
  end if;
  if v_l.acc > chase.kg('claim_max_acc_m') then
    return jsonb_build_object('ok', false, 'error', 'bad_acc');
  end if;
  v_left := v_cool - extract(epoch from now() - v_l.hc_used_at);
  if v_l.hc_used_at is not null and v_left > 0 then
    return jsonb_build_object('ok', false, 'error', 'cooldown', 'wait_s', ceil(v_left)::int);
  end if;

  -- Målet: nærmeste aktive spiller med motsatt rolle og fersk posisjon.
  v_want := case when v_p.role = 'hunter' then 'prey' else 'hunter' end;
  select l.pos into v_tpos
    from chase.players q join chase.player_live l on l.player_id = q.id
   where q.session_id = p_session and q.status = 'active' and q.role = v_want and q.id <> p_player
     and l.fix_at > now() - make_interval(secs => chase.kh('fresh_s'))
     and l.acc <= chase.kg('claim_max_acc_m')
   order by ST_Distance(l.pos, v_l.pos), q.id
   limit 1;
  if v_tpos is null then
    return jsonb_build_object('ok', false, 'error', 'no_target');
  end if;
  v_d_now := ST_Distance(v_l.pos, v_tpos);

  if p_kind = 'sniff' then
    v_ans := jsonb_build_object('near', chase._sniff_answer(v_d_now), 'range_m', chase.kh('sniff_m')::int);
  else
    if v_l.hc_prev_pos is null or v_l.hc_prev_at is null
       or now() - v_l.hc_prev_at < make_interval(secs => chase.kh('thermo_min_s'))
       or now() - v_l.hc_prev_at > make_interval(secs => chase.kh('thermo_max_s')) then
      return jsonb_build_object('ok', false, 'error', 'no_baseline');
    end if;
    v_d_then := ST_Distance(v_l.hc_prev_pos, v_tpos);
    v_ans := jsonb_build_object('trend', chase._thermo_answer(v_d_then, v_d_now, v_l.acc));
  end if;

  update chase.player_live set hc_used_at = now() where player_id = p_player;
  insert into chase.events (session_id, type, actor_player_id, payload)
  values (p_session, 'hotcold', p_player, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('ok', true, 'kind', p_kind, 'cooldown_s', v_cool::int) || v_ans;
end;
$$;

-- ───────────────────────── ceremony: «Mestergjemmer» ─────────────────────────
-- 0020's _team_ceremony + the hide podium (in the order: Mestergjemmer, Orienterer, Flest riktige, Lagspiller, Flest poeng).

create or replace function chase._team_ceremony(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  update chase.sessions s set podiums = chase._team_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'n', t.n, 'points', t.points)), '[]'::jsonb)
       from chase.teams t where t.session_id = p_session and t.n is not null),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'teamplay', st.team_acts + st.assists)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee' and p.team_id is not null))
   where s.id = p_session;
  update chase.sessions s set podiums = chase._quiz_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'quiz', st.quiz_right)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee'))
   where s.id = p_session;
  update chase.sessions s set podiums = chase._scoreo_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'so', st.so_pts)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee'))
   where s.id = p_session;
  update chase.sessions s set podiums = chase._hide_podiums(s.podiums,
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'hide', st.hide_best_s)), '[]'::jsonb)
       from chase.players p join chase.player_stats st on st.player_id = p.id
      where p.session_id = p_session and p.status = 'active' and p.role <> 'referee'))
   where s.id = p_session;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;

notify pgrst, 'reload schema';
