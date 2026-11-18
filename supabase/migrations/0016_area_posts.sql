-- Chase — 0016 — phase 9.4: faste poster per sted (PLAN §13 fase 9, ADR-027 bibliotek).
--
--   * chase.areas.posts / chase.shares.posts: the teacher's fixed posts for a
--     place, a list of {lat, lng, name?, kind: normal|golden, qr: bool, code?}.
--     qr = true: a printed QR card hangs at the spot (code = 5 stable chars,
--     the same alphabet as session QR cards); false = claimed by GPS.
--   * Stored and returned wherever the library stores areas: autosave «sist
--     brukt», library_save/get, share_create/get/copy.
--   * Session start: create_session takes settings.fixed_posts (same shape).
--     GPS posts are then spawned from that list in Postjakt instead of random
--     points (golden only if the list has golden ones; a point claimed in the
--     last 60 s is not respawned); qr posts become physical_qr posts with their
--     stable code, plan.qr_posts is raised, and claiming one requires a fresh
--     fix within max(100 m, acc) of the post (else too_far).
--     Autosave only updates posts on kind 'recent' areas.
--     An empty/missing list changes nothing (random posts as before).
--   * Additive: old Worker works against the new DB (new columns have defaults,
--     all wrappers pass through when the new keys are absent).
--   * Wraps with guarded renames (the migration runs twice in test-db.sh):
--     create_session, library_get, library_save, share_create, share_get,
--     share_copy, _spawn_post. Redefined in full: _library_autosave.

set search_path = chase, extensions, public;

-- ───────────────────────── schema ─────────────────────────

alter table chase.areas  add column if not exists posts jsonb not null default '[]'::jsonb check (jsonb_typeof(posts) = 'array');
alter table chase.shares add column if not exists posts jsonb not null default '[]'::jsonb check (jsonb_typeof(posts) = 'array');

-- ───────────────────────── pure rule (twin: normPosts in lib/rules/library.ts) ─────────────────────────

-- Fixed posts: array of 0..kg('posts_max') objects. lat/lng rounded to 6
-- decimals; name trimmed/squashed 1..40 chars (else omitted); kind normal|golden
-- (default normal); qr boolean (default false); qr posts need a unique 5-char
-- code (uppercase, alphabet A-HJ-NP-Z2-9), others carry none. null = invalid.
create or replace function chase._norm_posts(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_out   jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_x     jsonb;
  v_o     jsonb;
  v_lat   numeric;
  v_lng   numeric;
  v_name  text;
  v_kind  text;
  v_qr    boolean;
  v_code  text;
begin
  if p is null or p = 'null'::jsonb then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > chase.kg('posts_max') then
    return null;
  end if;
  for v_x in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v_x) <> 'object'
       or jsonb_typeof(v_x -> 'lat') is distinct from 'number' or jsonb_typeof(v_x -> 'lng') is distinct from 'number' then
      return null;
    end if;
    v_lat := (v_x ->> 'lat')::numeric;
    v_lng := (v_x ->> 'lng')::numeric;
    if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      return null;
    end if;
    v_kind := coalesce(v_x ->> 'kind', 'normal');
    if v_kind not in ('normal', 'golden') then
      return null;
    end if;
    if v_x ? 'qr' and jsonb_typeof(v_x -> 'qr') not in ('boolean', 'null') then
      return null;
    end if;
    v_qr := coalesce((v_x ->> 'qr')::boolean, false);
    v_o := jsonb_build_object('lat', round(v_lat, 6), 'lng', round(v_lng, 6), 'kind', v_kind, 'qr', v_qr);
    if jsonb_typeof(v_x -> 'name') = 'string' then
      v_name := btrim(regexp_replace(v_x ->> 'name', '\s+', ' ', 'g'));
      if char_length(v_name) > 40 then
        return null;
      end if;
      if v_name <> '' then
        v_o := v_o || jsonb_build_object('name', v_name);
      end if;
    elsif v_x ? 'name' and jsonb_typeof(v_x -> 'name') <> 'null' then
      return null;
    end if;
    if v_qr then
      v_code := upper(coalesce(v_x ->> 'code', ''));
      if v_code !~ '^[A-HJ-NP-Z2-9]{5}$' or v_code = any(v_codes) then
        return null;
      end if;
      v_codes := v_codes || v_code;
      v_o := v_o || jsonb_build_object('code', v_code);
    end if;
    v_out := v_out || v_o;
  end loop;
  return v_out;
