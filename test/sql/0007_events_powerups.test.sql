-- Assertions for 0007_events_powerups.sql. Runs in scripts/test-db.sh.
-- Same ~100 × 100 m Oslo square as the other tests. now() is constant inside
-- a DO block, so time is moved by editing the stored timestamps.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.square() returns jsonb language sql as $$
  select '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}'::jsonb
$$;
create function pg_temp.assembly() returns jsonb language sql as
  $$ select '{"type":"Point","coordinates":[10.7509,59.91045]}'::jsonb $$;
create function pg_temp.mk(p_tag text, p_plan jsonb, p_players int) returns uuid language plpgsql as $$
declare r jsonb; j jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null, pg_temp.square(), pg_temp.assembly(), null, p_plan => p_plan);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  for i in 1 .. p_players loop
    j := chase.join_session(r ->> 'pin', p_tag || '-' || i, pg_temp.h('tok-' || p_tag || '-' || i), pg_temp.h('res-' || p_tag || '-' || i));
    assert (j ->> 'ok')::boolean, 'mk join: ' || j::text;
  end loop;
  return (r ->> 'session_id')::uuid;
end $$;
create function pg_temp.pid(p_tag text, p_i int) returns uuid language sql as
  $$ select id from chase.players where token_hash = pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
create function pg_temp.tok(p_tag text, p_i int) returns text language sql as
  $$ select pg_temp.h('tok-' || p_tag || '-' || p_i) $$;
-- At the assembly point unless a position is given.
create function pg_temp.tick(p_tag text, p_i int, p_lat float8 default 59.91045, p_lng float8 default 10.7509, p_acc real default 5)
returns jsonb language sql as $$
  select chase.tick(pg_temp.pid(p_tag, p_i), pg_temp.tok(p_tag, p_i), p_lat, p_lng, p_acc)
$$;
create function pg_temp.act(p_session uuid, p_tag text, p_action text, p_payload jsonb default '{}') returns jsonb language sql as
  $$ select chase.host_action(p_session, pg_temp.h('host-' || p_tag), p_action, p_payload) $$;
create function pg_temp.ev(p_session uuid) returns jsonb language sql as $$
  select r.state -> 'ev' from chase.rounds r join chase.sessions s on s.id = r.session_id and r.idx = s.round_idx where s.id = p_session
$$;
-- Move the current event's clock: ends_at/closes_at → now() + p_s seconds.
create function pg_temp.ev_left(p_session uuid, p_s int) returns void language sql as $$
  update chase.rounds r
     set state = jsonb_set(jsonb_set(r.state, '{ev,ends_at}', to_jsonb(now() + make_interval(secs => p_s))),
                           '{ev,closes_at}', to_jsonb(now() + make_interval(secs => p_s)))
    from chase.sessions s where s.id = p_session and r.session_id = s.id and r.idx = s.round_idx
$$;
create function pg_temp.pu(p_tag text, p_i int, p_session uuid, p_kind text) returns jsonb language sql as
  $$ select chase.use_powerup(pg_temp.pid(p_tag, p_i), pg_temp.tok(p_tag, p_i), p_session, p_kind) $$;

