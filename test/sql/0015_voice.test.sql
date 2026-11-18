-- Assertions for 0015_voice.sql: talte varsler (settings.voice) i tick, tick_batch og host_snapshot.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

do $$
declare
  r jsonb; s uuid; s2 uuid; p1 uuid; q1 uuid; v jsonb; b jsonb; snap jsonb;
  poly jsonb := '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}';
  pt   jsonb := '{"type":"Point","coordinates":[10.7509,59.91045]}';
  plan jsonb := '{"rounds":[{"mode":"free","duration_s":600}],"countdown_s":0}';
begin
  -- Session A: no voice key at all → false.
  r := chase.create_session(pg_temp.h('host-v1'), null, poly, pt, null, p_plan => plan);
  s := (r ->> 'session_id')::uuid;
  p1 := (chase.join_session(r ->> 'pin', 'v-1', pg_temp.h('tok-v-1'), pg_temp.h('res-v-1')) ->> 'player_id')::uuid;
  v := chase.tick(p1, pg_temp.h('tok-v-1'), 59.91045, 10.7509, 5, null, null, s, null);
  assert (v ->> 'ok')::boolean, 'tick ok: ' || v::text;
  assert v ? 'voice' and (v ->> 'voice') = 'false', 'default voice=false: ' || v::text;

  -- Teacher turns it on mid-session; the next tick sees it.
  r := chase.set_voice(s, pg_temp.h('host-v1'), true);
  assert (r ->> 'ok')::boolean and (r ->> 'voice')::boolean, 'set_voice on: ' || r::text;
  v := chase.tick(p1, pg_temp.h('tok-v-1'), 59.91045, 10.7509, 5, null, null, s, null);
  assert (v ->> 'voice') = 'true', 'tick voice=true';
  assert (select settings ->> 'voice' from chase.sessions where id = s) = 'true', 'stored in settings';

  -- tick_batch gives every entry the field.
  b := chase.tick_batch(s, jsonb_build_array(jsonb_build_object('player', p1, 'token_hash', pg_temp.h('tok-v-1'),
        'lat', 59.91045, 'lng', 10.7509, 'acc', 5, 'speed', null, 'client_ts', null, 'steps', null)));
  assert (b -> 'results' -> 0 -> 'r' ->> 'voice') = 'true', 'batch voice: ' || b::text;

  -- host_snapshot exposes it.
  snap := chase.host_snapshot(s, pg_temp.h('host-v1'));
  assert (snap ->> 'voice') = 'true', 'snapshot voice';

  -- Off again; other settings keys survive.
  r := chase.set_voice(s, pg_temp.h('host-v1'), false);
  assert (r ->> 'ok')::boolean, 'set_voice off';
  v := chase.tick(p1, pg_temp.h('tok-v-1'), 59.91045, 10.7509, 5, null, null, s, null);
  assert (v ->> 'voice') = 'false', 'tick voice=false again';

  -- Wrong host token: auth error, nothing changes.
  r := chase.set_voice(s, pg_temp.h('nope'), true);
  assert (r ->> 'ok')::boolean is not true and r ->> 'error' = 'auth', 'bad token → auth';
  assert (select settings ->> 'voice' from chase.sessions where id = s) = 'false', 'unchanged after bad token';
  r := chase.set_voice(s, pg_temp.h('host-v1'), null);
  assert r ->> 'error' = 'bad_request', 'null → bad_request';

  -- Session B: voice set at creation through p_settings.
  r := chase.create_session(pg_temp.h('host-v2'), null, poly, pt, null, p_plan => plan,
                            p_settings => '{"voice":true,"other":1}'::jsonb);
  s2 := (r ->> 'session_id')::uuid;
  q1 := (chase.join_session(r ->> 'pin', 'v-2', pg_temp.h('tok-v-2'), pg_temp.h('res-v-2')) ->> 'player_id')::uuid;
  v := chase.tick(q1, pg_temp.h('tok-v-2'), 59.91045, 10.7509, 5, null, null, s2, null);
  assert (v ->> 'voice') = 'true', 'voice from p_settings';
  perform chase.set_voice(s2, pg_temp.h('host-v2'), false);
  assert (select settings ->> 'other' from chase.sessions where id = s2) = '1', 'other settings keys kept';

  -- A failed tick (bad token) carries no voice field and keeps its error.
  v := chase.tick(q1, pg_temp.h('wrong'), 59.91045, 10.7509, 5, null, null, s2, null);
  assert not coalesce((v ->> 'ok')::boolean, false), 'bad token still fails';

  -- Ended session refuses.
  perform chase.host_action(s2, pg_temp.h('host-v2'), 'start');
  perform chase.end_session(s2, pg_temp.h('host-v2'), true);
  r := chase.set_voice(s2, pg_temp.h('host-v2'), true);
  assert r ->> 'error' = 'ended', 'ended → error: ' || r::text;

  raise notice '0015 voice: ok';
end $$;
