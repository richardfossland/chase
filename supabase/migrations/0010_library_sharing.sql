-- Chase — 0010 — phase 6: library, share links, own missions (PLAN §13 fase 6, ADR-027).
--
--   * Library per lærernøkkel (teachers.key_hash): areas, plans («opplegg») and
--     challenge packs («oppdragspakker» = own mission texts). Every session made
--     with a teacher key is saved automatically as «sist brukt» (kind 'recent',
--     the 5 newest kept; an identical area/plan is only touched). The teacher
--     can keep one under a name (kind 'saved').
--   * Share links /d/<CODE>: a snapshot of a plan and, if the teacher chose it,
--     the area. Valid until the teacher revokes it (the row is deleted).
--     share_get returns a safe DTO without anything about the teacher.
--     «Lag kopi» copies it into the recipient's library.
--   * Own missions: plan.missions = 1..12 texts (2–80 chars). A mission event
--     then draws one of them (rounds.state.ev.mission_text) instead of the
--     built-in six.
--   * Teachers unused for 395 days are deleted with their library (purge_expired).
--   * Wraps with guarded renames: _norm_plan, create_session, _ev_start,
--     _mode_tick, purge_expired (the migration runs twice in test-db.sh).

set search_path = chase, extensions, public;

-- ───────────────────────── schema additions ─────────────────────────

alter table chase.areas add column if not exists kind text not null default 'saved' check (kind in ('recent', 'saved'));
alter table chase.areas add column if not exists last_used_at timestamptz not null default now();
alter table chase.plans add column if not exists kind text not null default 'saved' check (kind in ('recent', 'saved'));
alter table chase.plans add column if not exists last_used_at timestamptz not null default now();
alter table chase.challenge_packs add column if not exists last_used_at timestamptz not null default now();
create index if not exists areas_teacher_idx on chase.areas (teacher_id, last_used_at desc);
create index if not exists plans_teacher_idx on chase.plans (teacher_id, last_used_at desc);
create index if not exists packs_teacher_idx on chase.challenge_packs (teacher_id, last_used_at desc);
create index if not exists teachers_seen_idx on chase.teachers (last_seen_at);