-- ───────────────────────── pure: same vectors as test/events.test.ts ─────────────────────────
do $$
begin
  assert chase._ev_kinds('free', false, false) = array['sprint', 'mission', 'gather'], 'free, teacher';
  assert chase._ev_kinds('free', false, true) = array['sprint', 'gather'], 'free, auto without QR posts';
  assert chase._ev_kinds('free', true, true) = array['sprint', 'mission', 'gather'], 'free, auto with QR posts';
  assert chase._ev_kinds('posts', false, false) = array['sprint', 'mission', 'gather', 'golden'], 'posts, teacher';
  assert chase._ev_kinds('posts', true, true) = array['sprint', 'mission', 'gather'], 'posts, auto: no golden';
  assert chase._ev_kinds('tag', false, false) = array['sprint', 'mission', 'gather', 'storm', 'blackout'], 'tag, teacher';
  assert chase._ev_kinds('tag', false, true) = array['sprint', 'gather', 'storm', 'blackout'], 'tag, auto';
  assert array[chase._ev_dur('sprint'), chase._ev_dur('mission'), chase._ev_dur('gather'), chase._ev_dur('golden'),
               chase._ev_dur('storm'), chase._ev_dur('blackout')] = array[45, 90, 60, 0, 30, 45], 'durations';
  assert chase._ev_prize_pool(true) = array['shield', 'radar', 'decoy', 'turbo'], 'pool with tag ahead';
  assert chase._ev_prize_pool(false) = array['turbo'], 'pool without tag ahead';
  assert chase._pu_check('shield', 'tag', 'prey') is null, 'shield: prey ok';
  assert chase._pu_check('shield', 'tag', 'hunter') = 'not_useful', 'shield: hunter no';
  assert chase._pu_check('shield', 'posts', 'neutral') = 'not_useful', 'shield: posts no';
  assert chase._pu_check('radar', 'tag', 'hunter') is null, 'radar: hunter ok';
  assert chase._pu_check('radar', 'posts', 'neutral') = 'not_useful', 'radar: posts no';
  assert chase._pu_check('decoy', 'tag', 'prey') is null, 'decoy: prey ok';
  assert chase._pu_check('decoy', 'tag', 'hunter') = 'not_useful', 'decoy: hunter no';
  assert chase._pu_check('turbo', 'posts', 'neutral') is null, 'turbo anywhere';
  assert chase._pu_check('turbo', 'tag', 'sitting_out') = 'not_playing', 'sitting out';
  assert chase._pu_check('rocket', 'tag', 'prey') = 'bad_kind', 'unknown';

  -- Plan: event_every_s (0 / absent = off, else 60..300).
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"event_every_s":90}') ->> 'event_every_s' = '90', 'every 90';
  assert not chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"event_every_s":0}') ? 'event_every_s', '0 = off, omitted';
  assert not chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}]}') ? 'event_every_s', 'absent = off';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"event_every_s":30}') is null, 'too often';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"event_every_s":301}') is null, 'too rare';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300}],"event_every_s":"90"}') is null, 'string';
  assert chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":300,"zone":true}],"event_every_s":120}') -> 'rounds' -> 0 ->> 'zone' = 'true',
    'zone flag survives the wrapper';
  raise notice '0007 pure rules + plan: ok';
end $$;

