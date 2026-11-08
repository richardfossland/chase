-- Assertions for 0002_session_tick_safety.sql. Runs in scripts/test-db.sh.
--
-- now() is frozen inside a transaction, so "time passing" is simulated by
-- shifting a player's / session's stored timestamps into the past.
--
-- Test area: ~100 × 100 m square in Oslo. 1 m ≈ 0.00000898° lat, ≈ 0.00001793° lng.
--   lat 59.91 … 59.9109, lng 10.75 … 10.7518, centre (59.91045, 10.7509).
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

create function pg_temp.square() returns jsonb language sql as $$
  select '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}'::jsonb
$$;
create function pg_temp.assembly() returns jsonb language sql as
  $$ select '{"type":"Point","coordinates":[10.7509,59.91045]}'::jsonb $$;

-- Shift everything time-related for one session N seconds into the past.
create function pg_temp.age(p_session uuid, p_secs int) returns void language sql as $$
  update chase.player_live set
    fix_at = fix_at - make_interval(secs => p_secs),
    last_good_at = last_good_at - make_interval(secs => p_secs),
    still_since = still_since - make_interval(secs => p_secs),
    outside_since = outside_since - make_interval(secs => p_secs)
   where session_id = p_session;
  update chase.sessions set
    live_since = live_since - make_interval(secs => p_secs),
    round_started_at = round_started_at - make_interval(secs => p_secs),
    created_at = created_at - make_interval(secs => p_secs)
   where id = p_session;
  update chase.alarms set acked_at = acked_at - make_interval(secs => p_secs)
   where session_id = p_session and acked_at is not null;
$$;

-- New session + started game with one joined player; returns ids.
create function pg_temp.setup(p_tag text, p_forbidden jsonb default null, p_start boolean default true)
returns table (session_id uuid, player_id uuid, host text, tok text) language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), pg_temp.h('teacher-' || p_tag),
                            pg_temp.square(), pg_temp.assembly(), p_forbidden,
                            p_teacher_phone => '+47 912 34 567');
  assert (r ->> 'ok')::boolean, 'setup create_session: ' || r::text;
  j := chase.join_session(r ->> 'pin', 'P-' || p_tag, pg_temp.h('tok-' || p_tag), pg_temp.h('res-' || p_tag), 'dev-' || p_tag);
  assert (j ->> 'ok')::boolean, 'setup join: ' || j::text;
  if p_start then
    assert (chase.host_action((r ->> 'session_id')::uuid, pg_temp.h('host-' || p_tag), 'start') ->> 'ok')::boolean, 'setup start';
  end if;
  return query select (r ->> 'session_id')::uuid, (j ->> 'player_id')::uuid, pg_temp.h('host-' || p_tag), pg_temp.h('tok-' || p_tag);
end $$;

-- ───────────────────────── create_session ─────────────────────────
do $$
declare r jsonb; r2 jsonb; t1 uuid; t2 uuid;
begin
  assert chase.create_session('short', null, pg_temp.square(), pg_temp.assembly()) ->> 'error' = 'bad_token', 'short token';
  assert chase.create_session(pg_temp.h('x'), null, '{"type":"Point","coordinates":[10,59]}', pg_temp.assembly()) ->> 'error' = 'bad_boundary', 'point boundary';
  assert chase.create_session(pg_temp.h('x'), null, '{"nonsense":1}', pg_temp.assembly()) ->> 'error' = 'bad_boundary', 'garbage boundary';
  assert chase.create_session(pg_temp.h('x'), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7501,59.91],[10.7501,59.9101],[10.75,59.9101],[10.75,59.91]]]}',
    pg_temp.assembly()) ->> 'error' = 'area_size', 'tiny area';
  assert chase.create_session(pg_temp.h('x'), null, pg_temp.square(),
    '{"type":"Point","coordinates":[10.80,59.91]}') ->> 'error' = 'assembly_far', 'assembly far away';
  assert chase.create_session(pg_temp.h('x'), null, pg_temp.square(), pg_temp.assembly(),
    p_teacher_phone => 'ring meg') ->> 'error' = 'bad_phone', 'bad phone';

  r := chase.create_session(pg_temp.h('c1'), pg_temp.h('teacher-c'), pg_temp.square(), pg_temp.assembly(),
                            p_teacher_phone => '912 34 567');
  assert (r ->> 'ok')::boolean and (r ->> 'pin') ~ '^[0-9]{6}$', 'create ok + pin: ' || r::text;
  assert abs((r ->> 'area_m2')::numeric - 10000) < 300, 'area ~1 ha: ' || (r ->> 'area_m2');
  assert (select teacher_phone from chase.sessions where id = (r ->> 'session_id')::uuid) = '91234567', 'phone normalised';
  r2 := chase.create_session(pg_temp.h('c2'), pg_temp.h('teacher-c'), pg_temp.square(), pg_temp.assembly());
  select teacher_id into t1 from chase.sessions where id = (r ->> 'session_id')::uuid;
  select teacher_id into t2 from chase.sessions where id = (r2 ->> 'session_id')::uuid;
  assert t1 = t2 and t1 is not null, 'same lærernøkkel → same teacher';
  assert (r ->> 'pin') <> (r2 ->> 'pin'), 'distinct active PINs';
  assert (select host_token_hash from chase.sessions where id = (r ->> 'session_id')::uuid) = pg_temp.h('c1'), 'host hash stored';
  raise notice '0002 create_session: ok';