create table if not exists chase.shares (
  code            text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  teacher_id      uuid not null references chase.teachers(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  plan            jsonb not null,
  boundary        geography(Polygon, 4326),
  forbidden       geography(MultiPolygon, 4326),
  assembly_point  geography(Point, 4326),
  copies          int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists shares_teacher_idx on chase.shares (teacher_id);
alter table chase.shares enable row level security;   -- deny-all like every chase table

-- ───────────────────────── tunables ─────────────────────────
-- Mirrored in lib/rules/library.ts (test diffs them).

create or replace function chase.kb(p_name text)
returns real
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case p_name
    when 'recent_keep'      then 5      -- automatic «sist brukt» per kind
    when 'saved_max'        then 50     -- named items per kind
    when 'shares_max'       then 30
    when 'missions_max'     then 12
    when 'mission_min'      then 2
    when 'mission_max'      then 80
    when 'name_max'         then 80
    when 'code_len'         then 8
    when 'teacher_idle_d'   then 395    -- library deleted after this long unused
  end::real;
$$;

-- ───────────────────────── pure rules (twins in lib/rules/library.ts) ─────────────────────────

-- Own mission texts: an array of 1..12 strings, trimmed, 2..80 chars, no
-- duplicates (case-insensitive, first kept). null = invalid.
create or replace function chase._norm_missions(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_out  jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  v_x    jsonb;
  v_t    text;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and chase.kb('missions_max') then
    return null;
  end if;
  for v_x in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(v_x) <> 'string' then
      return null;
    end if;
    v_t := btrim(regexp_replace(v_x #>> '{}', '\s+', ' ', 'g'));
    if char_length(v_t) not between chase.kb('mission_min') and chase.kb('mission_max') then
      return null;
    end if;
    if not lower(v_t) = any(v_seen) then
      v_seen := v_seen || lower(v_t);
      v_out := v_out || to_jsonb(v_t);
    end if;
  end loop;
  return v_out;
end;
$$;

-- Library names: trimmed, single spaces, 1..80 chars. null = invalid.
create or replace function chase._norm_name(p text)
returns text
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when char_length(x) between 1 and chase.kb('name_max') then x end
    from (select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')) as x) q;
$$;

-- ───────────────────────── plan: own missions ─────────────────────────

do $$
begin
  if to_regprocedure('chase._norm_plan_team(jsonb)') is null then
    alter function chase._norm_plan(jsonb) rename to _norm_plan_team;
  end if;
end $$;

create or replace function chase._norm_plan(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_base jsonb := chase._norm_plan_team(p);
  v_m    jsonb;
begin
  if v_base is null then
    return null;
  end if;
  if p -> 'missions' is null or p -> 'missions' = 'null'::jsonb
     or (jsonb_typeof(p -> 'missions') = 'array' and jsonb_array_length(p -> 'missions') = 0) then
    return v_base;
  end if;
  v_m := chase._norm_missions(p -> 'missions');
  if v_m is null then
    return null;
  end if;
  return v_base || jsonb_build_object('missions', v_m);
end;
$$;

-- ───────────────────────── helpers ─────────────────────────

create or replace function chase._teacher(p_key_hash text, p_create boolean)
returns uuid
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_id uuid;
begin
  if coalesce(length(p_key_hash), 0) < 32 then
    return null;
  end if;
  if p_create then
    insert into chase.teachers (key_hash) values (p_key_hash)
    on conflict (key_hash) do update set last_seen_at = now()
    returning id into v_id;
  else
    update chase.teachers set last_seen_at = now() where key_hash = p_key_hash returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Same checks as create_session (0003) for a library area.
create or replace function chase._area_geo(p_boundary jsonb, p_assembly jsonb, p_forbidden jsonb,
  out err text, out boundary geography, out forbidden geography, out assembly geography)
language plpgsql
immutable
set search_path = chase, extensions, public
as $$
declare
  v_g geometry;
begin
  begin
    v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_boundary::text), 4326);
  exception when others then
    err := 'bad_boundary';
    return;
  end;
  if GeometryType(v_g) <> 'POLYGON' or not ST_IsValid(v_g) or ST_NPoints(v_g) > 500 then
    err := 'bad_boundary';
    return;
  end if;
  boundary := v_g::geography;
  if ST_Area(boundary) < 500 or ST_Area(boundary) > 5000000 then
    err := 'area_size';
    return;
  end if;
  begin
    v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_assembly::text), 4326);
  exception when others then
    err := 'bad_assembly';
    return;
  end;
  if GeometryType(v_g) <> 'POINT' then
    err := 'bad_assembly';
    return;
  end if;
  assembly := v_g::geography;
  if not ST_DWithin(boundary, assembly, 200) then
    err := 'assembly_far';
    return;
  end if;
  if p_forbidden is not null and p_forbidden <> 'null'::jsonb then
    begin
      v_g := ST_SetSRID(ST_GeomFromGeoJSON(p_forbidden::text), 4326);
    exception when others then
      err := 'bad_forbidden';
      return;
    end;
    if GeometryType(v_g) not in ('POLYGON', 'MULTIPOLYGON') or not ST_IsValid(v_g) or ST_NPoints(v_g) > 1000 then
      err := 'bad_forbidden';
      return;
    end if;
    forbidden := ST_Multi(v_g)::geography;
  end if;
end;
$$;

create or replace function chase._geo_dto(p_boundary geography, p_forbidden geography, p_assembly geography)
returns jsonb
language sql
immutable
set search_path = chase, extensions, public
as $$
  select case when p_boundary is null then null else jsonb_build_object(
    'boundary', ST_AsGeoJSON(p_boundary, 7)::jsonb,
    'forbidden', case when p_forbidden is not null then ST_AsGeoJSON(p_forbidden, 7)::jsonb end,
    'assembly', chase._latlng(p_assembly),
    'area_m2', round(ST_Area(p_boundary))) end;
$$;

create or replace function chase._new_share_code()
returns text
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code  text;
begin
  loop
    select string_agg(substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1), '')
      into v_code from generate_series(1, chase.kb('code_len')::int);
    exit when not exists (select 1 from chase.shares where code = v_code);
  end loop;
  return v_code;
end;
$$;

-- After create_session: remember the area and the plan as «sist brukt».
create or replace function chase._library_autosave(p_session uuid)
returns void
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  s   chase.sessions;
  v_a uuid;
  v_p uuid;
  v_n text;
begin
  select * into s from chase.sessions where id = p_session;
  if s.teacher_id is null then
    return;
  end if;
  v_n := 'Økt ' || to_char(now() at time zone 'Europe/Oslo', 'DD.MM.YYYY HH24:MI');

  select id into v_a from chase.areas a
   where a.teacher_id = s.teacher_id
     and ST_Equals(a.boundary::geometry, s.boundary::geometry)
     and ST_DWithin(a.assembly_point, s.assembly_point, 1)
     and coalesce(ST_Equals(a.forbidden::geometry, s.forbidden::geometry), a.forbidden is null and s.forbidden is null)
   order by a.kind = 'saved' desc, a.last_used_at desc limit 1;
  if v_a is not null then
    update chase.areas set last_used_at = now() where id = v_a;
  else
    insert into chase.areas (teacher_id, name, kind, boundary, forbidden, assembly_point)
    values (s.teacher_id, v_n, 'recent', s.boundary, s.forbidden, s.assembly_point);
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

-- ───────────────────────── create_session: + autosave ─────────────────────────

do $$
begin
  if to_regprocedure('chase._create_session_lib(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,boolean)') is null then
    alter function chase.create_session(text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, boolean)
      rename to _create_session_lib;
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
  v_r jsonb := chase._create_session_lib(p_host_token_hash, p_teacher_key_hash, p_boundary, p_assembly,
                                         p_forbidden, p_plan, p_settings, p_teacher_phone, p_is_sim);
begin
  if coalesce((v_r ->> 'ok')::boolean, false) and p_teacher_key_hash is not null and not coalesce(p_is_sim, false) then
    perform chase._library_autosave((v_r ->> 'session_id')::uuid);
  end if;
  return v_r;
end;
$$;

-- ───────────────────────── library RPCs ─────────────────────────

-- Everything in my library. Unknown key → known=false and empty lists (import check).
create or replace function chase.library_get(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t uuid := chase._teacher(p_key_hash, false);
begin
  if v_t is null then
    return jsonb_build_object('ok', true, 'known', false, 'areas', '[]'::jsonb, 'plans', '[]'::jsonb,
                              'packs', '[]'::jsonb, 'shares', '[]'::jsonb);
  end if;
  return jsonb_build_object('ok', true, 'known', true,
    'areas', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind,
                                                           'last_used_at', a.last_used_at)
                                        || chase._geo_dto(a.boundary, a.forbidden, a.assembly_point)
                                        order by a.kind = 'saved' desc, a.last_used_at desc), '[]'::jsonb)
                from chase.areas a where a.teacher_id = v_t),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
                                                           'last_used_at', p.last_used_at,
                                                           'plan', p.settings || jsonb_build_object('rounds', p.rounds))
                                        order by p.kind = 'saved' desc, p.last_used_at desc), '[]'::jsonb)
                from chase.plans p where p.teacher_id = v_t),
    'packs', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'items', c.items)
                                        order by c.last_used_at desc), '[]'::jsonb)
                from chase.challenge_packs c where c.teacher_id = v_t),
    'shares', (select coalesce(jsonb_agg(jsonb_build_object('code', h.code, 'name', h.name, 'has_area', h.boundary is not null,
                                                            'copies', h.copies, 'created_at', h.created_at)
                                         order by h.created_at desc), '[]'::jsonb)
                 from chase.shares h where h.teacher_id = v_t));