-- ───────────────────────── sprint: 3 winners, prize, end ─────────────────────────
do $$
declare s uuid; r jsonb; t jsonb; ev jsonb; lat float8; lng float8; st chase.player_stats;
begin
  s := pg_temp.mk('sp7', '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}', 5);
  perform pg_temp.act(s, 'sp7', 'start');
  for i in 1 .. 5 loop perform pg_temp.tick('sp7', i); end loop;
  assert (select status from chase.sessions where id = s) = 'live', 'live';

  r := pg_temp.act(s, 'sp7', 'event_start', '{"kind":"storm"}');
  assert r ->> 'error' = 'bad_kind', 'no storm in a free round';
  r := pg_temp.act(s, 'sp7', 'event_start', '{"kind":"sprint"}');
  assert (r ->> 'ok')::boolean, 'sprint starts: ' || r::text;
  assert pg_temp.act(s, 'sp7', 'event_start', '{"kind":"gather"}') ->> 'error' = 'busy', 'one at a time';
  ev := pg_temp.ev(s);
  assert ev ->> 'kind' = 'sprint' and ev -> 'target' ? 'lat', 'target: ' || ev::text;
  lat := (ev -> 'target' ->> 'lat')::float8; lng := (ev -> 'target' ->> 'lng')::float8;

  t := pg_temp.tick('sp7', 1);
  assert t -> 'event' ->> 'kind' = 'sprint' and (t -> 'event' ->> 'dist_m')::int > 0 and t -> 'event' -> 'me' = 'null'::jsonb,
    'phone sees the sprint: ' || (t -> 'event')::text;
  assert (t -> 'event' ->> 'left')::int = 3, '3 places left';
  -- Bad fix at the target does not count.
  t := pg_temp.tick('sp7', 1, lat, lng, 40);
  assert t -> 'event' -> 'me' = 'null'::jsonb, 'fix too poor';
  for i in 1 .. 4 loop perform pg_temp.tick('sp7', i, lat, lng, 5); end loop;
  assert (select count(*) from chase.event_entries where session_id = s) = 3, 'only 3 winners';
  t := pg_temp.tick('sp7', 1, lat, lng, 5);
  assert t -> 'event' -> 'me' ->> 'state' = 'won' and t -> 'event' -> 'me' ->> 'place' = '1'
     and t -> 'event' -> 'me' ->> 'points' = '20' and t -> 'event' -> 'me' ->> 'powerup' = 'turbo',
    'winner 1, free-only plan → turbo: ' || (t -> 'event')::text;
  assert t -> 'power' -> 'inv' = '["turbo"]', 'inventory';
  select * into st from chase.player_stats where player_id = pg_temp.pid('sp7', 1);
  assert st.points >= 20 and 'sprint' = any(st.badges), 'points + badge';
  assert not exists (select 1 from chase.event_entries where player_id = pg_temp.pid('sp7', 4)), 'fourth one too late';
  -- Upkeep closes a full sprint; the result stays visible for a while.
  t := pg_temp.tick('sp7', 5);
  assert (pg_temp.ev(s) ->> 'done')::boolean, 'full sprint ends';
  assert (t -> 'event' ->> 'done')::boolean, 'result still shown';
  assert exists (select 1 from chase.events where session_id = s and type = 'ev_end' and payload ->> 'why' = 'full'), 'logged';
  -- Inventory max 2: a third prize gives points only.
  update chase.player_stats set powerups = '{turbo,turbo}' where player_id = pg_temp.pid('sp7', 5);
  assert chase._ev_award(pg_temp.pid('sp7', 5), 20, true, null) is null, 'full inventory: no power-up';
  assert (select cardinality(powerups) from chase.player_stats where player_id = pg_temp.pid('sp7', 5)) = 2, 'still 2';
  raise notice '0007 sprint: ok';
end $$;

-- ───────────────────────── gather, golden, time-out, too late ─────────────────────────
do $$
declare s uuid; r jsonb; t jsonb;
begin
  s := pg_temp.mk('ga7', '{"rounds":[{"mode":"posts","duration_s":600},{"mode":"tag","duration_s":300}],"countdown_s":0}', 4);
  perform pg_temp.act(s, 'ga7', 'start');
  for i in 1 .. 4 loop perform pg_temp.tick('ga7', i, 59.9101, 10.7501); end loop;
  r := pg_temp.act(s, 'ga7', 'event_start', '{"kind":"gather"}');
  assert (r ->> 'ok')::boolean, 'gather: ' || r::text;
  for i in 1 .. 4 loop perform pg_temp.tick('ga7', i); end loop;     -- everybody at the assembly point
  assert (select count(*) from chase.event_entries where session_id = s and state = 'reached') = 4, 'all four reached';
  assert (select count(*) from chase.event_entries where session_id = s and powerup is not null) = 3, 'first 3 get a power-up';
  assert (select bool_and(points = 10) from chase.event_entries where session_id = s), '+10 each';
  -- A tag round is still ahead: the prize can be any of the four.
  assert (select bool_and(powerup in ('shield', 'radar', 'decoy', 'turbo')) from chase.event_entries where session_id = s and powerup is not null), 'pool';
  -- Time up → done at the next upkeep.
  perform pg_temp.ev_left(s, -1);
  perform pg_temp.tick('ga7', 1);
  assert (pg_temp.ev(s) ->> 'done')::boolean, 'gather times out';

  r := pg_temp.act(s, 'ga7', 'event_start', '{"kind":"golden"}');
  assert (r ->> 'ok')::boolean and (pg_temp.ev(s) ->> 'done')::boolean, 'golden is instant';
  assert exists (select 1 from chase.posts where session_id = s and kind = 'golden'), 'golden post spawned';

  update chase.sessions set phase_ends_at = now() + interval '20 seconds' where id = s;
  assert pg_temp.act(s, 'ga7', 'event_start', '{"kind":"sprint"}') ->> 'error' = 'too_late', 'not at the very end';
  assert chase.host_action(s, pg_temp.h('nope'), 'event_start', '{"kind":"sprint"}') ->> 'error' = 'auth', 'auth';
  raise notice '0007 gather + golden + time: ok';