end $$;

-- ───────────────────────── join / resume ─────────────────────────
do $$
declare r jsonb; j jsonb; s uuid; pin text; v jsonb;
begin
  r := chase.create_session(pg_temp.h('j-host'), null, pg_temp.square(), pg_temp.assembly());
  s := (r ->> 'session_id')::uuid; pin := r ->> 'pin';

  assert chase.join_session('000000', 'Lyn', pg_temp.h('a'), pg_temp.h('ra')) ->> 'error' in ('no_session'), 'unknown pin';
  assert chase.join_session(pin, '   ', pg_temp.h('a'), pg_temp.h('ra')) ->> 'error' = 'bad_nickname', 'blank nick';
  assert chase.join_session(pin, repeat('x', 21), pg_temp.h('a'), pg_temp.h('ra')) ->> 'error' = 'bad_nickname', 'long nick';
  assert chase.join_session(pin, 'Lyn', 'short', pg_temp.h('ra')) ->> 'error' = 'bad_token', 'short token';

  j := chase.join_session(pin, '  Lyn   Rask ', pg_temp.h('a'), pg_temp.h('ra'), 'dev-a');
  assert (j ->> 'ok')::boolean and j ->> 'nickname' = 'Lyn Rask', 'join + trim: ' || j::text;
  assert exists (select 1 from chase.player_stats where player_id = (j ->> 'player_id')::uuid), 'stats row created';
  assert chase.join_session(pin, 'lyn rask', pg_temp.h('b'), pg_temp.h('rb')) ->> 'error' = 'nickname_taken', 'nick case-insensitive';
  assert (select token_hash from chase.players where id = (j ->> 'player_id')::uuid) = pg_temp.h('a'), 'token stored as hash';

  -- Resume rotates the token; the old one stops working.
  v := chase.resume_player(pin, pg_temp.h('ra'), pg_temp.h('a2'));
  assert (v ->> 'ok')::boolean and v ->> 'player_id' = j ->> 'player_id', 'resume: ' || v::text;
  assert chase.player_bootstrap((j ->> 'player_id')::uuid, pg_temp.h('a')) ->> 'error' = 'auth', 'old token dead';
  assert (chase.player_bootstrap((j ->> 'player_id')::uuid, pg_temp.h('a2')) ->> 'ok')::boolean, 'new token works';
  assert chase.resume_player(pin, pg_temp.h('nope'), pg_temp.h('a3')) ->> 'error' = 'not_found', 'wrong resume code';

  -- Kicked players cannot come back on the same device or by resume code.
  assert (chase.host_action(s, pg_temp.h('j-host'), 'kick', jsonb_build_object('player_id', j ->> 'player_id')) ->> 'ok')::boolean, 'kick';
  assert chase.join_session(pin, 'Ny', pg_temp.h('c'), pg_temp.h('rc'), 'dev-a') ->> 'error' = 'kicked', 'kicked device';
  assert chase.resume_player(pin, pg_temp.h('ra'), pg_temp.h('a4')) ->> 'error' = 'kicked', 'kicked resume';
  assert chase.tick((j ->> 'player_id')::uuid, pg_temp.h('a2'), 59.91045, 10.7509, 5) ->> 'error' = 'kicked', 'kicked tick';

  -- Player cap (60 active).
  for i in 1..60 loop
    assert (chase.join_session(pin, 'B' || i, pg_temp.h('bot' || i), pg_temp.h('rbot' || i)) ->> 'ok')::boolean, 'bot join ' || i;
  end loop;
  assert chase.join_session(pin, 'B61', pg_temp.h('bot61'), pg_temp.h('rbot61')) ->> 'error' = 'full', 'cap 60';
  raise notice '0002 join/resume: ok';
