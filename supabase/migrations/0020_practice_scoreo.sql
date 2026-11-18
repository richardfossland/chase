-- Chase — 0020 — prøverunde og poengorientering (fase 10.7 + 10.8, PLAN § 13).
--
-- 10.7 Prøverunde. En runde i planen kan merkes `"practice": true` (bare Postjakt
--   og Smittejakt, uten sone og lag): `{"mode":"posts","duration_s":60,"practice":true}`.
--   Valget er et flagg på runden, ikke en egen modus: spilleflyten og alle de
--   eldre valideringslagene i _norm_plan er uendret, og runden spilles som den
--   modusen den er (eleven lærer de ekte knappene).
--     * Ingen poeng, merker eller statistikk: player_stats.practice settes ved
--       rundestart (_mode_begin) og fjernes ved rundeslutt (_mode_finish). En
--       BEFORE UPDATE-trigger (bare mens flagget er på, WHEN-klausul) lar KUN en
--       hviteliste endre seg: distanse, aktive sekunder, ruter og modusenes bokføring. Alle andre
--       kolonner (poeng, tellere, merker, power-ups, quiz-svar) er frosset, også nye poengkolonner.
--       Hendelser (_ev_upkeep, event_start, oppdrag) og justering av poeng er avslått i prøverunder.
--       Én trigger fanger alle poengkildene (flytting, post, QR, fangst, hendelser,
--       overlevelse) uten å kopiere de store funksjonene, og nye kilder blir med
--       automatisk. Ferske spillere (join midt i runden) får flagget av en INSERT-trigger.
--     * Distanse, aktive sekunder og ruter (cells) TELLER: det er bevegelsen
--       appen handler om, og de er ikke poeng. De viser likevel ikke på pallen som
--       «prøve»; de er vanlige distansetall.
--     * Poster i en prøverunde får verdi 0 (BEFORE INSERT-trigger på posts), så
--       klaimsvaret og postmarkøren sier 0 p.
--     * Prøverunden er aldri med i premieutdelingen: pallene leses fra de frosne
--       totalene. «Comeback» leser per_round, der prøverunden står med 0 p.
--   _round_view får `practice` (alle klienter) så elev og lærer kan vise merket.
--
-- 10.8 Poengorientering (score-O), ny modus `scoreo`.
--   * Postene står hele runden (ingen respawn). Antall: ks('so_posts') = 12, fordelt
--     over fire avstandsbånd fra møteplassen (rundt: 0,1,2,3,0,… med lengst-unna
--     innen båndet), minst ks('so_from_base_m') = 20 m fra møteplassen. Faste GPS-poster
--     fra biblioteket (0016, settings.fixed_posts, uten qr) brukes i stedet hvis det
--     er minst ks('so_fixed_min') = 3 av dem (bonus, ikke krav). Golden regnes som vanlig.
--   * Verdi = 10 × (bånd + 1), bånd = min(3, floor(4 × avstand / lengste avstand
--     fra møteplassen til områdekanten)): 10/20/30/40 (_so_value, TS-tvilling).
--   * Hver spiller kan klaime hver post én gang (post_claims har allerede
--     (post_id, player_id, round_idx) som nøkkel). Klaim som i Postjakt: innenfor
--     max(12 m, acc), fix ≤ 25 m, to påfølgende ticks. Posten forblir åpen for andre
--     (posts.claimed_by brukes ikke). Klaimen ligger i _mode_tick (_so_tick), så
--     tick er uendret; svaret ligger under nøkkelen `scoreo`.
--   * Tidsgrensen er rundens lengde (plan.duration_s). Rundefasen forlenges med
--     ks('so_return_s') = 120 s «innkomst»: limit_at = phase_ends_at − 120 s (ren funksjon
--     av tid, forlengelse og pause flytter begge; regel 6). Etter limit_at gir poster
--     ingenting; spilleren må være på møteplassen (nøyaktighet ≤ 50 m, innenfor
--     k('gather_radius_m') som ved innsjekk). Var spilleren der ved limit_at, er hen
--     i tide. For sent: −5 p per påbegynte 10 s (_so_pen), aldri mer enn rundens poeng
--     (ingen negative runder). Ikke innkommet innen fasen er slutt: trekk = alle
--     rundepoengene («maks trekk»). Ingen permanent utslagning (regel 5): poengene
--     er bare lavere i denne runden. Hopper læreren over runden før tidsgrensen,
--     trekkes ingen. Er alle inne etter tidsgrensen, avsluttes runden med en gang.
--   * Ny pall «Orienterer» (player_stats.so_pts = rundepoeng i score-O etter trekk)
--     rett før «Flest riktige» / «Lagspiller» / «Flest poeng» (_scoreo_podiums, via
--     _team_ceremony).
--   * Ingen automatiske hendelser og ingen sprint/samling i score-O (_ev_kinds),
--     for de trekker spillerne bort fra rutene eller samler dem på møteplassen.
--   * Personvern: so_home_since / so_arrived_at er tider uten posisjon; de nullstilles ved
--     rundeslutt og i _end_session (PLAN § 8).
--
-- Additiv: nye kolonner har standardverdi, og en gammel Worker mot ny DB ser bare en
-- ekstra nøkkel (`scoreo`, `practice`) i svarene.
--
-- Omdefinert/wrappet (guardede rename-wrappere fordi migrasjonen kjøres to ganger i
-- test-db.sh): _norm_plan, _mode_begin, _mode_finish, _mode_upkeep_team, _mode_tick,
-- _round_view, _end_session. Omdefinert i sin helhet: _ev_kinds, _team_ceremony.
-- tick og host_snapshot (flate etter 0018) er IKKE rørt.