end $$;

-- ───────────────────────── mission: «Ferdig» + teacher, QR ─────────────────────────
do $$
declare s uuid; r jsonb; c text; st chase.player_stats;
begin
  s := pg_temp.mk('mi7', '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0,"qr_posts":2}', 3);
  perform pg_temp.act(s, 'mi7', 'start');
  for i in 1 .. 3 loop perform pg_temp.tick('mi7', i); end loop;
  assert chase.mission_done(pg_temp.pid('mi7', 1), pg_temp.tok('mi7', 1), s) ->> 'error' = 'not_now', 'no mission yet';
  r := pg_temp.act(s, 'mi7', 'event_start', '{"kind":"mission"}');
  assert (r ->> 'ok')::boolean and (pg_temp.ev(s) ->> 'mission')::int between 0 and 5, 'mission with an exercise';

  r := chase.mission_done(pg_temp.pid('mi7', 1), pg_temp.tok('mi7', 1), s);
  assert r ->> 'state' = 'pending', 'waits for the teacher: ' || r::text;
  perform chase.mission_done(pg_temp.pid('mi7', 2), pg_temp.tok('mi7', 2), s);
  assert jsonb_array_length(chase.host_snapshot(s, pg_temp.h('host-mi7')) -> 'mission_pending') = 2, 'teacher sees 2 pending';
  r := pg_temp.act(s, 'mi7', 'mission_confirm', jsonb_build_object('player_id', pg_temp.pid('mi7', 1)));
  assert (r ->> 'confirmed')::int = 1, 'one confirmed: ' || r::text;
  select * into st from chase.player_stats where player_id = pg_temp.pid('mi7', 1);
  assert st.points >= 15 and 'mission' = any(st.badges), '+15 + badge';
  assert (pg_temp.tick('mi7', 1) -> 'event' -> 'me' ->> 'state') = 'done', 'phone sees done';

  -- QR post during the mission: confirmed at once (no «Ferdig» needed).
  select code into c from chase.posts where session_id = s and kind = 'physical_qr' limit 1;
  r := chase.claim_qr(pg_temp.pid('mi7', 3), pg_temp.tok('mi7', 3), s, c);
  assert (r ->> 'mission')::boolean and (r ->> 'value')::int = 15, 'QR confirms the mission: ' || r::text;
  r := chase.claim_qr(pg_temp.pid('mi7', 3), pg_temp.tok('mi7', 3), s, c);
  assert (r ->> 'already')::boolean, 'only once';

  -- After the mission ends, the teacher can still confirm (grace).
  perform pg_temp.ev_left(s, -1);
  perform pg_temp.tick('mi7', 3);
  assert (pg_temp.ev(s) ->> 'done')::boolean, 'mission over';
  r := chase.claim_qr(pg_temp.pid('mi7', 1), pg_temp.tok('mi7', 1), s, c);
  assert r ->> 'error' = 'not_now' or (r ->> 'mission') is null, 'QR back to normal after the mission';
  r := pg_temp.act(s, 'mi7', 'mission_confirm', '{}');
  assert (r ->> 'confirmed')::int = 1, 'grace: the last pending confirmed';
  assert pg_temp.act(s, 'mi7', 'mission_confirm', '{}') ->> 'error' = 'none_pending', 'nothing left';
  raise notice '0007 mission: ok';
end $$;