end $$;

-- ───────────────────────── geofence 1–3 ─────────────────────────
do $$
declare x record; t jsonb; snap jsonb; a jsonb;
begin
  select * into x from pg_temp.setup('geo');

  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert (t ->> 'ok')::boolean and (t -> 'safety' ->> 'geofence')::int = 0, 'centre = level 0: ' || t::text;
  t := chase.tick(x.player_id, x.tok, 59.9100449, 10.7509, 5);          -- 5 m inside south edge
  assert (t -> 'safety' ->> 'geofence')::int = 1, 'near edge = level 1';
  t := chase.tick(x.player_id, x.tok, 59.9099820, 10.7509, 5);          -- ~2 m outside, acc 5
  assert (t -> 'safety' ->> 'geofence')::int = 1, 'outside within acc = level 1';
  t := chase.tick(x.player_id, x.tok, 59.9098204, 10.7509, 5);          -- 20 m outside
  assert (t -> 'safety' ->> 'geofence')::int = 2, 'outside beyond acc = level 2';
  assert not (t ->> 'alert_host')::boolean, 'level 2 does not alert yet';
  assert not exists (select 1 from chase.alarms where player_id = x.player_id), 'no alarm at level 2';

  perform pg_temp.age(x.session_id, 31);                                -- 31 s outside
  t := chase.tick(x.player_id, x.tok, 59.9098204, 10.7509, 5);
  assert (t -> 'safety' ->> 'geofence')::int = 3, 'outside > 30 s = level 3';
  assert (t ->> 'alert_host')::boolean, 'level 3 alerts host';
  assert (select level from chase.alarms where player_id = x.player_id and kind = 'outside' and resolved_at is null) = 1, 'outside alarm level 1';
  t := chase.tick(x.player_id, x.tok, 59.9098204, 10.7509, 5);
  assert not (t ->> 'alert_host')::boolean, 'no repeat alert for the same open alarm';

  -- Teacher acks, then the player runs further: escalation re-alerts.
  snap := chase.host_snapshot(x.session_id, x.host);
  a := snap -> 'alarms' -> 0;
  assert a ->> 'kind' = 'outside' and not (a ->> 'acked')::boolean, 'strip shows outside: ' || snap::text;
  assert (chase.ack_alarm(x.session_id, (a ->> 'id')::uuid, x.host) ->> 'ok')::boolean, 'ack outside';
  t := chase.tick(x.player_id, x.tok, 59.9090, 10.7509, 5);             -- ~112 m outside
  assert (t ->> 'alert_host')::boolean, 'escalation > 100 m re-alerts';
  assert (select level from chase.alarms where player_id = x.player_id and kind = 'outside' and resolved_at is null) = 2, 'escalated to high';
  assert (select acked_at from chase.alarms where player_id = x.player_id and kind = 'outside' and resolved_at is null) is null, 'escalation clears ack';

  -- Back inside: resolved, but stays in the strip until acked (nothing disappears unseen).
  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert (t -> 'safety' ->> 'geofence')::int = 0, 'back inside';
  snap := chase.host_snapshot(x.session_id, x.host);
  a := snap -> 'alarms' -> 0;
  assert a ->> 'kind' = 'outside' and (a ->> 'resolved')::boolean and not (a ->> 'acked')::boolean, 'resolved but unacked stays: ' || snap::text;
  perform chase.ack_alarm(x.session_id, (a ->> 'id')::uuid, x.host);
  assert jsonb_array_length(chase.host_snapshot(x.session_id, x.host) -> 'alarms') = 0, 'acked + resolved leaves the strip';

  -- 40 m rule: far outside alarms immediately, without waiting 30 s.
  t := chase.tick(x.player_id, x.tok, 59.9095, 10.7509, 5);             -- ~56 m outside
  assert (t -> 'safety' ->> 'geofence')::int = 3 and (t ->> 'alert_host')::boolean, 'over 40 m = immediate level 3';

  -- Wrong host token sees nothing.
  assert chase.host_snapshot(x.session_id, pg_temp.h('evil')) ->> 'error' = 'auth', 'host auth';
  raise notice '0002 geofence: ok';
end $$;