set search_path = chase, extensions, public;

-- ───────────────────────── schema ─────────────────────────

alter table chase.rounds drop constraint if exists rounds_mode_check;
alter table chase.rounds add constraint rounds_mode_check
  check (mode in ('free', 'posts', 'tag', 'zone_only', 'teams', 'flag', 'king', 'relay', 'scoreo'));

alter table chase.player_stats add column if not exists practice      boolean     not null default false;
alter table chase.player_stats add column if not exists so_home_since timestamptz;
alter table chase.player_stats add column if not exists so_arrived_at timestamptz;
alter table chase.player_stats add column if not exists so_late_s     int;
alter table chase.player_stats add column if not exists so_pen        int         not null default 0;
alter table chase.player_stats add column if not exists so_cand       uuid;
alter table chase.player_stats add column if not exists so_hits       smallint    not null default 0;
alter table chase.player_stats add column if not exists so_pts        int         not null default 0;
-- Set on every player row at each round start (true in a score-O round, kept through the breather): lets
-- _so_tick leave at once in every other mode with one narrow row read (no sessions/plan lookup on the hot path).
alter table chase.player_stats add column if not exists so_on         boolean     not null default false;

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/scoreo.ts (test/scoreo.test.ts diffs them).

create or replace function chase.ks(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'practice_s'     then 60    -- suggested length of a practice round (= kg('round_min_s'))
    when 'so_posts'       then 12    -- posts in a score-O round (random placement)
    when 'so_bands'       then 4     -- distance bands from the assembly point
    when 'so_band_pts'    then 10    -- value = this × (band + 1): 10/20/30/40
    when 'so_from_base_m' then 20    -- no random post closer than this to the assembly point
    when 'so_fixed_min'   then 3     -- use the teacher's fixed GPS posts when there are at least this many
    when 'so_return_s'    then 120   -- «innkomst»: the phase runs this long after the time limit
    when 'so_late_step_s' then 10    -- penalty per started … seconds late
    when 'so_late_pen'    then 5     -- … this many points
    when 'so_cands'       then 120   -- random candidate points for the spread
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/scoreo.ts) ─────────────────────────

-- Value of a post at p_d metres from the assembly point when the farthest point of the area is p_max away.
create or replace function chase._so_value(p_d double precision, p_max double precision)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select (chase.ks('so_band_pts') * (1 + least(chase.ks('so_bands') - 1,
            floor(chase.ks('so_bands') * greatest(coalesce(p_d, 0), 0) / greatest(coalesce(p_max, 1), 1)))))::int;
$$;

