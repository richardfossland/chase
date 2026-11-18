-- Chase — 0017 — «Varmere/kaldere» (fase 9.5): Snus og Termometer.
--
-- Et eget verktøy for jakten, ikke en power-up fra 0007: power-ups deles ut som
-- premier fra hendelser og forbrukes, mens dette er alltid tilgjengelig med
-- 60 s nedkjøling per spiller (felles for begge). Bare i tag-runder (Smittejakt,
-- Sisten, Sporing) mens runden er live, og bare for jeger og bytte.
--
--   * Snus:       «Er målet innenfor 50 m av meg?» → ja/nei. Målet er nærmeste
--                 bytte (jeger; i Sporing er det reven) eller nærmeste jeger (bytte).
--   * Termometer: «Er jeg varmere eller kaldere enn for ca. 30 s siden?» Avstanden
--                 fra min posisjon nå til målets posisjon NÅ sammenlignes med
--                 avstanden fra min posisjon for 20-40 s siden til målets posisjon NÅ
--                 (begge mot samme punkt, så svaret måler bare min egen bevegelse).
--                 Svar: warmer / colder / same (innenfor max(5 m, GPS-nøyaktighet)).
--
-- Personvern (regel 3): «posisjon for ~30 s siden» er to flyktige verdier per
-- spiller i player_live (UNLOGGED): hc_pos (0-20 s gammel) og hc_prev_pos
-- (20-40 s gammel). Aldri en logg. player_live slettes i _end_session, så
-- ankrene følger med. Svaret inneholder ingen posisjon, og events-raden bærer
-- bare verktøyets navn.
--
-- Additivt: chase.tick() pakkes inn (samme guardede rename som 0015) og flytter
-- ankeret når det er >= 20 s gammelt (én PK-oppdatering, bare da). Resultatet
-- fra tick er uendret. tick_batch (0014) kaller tick() og får ankeret uten
-- egen endring. Gammel Worker kjenner ikke use_hotcold og kaller den aldri.
-- Ingen sikkerhetsvarsler berøres (regel 4).

set search_path = chase, extensions, public;

-- ───────────────────────── konstanter (twin: lib/rules/hotcold.ts) ─────────────────────────

create or replace function chase.kh(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'sniff_m'        then 50   -- «innenfor» for Snus
    when 'cooldown_s'     then 60   -- per spiller, felles for begge
    when 'anchor_every_s' then 20   -- ankeret flyttes når det er så gammelt
    when 'thermo_min_s'   then 15   -- eldste anker må være minst så gammelt
    when 'thermo_max_s'   then 60   -- ...og høyst så gammelt
    when 'tie_m'          then 5    -- «omtrent likt» under dette (eller GPS-nøyaktighet)
    when 'fresh_s'        then 10   -- egen og målets fix må være så fersk
  end::real;
$$;

-- ───────────────────────── rene regler ─────────────────────────

create or replace function chase._sniff_answer(p_dist_m double precision)
returns boolean
language sql
immutable
set search_path = chase, extensions, public
as $$ select p_dist_m <= chase.kh('sniff_m'); $$;

-- d_then: avstand fra min gamle posisjon til målet nå. d_now: fra min posisjon nå.
create or replace function chase._thermo_answer(p_d_then double precision, p_d_now double precision, p_acc real)
returns text
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case
    when p_d_now < p_d_then - greatest(chase.kh('tie_m'), coalesce(p_acc, 0)) then 'warmer'
    when p_d_now > p_d_then + greatest(chase.kh('tie_m'), coalesce(p_acc, 0)) then 'colder'
    else 'same'
  end;
$$;

-- Hvem kan bruke verktøyet: bare jeger og bytte i en tag-runde. null = ok.
create or replace function chase._hc_check(p_kind text, p_mode text, p_role text)
returns text
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case
    when p_kind not in ('sniff', 'thermo') then 'bad_kind'
    when p_mode is distinct from 'tag' then 'not_useful'
    when p_role not in ('hunter', 'prey') then 'not_useful'
  end;
$$;

-- ───────────────────────── ankre i player_live ─────────────────────────

set local lock_timeout = '2s';   -- player_live brukes av tick: heller feile raskt enn å stå i kø
alter table chase.player_live
  add column if not exists hc_pos       geography(Point, 4326),
  add column if not exists hc_at        timestamptz,
  add column if not exists hc_prev_pos  geography(Point, 4326),
  add column if not exists hc_prev_at   timestamptz,
  add column if not exists hc_used_at   timestamptz;   -- nedkjøling, ingen posisjon

-- ───────────────────────── tick: flytt ankeret ─────────────────────────

do $$
begin
  if to_regprocedure('chase._tick_voice(uuid,text,double precision,double precision,real,real,timestamptz,uuid,int)') is null then
    alter function chase.tick(uuid, text, double precision, double precision, real, real, timestamptz, uuid, int)
      rename to _tick_voice;
  end if;
end $$;

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
  v_r jsonb := chase._tick_voice(p_player, p_token_hash, p_lat, p_lng, p_acc, p_speed, p_client_ts, p_session, p_steps);
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

-- ───────────────────────── Snus / Termometer ─────────────────────────
-- Låser bare spillerens egen rad (som use_powerup), aldri andres: målets
-- posisjon leses uten lås. Svaret avgjøres her; klienten viser det bare.

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
  v_left := chase.kh('cooldown_s') - extract(epoch from now() - v_l.hc_used_at);
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
  return jsonb_build_object('ok', true, 'kind', p_kind, 'cooldown_s', chase.kh('cooldown_s')::int) || v_ans;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
