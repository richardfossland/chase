-- Chase — 0024 — Live-belønning (fase 12, PLAN § 13): det skal lønne seg å ha skjermen åpen.
--
-- Bakgrunn: nettleseren stopper GPS og JS når en iPhone låses. Dagens regler belønner det: poengene
-- (Smittejakt +1/5 s, Gjemsel 10/min) går etter veggklokka og betales i ettertid ved neste tick, en låst telefon
-- blir usynlig etter 20 s (pling, «Bytte i nærheten», radar krever fix_fresh_s), og overlevelsesbonusen går
-- også til den som har låst skjermen. Nå:
--
--   * LIVE-REKKE: lv_acc_s teller sammenhengende live-tid (tick med < gap_s mellom). ×1 → ×1,25 (t1_s = 2 min)
--     → ×1,5 (t2_s = 4 min). Rekka ryker (nullstilles) når det går mer enn gap_s (20 s) mellom to tick i en aktiv
--     runde. Pauser teller ikke: i lobby, nedtelling, pustepause, pause, samling og prøverunde er rekka fryst,
--     og _mode_begin / _unfreeze setter lv_at = now() så avstanden regnes fra rundestart / fortsettelse.
--   * BARE LIVE-TID TELLER for tidspoeng: ved gap > gap_s flyttes current_survival_start og hs_since fram med
--     den stille tida (samme grep som pause: 0004 _unfreeze, 0023 _unfreeze), så 0004/0023 betaler bare live-tid.
--   * MULTIPLIKATOR: etter den indre _mode_tick er delta = points − lv_base; bonus = floor(delta·(mult−1) + lv_frac),
--     resten går til lv_frac. Bonusen legges på points og round_points, så settes lv_base = points. Lærerens
--     poengjustering (adjust_points) flytter lv_base like mye (host_action-wrapper), så den ikke ganges opp.
--     Poeng som gis utenfor tick (rundeslutt, lagpoeng) absorberes i lv_base av _mode_begin/_mode_finish.
--   * AVSLØRT: i Smittejakt og Gjemsel ser jegerne `tag.revealed` = [{id, pos, age_s}] for byttene som ikke har
--     ticket på ≥ reveal_s (20 s) i en aktiv runde (Gjemsel: bare etter slipp). Eksakt siste posisjon erstatter
--     plinget for den spilleren. id = samme saltede hash som plinget.
--   * hunter_close: bytter/gjemmere får `tag.hunter_close` = jeger ≤ close_m (30 m), i tillegg til hunter_near (60 m).
--   * OVERLEVELSESBONUS BARE TIL LIVE (valg): convert +25 og Gjemsel survivor_pts gis av de indre lagene til alle
--     overlevende; _mode_finish-wrapperen leser før det hvilke bytter som IKKE er live ved rundeslutt
--     (lv_at < p_at − gap_s) og trekker bonusen (og 'survivor'-merket) fra dem igjen. Valgt framfor å gi selv, fordi
--     de indre funksjonene (0004, 0023) da ikke trenger å røres.
--   * LYNPOST (Postjakt): omtrent hvert flash_every_s (90 ± 20 s) lages én post `kind = 'flash'` (flash_pts 25 p,
--     flash_ttl_s 30 s) 30–90 m fra en tilfeldig live spiller, innenfor området og utenfor sperrede soner.
--     `hint_all` som for gullposten, så live-telefoner varsles; låste telefoner får det ikke. Klaim som vanlige poster.
--     Tick-svarets `posts[]` har allerede `kind` og `expires_at`; flat tick er IKKE rørt, så `flash: true` finnes
--     ikke: klienten leser `kind === 'flash'`.
--   * LAGBONUS (Flaggjakt/Kongen): +team_bonus (25 %) på lagets poeng fra flagg-hold/haug mens ALLE aktive
--     lagmedlemmer har fix ≤ gap_s. At bare live spillere tar/holder post er allerede sant via _team_in (fix_fresh_s).
--   * 🔒: chase.mark_away(session, token_hash) setter player_live.away_at. host_snapshot_svc og den nye
--     host_snapshot_away legger `away` og `away_s` per spiller på snapshotet (host_snapshot selv er uendret).
--
-- Sikkerhet (regel 4): geofence-, SOS- og signaltapvarsler er IKKE rørt (signaltap reises fortsatt etter 60 s).
-- Personvern (regel 3): ingen ny posisjonskolonne; lv_at/lv_acc_s/away_at/lv_base/lv_frac/best_streak_s er tider og
-- tall. `revealed` leser player_live.pos (finnes fra før) bare ved visning for jegere, og lagrer ingenting.
--
-- Additiv: kolonner har standardverdi; gammel Worker mot ny DB ser bare ekstra nøkler (`live`, `tag.revealed`,
-- `tag.hunter_close`). tick/host_snapshot (flate, 0018) er IKKE rørt. Guardede rename-wrappere (kjøres to ganger i
-- test-db.sh): _mode_begin, _mode_finish, _mode_upkeep_team, _mode_tick, _unfreeze, host_action, _posts_upkeep.
-- Låserekkefølge: ingen nye låser. Tick-grenen rører bare egen player_live/player_stats-rad (som før); finish/upkeep
-- kjører under øktlåsen og alle spillerrader (ADR-025); lagoppdateringer i n-rekkefølge.