-- Points lost for arriving p_late_s seconds after the time limit; never more than p_base (the round's points).
create or replace function chase._so_pen(p_late_s double precision, p_base int)
returns int
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when p_late_s is null or p_late_s <= 0 then 0
         else greatest(0, least(coalesce(p_base, 0), (chase.ks('so_late_pen') * ceil(p_late_s / chase.ks('so_late_step_s')))::int)) end;
$$;

-- Farthest assembly → boundary vertex, metres (≥ 1): the scale of the distance bands.
create or replace function chase._so_maxd(p_session uuid)
returns double precision
language sql
stable
set search_path = chase, extensions, public
as $$
  select greatest(1, coalesce(max(ST_Distance(s.assembly_point, d.geom::geography)), 1))
    from chase.sessions s, lateral ST_DumpPoints(s.boundary::geometry) d
   where s.id = p_session;
$$;

-- Podiums + «Orienterer» right before «Flest riktige» / «Lagspiller» / «Flest poeng» / «Lagpall» (else last).
-- p_rows: [{id, so}]. Same shape as _quiz_podiums (0012).
create or replace function chase._scoreo_podiums(p_podiums jsonb, p_rows jsonb)
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
  select jsonb_agg(jsonb_build_object('id', r ->> 'id', 'value', (r ->> 'so')::numeric)
                   order by (r ->> 'so')::numeric desc, (r ->> 'id') collate "C")
    into v_pod
    from (select r from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
           where coalesce((r ->> 'so')::numeric, 0) > 0
           order by (r ->> 'so')::numeric desc, (r ->> 'id') collate "C"
           limit chase.kc('podium_size')::int) q;
  if v_pod is null then
    return coalesce(p_podiums, '[]'::jsonb);
  end if;
  for v_p in select * from jsonb_array_elements(coalesce(p_podiums, '[]'::jsonb)) loop
    if v_pod is not null and v_p ->> 'cat' in ('quiz', 'teamplay', 'points', 'team') then
      v_out := v_out || jsonb_build_object('cat', 'scoreo', 'entries', v_pod);
      v_pod := null;
    end if;
    v_out := v_out || v_p;
  end loop;
  if v_pod is not null then
    v_out := v_out || jsonb_build_object('cat', 'scoreo', 'entries', v_pod);
  end if;
  return v_out;
end;
$$;

-- 0013 + score-O: no sprint / gathering pulling the runners off their routes.
create or replace function chase._ev_kinds(p_mode text, p_qr boolean, p_auto boolean)
returns text[]
language sql
immutable
set search_path = chase, extensions, public
as $$
  select array_remove(array[
    case when p_mode is distinct from 'relay' and p_mode is distinct from 'scoreo' then 'sprint' end,
    case when not p_auto or p_qr then 'mission' end,
    case when p_mode is distinct from 'relay' and p_mode is distinct from 'scoreo' then 'gather' end,
    case when p_mode = 'posts' and not p_auto then 'golden' end,
    case when p_mode = 'tag' then 'storm' end,
    case when p_mode = 'tag' then 'blackout' end], null);
$$;

-- ───────────────────────── practice: freeze the scoring ─────────────────────────

create or replace function chase._stats_practice_guard()
returns trigger
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_prac boolean;
  v_so   boolean;
  v      chase.player_stats;
begin
  if tg_op = 'INSERT' then
    -- A player who joins while a practice / score-O round is live gets the flags too.
    select (s.plan -> 'rounds' -> s.round_idx ->> 'practice') = 'true' and s.status in ('live', 'paused'),
           (s.plan -> 'rounds' -> s.round_idx ->> 'mode') = 'scoreo' and s.status in ('live', 'paused')
      into v_prac, v_so
      from chase.sessions s where s.id = new.session_id and s.round_idx >= 0;
    new.practice := coalesce(v_prac, false);
    new.so_on := coalesce(v_so, false);
    return new;
  end if;
  -- UPDATE (only fires while a practice round runs, see the trigger's WHEN): a WHITELIST of what may change.
  -- Movement counts (distance, active seconds, explorer cells) and the bookkeeping the modes need;
  -- every other column, points and counters included, keeps its old value. New point columns are frozen by default.
  v := new;
  new := old;
  new.practice := v.practice;                 new.so_on := v.so_on;
  new.distance_m := v.distance_m;             new.active_s := v.active_s;
  new.round_distance_m := v.round_distance_m; new.round_active_s := v.round_active_s;
  new.cells := v.cells;                       new.explorer_n := v.explorer_n;
  new.per_round := v.per_round;               new.best := v.best;
  new.current_survival_start := v.current_survival_start;  new.surv_pts_stint := v.surv_pts_stint;
  new.radar_until := v.radar_until;           new.turbo_until := v.turbo_until;
  new.turbo_base_m := v.turbo_base_m;         new.turbo_paid := v.turbo_paid;
  return new;
end;
$$;

drop trigger if exists player_stats_practice on chase.player_stats;
drop trigger if exists player_stats_practice_ins on chase.player_stats;
drop trigger if exists player_stats_practice_upd on chase.player_stats;
create trigger player_stats_practice_ins before insert on chase.player_stats
  for each row execute function chase._stats_practice_guard();
create trigger player_stats_practice_upd before update on chase.player_stats
  for each row when (old.practice and new.practice) execute function chase._stats_practice_guard();

create or replace function chase._posts_practice_guard()
returns trigger
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if exists (select 1 from chase.sessions s
              where s.id = new.session_id and s.round_idx = new.round_idx and s.round_idx >= 0
                and (s.plan -> 'rounds' -> s.round_idx ->> 'practice') = 'true') then
    new.value := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists posts_practice on chase.posts;
create trigger posts_practice before insert on chase.posts
  for each row execute function chase._posts_practice_guard();

-- ───────────────────────── plan: practice, scoreo ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_so(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_so;
  end if;
end $$;

-- The older layers know free/posts/tag/…: scoreo is checked as a plain 'free' round and
-- `practice` is taken off before they run; both are put back on the normalised plan.
create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_in   jsonb := p;
  v_base jsonb;
  v_r    jsonb;
  v_prac int[] := '{}';
  v_so   int[] := '{}';
  v_i    int;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'rounds') <> 'array' then
    return null;
  end if;
  for i in 0 .. jsonb_array_length(p -> 'rounds') - 1 loop
    v_r := p -> 'rounds' -> i;
    if jsonb_typeof(v_r) <> 'object' then
      return null;
    end if;
    if v_r ? 'practice' then
      if jsonb_typeof(v_r -> 'practice') not in ('boolean', 'null') then
        return null;
      end if;
      if v_r -> 'practice' = 'true'::jsonb then
        -- Only Postjakt and Smittejakt, kept simple: no zone, no teams.
        if v_r ->> 'mode' not in ('posts', 'tag')
           or coalesce(v_r -> 'zone', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb)
           or coalesce(v_r -> 'team', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb) then
          return null;
        end if;
        v_prac := v_prac || i;
      end if;
      v_r := v_r - 'practice';
      v_in := jsonb_set(v_in, array['rounds', i::text], v_r);
    end if;
    if v_r ->> 'mode' = 'scoreo' then
      if coalesce(v_r -> 'zone', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb)
         or coalesce(v_r -> 'team', 'false'::jsonb) not in ('false'::jsonb, 'null'::jsonb) then
        return null;                 -- the posts and the assembly point must stay reachable; always individual
      end if;
      v_in := jsonb_set(v_in, array['rounds', i::text], (v_r - 'zone' - 'team') || '{"mode":"free"}'::jsonb);
      v_so := v_so || i;
    end if;
  end loop;
  v_base := chase._norm_plan_so(v_in);
  if v_base is null then
    return null;
  end if;
  foreach v_i in array v_so loop
    v_base := jsonb_set(v_base, array['rounds', v_i::text, 'mode'], '"scoreo"'::jsonb);
  end loop;
  foreach v_i in array v_prac loop
    v_base := jsonb_set(v_base, array['rounds', v_i::text, 'practice'], 'true'::jsonb);
  end loop;
  return v_base;
exception when others then
  return null;
end;
$$;

-- ───────────────────────── score-O: round lifecycle ─────────────────────────

-- Round start: place the posts, add the return window to the phase, clear last round's state.
create or replace function chase._so_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_fx    jsonb;
  v_sel   geography[] := '{}';
  v_idx   int[] := '{}';
  v_area  geometry;
  v_cands geography[];
  v_far   geography[];
  v_max   double precision;
  v_band  int;
  v_pt    geography;
  v_i     int;
  v_total int;
begin
  select * into s from chase.sessions where id = p_session;
  v_max := chase._so_maxd(p_session);

  -- The teacher's fixed GPS posts (0016) when there are enough of them.
  v_fx := s.settings -> 'fixed_posts';
  if jsonb_typeof(v_fx) = 'array' then
    -- Only GPS posts inside the area and not in / near a forbidden area (as the random ones).
    select coalesce(array_agg(g.pt order by o), '{}')
      into v_sel
      from jsonb_array_elements(v_fx) with ordinality t(x, o)
     cross join lateral (select ST_SetSRID(ST_MakePoint((x ->> 'lng')::float8, (x ->> 'lat')::float8), 4326)::geography as pt) g
     where not coalesce((x ->> 'qr')::boolean, false)
       and ST_Covers(s.boundary, g.pt)
       and (s.forbidden is null or not ST_DWithin(s.forbidden, g.pt, chase.kg('post_forbidden_m')));
    if cardinality(v_sel) < chase.ks('so_fixed_min') then
      v_sel := '{}';
    end if;
  end if;

  -- Otherwise a random spread: one post per band in turn, each the farthest from the ones already placed.
  if cardinality(v_sel) = 0 then
    v_area := chase._team_area(p_session);
    if v_area is not null and not ST_IsEmpty(v_area) then
      select array_agg(d.geom::geography) into v_cands from ST_Dump(ST_GeneratePoints(v_area, chase.ks('so_cands')::int)) d;
      select array_agg(c) into v_far from unnest(v_cands) c where ST_Distance(c, s.assembly_point) >= chase.ks('so_from_base_m');
      if coalesce(cardinality(v_far), 0) >= chase.ks('so_posts') then
        v_cands := v_far;
      end if;
      for k in 1 .. chase.ks('so_posts')::int loop
        v_band := (k - 1) % chase.ks('so_bands')::int;
        select u.pt, u.i into v_pt, v_i
          from (select c.pt, c.i,
                       least(chase.ks('so_bands') - 1, floor(chase.ks('so_bands') * ST_Distance(c.pt, s.assembly_point) / v_max))::int as band,
                       (select min(ST_Distance(c.pt, x)) from unnest(v_sel) x) as dmin
                  from unnest(coalesce(v_cands, '{}'::geography[])) with ordinality c(pt, i)
                 where c.i <> all(v_idx)) u
         order by (u.band <> v_band), coalesce(u.dmin, random()) desc
         limit 1;
        exit when v_pt is null;
        v_sel := v_sel || v_pt;
        v_idx := v_idx || v_i;
        v_pt := null;
      end loop;
    end if;
  end if;

  insert into chase.posts (session_id, round_idx, pos, radius_m, value, kind)
  select p_session, s.round_idx, pt, chase.kg('claim_radius_m'), chase._so_value(ST_Distance(pt, s.assembly_point), v_max), 'normal'
    from unnest(v_sel) pt;
  get diagnostics v_total = row_count;

  -- The phase runs through the return window; limit_at = phase_ends_at − so_return_s (kept fresh by the upkeep).
  update chase.sessions set phase_ends_at = phase_ends_at + make_interval(secs => chase.ks('so_return_s')) where id = p_session;
  update chase.rounds
     set state = state || jsonb_build_object('so', jsonb_build_object(
           'total', v_total, 'past_limit', false, 'in', 0, 'of', 0,
           'limit_at', p_at + make_interval(secs => ((s.plan -> 'rounds' -> s.round_idx ->> 'duration_s')::int))))
   where session_id = p_session and idx = s.round_idx;
  update chase.player_stats
     set so_home_since = null, so_arrived_at = null, so_late_s = null, so_pen = 0, so_cand = null, so_hits = 0
   where session_id = p_session;
end;
$$;

-- Upkeep (under the session lock, ≤ 1/s): freeze limit_at once it has passed, count who is in,
-- and end the round when everybody is.
create or replace function chase._so_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  r      chase.rounds;
  v_so   jsonb;
  v_lim  timestamptz;
  v_in   int;
  v_of   int;
begin
  select * into s from chase.sessions where id = p_session;
  if s.status <> 'live' or s.frozen_at is not null or s.round_idx < 0 then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.mode is distinct from 'scoreo' or jsonb_typeof(r.state -> 'so') is distinct from 'object' then
    return;
  end if;
  v_so := r.state -> 'so';
  if not coalesce((v_so ->> 'past_limit')::boolean, false) then
    v_lim := s.phase_ends_at - make_interval(secs => chase.ks('so_return_s'));
    v_so := jsonb_set(v_so, '{limit_at}', to_jsonb(v_lim));
    if now() >= v_lim then
      v_so := jsonb_set(v_so, '{past_limit}', 'true'::jsonb);
    end if;
  end if;
  if coalesce((v_so ->> 'past_limit')::boolean, false) then
    v_lim := (v_so ->> 'limit_at')::timestamptz;
    select count(*) filter (where st.so_arrived_at is not null or st.so_home_since <= v_lim), count(*)
      into v_in, v_of
      from chase.player_stats st join chase.players p on p.id = st.player_id
     where st.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out');
    v_so := v_so || jsonb_build_object('in', v_in, 'of', v_of);
    if v_of > 0 and v_in = v_of and s.phase_ends_at > now() then
      update chase.sessions set phase_ends_at = now() where id = p_session;   -- everybody is back: the next advance ends the round
    end if;
  end if;
  if v_so is distinct from r.state -> 'so' then
    update chase.rounds set state = jsonb_set(state, '{so}', v_so) where session_id = p_session and idx = s.round_idx;
  end if;
end;
$$;

-- Round end (called before 0004's finish banks the round): everybody who never registered after the
-- time limit loses the whole round's points (or nothing, when the teacher skipped the round early).
create or replace function chase._so_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s      chase.sessions;
  r      chase.rounds;
  v_lim  timestamptz;
begin
  select * into s from chase.sessions where id = p_session;
  if s.round_idx < 0 then
    return;
  end if;
  select * into r from chase.rounds where session_id = p_session and idx = s.round_idx;
  if r.mode is distinct from 'scoreo' then
    return;
  end if;
  -- No penalty when the teacher ended the round («Neste runde», «Avslutt», state.so.skipped) or for a player
  -- with an open SOS alarm (the penalty is a game rule; safety comes first, rule 4).
  if coalesce((r.state -> 'so' ->> 'past_limit')::boolean, false) and not coalesce((r.state -> 'so' ->> 'skipped')::boolean, false) then
    v_lim := (r.state -> 'so' ->> 'limit_at')::timestamptz;
    -- At home at their last tick (no tick since the limit): in time. Otherwise never in: the whole round.
    update chase.player_stats st
       set so_late_s = case when st.so_home_since is not null then 0 else chase.ks('so_return_s')::int end,
           so_pen = case when st.so_home_since is not null then 0 else st.round_points end,
           points = st.points - case when st.so_home_since is not null then 0 else st.round_points end,
           round_points = st.round_points - case when st.so_home_since is not null then 0 else st.round_points end
      from chase.players p
     where p.id = st.player_id and st.session_id = p_session and st.so_arrived_at is null
       and p.status = 'active' and p.role not in ('referee', 'sitting_out')
       and not exists (select 1 from chase.alarms a where a.player_id = st.player_id and a.kind = 'sos' and a.resolved_at is null);
  end if;
  update chase.player_stats st
     set so_pts = st.so_pts + st.round_points
    from chase.players p
   where p.id = st.player_id and st.session_id = p_session and p.status = 'active' and p.role not in ('referee', 'sitting_out');
  update chase.player_stats
     set so_home_since = null, so_arrived_at = null, so_cand = null, so_hits = 0
   where session_id = p_session;
end;
$$;

-- The phone's view and my claims / arrival (merged into the tick answer under `scoreo`).
create or replace function chase._so_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_on     boolean;
  v_status text;
  v_idx    int;
  v_ends   timestamptz;
  v_frozen timestamptz;
  v_asm    geography;
  v_role   text;
  v_st     chase.player_stats;
  v_acc    real;
  v_so     jsonb;
  v_ret    int := chase.ks('so_return_s')::int;
  v_lim    timestamptz;
  v_past   boolean;
  v_play   boolean;
  v_home   boolean := false;
  v_home_m double precision;
  v_cand   uuid;
  v_cval   int;
  v_hits   smallint;
  v_claimed jsonb;
  v_posts  jsonb := '[]'::jsonb;
  v_got    int := 0;
  v_total  int := 0;
  v_pts    int := 0;
  v_pcount int := 0;
  v_pen    int := 0;
  v_late   double precision;
  v_arr    timestamptz;
  v_hsince timestamptz;
  v_late_s int;
  v_dirty  boolean := false;
begin
  -- One narrow read of my own rows; every mode but score-O leaves here (so_on is set at each round start).
  select st.so_on, st.round_points, st.round_posts, st.so_cand, st.so_hits, st.so_home_since, st.so_arrived_at, st.so_late_s, st.so_pen,
         p.role, l.acc
    into v_on, v_st.round_points, v_st.round_posts, v_st.so_cand, v_st.so_hits, v_st.so_home_since, v_st.so_arrived_at,
         v_st.so_late_s, v_st.so_pen, v_role, v_acc
    from chase.player_stats st join chase.players p on p.id = st.player_id
    left join chase.player_live l on l.player_id = st.player_id
   where st.player_id = p_player;
  if not coalesce(v_on, false) or v_role = 'referee' then
    return '{}'::jsonb;
  end if;
  select s.status, s.round_idx, s.phase_ends_at, s.frozen_at, s.assembly_point, r.state -> 'so'
    into v_status, v_idx, v_ends, v_frozen, v_asm, v_so
    from chase.sessions s join chase.rounds r on r.session_id = s.id and r.idx = s.round_idx
   where s.id = p_session and s.round_idx >= 0;
  if v_idx is null then
    return '{}'::jsonb;
  end if;

  -- Round over (breather / roll call): what the card says about this round.
  if v_status not in ('live', 'paused') then
    return jsonb_build_object('scoreo', jsonb_build_object(
      'done', true, 'got', v_st.round_posts, 'total', coalesce((v_so ->> 'total')::int, 0),
      'late_s', v_st.so_late_s, 'penalty', v_st.so_pen));
  end if;

  v_lim := case when coalesce((v_so ->> 'past_limit')::boolean, false) then (v_so ->> 'limit_at')::timestamptz
                else v_ends - make_interval(secs => v_ret) end;
  -- While paused the clock stands still at frozen_at (rule 6).
  v_past := coalesce(v_frozen, now()) >= v_lim;
  v_play := v_status = 'live' and v_frozen is null and v_role <> 'sitting_out';
  v_acc := coalesce(v_acc, 999);
  v_home_m := ST_Distance(p_pos, v_asm);
  v_home := v_acc <= chase.k('uncertain_acc_m') and v_home_m <= chase.k('gather_radius_m');
  v_cand := v_st.so_cand;
  v_hits := v_st.so_hits;
  v_hsince := v_st.so_home_since;
  v_late_s := v_st.so_late_s;
  v_arr := v_st.so_arrived_at;
  v_pen := v_st.so_pen;

  if v_play then
    if not v_past then
      -- Claim: inside max(12 m, acc) of a post I have not taken, on two ticks in a row.
      v_cand := null;
      v_hits := 0;
      if v_acc <= chase.kg('claim_max_acc_m') then
        select o.id, o.value into v_cand, v_cval
          from chase.posts o
         where o.session_id = p_session and o.round_idx = v_idx and o.claimed_by is null and o.pos is not null
           and ST_DWithin(o.pos, p_pos, greatest(o.radius_m, v_acc))
           and not exists (select 1 from chase.post_claims c
                            where c.post_id = o.id and c.player_id = p_player and c.round_idx = o.round_idx)
         order by ST_Distance(o.pos, p_pos)
         limit 1;
        if v_cand is not null then
          v_hits := case when v_st.so_cand = v_cand then v_st.so_hits + 1 else 1 end;
          if v_hits >= chase.kg('claim_hits') then
            insert into chase.post_claims (post_id, player_id, session_id, round_idx, points, via)
            values (v_cand, p_player, p_session, v_idx, v_cval, 'gps')
            on conflict do nothing;
            if found then
              v_pts := v_cval;
              v_pcount := 1;
              insert into chase.events (session_id, type, actor_player_id, payload)
              values (p_session, 'claim', p_player,
                      jsonb_build_object('post', v_cand, 'value', v_cval, 'kind', 'normal', 'via', 'gps', 'scoreo', true));
              v_claimed := jsonb_build_object('post_id', v_cand, 'value', v_cval, 'kind', 'normal');
            end if;
            v_cand := null;
            v_hits := 0;
          end if;
        end if;
      end if;
    elsif v_arr is null and v_home then
      -- Back at the assembly point after the time limit. At home since before the limit = in time.
      v_arr := case when v_hsince is not null and v_hsince <= v_lim then v_lim else now() end;
      v_late := extract(epoch from v_arr - v_lim);
      v_pen := case when exists (select 1 from chase.alarms a where a.player_id = p_player and a.kind = 'sos' and a.resolved_at is null)
                    then 0 else chase._so_pen(v_late, v_st.round_points) end;
      v_late_s := ceil(v_late)::int;
    end if;
    -- Home clock: since when have I been at the assembly point (written only when it changes).
    v_hsince := case when v_home then coalesce(v_hsince, now()) else null end;
    v_dirty := v_cand is distinct from v_st.so_cand or v_hits is distinct from v_st.so_hits
            or v_hsince is distinct from v_st.so_home_since or v_arr is distinct from v_st.so_arrived_at
            or v_pts <> 0;
    if v_dirty then
      update chase.player_stats
         set points = points + v_pts - (v_pen - v_st.so_pen),
             round_points = round_points + v_pts - (v_pen - v_st.so_pen),
             posts = posts + v_pcount, round_posts = round_posts + v_pcount,
             so_cand = v_cand, so_hits = v_hits, so_home_since = v_hsince,
             so_arrived_at = v_arr, so_late_s = v_late_s, so_pen = v_pen
       where player_id = p_player;
    end if;
  end if;

  -- The posts I have not taken (none once the time is up), and how many I have.
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'pos', chase._latlng(o.pos), 'value', o.value, 'kind', 'normal',
                                               'radius_m', o.radius_m, 'expires_at', null) order by o.value, o.spawned_at)
                    filter (where c.post_id is null), '[]'::jsonb),
         count(*) filter (where c.post_id is not null), count(*)
    into v_posts, v_got, v_total
    from chase.posts o
    left join chase.post_claims c on c.post_id = o.id and c.player_id = p_player and c.round_idx = o.round_idx
   where o.session_id = p_session and o.round_idx = v_idx and o.claimed_by is null and o.pos is not null;

  return jsonb_build_object('scoreo', jsonb_build_object(
    'posts', case when v_past then '[]'::jsonb else v_posts end,
    'got', v_got, 'total', v_total,
    'limit_at', v_lim, 'final_at', v_ends, 'past', v_past,
    'home', v_home, 'home_m', round(v_home_m::numeric),
    'arrived', v_arr is not null, 'late_s', v_late_s, 'penalty', v_pen,
    'claim', case when v_cand is not null then jsonb_build_object('post_id', v_cand, 'hits', v_hits, 'need', chase.kg('claim_hits')::int) end,
    'claimed', v_claimed));