-- ───────────────────────── automatic events + teacher switch ─────────────────────────
do $$
declare s uuid; t jsonb; n int;
begin
  s := pg_temp.mk('au7', '{"rounds":[{"mode":"tag","duration_s":600}],"countdown_s":0,"event_every_s":90}', 4);
  perform pg_temp.act(s, 'au7', 'start');
  perform pg_temp.tick('au7', 1);
  assert pg_temp.ev(s) is null, 'nothing before the first interval';
  assert (select (state ->> 'ev_next')::timestamptz > now() from chase.rounds where session_id = s), 'scheduled';
  assert (chase.host_snapshot(s, pg_temp.h('host-au7')) ->> 'events_auto')::boolean, 'auto on';

  update chase.rounds set state = state || jsonb_build_object('ev_next', now() - interval '1 second') where session_id = s;
  perform pg_temp.tick('au7', 1);
  assert pg_temp.ev(s) ->> 'by' = 'auto' and pg_temp.ev(s) ->> 'kind' in ('sprint', 'gather', 'storm', 'blackout'),
    'auto event from the tag pool: ' || pg_temp.ev(s)::text;
  assert (select (state ->> 'ev_next')::timestamptz = now() + interval '90 seconds' from chase.rounds where session_id = s), 'next in 90 s';
  perform pg_temp.act(s, 'au7', 'event_stop');
  assert (pg_temp.ev(s) ->> 'done')::boolean, 'teacher stops it';

  perform pg_temp.act(s, 'au7', 'events_auto', '{"on":false}');
  assert not (chase.host_snapshot(s, pg_temp.h('host-au7')) ->> 'events_auto')::boolean, 'auto off';
  update chase.rounds set state = state || jsonb_build_object('ev_next', now() - interval '1 second') where session_id = s;
  select (state -> 'ev' ->> 'no')::int into n from chase.rounds where session_id = s;
  perform pg_temp.tick('au7', 1);
  assert (pg_temp.ev(s) ->> 'no')::int = n, 'no new event while off';
  perform pg_temp.act(s, 'au7', 'events_auto', '{"on":true}');
  perform pg_temp.tick('au7', 1);
  assert (pg_temp.ev(s) ->> 'no')::int = n + 1, 'on again';
  raise notice '0007 auto: ok';
end $$;