-- ───────────────────────── forbidden zones ─────────────────────────
do $$
declare x record; t jsonb;
begin
  -- 20 × 20 m forbidden square inside the area (NE quadrant).
  select * into x from pg_temp.setup('forb',
    '{"type":"Polygon","coordinates":[[[10.7510,59.9105],[10.75136,59.9105],[10.75136,59.91068],[10.7510,59.91068],[10.7510,59.9105]]]}');

  t := chase.tick(x.player_id, x.tok, 59.91059, 10.7508207, 5);         -- 10 m west of it, acc 5
  assert not (t -> 'safety' ->> 'forbidden')::boolean, '10 m away with acc 5 = outside zone';
  t := chase.tick(x.player_id, x.tok, 59.91059, 10.7508207, 12);        -- same spot, acc 12 → possibly inside
  assert (t -> 'safety' ->> 'forbidden')::boolean, 'possibly inside (acc 12 ≥ 10 m) counts';
  assert (t ->> 'alert_host')::boolean, 'forbidden alerts immediately';
  assert (select level from chase.alarms where player_id = x.player_id and kind = 'forbidden' and resolved_at is null) = 2, 'forbidden is high';

  t := chase.tick(x.player_id, x.tok, 59.91059, 10.7508207, 40);        -- acc 40: margin capped at 15 m
  assert (t -> 'safety' ->> 'forbidden')::boolean, 'still in (10 m < 15 m cap)';
  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7505, 40);           -- ~28 m away, acc 40
  assert not (t -> 'safety' ->> 'forbidden')::boolean, 'margin capped at 15 m';
  assert (select resolved_at from chase.alarms where player_id = x.player_id and kind = 'forbidden') is not null, 'resolved when out';

  -- Safety runs during pause too.
  perform chase.host_action(x.session_id, x.host, 'pause');
  t := chase.tick(x.player_id, x.tok, 59.91059, 10.7511, 5);            -- inside the zone
  assert t ->> 'status' = 'paused' and (t -> 'safety' ->> 'forbidden')::boolean and (t ->> 'alert_host')::boolean, 'forbidden during pause';
  raise notice '0002 forbidden: ok';
end $$;

-- ───────────────────────── lobby: no alarms ─────────────────────────
do $$
declare x record; t jsonb;
begin
  select * into x from pg_temp.setup('lobby', null, false);
  t := chase.tick(x.player_id, x.tok, 59.9090, 10.7509, 5);             -- far outside in lobby
  assert t ->> 'status' = 'lobby' and (t -> 'safety' ->> 'geofence')::int >= 2, 'lobby still reports geofence';
  assert not exists (select 1 from chase.alarms where session_id = x.session_id), 'no alarms in lobby';
  perform pg_temp.age(x.session_id, 120);
  assert jsonb_array_length(chase.host_snapshot(x.session_id, x.host) -> 'alarms') = 0, 'no signal alarm in lobby';
  raise notice '0002 lobby: ok';
end $$;