end;
$$;

-- Create (p_id null) or update one item. p_data null with p_id = rename + keep.
-- kind: area {boundary, assembly, forbidden} | plan <plan> | pack {items: [..]}
create or replace function chase.library_save(p_key_hash text, p_kind text, p_id uuid, p_name text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t    uuid;
  v_name text := chase._norm_name(p_name);
  v_geo  record;
  v_plan jsonb;
  v_m    jsonb;
  v_id   uuid;
  v_n    int;
begin
  if p_kind not in ('area', 'plan', 'pack') then
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'bad_name');
  end if;
  if p_id is null and p_data is null then
    return jsonb_build_object('ok', false, 'error', 'bad_data');
  end if;
  v_t := chase._teacher(p_key_hash, p_id is null);
  if v_t is null then
    return jsonb_build_object('ok', false, 'error', case when p_id is null then 'auth' else 'not_found' end);
  end if;

  if p_kind = 'area' then
    if p_data is null then
      select null::text as err, null::geography as boundary, null::geography as forbidden, null::geography as assembly
        into v_geo;
    else
      select * into v_geo from chase._area_geo(p_data -> 'boundary', p_data -> 'assembly', p_data -> 'forbidden');
      if v_geo.err is not null then
        return jsonb_build_object('ok', false, 'error', v_geo.err);
      end if;
    end if;
    if p_id is null then
      select count(*) into v_n from chase.areas where teacher_id = v_t and kind = 'saved';
      if v_n >= chase.kb('saved_max') then
        return jsonb_build_object('ok', false, 'error', 'full');
      end if;
      insert into chase.areas (teacher_id, name, kind, boundary, forbidden, assembly_point)
      values (v_t, v_name, 'saved', v_geo.boundary, v_geo.forbidden, v_geo.assembly) returning id into v_id;
    else
      update chase.areas set name = v_name, kind = 'saved', updated_at = now(),
             boundary = coalesce(v_geo.boundary, boundary),
             forbidden = case when p_data is null then forbidden else v_geo.forbidden end,
             assembly_point = coalesce(v_geo.assembly, assembly_point)
       where id = p_id and teacher_id = v_t returning id into v_id;
    end if;

  elsif p_kind = 'plan' then
    if p_data is not null then
      v_plan := chase._norm_plan(p_data);
      if v_plan is null then
        return jsonb_build_object('ok', false, 'error', 'bad_plan');
      end if;
    end if;
    if p_id is null then
      select count(*) into v_n from chase.plans where teacher_id = v_t and kind = 'saved';
      if v_n >= chase.kb('saved_max') then
        return jsonb_build_object('ok', false, 'error', 'full');
      end if;
      insert into chase.plans (teacher_id, name, kind, rounds, settings)
      values (v_t, v_name, 'saved', v_plan -> 'rounds', v_plan - 'rounds') returning id into v_id;
    else
      update chase.plans set name = v_name, kind = 'saved', updated_at = now(),
             rounds = coalesce(v_plan -> 'rounds', rounds), settings = coalesce(v_plan - 'rounds', settings)
       where id = p_id and teacher_id = v_t returning id into v_id;
    end if;

  else
    if p_data is not null then
      v_m := chase._norm_missions(p_data -> 'items');
      if v_m is null then
        return jsonb_build_object('ok', false, 'error', 'bad_pack');
      end if;
    end if;
    if p_id is null then
      select count(*) into v_n from chase.challenge_packs where teacher_id = v_t;
      if v_n >= chase.kb('saved_max') then
        return jsonb_build_object('ok', false, 'error', 'full');
      end if;
      insert into chase.challenge_packs (teacher_id, name, items) values (v_t, v_name, v_m) returning id into v_id;
    else
      update chase.challenge_packs set name = v_name, items = coalesce(v_m, items), updated_at = now(), last_used_at = now()
       where id = p_id and teacher_id = v_t returning id into v_id;
    end if;
  end if;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function chase.library_delete(p_key_hash text, p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t uuid := chase._teacher(p_key_hash, false);
  v_n int := 0;
begin
  if v_t is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_kind = 'area' then
    delete from chase.areas where id = p_id and teacher_id = v_t;
  elsif p_kind = 'plan' then
    delete from chase.plans where id = p_id and teacher_id = v_t;
  elsif p_kind = 'pack' then
    delete from chase.challenge_packs where id = p_id and teacher_id = v_t;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_kind');
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ───────────────────────── share links ─────────────────────────

create or replace function chase.share_create(p_key_hash text, p_plan_id uuid, p_area_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t    uuid := chase._teacher(p_key_hash, false);
  v_p    chase.plans;
  v_a    chase.areas;
  v_name text;
  v_code text;
begin
  if v_t is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_p from chase.plans where id = p_plan_id and teacher_id = v_t;
  if v_p.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if p_area_id is not null then
    select * into v_a from chase.areas where id = p_area_id and teacher_id = v_t;
    if v_a.id is null then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  end if;
  v_name := coalesce(chase._norm_name(p_name), v_p.name);
  if (select count(*) from chase.shares where teacher_id = v_t) >= chase.kb('shares_max') then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  v_code := chase._new_share_code();
  insert into chase.shares (code, teacher_id, name, plan, boundary, forbidden, assembly_point)
  values (v_code, v_t, v_name, v_p.settings || jsonb_build_object('rounds', v_p.rounds),
          v_a.boundary, v_a.forbidden, v_a.assembly_point);
  return jsonb_build_object('ok', true, 'code', v_code);
end;
$$;

create or replace function chase.share_revoke(p_key_hash text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_t uuid := chase._teacher(p_key_hash, false);
  v_n int := 0;
begin
  delete from chase.shares where code = upper(coalesce(p_code, '')) and teacher_id = v_t;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- Public preview: the plan and (if shared) the area. Nothing about the teacher.
create or replace function chase.share_get(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = chase, extensions, public
as $$
  select coalesce((
    select jsonb_build_object('ok', true, 'code', h.code, 'name', h.name, 'plan', h.plan,
                              'area', chase._geo_dto(h.boundary, h.forbidden, h.assembly_point),
                              'copies', h.copies, 'created_at', h.created_at)
      from chase.shares h where h.code = upper(coalesce(p_code, ''))),
    jsonb_build_object('ok', false, 'error', 'not_found'));
$$;

-- «Lag kopi»: into my library as saved items (creates my library if needed).
create or replace function chase.share_copy(p_key_hash text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_h    chase.shares;
  v_t    uuid;
  v_plan uuid;
  v_area uuid;
begin
  select * into v_h from chase.shares where code = upper(coalesce(p_code, '')) for update;
  if v_h.code is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_t := chase._teacher(p_key_hash, true);
  if v_t is null then
    return jsonb_build_object('ok', false, 'error', 'auth');
  end if;
  insert into chase.plans (teacher_id, name, kind, rounds, settings)
  values (v_t, v_h.name, 'saved', v_h.plan -> 'rounds', v_h.plan - 'rounds') returning id into v_plan;
  if v_h.boundary is not null then
    insert into chase.areas (teacher_id, name, kind, boundary, forbidden, assembly_point)
    values (v_t, v_h.name, 'saved', v_h.boundary, v_h.forbidden, v_h.assembly_point) returning id into v_area;
  end if;
  if v_h.teacher_id <> v_t then
    update chase.shares set copies = copies + 1 where code = v_h.code;
  end if;
  return jsonb_build_object('ok', true, 'plan_id', v_plan, 'area_id', v_area);
end;
$$;

-- ───────────────────────── own missions in events ─────────────────────────

do $$
begin
  if to_regprocedure('chase._ev_start_base(uuid,text,text)') is null then
    alter function chase._ev_start(uuid, text, text) rename to _ev_start_base;
  end if;
  if to_regprocedure('chase._mode_tick_team(uuid,uuid,geography)') is null then
    alter function chase._mode_tick(uuid, uuid, geography) rename to _mode_tick_team;
  end if;
  if to_regprocedure('chase._purge_expired_base()') is null then
    alter function chase.purge_expired() rename to _purge_expired_base;
  end if;
end $$;

create or replace function chase._ev_start(p_session uuid, p_kind text, p_by text)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_r  jsonb := chase._ev_start_base(p_session, p_kind, p_by);
  v_m  jsonb;
  v_tx text;
begin
  if p_kind = 'mission' and coalesce((v_r ->> 'ok')::boolean, false) then
    select plan -> 'missions' into v_m from chase.sessions where id = p_session;
    if jsonb_typeof(v_m) = 'array' and jsonb_array_length(v_m) > 0 then
      v_tx := v_m ->> floor(random() * jsonb_array_length(v_m))::int;
      update chase.rounds r set state = jsonb_set(r.state, '{ev,mission_text}', to_jsonb(v_tx))
        from chase.sessions s
       where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx;
      v_r := jsonb_set(v_r, '{ev,mission_text}', to_jsonb(v_tx));
    end if;
  end if;
  return v_r;
end;
$$;

create or replace function chase._mode_tick(p_player uuid, p_session uuid, p_pos geography)
returns jsonb
language plpgsql
set search_path = chase, extensions, public
as $$
declare
  v_out jsonb := chase._mode_tick_team(p_player, p_session, p_pos);
  v_ev  jsonb;
begin
  if jsonb_typeof(v_out -> 'event') = 'object' and v_out -> 'event' ->> 'kind' = 'mission' then
    v_ev := chase._ev_of(p_session);
    if v_ev ? 'mission_text' and v_ev ->> 'no' = v_out -> 'event' ->> 'no' then
      v_out := jsonb_set(v_out, '{event,mission_text}', v_ev -> 'mission_text');
    end if;
  end if;
  return v_out;
end;
$$;

-- ───────────────────────── purge: unused libraries ─────────────────────────

create or replace function chase.purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = chase, extensions, public
as $$
declare
  v_r jsonb := chase._purge_expired_base();
  v_n int;
begin
  with d as (delete from chase.teachers
              where last_seen_at < now() - make_interval(days => chase.kb('teacher_idle_d')::int) returning 1)
  select count(*) into v_n from d;
  return v_r || jsonb_build_object('teachers', v_n);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on chase.shares from public, anon, authenticated;
revoke execute on all functions in schema chase from public, anon, authenticated;
grant execute on all functions in schema chase to service_role;