-- ───────────────────────── storm, blackout, pause, round end ─────────────────────────
do $$
declare s uuid; r jsonb; t jsonb; h0 uuid[]; p0 uuid[]; h uuid; p uuid; ends timestamptz;
begin
  s := pg_temp.mk('st7', '{"rounds":[{"mode":"tag","duration_s":600,"variant":"convert"}],"countdown_s":0}', 6);
  perform pg_temp.act(s, 'st7', 'start');
  for i in 1 .. 6 loop perform pg_temp.tick('st7', i); end loop;
  select array_agg(id order by id) filter (where role = 'hunter'), array_agg(id order by id) filter (where role = 'prey')
    into h0, p0 from chase.players where session_id = s;
  assert cardinality(h0) = 1 and cardinality(p0) = 5, 'dealt 1 + 5';

  r := pg_temp.act(s, 'st7', 'event_start', '{"kind":"storm"}');
  assert (r ->> 'ok')::boolean, 'storm: ' || r::text;
  assert (select array_agg(id order by id) from chase.players where session_id = s and role = 'hunter') = p0, 'prey hunt now';
  assert (select array_agg(id order by id) from chase.players where session_id = s and role = 'prey') = h0, 'hunter is prey';
  assert (select immune_until > now() from chase.players where id = h0[1]), 'short immunity for the new prey';
  assert chase._round_mode(s) ->> 'variant' = 'swap', 'Sisten rules during the storm';

  -- A storm catch swaps (Smitte cannot end mid-storm).
  update chase.players set immune_until = null where id = h0[1];
  h := p0[1]; p := h0[1];
  r := chase.catch(h, (select token_hash from chase.players where id = h), s, (select catch_code from chase.players where id = p));
  assert (r ->> 'ok')::boolean and r ->> 'variant' = 'swap' and not (r ->> 'last')::boolean, 'storm catch swaps: ' || r::text;
  assert (select role from chase.players where id = h) = 'prey' and (select role from chase.players where id = p) = 'hunter', 'swapped';

  -- Pause shifts the storm's end.
  ends := (pg_temp.ev(s) ->> 'ends_at')::timestamptz;
  perform pg_temp.act(s, 'st7', 'pause');
  update chase.sessions set frozen_at = frozen_at - interval '30 seconds' where id = s;
  perform pg_temp.act(s, 'st7', 'resume');
  assert (pg_temp.ev(s) ->> 'ends_at')::timestamptz = ends + interval '30 seconds', 'pause shifts the event';

  perform pg_temp.ev_left(s, -1);
  perform pg_temp.tick('st7', 1);
  assert (pg_temp.ev(s) ->> 'done')::boolean, 'storm over';
  assert chase._round_mode(s) ->> 'variant' = 'convert', 'Smitte again';
  -- Swapped back: the catcher (prey during the storm) is a hunter again, the one caught is prey.
  assert (select role from chase.players where id = h) = 'hunter' and (select role from chase.players where id = p) = 'prey', 'swapped back';
  assert (select count(*) from chase.players where session_id = s and role = 'hunter') = 1, 'counts as before';

  -- Blackout: hunters get no radar.
  r := pg_temp.act(s, 'st7', 'event_start', '{"kind":"blackout"}');
  assert (r ->> 'ok')::boolean, 'blackout';
  t := chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  assert t -> 'tag' -> 'radar' = '[]' and (t -> 'tag' ->> 'blackout')::boolean, 'radar off: ' || (t -> 'tag')::text;
  perform pg_temp.act(s, 'st7', 'event_stop');

  -- Round end during a storm: roles back before Smittejakt's own end.
  r := pg_temp.act(s, 'st7', 'event_start', '{"kind":"storm"}');
  perform pg_temp.act(s, 'st7', 'next');
  assert exists (select 1 from chase.events where session_id = s and type = 'ev_end' and payload ->> 'why' = 'round_end'), 'ended with the round';
  assert (select count(*) from chase.players where session_id = s and role in ('hunter', 'prey')) = 0, 'neutral after the round';
  raise notice '0007 storm + blackout + pause: ok';
end $$;