end;
$$;

-- Every post inside the boundary (edge counts as inside) and not in, or within
-- kg('post_forbidden_m') of, a forbidden area (twin: fixedPostsOk in lib/rules/library.ts).
create or replace function chase._posts_ok(p_posts jsonb, p_boundary geography, p_forbidden geography)
returns boolean
language sql
immutable
set search_path = chase, extensions, public
as $$
  select not exists (
    select 1 from jsonb_array_elements(p_posts) x
     cross join lateral (select ST_SetSRID(ST_MakePoint((x ->> 'lng')::float8, (x ->> 'lat')::float8), 4326)::geography as pt) g
     where not ST_Covers(p_boundary, g.pt)
        or (p_forbidden is not null and ST_DWithin(p_forbidden, g.pt, chase.kg('post_forbidden_m'))));
$$;

-- Tunables of the fixed posts (twin: FIXED_POSTS in lib/rules/library.ts, diffed by test/area-posts.test.ts).
create or replace function chase._fx(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'claim_cooldown_s' then 60    -- a claimed fixed GPS post does not respawn at once (no farming)
    when 'qr_near_m'        then 100   -- a fixed QR post is claimed within max(this, acc) of the post …
    when 'qr_fix_age_s'     then 60    -- … by a player whose last fix is at most this old
  end::real;
$$;

-- ───────────────────────── autosave: remember the posts with the area ─────────────────────────
-- 0010's _library_autosave, plus posts: when the session carries
-- settings.fixed_posts (even an empty list) the area's posts follow it.

create or replace function chase._library_autosave(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s       chase.sessions;
  v_a     uuid;
  v_p     uuid;
  v_n     text;
  v_has   boolean;
  v_posts jsonb;
begin
  select * into s from chase.sessions where id = p_session;
  if s.teacher_id is null then
    return;
  end if;
  v_n := 'Økt ' || to_char(now() at time zone 'Europe/Oslo', 'DD.MM.YYYY HH24:MI');
  v_has := jsonb_typeof(s.settings -> 'fixed_posts') = 'array';
  v_posts := case when v_has then s.settings -> 'fixed_posts' else '[]'::jsonb end;

  select id into v_a from chase.areas a
   where a.teacher_id = s.teacher_id
     and ST_Equals(a.boundary::geometry, s.boundary::geometry)
     and ST_DWithin(a.assembly_point, s.assembly_point, 1)
     and coalesce(ST_Equals(a.forbidden::geometry, s.forbidden::geometry), a.forbidden is null and s.forbidden is null)
   order by a.kind = 'saved' desc, a.last_used_at desc limit 1;
  if v_a is not null then
    -- Only «sist brukt» follows the session; a saved area (printed cards!) changes by an explicit save only.
    update chase.areas set last_used_at = now(),
           posts = case when v_has and kind = 'recent' then v_posts else posts end
     where id = v_a;
  else
    insert into chase.areas (teacher_id, name, kind, boundary, forbidden, assembly_point, posts)
    values (s.teacher_id, v_n, 'recent', s.boundary, s.forbidden, s.assembly_point, v_posts);
    delete from chase.areas where teacher_id = s.teacher_id and kind = 'recent' and id not in (
      select id from chase.areas where teacher_id = s.teacher_id and kind = 'recent'
       order by last_used_at desc limit chase.kb('recent_keep')::int);
  end if;

  select id into v_p from chase.plans p
   where p.teacher_id = s.teacher_id and (p.settings || jsonb_build_object('rounds', p.rounds)) = s.plan
   order by p.kind = 'saved' desc, p.last_used_at desc limit 1;
  if v_p is not null then
    update chase.plans set last_used_at = now() where id = v_p;
  else
    insert into chase.plans (teacher_id, name, kind, rounds, settings)
    values (s.teacher_id, v_n, 'recent', s.plan -> 'rounds', s.plan - 'rounds');
    delete from chase.plans where teacher_id = s.teacher_id and kind = 'recent' and id not in (
      select id from chase.plans where teacher_id = s.teacher_id and kind = 'recent'
       order by last_used_at desc limit chase.kb('recent_keep')::int);
  end if;
end;
$$;

-- ───────────────────────── create_session: fixed posts ─────────────────────────
-- The base creates its random cards first (numbered 1..k); afterwards they are
-- renumbered to come after the fixed ones, the fixed qr cards are inserted
-- (fixed qr post i keeps n = its index in the list) and plan.qr_posts is raised
-- by the number of fixed qr posts.

do $$
begin
  if to_regprocedure('chase._create_session_posts(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,boolean)') is null then
    alter function chase.create_session(text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, boolean)
      rename to _create_session_posts;
  end if;
end $$;

create or replace function chase.create_session(
  p_host_token_hash  text,
  p_teacher_key_hash text,
  p_boundary         jsonb,
  p_assembly         jsonb,
  p_forbidden        jsonb default null,
  p_plan             jsonb default '{"rounds":[{"mode":"free","duration_s":600}]}'::jsonb,
  p_settings         jsonb default '{}'::jsonb,
  p_teacher_phone    text default null,
  p_is_sim           boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_settings jsonb := coalesce(p_settings, '{}'::jsonb);
  v_posts    jsonb;
  v_geo      record;
  v_r        jsonb;
  v_sid      uuid;
  v_alpha    constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_x        jsonb;
  v_i        int := 0;
  v_k        int := 0;
  v_new      text;
begin
  if jsonb_typeof(v_settings) <> 'object' or not v_settings ? 'fixed_posts' then
    return chase._create_session_posts(p_host_token_hash, p_teacher_key_hash, p_boundary, p_assembly,
                                       p_forbidden, p_plan, p_settings, p_teacher_phone, p_is_sim);
  end if;

  v_posts := chase._norm_posts(v_settings -> 'fixed_posts');
  if v_posts is null then
    return jsonb_build_object('ok', false, 'error', 'bad_posts');
  end if;
  select * into v_geo from chase._area_geo(p_boundary, p_assembly, p_forbidden);
  if v_geo.err is null and not chase._posts_ok(v_posts, v_geo.boundary, v_geo.forbidden) then
    return jsonb_build_object('ok', false, 'error', 'bad_posts');
  end if;
  v_settings := v_settings || jsonb_build_object('fixed_posts', v_posts);

  v_r := chase._create_session_posts(p_host_token_hash, p_teacher_key_hash, p_boundary, p_assembly,
                                     p_forbidden, p_plan, v_settings, p_teacher_phone, p_is_sim);
  if not coalesce((v_r ->> 'ok')::boolean, false) then
    return v_r;
  end if;
  v_sid := (v_r ->> 'session_id')::uuid;

  select count(*) into v_k from jsonb_array_elements(v_posts) x where (x ->> 'qr')::boolean;
  if v_k > 0 then
    -- Base cards (random codes) move after the fixed ones: n = n + list length.
    update chase.posts set n = n + jsonb_array_length(v_posts) where session_id = v_sid and kind = 'physical_qr';
    for v_x in select * from jsonb_array_elements(v_posts) loop
      v_i := v_i + 1;
      continue when not (v_x ->> 'qr')::boolean;
      -- A (very unlikely) clash with a random base code: give the base card a new code.
      while exists (select 1 from chase.posts where session_id = v_sid and code = v_x ->> 'code') loop
        select string_agg(substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1), '')
          into v_new from generate_series(1, 5);
        update chase.posts set code = v_new
         where session_id = v_sid and code = v_x ->> 'code' and not exists (select 1 from chase.posts where session_id = v_sid and code = v_new);
      end loop;
      insert into chase.posts (session_id, round_idx, pos, value, kind, code, n)
      values (v_sid, -1, null, chase.kg('qr_value')::int, 'physical_qr', v_x ->> 'code', v_i);
    end loop;
    update chase.sessions
       set plan = jsonb_set(plan, '{qr_posts}', to_jsonb(coalesce((plan ->> 'qr_posts')::int, 0) + v_k))
     where id = v_sid;
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── Postjakt: spawn from the fixed list ─────────────────────────
-- A session with GPS fixed posts of the requested kind spawns them (one that
-- has no open post within 2 m, preferring spots without a player nearby)
-- instead of random points. No fixed post of that kind → the old random spawn.
-- Zone rounds keep the random spawn (the circle shrinks).

do $$
begin
  if to_regprocedure('chase._spawn_post_base(uuid,integer,text)') is null then
    alter function chase._spawn_post(uuid, int, text) rename to _spawn_post_base;
  end if;
end $$;

create or replace function chase._spawn_post(p_session uuid, p_round int, p_kind text default 'normal')
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_fx     jsonb;
  v_kind   text := case when p_kind = 'golden' then 'golden' else 'normal' end;
  v_pt     geography;
  v_id     uuid;
  v_free   bigint;
begin
  select settings -> 'fixed_posts' into v_fx from chase.sessions where id = p_session;
  if jsonb_typeof(v_fx) is distinct from 'array' or jsonb_array_length(v_fx) = 0
     or chase._zone_of(p_session) is not null
     or not exists (select 1 from jsonb_array_elements(v_fx) x
                     where not coalesce((x ->> 'qr')::boolean, false) and coalesce(x ->> 'kind', 'normal') = v_kind) then
    return chase._spawn_post_base(p_session, p_round, p_kind);
  end if;

  -- Points without an open post; of those, skip any claimed in the last
  -- claim_cooldown_s (a pupil must not farm the spot they just claimed).
  with c as (
  select g.pt,
         exists (select 1 from chase.posts o
                  where o.session_id = p_session and o.round_idx = p_round and o.claimed_at is not null
                    and o.claimed_at > now() - make_interval(secs => chase._fx('claim_cooldown_s'))
                    and o.pos is not null and ST_DWithin(o.pos, g.pt, 2)) as cooling,
         (exists (select 1 from chase.player_live l join chase.players p on p.id = l.player_id
                   where l.session_id = p_session and p.status = 'active'
                     and l.fix_at > now() - interval '30 seconds'
                     and ST_DWithin(l.pos, g.pt, chase.kg('post_min_player_m'))))::int as near_player
    from jsonb_array_elements(v_fx) x
    cross join lateral (select ST_SetSRID(ST_MakePoint((x ->> 'lng')::float8, (x ->> 'lat')::float8), 4326)::geography as pt) g
   where not coalesce((x ->> 'qr')::boolean, false) and coalesce(x ->> 'kind', 'normal') = v_kind
     and not exists (select 1 from chase.posts o
                      where o.session_id = p_session and o.round_idx = p_round and o.claimed_by is null
                        and o.pos is not null and (o.expires_at is null or o.expires_at > now())
                        and ST_DWithin(o.pos, g.pt, 2)))
  select (select count(*) from c),
         (select pt from c where not cooling order by near_player, random() limit 1)
    into v_free, v_pt;
  if v_free = 0 then
    return null;     -- every fixed post of this kind is already open
  end if;
  if v_pt is null then
    return chase._spawn_post_base(p_session, p_round, p_kind);   -- all just claimed: random spot this time
  end if;
  insert into chase.posts (session_id, round_idx, pos, radius_m, value, kind, expires_at)
  values (p_session, p_round, v_pt, chase.kg('claim_radius_m'),
          case when v_kind = 'golden' then chase.kg('golden_value') else chase.kg('post_value') end::int,
          v_kind,
          case when v_kind = 'golden' then now() + make_interval(secs => chase.kg('golden_life_s')) end)
  returning id into v_id;
  return v_id;
end;
$$;

-- ───────────────────────── library: posts with the area ─────────────────────────

do $$
begin
  if to_regprocedure('chase._library_get_posts(text)') is null then
    alter function chase.library_get(text) rename to _library_get_posts;
  end if;
  if to_regprocedure('chase._library_save_posts(text,text,uuid,text,jsonb)') is null then
    alter function chase.library_save(text, text, uuid, text, jsonb) rename to _library_save_posts;
  end if;
  if to_regprocedure('chase._share_create_posts(text,uuid,uuid,text)') is null then
    alter function chase.share_create(text, uuid, uuid, text) rename to _share_create_posts;
  end if;
  if to_regprocedure('chase._share_get_posts(text)') is null then
    alter function chase.share_get(text) rename to _share_get_posts;
  end if;
  if to_regprocedure('chase._share_copy_posts(text,text)') is null then
    alter function chase.share_copy(text, text) rename to _share_copy_posts;
  end if;
end $$;

create or replace function chase.library_get(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._library_get_posts(p_key_hash);
begin
  if not coalesce((v_r ->> 'known')::boolean, false) then
    return v_r;
  end if;
  return jsonb_set(v_r, '{areas}', coalesce((
    select jsonb_agg(e.x || jsonb_build_object('posts', coalesce(a.posts, '[]'::jsonb)) order by e.ord)
      from jsonb_array_elements(v_r -> 'areas') with ordinality e(x, ord)
      left join chase.areas a on a.id = (e.x ->> 'id')::uuid), '[]'::jsonb));
end;
$$;

-- kind 'area': data.posts (when the key is present) replaces the area's posts.
create or replace function chase.library_save(p_key_hash text, p_kind text, p_id uuid, p_name text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_posts jsonb;
  v_geo   record;
  v_r     jsonb;
begin
  if p_kind <> 'area' or p_data is null or jsonb_typeof(p_data) <> 'object' or not p_data ? 'posts' then
    return chase._library_save_posts(p_key_hash, p_kind, p_id, p_name, p_data);
  end if;
  v_posts := chase._norm_posts(p_data -> 'posts');
  if v_posts is null then
    return jsonb_build_object('ok', false, 'error', 'bad_posts');
  end if;
  select * into v_geo from chase._area_geo(p_data -> 'boundary', p_data -> 'assembly', p_data -> 'forbidden');
  if v_geo.err is null and not chase._posts_ok(v_posts, v_geo.boundary, v_geo.forbidden) then
    return jsonb_build_object('ok', false, 'error', 'bad_posts');
  end if;
  v_r := chase._library_save_posts(p_key_hash, p_kind, p_id, p_name, p_data - 'posts');
  if coalesce((v_r ->> 'ok')::boolean, false) then
    update chase.areas set posts = v_posts where id = (v_r ->> 'id')::uuid;
  end if;
  return v_r;
end;
$$;

create or replace function chase.share_create(p_key_hash text, p_plan_id uuid, p_area_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._share_create_posts(p_key_hash, p_plan_id, p_area_id, p_name);
begin
  if coalesce((v_r ->> 'ok')::boolean, false) and p_area_id is not null then
    update chase.shares h set posts = a.posts from chase.areas a where h.code = v_r ->> 'code' and a.id = p_area_id;
  end if;
  return v_r;
end;
$$;

create or replace function chase.share_get(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._share_get_posts(p_code);
begin
  if coalesce((v_r ->> 'ok')::boolean, false) and jsonb_typeof(v_r -> 'area') = 'object' then
    v_r := jsonb_set(v_r, '{area,posts}',
      coalesce((select h.posts from chase.shares h where h.code = upper(coalesce(p_code, ''))), '[]'::jsonb));
  end if;
  return v_r;
end;
$$;

create or replace function chase.share_copy(p_key_hash text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._share_copy_posts(p_key_hash, p_code);
begin
  if coalesce((v_r ->> 'ok')::boolean, false) and v_r ->> 'area_id' is not null then
    update chase.areas a set posts = h.posts
      from chase.shares h
     where a.id = (v_r ->> 'area_id')::uuid and h.code = upper(coalesce(p_code, ''));
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── claim_qr: fixed QR cards need presence ─────────────────────────
-- A fixed card's code is stable and printed, so it could be reused from home in
-- later sessions. Claiming one therefore needs a fix at most qr_fix_age_s old
-- within max(qr_near_m, acc) of the post, else too_far. Random per-session
-- cards are unchanged.

do $$
begin
  if to_regprocedure('chase._claim_qr_posts(uuid,text,uuid,text)') is null then
    alter function chase.claim_qr(uuid, text, uuid, text) rename to _claim_qr_posts;
  end if;
end $$;

create or replace function chase.claim_qr(
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
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_x    jsonb;
  v_pt   geography;
  l      chase.player_live;
begin
  select x into v_x
    from chase.sessions s, jsonb_array_elements(case when jsonb_typeof(s.settings -> 'fixed_posts') = 'array'
                                                     then s.settings -> 'fixed_posts' else '[]'::jsonb end) x
   where s.id = p_session and coalesce((x ->> 'qr')::boolean, false) and x ->> 'code' = v_code
   limit 1;
  if v_x is not null
     and exists (select 1 from chase.players where id = p_player and token_hash = p_token_hash and session_id = p_session) then
    v_pt := ST_SetSRID(ST_MakePoint((v_x ->> 'lng')::float8, (v_x ->> 'lat')::float8), 4326)::geography;
    select * into l from chase.player_live where player_id = p_player;
    if l.player_id is null
       or l.fix_at <= now() - make_interval(secs => chase._fx('qr_fix_age_s'))
       or ST_Distance(l.pos, v_pt) > greatest(chase._fx('qr_near_m'), l.acc) then
      return jsonb_build_object('ok', false, 'error', 'too_far');
    end if;
  end if;
  return chase._claim_qr_posts(p_player, p_token_hash, p_session, p_code);
end;
$$;

revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