-- ───────────────────────── distance + active seconds ─────────────────────────
do $$
declare x record; t jsonb; d real; a real;
begin
  select * into x from pg_temp.setup('dist');
  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);         -- anchor
  perform pg_temp.age(x.session_id, 4);
  t := chase.tick(x.player_id, x.tok, 59.9105398, 10.7509, 5);          -- 10 m north in 4 s = 2.5 m/s
  select distance_m, active_s into d, a from chase.player_stats where player_id = x.player_id;
  assert abs(d - 10) < 0.5, 'distance ~10 m: ' || d;
  assert abs(a - 4) < 0.01, 'active 4 s: ' || a;

  perform pg_temp.age(x.session_id, 2);
  perform chase.tick(x.player_id, x.tok, 59.9105488, 10.7509, 5);       -- 1 m jitter
  assert (select distance_m from chase.player_stats where player_id = x.player_id) = d, 'jitter ignored';

  perform pg_temp.age(x.session_id, 4);
  perform chase.tick(x.player_id, x.tok, 59.910001, 10.7509, 5);        -- ~60 m in ~6 s → too fast
  assert (select distance_m from chase.player_stats where player_id = x.player_id) = d, 'teleport ignored';

  perform pg_temp.age(x.session_id, 4);
  perform chase.tick(x.player_id, x.tok, 59.9101808, 10.7509, 30);      -- bad accuracy
  assert (select distance_m from chase.player_stats where player_id = x.player_id) = d, 'acc > 25 ignored';

  perform pg_temp.age(x.session_id, 40);
  perform chase.tick(x.player_id, x.tok, 59.9103604, 10.7509, 5);       -- 40 s gap → restart anchor
  assert (select distance_m from chase.player_stats where player_id = x.player_id) = d, 'gap restarts, no count';

  perform pg_temp.age(x.session_id, 10);
  perform chase.tick(x.player_id, x.tok, 59.9103784, 10.7509, 5);       -- 2 m in 10 s: walking slowly, below gate
  perform pg_temp.age(x.session_id, 10);
  perform chase.tick(x.player_id, x.tok, 59.9104053, 10.7509, 5);       -- 5 m total in 20 s = 0.25 m/s
  select distance_m, active_s into d, a from chase.player_stats where player_id = x.player_id;
  assert abs(d - 15) < 0.6, 'slow walk counts distance: ' || d;
  assert abs(a - 4) < 0.01, 'slow walk is not active time: ' || a;

  -- Paused: no game accounting.
  perform chase.host_action(x.session_id, x.host, 'pause');
  perform pg_temp.age(x.session_id, 4);
  perform chase.tick(x.player_id, x.tok, 59.9104951, 10.7509, 5);       -- 10 m in 4 s
  assert (select distance_m from chase.player_stats where player_id = x.player_id) = d, 'no distance while paused';
  assert (select pause_accum from chase.sessions where id = x.session_id) = interval '0', 'pause_accum before resume';
  perform chase.host_action(x.session_id, x.host, 'resume');
  assert (select status from chase.sessions where id = x.session_id) = 'live', 'resume back to live';

  -- Stale (reordered) ticks are dropped.
  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5, null, '2026-11-08 10:00:02+00');
  assert chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5, null, '2026-11-08 10:00:01+00') ->> 'error' = 'stale', 'stale tick';
  assert chase.tick(x.player_id, pg_temp.h('evil'), 59.91045, 10.7509, 5) ->> 'error' = 'auth', 'tick auth';
  -- A valid token sent to another session's route: rejected before any write.
  assert chase.tick(x.player_id, x.tok, 59.9090, 10.7509, 5, null, null, gen_random_uuid()) ->> 'error' = 'not_found', 'tick session mismatch';
  assert (select geofence_state from chase.player_live where player_id = x.player_id) = 0, 'mismatch wrote nothing';
  assert chase.raise_sos(x.player_id, x.tok, null, null, gen_random_uuid()) ->> 'error' = 'not_found', 'sos session mismatch';
  assert chase.player_bootstrap(x.player_id, x.tok, gen_random_uuid()) ->> 'error' = 'not_found', 'bootstrap session mismatch';
  assert (chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5, null, null, x.session_id) ->> 'ok')::boolean, 'matching session ok';
  raise notice '0002 distance/active: ok';
end $$;

-- ───────────────────────── signal loss ─────────────────────────
do $$
declare x record; snap jsonb; j jsonb; p2 uuid;
begin
  select * into x from pg_temp.setup('sig');
  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  -- A second player who never sent a fix.
  j := chase.join_session((select join_pin from chase.sessions where id = x.session_id), 'Stille',
                          pg_temp.h('sig2'), pg_temp.h('rsig2'));
  p2 := (j ->> 'player_id')::uuid;

  perform pg_temp.age(x.session_id, 25);
  snap := chase.host_snapshot(x.session_id, x.host);
  assert (select p ->> 'signal' from jsonb_array_elements(snap -> 'players') p where p ->> 'id' = x.player_id::text) = 'uncertain', '25 s = uncertain';
  assert jsonb_array_length(snap -> 'alarms') = 0, 'no signal alarm before 60 s';

  perform pg_temp.age(x.session_id, 40);                                -- 65 s
  snap := chase.host_snapshot(x.session_id, x.host);
  assert (snap ->> 'alert_host')::boolean, 'signal loss alerts host';
  assert (select count(*) from jsonb_array_elements(snap -> 'alarms') a where a ->> 'kind' = 'signal') = 2, 'both players lost (incl. never-fixed): ' || snap::text;
  assert (select a -> 'pos' from jsonb_array_elements(snap -> 'alarms') a where a ->> 'player_id' = x.player_id::text) is not null, 'last known position on alarm';
  assert not (chase.host_snapshot(x.session_id, x.host) ->> 'alert_host')::boolean, 'no repeat alert';

  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);         -- GPS back
  assert (select resolved_at from chase.alarms where player_id = x.player_id and kind = 'signal') is not null, 'fix resolves signal alarm';

  -- Sitting out: exempt from signal alarms (injured, phone away).
  perform chase.host_action(x.session_id, x.host, 'sit_out', jsonb_build_object('player_id', p2));
  update chase.alarms set acked_at = now() where player_id = p2;
  update chase.alarms set resolved_at = now() where player_id = p2;
  perform pg_temp.age(x.session_id, 120);
  perform chase.host_snapshot(x.session_id, x.host);
  assert not exists (select 1 from chase.alarms where player_id = p2 and resolved_at is null), 'sitting_out exempt';

  -- Resume after pause resets the reference: no instant false alarm.
  perform chase.host_action(x.session_id, x.host, 'pause');
  perform pg_temp.age(x.session_id, 300);
  perform chase.host_action(x.session_id, x.host, 'resume');
  update chase.alarms set acked_at = now(), resolved_at = now() where session_id = x.session_id;
  snap := chase.host_snapshot(x.session_id, x.host);
  assert jsonb_array_length(snap -> 'alarms') = 0, 'no signal alarm right after resume: ' || snap::text;
  raise notice '0002 signal: ok';