set search_path = chase, extensions, public;
set local lock_timeout = '3s';   -- ALTER TABLE takes ACCESS EXCLUSIVE: never queue the ticks behind it for long

-- ───────────────────────── schema ─────────────────────────

alter table chase.player_live  add column if not exists lv_at       timestamptz;
alter table chase.player_live  add column if not exists lv_acc_s    double precision not null default 0;
alter table chase.player_live  add column if not exists away_at     timestamptz;
alter table chase.player_stats add column if not exists lv_base         int not null default 0;
alter table chase.player_stats add column if not exists lv_frac         numeric not null default 0;
alter table chase.player_stats add column if not exists best_streak_s   int not null default 0;
alter table chase.teams        add column if not exists lv_base         int not null default 0;
alter table chase.teams        add column if not exists lv_frac         numeric not null default 0;

-- posts.kind gets 'flash'. The constraint is anonymous (0001), so find it by definition.
do $$
declare
  v_c text;
begin
  select conname into v_c from pg_constraint
   where conrelid = 'chase.posts'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%kind%' and pg_get_constraintdef(oid) like '%sprint%'
     and pg_get_constraintdef(oid) not like '%flash%';
  if v_c is not null then
    execute format('alter table chase.posts drop constraint %I', v_c);
    alter table chase.posts add constraint posts_kind_check
      check (kind in ('normal', 'golden', 'physical_qr', 'sprint', 'flash'));
  end if;
end $$;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/live.ts (test/live.test.ts diffs them).

create or replace function chase.klv(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'gap_s'          then 20    -- no tick for longer than this = the streak breaks (and the silent time does not count)
    when 't1_s'           then 120   -- streak this long: ×m1
    when 'm1'             then 1.25
    when 't2_s'           then 240   -- streak this long: ×m2
    when 'm2'             then 1.5
    when 'reveal_s'       then 20    -- hunters see a prey that has not ticked this long (active round)
    when 'close_m'        then 30    -- «Jeger veldig nær» for prey
    when 'flash_every_s'  then 90    -- lightning post: about this often …
    when 'flash_jitter_s' then 20    -- … ± this
    when 'flash_ttl_s'    then 30
    when 'flash_pts'      then 25
    when 'flash_min_m'    then 30    -- … placed this far from a random live player …
    when 'flash_max_m'    then 90    -- … to this far
    when 'team_bonus'     then 0.25  -- team points from flags/hill ×1.25 while the whole team is live
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/live.ts) ─────────────────────────

-- Multiplier for a streak of p_acc seconds.
create or replace function chase._live_mult(p_acc double precision)
returns numeric
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when coalesce(p_acc, 0) >= chase.klv('t2_s') then chase.klv('m2')::numeric
              when coalesce(p_acc, 0) >= chase.klv('t1_s') then chase.klv('m1')::numeric
              else 1::numeric end;
$$;