-- ───────────────────────── power-ups ─────────────────────────
do $$
declare s uuid; r jsonb; t jsonb; h uuid; p uuid; q uuid; pts int;
begin
  s := pg_temp.mk('pu7', '{"rounds":[{"mode":"tag","duration_s":600,"variant":"swap"}],"countdown_s":0}', 6);
  perform pg_temp.act(s, 'pu7', 'start');
  for i in 1 .. 6 loop perform pg_temp.tick('pu7', i); end loop;
  select id into h from chase.players where session_id = s and role = 'hunter' limit 1;
  select id into p from chase.players where session_id = s and role = 'prey' order by id limit 1;
  select id into q from chase.players where session_id = s and role = 'prey' order by id desc limit 1;
  update chase.player_stats set powerups = '{shield,decoy}' where player_id = p;
  update chase.player_stats set powerups = '{radar,turbo}' where player_id = h;

  r := chase.use_powerup(h, (select token_hash from chase.players where id = h), s, 'shield');
  assert r ->> 'error' = 'not_useful', 'hunter cannot shield';
  r := chase.use_powerup(p, (select token_hash from chase.players where id = p), s, 'turbo');
  assert r ->> 'error' = 'none_left', 'not in the inventory';
  assert chase.use_powerup(p, pg_temp.h('nope'), s, 'shield') ->> 'error' = 'auth', 'auth';

  r := chase.use_powerup(p, (select token_hash from chase.players where id = p), s, 'shield');
  assert (r ->> 'ok')::boolean and (select immune_until >= now() + interval '15 seconds' from chase.players where id = p), 'shield: immune 15 s';
  assert (select powerups from chase.player_stats where player_id = p) = '{decoy}', 'used up';
  assert (select 'powerup' = any(badges) from chase.player_stats where player_id = p), 'first power-up badge';

  -- Decoy: one more ping on the hunter's radar, same shape.
  update chase.player_live set ping_pos = pos, ping_at = now() where session_id = s;
  t := chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  pts := jsonb_array_length(t -> 'tag' -> 'radar');
  r := chase.use_powerup(p, (select token_hash from chase.players where id = p), s, 'decoy');
  assert (r ->> 'ok')::boolean, 'decoy: ' || r::text;
  assert (select ST_Distance(decoy_pos, pos) between 30 and 50 from chase.player_live where player_id = p), 'decoy ~40 m away';
  t := chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  assert jsonb_array_length(t -> 'tag' -> 'radar') = pts + 1, 'decoy on the radar';
  assert (select bool_and(x ?& array['pos', 'age_s', 'stealth']) from jsonb_array_elements(t -> 'tag' -> 'radar') x), 'same shape';

  -- Radar: the hunter sees every prey for 5 s.
  r := chase.use_powerup(h, (select token_hash from chase.players where id = h), s, 'radar');
  t := chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  assert jsonb_array_length(t -> 'tag' -> 'radar_live') = 5, 'all 5 prey: ' || (t -> 'tag')::text;
  assert t -> 'power' ->> 'radar_until' is not null, 'radar clock';

  -- Turbo: +1 extra per 50 m while it lasts.
  r := chase.use_powerup(h, (select token_hash from chase.players where id = h), s, 'turbo');
  select points into pts from chase.player_stats where player_id = h;
  -- round_move_pts moved along so the normal movement points stay out of it.
  update chase.player_stats set round_distance_m = round_distance_m + 120,
         round_move_pts = least(20, floor((round_distance_m + 120) / 50)::int) where player_id = h;
  perform chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  assert (select points - pts from chase.player_stats where player_id = h) = 2, 'turbo: +2 for 120 m';
  update chase.player_stats set turbo_until = now() - interval '1 second' where player_id = h;
  update chase.player_stats set round_distance_m = round_distance_m + 200,
         round_move_pts = least(20, floor((round_distance_m + 200) / 50)::int) where player_id = h;
  select points into pts from chase.player_stats where player_id = h;
  perform chase.tick(h, (select token_hash from chase.players where id = h), 59.91045, 10.7509, 5);
  assert (select points - pts from chase.player_stats where player_id = h) = 0, 'no turbo after it ran out';

  perform pg_temp.act(s, 'pu7', 'pause');
  assert chase.use_powerup(h, (select token_hash from chase.players where id = h), s, 'turbo') ->> 'error' = 'not_now', 'not while paused';
  raise notice '0007 power-ups: ok';
end $$;

-- ───────────────────────── badges + privileges ─────────────────────────
do $$
declare s uuid; t jsonb;
begin
  s := pg_temp.mk('bd7', '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}', 1);
  perform pg_temp.act(s, 'bd7', 'start');
  perform pg_temp.tick('bd7', 1);
  update chase.player_stats set distance_m = 600, active_s = 320, cells = array[1,2,3,4,5,6,7,8,9,10] where player_id = pg_temp.pid('bd7', 1);
  t := pg_temp.tick('bd7', 1);
  assert t -> 'new_badges' ?& array['m500', 'active_5', 'explorer_10'], 'new badges: ' || (t -> 'new_badges')::text;
  assert not t -> 'new_badges' ? 'km_1', 'not 1 km yet';

  assert not has_function_privilege('anon', 'chase.use_powerup(uuid,text,uuid,text)', 'execute'), 'anon: use_powerup';
  assert not has_function_privilege('anon', 'chase.mission_done(uuid,text,uuid)', 'execute'), 'anon: mission_done';
  assert not has_function_privilege('authenticated', 'chase._ev_start(uuid,text,text)', 'execute'), 'authenticated: _ev_start';
  assert has_function_privilege('service_role', 'chase.use_powerup(uuid,text,uuid,text)', 'execute'), 'service_role ok';
  raise notice '0007 badges + privileges: ok';
end $$;