end $$;

-- ───────────────────────── SOS ─────────────────────────
do $$
declare x record; r jsonb; t jsonb; ack jsonb; snap jsonb;
begin
  select * into x from pg_temp.setup('sos');
  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  r := chase.raise_sos(x.player_id, x.tok);
  assert (r ->> 'ok')::boolean and (r ->> 'new')::boolean, 'sos raised: ' || r::text;
  assert not (chase.raise_sos(x.player_id, x.tok) ->> 'new')::boolean, 'double press = same alarm';
  assert (select pos from chase.alarms where id = (r ->> 'alarm_id')::uuid) is not null, 'sos has position';

  -- SOS goes to the top of the strip, above other alarms.
  perform chase.tick(x.player_id, x.tok, 59.9090, 10.7509, 5);          -- also far outside
  snap := chase.host_snapshot(x.session_id, x.host);
  assert snap -> 'alarms' -> 0 ->> 'kind' = 'sos', 'sos first: ' || snap::text;

  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert t -> 'sos' ->> 'acked' = 'false', 'player sees pending sos';
  assert (select resolved_at from chase.alarms where id = (r ->> 'alarm_id')::uuid) is null, 'sos never auto-resolves';

  assert chase.ack_alarm(x.session_id, (r ->> 'alarm_id')::uuid, pg_temp.h('evil')) ->> 'error' = 'auth', 'ack auth';
  ack := chase.ack_alarm(x.session_id, (r ->> 'alarm_id')::uuid, x.host);
  assert (ack ->> 'ok')::boolean and ack ->> 'player_id' = x.player_id::text, 'ack returns player for broadcast';
  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert t -> 'sos' ->> 'acked' = 'true', 'player sees «Læreren har sett det»';
  perform pg_temp.age(x.session_id, 61);
  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert t -> 'sos' is null or t -> 'sos' = 'null'::jsonb, 'sos card gone a minute after ack';

  -- Works with a fix sent along, and in the lobby too.
  r := chase.raise_sos(x.player_id, x.tok, 59.9105, 10.751);
  assert (r ->> 'new')::boolean, 'new sos after ack';
  raise notice '0002 sos: ok';
end $$;

-- ───────────────────────── messages + host actions ─────────────────────────
do $$
declare x record; j jsonb; p2 uuid; t jsonb;
begin
  select * into x from pg_temp.setup('msg');
  j := chase.join_session((select join_pin from chase.sessions where id = x.session_id), 'Andre',
                          pg_temp.h('msg2'), pg_temp.h('rmsg2'));
  p2 := (j ->> 'player_id')::uuid;

  assert (chase.host_action(x.session_id, x.host, 'message', '{"text":"2 minutter igjen"}') ->> 'ok')::boolean, 'msg all';
  assert (chase.host_action(x.session_id, x.host, 'message', jsonb_build_object('text', 'Kom tilbake', 'player_id', x.player_id)) ->> 'ok')::boolean, 'msg private';
  assert chase.host_action(x.session_id, x.host, 'message', '{"text":""}') ->> 'error' = 'bad_text', 'empty msg';
  t := chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert jsonb_array_length(t -> 'messages') = 2, 'player 1 sees both: ' || (t -> 'messages')::text;
  t := chase.tick(p2, pg_temp.h('msg2'), 59.91045, 10.7509, 5);
  assert jsonb_array_length(t -> 'messages') = 1 and t -> 'messages' -> 0 ->> 'text' = '2 minutter igjen', 'player 2 only sees broadcast';

  assert (chase.host_action(x.session_id, x.host, 'rename', jsonb_build_object('player_id', p2, 'nickname', 'Ny')) ->> 'ok')::boolean, 'rename';
  assert chase.host_action(x.session_id, x.host, 'rename', jsonb_build_object('player_id', p2, 'nickname', 'p-MSG')) ->> 'error' = 'nickname_taken', 'rename clash';
  assert chase.host_action(x.session_id, x.host, 'start') ->> 'error' = 'bad_state', 'cannot start twice';
  assert chase.host_action(x.session_id, x.host, 'resume') ->> 'error' = 'bad_state', 'resume when live';
  assert chase.host_action(x.session_id, x.host, 'explode') ->> 'error' = 'unknown_action', 'unknown action';
  assert chase.host_action(x.session_id, pg_temp.h('evil'), 'pause') ->> 'error' = 'auth', 'host_action auth';
  assert not exists (select 1 from chase.events where session_id = x.session_id and type like 'host:%' and payload ? 'text'), 'audit log holds no message text';
  raise notice '0002 messages/host: ok';