-- Seconds to the next step (null at the top).
create or replace function chase._live_next_s(p_acc double precision)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when coalesce(p_acc, 0) >= chase.klv('t2_s') then null
              when coalesce(p_acc, 0) >= chase.klv('t1_s') then ceil(chase.klv('t2_s') - p_acc)::int
              else ceil(chase.klv('t1_s') - greatest(coalesce(p_acc, 0), 0))::int end;
$$;

-- Bonus on p_delta points at p_mult with the carried fraction: [whole bonus, new fraction].
-- A negative delta (points taken away) earns nothing and carries the fraction unchanged.
create or replace function chase._live_bonus(p_delta int, p_mult numeric, p_frac numeric)
returns numeric[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when coalesce(p_delta, 0) <= 0 then array[0::numeric, coalesce(p_frac, 0)]
              else array[floor(x), x - floor(x)] end
    from (select p_delta * (p_mult - 1) + coalesce(p_frac, 0) as x) q;
$$;

-- ───────────────────────── wrappers: renames ─────────────────────────

do $$
begin
  if to_regprocedure('chase._mode_begin_lv(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _mode_begin_lv;
  end if;
  if to_regprocedure('chase._mode_finish_lv(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _mode_finish_lv;
  end if;
  if to_regprocedure('chase._mode_upkeep_lv(uuid)') is null then
    alter function chase._mode_upkeep_team(uuid) rename to _mode_upkeep_lv;
  end if;
  if to_regprocedure('chase._mode_tick_lv(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_lv;
  end if;
  if to_regprocedure('chase._unfreeze_lv(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_lv;
  end if;
  if to_regprocedure('chase._host_action_lv(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_lv;
  end if;
  if to_regprocedure('chase._posts_upkeep_lv(uuid,integer)') is null then
    alter function chase._posts_upkeep(uuid, int) rename to _posts_upkeep_lv;
  end if;
end $$;

-- ───────────────────────── round start: the distance is measured from here ─────────────────────────

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_begin_lv(p_session, p_at);
  -- The streak is kept (frozen between rounds), but the distance to the last tick counts from now.
  update chase.player_live set lv_at = now() where session_id = p_session;
  -- Points given between rounds are not multiplied.
  update chase.player_stats set lv_base = points, lv_frac = 0
   where session_id = p_session and (lv_base <> points or lv_frac <> 0);
  update chase.teams set lv_base = points, lv_frac = 0
   where session_id = p_session and (lv_base <> points or lv_frac <> 0);
end;
$$;

-- ───────────────────────── round end: bonus for the live only ─────────────────────────

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_snap jsonb := '{}'::jsonb;
  v_pts  int := chase.kt('survivor_pts')::int;
begin
  -- Hiders/prey that are NOT live at the end: remember what they have, so the survivor bonus can be taken back.
  if chase._round_mode(p_session) ->> 'mode' = 'tag' then
    select coalesce(jsonb_object_agg(st.player_id::text, jsonb_build_object(
             'p', st.points, 'rp', st.round_points, 'sv', 'survivor' = any(st.badges), 'rsv', 'survivor' = any(st.round_badges))), '{}'::jsonb)
      into v_snap
      from chase.players p
      join chase.player_stats st on st.player_id = p.id
      left join chase.player_live l on l.player_id = p.id
     where p.session_id = p_session and p.role = 'prey' and p.status = 'active'
       and (l.lv_at is null or l.lv_at < p_at - make_interval(secs => chase.klv('gap_s')));
  end if;

  perform chase._mode_finish_lv(p_session, p_at);

  if v_snap <> '{}'::jsonb then
    update chase.player_stats st
       set points = st.points - v_pts,
           round_points = st.round_points - least(v_pts, greatest(st.round_points - (e.value ->> 'rp')::int, 0)),
           badges = case when not (e.value ->> 'sv')::boolean then array_remove(st.badges, 'survivor') else st.badges end,
           round_badges = case when not (e.value ->> 'rsv')::boolean then array_remove(st.round_badges, 'survivor') else st.round_badges end
      from jsonb_each(v_snap) e
     where st.player_id = e.key::uuid and st.points - (e.value ->> 'p')::int >= v_pts;
  end if;

  -- The longest streak of the round, then everything given so far is the new base (nothing is multiplied afterwards).
  update chase.player_stats st
     set best_streak_s = greatest(st.best_streak_s, floor(l.lv_acc_s)::int)
    from chase.player_live l
   where l.player_id = st.player_id and st.session_id = p_session and floor(l.lv_acc_s)::int > st.best_streak_s;
  update chase.player_stats set lv_base = points, lv_frac = 0
   where session_id = p_session and (lv_base <> points or lv_frac <> 0);
  update chase.teams set lv_base = points, lv_frac = 0
   where session_id = p_session and (lv_base <> points or lv_frac <> 0);
end;
$$;

-- ───────────────────────── pause: the streak and the distance are frozen ─────────────────────────

create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_f timestamptz;
begin
  select s.frozen_at into v_f from chase.sessions s where s.id = p_session;
  perform chase._unfreeze_lv(p_session);
  if v_f is not null then
    update chase.player_live set lv_at = now() where session_id = p_session;
    update chase.rounds r
       set state = jsonb_set(r.state, '{flash_at}', to_jsonb((r.state ->> 'flash_at')::timestamptz + (now() - v_f)))
      from chase.sessions s
     where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx and s.round_idx >= 0 and r.state ? 'flash_at';
  end if;
end;
$$;

-- ───────────────────────── teacher adjustments are not multiplied ─────────────────────────

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
  v_t      uuid;
  v_before int;
  v_after  int;
  v_r      jsonb;
begin
  if p_action <> 'adjust_points' then
    return chase._host_action_lv(p_session, p_host_token_hash, p_action, p_payload);
  end if;
  begin
    v_t := (p_payload ->> 'player_id')::uuid;
  exception when others then
    v_t := null;
  end;
  select st.points into v_before from chase.player_stats st
   where st.player_id = v_t and st.session_id = p_session;
  v_r := chase._host_action_lv(p_session, p_host_token_hash, p_action, p_payload);
  if coalesce((v_r ->> 'ok')::boolean, false) and v_before is not null then
    select st.points into v_after from chase.player_stats st where st.player_id = v_t;
    -- Same shift in the base: the adjustment itself is never multiplied.
    update chase.player_stats set lv_base = lv_base + (v_after - v_before) where player_id = v_t and v_after <> v_before;
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── per-tick: live accounting, multiplier, reveal ─────────────────────────

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_role    text;
  v_status  text;
  v_frozen  timestamptz;
  v_idx     int;
  v_salt    text;
  v_prac    boolean;
  v_lv_at   timestamptz;
  v_acc     double precision;
  v_base    int;
  v_frac    numeric;
  v_pts     int;
  v_active  boolean;
  v_gap     double precision;
  v_mult    numeric;
  v_b       numeric[];
  v_out     jsonb;
  v_rev     jsonb;
  v_ids     text[];
begin
  select p.role, s.status, s.frozen_at, s.round_idx, s.host_token_hash,
         coalesce((s.plan -> 'rounds' -> greatest(s.round_idx, 0) ->> 'practice') = 'true', false),
         l.lv_at, coalesce(l.lv_acc_s, 0), coalesce(st.lv_base, 0), coalesce(st.lv_frac, 0), coalesce(st.points, 0)
    into v_role, v_status, v_frozen, v_idx, v_salt, v_prac, v_lv_at, v_acc, v_base, v_frac, v_pts
    from chase.players p
    join chase.sessions s on s.id = p.session_id
    left join chase.player_live l on l.player_id = p.id
    left join chase.player_stats st on st.player_id = p.id
   where p.id = p_player;

  v_active := v_status = 'live' and v_frozen is null and v_idx >= 0 and not v_prac
              and v_role not in ('sitting_out', 'referee');

  if v_active then
    v_gap := case when v_lv_at is null then null else extract(epoch from now() - v_lv_at) end;
    if v_gap is null or v_gap > chase.klv('gap_s') then
      -- The streak breaks. Silent time does not count: the clocks that pay by the wall clock move forward by the
      -- part of the silence they were running in (never past now()).
      if v_lv_at is not null then
        update chase.player_stats
           set current_survival_start = case when current_survival_start < now()
                 then current_survival_start + (now() - greatest(current_survival_start, v_lv_at)) else current_survival_start end,
               hs_since = case when hs_since < now()
                 then hs_since + (now() - greatest(hs_since, v_lv_at)) else hs_since end,
               best_streak_s = greatest(best_streak_s, floor(v_acc)::int)
         where player_id = p_player;
      end if;
      v_acc := 0;
    else
      v_acc := v_acc + v_gap;
    end if;
    update chase.player_live set lv_at = now(), lv_acc_s = v_acc where player_id = p_player;
  elsif not v_prac and v_pts <> v_base and v_status not in ('ceremony', 'ended') then
    -- Points given outside an active round (teacher, round end) are not multiplied later.
    update chase.player_stats set lv_base = points, lv_frac = 0 where player_id = p_player;
  end if;

  v_out := coalesce(chase._mode_tick_lv(p_player, p_session, p_pos), '{}'::jsonb);

  v_mult := chase._live_mult(v_acc);
  if v_active then
    select st.points into v_pts from chase.player_stats st where st.player_id = p_player;
    if v_pts <> v_base then
      v_b := chase._live_bonus(v_pts - v_base, v_mult, v_frac);
      update chase.player_stats
         set points = points + v_b[1]::int, round_points = round_points + v_b[1]::int,
             lv_base = points + v_b[1]::int, lv_frac = v_b[2]
       where player_id = p_player;
    end if;
  end if;

  v_out := v_out || jsonb_build_object('live', jsonb_build_object(
    'on', v_active,
    'mult', v_mult,
    'streak_s', floor(v_acc)::int,
    'next_s', chase._live_next_s(v_acc),
    'frozen', v_status in ('paused', 'breather', 'gathering') or (v_status = 'live' and v_frozen is not null)));

  if jsonb_typeof(v_out -> 'tag') is distinct from 'object' then
    return v_out;
  end if;

  -- Prey: «Jeger veldig nær» (only worth a look when hunter_near already says a hunter is within 60 m).
  if v_role = 'prey' and v_status in ('live', 'paused') then
    v_out := jsonb_set(v_out, '{tag,hunter_close}', to_jsonb(
      coalesce((v_out -> 'tag' ->> 'hunter_near')::boolean, false) and p_pos is not null and exists (
        select 1 from chase.player_live l join chase.players p on p.id = l.player_id
         where l.session_id = p_session and p.role = 'hunter' and p.status = 'active'
           and l.fix_at > now() - make_interval(secs => chase.kt('fix_fresh_s'))
           and ST_DWithin(l.pos, p_pos, chase.klv('close_m')))));
  end if;

  -- Hunter: prey that has not ticked for reveal_s in an active round (Gjemsel: after the release).
  if v_role = 'hunter' and v_status in ('live', 'paused') then
    v_rev := '[]'::jsonb;
    if v_active and (v_out -> 'tag' ->> 'variant' is distinct from 'hide'
                     or coalesce((v_out -> 'tag' -> 'hide' ->> 'released')::boolean, false)) then
      select coalesce(jsonb_agg(jsonb_build_object('id', c.pid, 'pos', chase._latlng(c.pos), 'age_s', c.age_s)
                                order by c.age_s desc, c.pid), '[]'::jsonb),
             array_agg(c.pid)
        into v_rev, v_ids
        from (select left(md5('pling-id:' || l.player_id::text || ':' || v_idx::text || ':' || v_salt), 8) as pid,
                     l.pos, floor(extract(epoch from now() - l.lv_at))::int as age_s
                from chase.player_live l join chase.players q on q.id = l.player_id
               where l.session_id = p_session and q.role = 'prey' and q.status = 'active'
                 and l.pos is not null and l.lv_at < now() - make_interval(secs => chase.klv('reveal_s'))
               order by l.lv_at, l.player_id
               limit 25) c;
      -- The exact last position replaces the pling for that player.
      if v_ids is not null and jsonb_typeof(v_out -> 'tag' -> 'hide' -> 'still') = 'array' then
        v_out := jsonb_set(v_out, '{tag,hide,still}', coalesce((
          select jsonb_agg(e order by o) from jsonb_array_elements(v_out -> 'tag' -> 'hide' -> 'still') with ordinality t(e, o)
           where not (e ->> 'id') = any(v_ids)), '[]'::jsonb));
      end if;
    end if;
    v_out := jsonb_set(v_out, '{tag,revealed}', v_rev);
  end if;
  return v_out;
end;
$$;

-- ───────────────────────── lightning posts (Postjakt) ─────────────────────────

-- One lightning post 30–90 m from a random live player, inside the area (as _spawn_post, 0003) and away from
-- forbidden zones and other open posts. Null when no spot was found (the caller tries again shortly).
create or replace function chase._spawn_flash(p_session uuid, p_round int)
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  v_area geometry;
  v_o    geography;
  v_pt   geography;
  v_id   uuid;
begin
  select * into s from chase.sessions where id = p_session;
  v_area := ST_Buffer(s.boundary, -chase.kg('post_edge_m'))::geometry;
  if s.forbidden is not null and v_area is not null and not ST_IsEmpty(v_area) then
    v_area := ST_Difference(v_area, ST_Buffer(s.forbidden, chase.kg('post_forbidden_m'))::geometry);
  end if;
  if v_area is null or ST_IsEmpty(v_area) or ST_Area(v_area::geography) < 50 then
    v_area := s.boundary::geometry;
    if s.forbidden is not null then
      v_area := ST_Difference(v_area, s.forbidden::geometry);
    end if;
  end if;
  if v_area is null or ST_IsEmpty(v_area) then
    return null;
  end if;
  for i in 1 .. 25 loop
    select l.pos into v_o
      from chase.player_live l join chase.players p on p.id = l.player_id
     where l.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out')
       and l.fix_at > now() - make_interval(secs => chase.klv('gap_s')) and l.pos is not null
     order by random() limit 1;
    exit when v_o is null;
    v_pt := ST_Project(v_o, chase.klv('flash_min_m') + random() * (chase.klv('flash_max_m') - chase.klv('flash_min_m')),
                       radians(random() * 360))::geography;
    continue when not ST_Covers(v_area, v_pt::geometry);
    continue when exists (select 1 from chase.posts o
                           where o.session_id = p_session and o.round_idx = p_round and o.claimed_by is null
                             and (o.expires_at is null or o.expires_at > now())
                             and ST_DWithin(o.pos, v_pt, chase.kg('post_min_post_m')));
    insert into chase.posts (session_id, round_idx, pos, radius_m, value, kind, expires_at)
    values (p_session, p_round, v_pt, chase.kg('claim_radius_m'), chase.klv('flash_pts')::int, 'flash',
            now() + make_interval(secs => chase.klv('flash_ttl_s')))
    returning id into v_id;
    return v_id;
  end loop;
  return null;
end;
$$;

-- Caller holds the session lock (_advance). Returns true when the golden OR a lightning post appeared (hint_all).
create or replace function chase._posts_upkeep(p_session uuid, p_max int default 3)
returns boolean
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_hint  boolean;
  v_idx   int;
  v_state jsonb;
  v_at    timestamptz;
  v_left  double precision;
  v_id    uuid;
begin
  v_hint := chase._posts_upkeep_lv(p_session, p_max);
  select r.idx, r.state, extract(epoch from s.phase_ends_at - now())
    into v_idx, v_state, v_left
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.status = 'live' and s.frozen_at is null and s.round_idx >= 0
     and r.mode = 'posts' and r.ended_at is null
     and coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'practice') = 'true', false) = false;
  if v_idx is null then
    return v_hint;
  end if;
  if not v_state ? 'flash_at' then
    update chase.rounds set state = state || jsonb_build_object('flash_at',
             now() + make_interval(secs => chase.klv('flash_every_s') + (random() * 2 - 1) * chase.klv('flash_jitter_s')))
     where session_id = p_session and idx = v_idx;
    return v_hint;
  end if;
  v_at := (v_state ->> 'flash_at')::timestamptz;
  if now() < v_at then
    return v_hint;
  end if;
  if coalesce(v_left, 0) < chase.klv('flash_ttl_s') then
    return v_hint;            -- too late in the round for a lightning post to be worth it
  end if;
  v_id := chase._spawn_flash(p_session, v_idx);
  update chase.rounds set state = state || jsonb_build_object('flash_at', case when v_id is null
           then now() + interval '10 seconds'
           else now() + make_interval(secs => chase.klv('flash_every_s') + (random() * 2 - 1) * chase.klv('flash_jitter_s')) end)
   where session_id = p_session and idx = v_idx;
  return v_hint or v_id is not null;
end;
$$;

-- ───────────────────────── team bonus (Flaggjakt / Kongen) ─────────────────────────

create or replace function chase._mode_upkeep_team(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_t   record;
  v_all boolean;
  v_b   numeric[];
begin
  perform chase._mode_upkeep_lv(p_session);
  if coalesce(chase._round_mode(p_session) ->> 'mode', '') not in ('flag', 'king')
     or not exists (select 1 from chase.sessions s where s.id = p_session and s.status = 'live' and s.frozen_at is null) then
    return;
  end if;
  for v_t in select t.id, t.points, t.lv_base, t.lv_frac from chase.teams t
              where t.session_id = p_session and t.n is not null and t.points <> t.lv_base
              order by t.n loop
    v_all := exists (select 1 from chase.players p where p.team_id = v_t.id and p.status = 'active'
                      and p.role not in ('referee', 'sitting_out'))
             and not exists (select 1 from chase.players p left join chase.player_live l on l.player_id = p.id
                              where p.team_id = v_t.id and p.status = 'active' and p.role not in ('referee', 'sitting_out')
                                and (l.fix_at is null or l.fix_at <= now() - make_interval(secs => chase.klv('gap_s'))));
    if v_all then
      v_b := chase._live_bonus(v_t.points - v_t.lv_base, 1 + chase.klv('team_bonus')::numeric, v_t.lv_frac);
      update chase.teams set points = points + v_b[1]::int, lv_base = points + v_b[1]::int, lv_frac = v_b[2]
       where id = v_t.id;
    else
      update chase.teams set lv_base = points where id = v_t.id;      -- not everybody live: no bonus on this stretch
    end if;
  end loop;
end;
$$;

-- ───────────────────────── 🔒: the phone reported a hidden page ─────────────────────────

create or replace function chase.mark_away(p_session uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_id uuid;
begin
  select p.id into v_id from chase.players p
   where p.session_id = p_session and p.token_hash = p_token_hash and p.status = 'active';
  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  update chase.player_live set away_at = now() where player_id = v_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- `away` / `away_s` per player on a host snapshot (host_snapshot itself is unchanged). away = the phone said «hidden»
-- after its last fix; away_s = seconds since it said so.
create or replace function chase._snapshot_away(p_snap jsonb, p_session uuid)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when coalesce((p_snap ->> 'ok')::boolean, false) is not true or jsonb_typeof(p_snap -> 'players') is distinct from 'array'
              then p_snap
         else jsonb_set(p_snap, '{players}', coalesce((
           select jsonb_agg(t.e || jsonb_build_object(
                    'away', l.away_at is not null and (l.fix_at is null or l.away_at > l.fix_at),
                    'away_s', case when l.away_at is not null and (l.fix_at is null or l.away_at > l.fix_at)
                                   then floor(extract(epoch from now() - l.away_at))::int end)
                  order by t.o)
             from jsonb_array_elements(p_snap -> 'players') with ordinality t(e, o)
             left join chase.player_live l on l.player_id = (t.e ->> 'id')::uuid and l.session_id = p_session), '[]'::jsonb)) end;
$$;

-- For the HTTP snapshot route (host token hash, like host_snapshot).
create or replace function chase.host_snapshot_away(
  p_session         uuid,
  p_host_token_hash text,
  p_include_geo     boolean default false)
returns jsonb
language sql
security definer
set search_path = chase, extensions, public
as $$
  select chase._snapshot_away(chase.host_snapshot(p_session, p_host_token_hash, p_include_geo), p_session);
$$;

-- For the live room (Durable Object): 0014's service entry point + away.
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
  return chase._snapshot_away(chase.host_snapshot(p_session, v_hash, p_include_geo), p_session);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;

notify pgrst, 'reload schema';