end;
$$;

-- ───────────────────────── hooks ─────────────────────────

do $$
begin
  if to_regprocedure('chase._mode_begin_so(uuid,timestamptz)') is null then
    alter function chase._mode_begin(uuid, timestamptz) rename to _mode_begin_so;
  end if;
  if to_regprocedure('chase._mode_finish_so(uuid,timestamptz)') is null then
    alter function chase._mode_finish(uuid, timestamptz) rename to _mode_finish_so;
  end if;
  if to_regprocedure('chase._mode_upkeep_so(uuid)') is null then
    alter function chase._mode_upkeep_team(uuid) rename to _mode_upkeep_so;
  end if;
  if to_regprocedure('chase._mode_tick_so(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_so;
  end if;
  if to_regprocedure('chase._round_view_so(chase.sessions)') is null then
    alter function chase._round_view(chase.sessions) rename to _round_view_so;
  end if;
  if to_regprocedure('chase._end_session_so(uuid)') is null then
    alter function chase._end_session(uuid) rename to _end_session_so;
  end if;
  if to_regprocedure('chase._unfreeze_so(uuid)') is null then
    alter function chase._unfreeze(uuid) rename to _unfreeze_so;
  end if;
  if to_regprocedure('chase._ev_upkeep_so(uuid)') is null then
    alter function chase._ev_upkeep(uuid) rename to _ev_upkeep_so;
  end if;
  if to_regprocedure('chase._host_action_so(uuid,text,text,jsonb)') is null then
    alter function chase.host_action(uuid, text, text, jsonb) rename to _host_action_so;
  end if;
end $$;

create or replace function chase._mode_begin(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb;
begin
  perform chase._mode_begin_so(p_session, p_at);
  select s.plan -> 'rounds' -> s.round_idx into v_r from chase.sessions s where s.id = p_session and s.round_idx >= 0;
  -- Practice: from now on the scoring is frozen (the round_* counters were zeroed by 0004's _begin_round).
  if v_r ->> 'practice' = 'true' then
    update chase.player_stats set practice = true where session_id = p_session and not practice;
  end if;
  update chase.player_stats set so_on = (v_r ->> 'mode' = 'scoreo')
   where session_id = p_session and so_on is distinct from (v_r ->> 'mode' = 'scoreo');
  if v_r ->> 'mode' = 'scoreo' then
    perform chase._so_begin(p_session, p_at);
  end if;
end;
$$;

create or replace function chase._mode_finish(p_session uuid, p_at timestamptz)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._so_finish(p_session, p_at);
  perform chase._mode_finish_so(p_session, p_at);
  update chase.player_stats set practice = false where session_id = p_session and practice;
end;
$$;

create or replace function chase._mode_upkeep_team(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._mode_upkeep_so(p_session);
  perform chase._so_upkeep(p_session);
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  return coalesce(chase._mode_tick_so(p_player, p_session, p_pos), '{}'::jsonb) || chase._so_tick(p_player, p_session, p_pos);
end;
$$;

-- Round view: + practice (all clients) and the score-O clock (live/paused only).
create or replace function chase._round_view(s chase.sessions)
returns jsonb
language sql
stable
set search_path = chase, extensions, public
as $$
  select case when q.b is null then null else q.b || jsonb_build_object(
    'practice', coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'practice') = 'true', false),
    'scoreo', case when s.plan -> 'rounds' -> s.round_idx ->> 'mode' = 'scoreo' and s.status in ('live', 'paused') then
      (select jsonb_build_object(
          'limit_at', case when coalesce((r.state -> 'so' ->> 'past_limit')::boolean, false) then r.state -> 'so' -> 'limit_at'
                           else to_jsonb(s.phase_ends_at - make_interval(secs => chase.ks('so_return_s'))) end,
          'return_s', chase.ks('so_return_s')::int,
          'total', coalesce((r.state -> 'so' ->> 'total')::int, 0),
          'in', coalesce((r.state -> 'so' ->> 'in')::int, 0),
          'of', coalesce((r.state -> 'so' ->> 'of')::int, 0))
         from chase.rounds r where r.session_id = s.id and r.idx = s.round_idx) end) end
    from (select chase._round_view_so(s) as b) q;
$$;

-- «Avslutt»: the arrival clocks go with the positions (PLAN § 8).
create or replace function chase._end_session(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  perform chase._so_skip(p_session);          -- ending the session mid-round penalises nobody
  perform chase._end_session_so(p_session);
  update chase.player_stats set so_home_since = null, so_arrived_at = null, so_cand = null, so_hits = 0, practice = false, so_on = false
   where session_id = p_session;
end;
$$;

-- The teacher ends the score-O round («Neste runde», «Avslutt»): nobody is penalised for it.
create or replace function chase._so_skip(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  update chase.rounds r set state = jsonb_set(r.state, '{so,skipped}', 'true'::jsonb)
    from chase.sessions s
   where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx and s.round_idx >= 0
     and r.mode = 'scoreo' and jsonb_typeof(r.state -> 'so') = 'object';
end;
$$;

-- Pause: the pause does not count as lateness. _unfreeze moves phase_ends_at (and so the derived limit);
-- the frozen limit_at of a round already past its limit moves with it (rule 6).
create or replace function chase._unfreeze(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_f timestamptz;
begin
  select s.frozen_at into v_f from chase.sessions s where s.id = p_session;
  perform chase._unfreeze_so(p_session);
  if v_f is not null then
    update chase.rounds r
       set state = jsonb_set(r.state, '{so,limit_at}', to_jsonb((r.state -> 'so' ->> 'limit_at')::timestamptz + (now() - v_f)))
      from chase.sessions s
     where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx and s.round_idx >= 0 and r.mode = 'scoreo'
       and coalesce((r.state -> 'so' ->> 'past_limit')::boolean, false);
  end if;
end;
$$;

-- No automatic events, missions or golden posts in a practice round.
create or replace function chase._ev_upkeep(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
begin
  if chase._is_practice(p_session) then
    return;
  end if;
  perform chase._ev_upkeep_so(p_session);
end;
$$;

create or replace function chase._is_practice(p_session uuid)
returns boolean
language sql
stable
set search_path = chase, extensions, public
as $$
  select coalesce((s.plan -> 'rounds' -> s.round_idx ->> 'practice') = 'true' and s.status in ('live', 'paused'), false)
    from chase.sessions s where s.id = p_session and s.round_idx >= 0;
$$;

-- host_action: points cannot be adjusted and events cannot be started in a practice round (error 'practice');
-- «Neste runde» in a score-O round marks it skipped (no penalties).
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
  if p_action in ('adjust_points', 'event_start', 'mission_confirm')
     and exists (select 1 from chase.sessions s where s.id = p_session and s.host_token_hash = p_host_token_hash)
     and chase._is_practice(p_session) then
    return jsonb_build_object('ok', false, 'error', 'practice');
  end if;
  if p_action = 'next'
     and exists (select 1 from chase.sessions s where s.id = p_session and s.host_token_hash = p_host_token_hash and s.status = 'live') then
    perform chase._so_skip(p_session);
  end if;
  return chase._host_action_so(p_session, p_host_token_hash, p_action, p_payload);
end;
$$;

-- ───────────────────────── ceremony: «Orienterer» ─────────────────────────
-- 0012's _team_ceremony + the score-O podium (in the order: Lagspiller/Lagpall, Flest riktige, Orienterer).

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
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;

notify pgrst, 'reload schema';