end $$;

-- ───────────────────────── gather, roll call, end_session wipe ─────────────────────────
do $$
declare x record; j jsonb; p2 uuid; e jsonb; t jsonb; s jsonb; n int;
begin
  select * into x from pg_temp.setup('end',
    '{"type":"Polygon","coordinates":[[[10.7510,59.9105],[10.75136,59.9105],[10.75136,59.91068],[10.7510,59.91068],[10.7510,59.9105]]]}');
  j := chase.join_session((select join_pin from chase.sessions where id = x.session_id), 'Borte',
                          pg_temp.h('end2'), pg_temp.h('rend2'));
  p2 := (j ->> 'player_id')::uuid;
  perform pg_temp.age(x.session_id, 600);                               -- 10 min game
  perform chase.tick(x.player_id, x.tok, 59.91059, 10.7511, 5);         -- forbidden → alarm with pos
  perform chase.tick(p2, pg_temp.h('end2'), 59.9101, 10.7501, 5);
  perform chase.raise_sos(p2, pg_temp.h('end2'));

  assert (chase.host_action(x.session_id, x.host, 'gather') ->> 'status') = 'gathering', 'gather';
  t := chase.tick(x.player_id, x.tok, 59.91050, 10.7509, 8);            -- ~5 m from assembly point
  assert (t -> 'gather' ->> 'checked_in')::boolean, 'auto check-in near assembly';
  t := chase.tick(p2, pg_temp.h('end2'), 59.9101, 10.7501, 5);          -- ~60 m away
  assert not (t -> 'gather' ->> 'checked_in')::boolean and (t -> 'gather' ->> 'distance_m')::numeric > 25, 'far player not checked in';

  e := chase.end_session(x.session_id, x.host);
  assert e ->> 'error' = 'missing' and jsonb_array_length(e -> 'missing') = 1
     and e -> 'missing' -> 0 ->> 'nickname' = 'Borte', 'roll call blocks end: ' || e::text;
  assert chase.end_session(x.session_id, pg_temp.h('evil')) ->> 'error' = 'auth', 'end auth';

  -- Manual check-in clears the block.
  perform chase.host_action(x.session_id, x.host, 'check_in', jsonb_build_object('player_id', p2));
  select count(*) into n from chase.session_summaries;
  e := chase.end_session(x.session_id, x.host);
  assert (e ->> 'ok')::boolean, 'end ok: ' || e::text;

  -- PLAN §8 / phase 1 «Ferdig når»: positions, alarm positions and phone are gone.
  assert not exists (select 1 from chase.player_live where session_id = x.session_id), 'player_live empty after end';
  assert exists (select 1 from chase.alarms where session_id = x.session_id), 'alarms kept (without pos)';
  assert not exists (select 1 from chase.alarms where session_id = x.session_id and pos is not null), 'alarm positions nulled';
  assert (select teacher_phone from chase.sessions where id = x.session_id) is null, 'teacher phone nulled';
  assert (select status from chase.sessions where id = x.session_id) = 'ended', 'status ended';
  assert (select count(*) from chase.session_summaries) = n + 1, 'summary written';
  select to_jsonb(ss) into s from chase.session_summaries ss order by created_at desc, id limit 1;
  assert (s ->> 'player_count')::int = 2 and (s ->> 'duration_s')::int between 590 and 620, 'summary content: ' || s::text;
  assert not exists (select 1 from jsonb_object_keys(s) k where k in ('boundary','nickname','pos')), 'summary has no geometry or names';

  assert chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5) ->> 'error' = 'ended', 'tick after end';
  assert chase.raise_sos(x.player_id, x.tok) ->> 'error' = 'ended', 'sos after end';
  assert chase.host_action(x.session_id, x.host, 'pause') ->> 'error' = 'ended', 'host action after end';
  assert (chase.end_session(x.session_id, x.host) ->> 'already')::boolean, 'end idempotent';
  -- The PIN is free again.
  assert not exists (select 1 from chase.sessions where join_pin = (select join_pin from chase.sessions where id = x.session_id) and status <> 'ended'), 'pin released';
  raise notice '0002 end_session: ok';
end $$;

-- Force end without roll call; lobby end needs no roll call.
do $$
declare x record; y record; e jsonb;
begin
  select * into x from pg_temp.setup('force');
  perform chase.tick(x.player_id, x.tok, 59.91045, 10.7509, 5);
  assert chase.end_session(x.session_id, x.host) ->> 'error' = 'missing', 'needs roll call';
  assert (chase.end_session(x.session_id, x.host, true) ->> 'ok')::boolean, 'force end';
  assert exists (select 1 from chase.events where session_id = x.session_id and type = 'end_forced'), 'forced end logged';
  assert not exists (select 1 from chase.player_live where session_id = x.session_id), 'forced end wipes too';

  select * into y from pg_temp.setup('lobbyend', null, false);
  assert (chase.end_session(y.session_id, y.host) ->> 'ok')::boolean, 'lobby end without roll call';
  raise notice '0002 force end: ok';
end $$;

-- ───────────────────────── purge_expired + pg_cron ─────────────────────────
do $$
declare old record; done record; fresh record; r jsonb;
begin
  select * into old   from pg_temp.setup('purge-old');
  select * into done  from pg_temp.setup('purge-done');
  select * into fresh from pg_temp.setup('purge-fresh');
  perform chase.tick(old.player_id, old.tok, 59.91045, 10.7509, 5);
  perform chase.tick(fresh.player_id, fresh.tok, 59.91045, 10.7509, 5);
  update chase.sessions set created_at = now() - interval '5 hours' where id = old.session_id;
  perform chase.end_session(done.session_id, done.host, true);
  update chase.sessions set ended_at = now() - interval '25 hours' where id = done.session_id;

  r := chase.purge_expired();
  assert (r ->> 'ended')::int >= 1 and (r ->> 'deleted')::int >= 1, 'purge counts: ' || r::text;
  assert (select status from chase.sessions where id = old.session_id) = 'ended', 'abandoned >4 h ended';
  assert not exists (select 1 from chase.player_live where session_id = old.session_id), 'abandoned positions wiped';
  assert not exists (select 1 from chase.sessions where id = done.session_id), 'ended >24 h deleted';
  assert not exists (select 1 from chase.players where session_id = done.session_id), 'players deleted';
  assert not exists (select 1 from chase.events where session_id = done.session_id), 'events deleted';
  assert (select status from chase.sessions where id = fresh.session_id) = 'live', 'fresh session untouched';
  assert exists (select 1 from chase.player_live where session_id = fresh.session_id), 'fresh positions untouched';

  assert exists (select 1 from cron.job where jobname = 'chase-purge-expired' and schedule = '*/15 * * * *'), 'pg_cron job scheduled';
  assert (select count(*) from cron.job where jobname = 'chase-purge-expired') = 1, 'scheduled once (idempotent)';
  raise notice '0002 purge: ok';
end $$;

-- ───────────────────────── privileges ─────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'chase.create_session(text,text,jsonb,jsonb,jsonb,jsonb,jsonb,text,boolean)',
    'chase.join_session(text,text,text,text,text)',
    'chase.resume_player(text,text,text)',
    'chase.player_bootstrap(uuid,text,uuid)',
    'chase.tick(uuid,text,double precision,double precision,real,real,timestamptz,uuid)',
    'chase.raise_sos(uuid,text,double precision,double precision,uuid)',
    'chase.ack_alarm(uuid,uuid,text)',
    'chase.host_action(uuid,text,text,jsonb)',
    'chase.host_snapshot(uuid,text,boolean)',
    'chase.end_session(uuid,text,boolean)',
    'chase.purge_expired()'
  ] loop
    assert not has_function_privilege('anon', f, 'EXECUTE'), 'anon must not execute ' || f;
    assert not has_function_privilege('authenticated', f, 'EXECUTE'), 'authenticated must not execute ' || f;
    assert has_function_privilege('service_role', f, 'EXECUTE'), 'service_role executes ' || f;
    assert (select prosecdef from pg_proc where oid = f::regprocedure), f || ' must be security definer';
  end loop;
  assert (select relpersistence from pg_class where oid = 'chase.player_live'::regclass) = 'u', 'player_live still UNLOGGED';
  raise notice '0002 privileges: ALL ASSERTIONS PASSED';
end $$;

truncate chase.sessions, chase.teachers, chase.session_summaries cascade;
