-- Assertions for 0022_demo_sessions.sql: demo_gate/refund, ingen sammendrag for sim, demo avsluttes etter 30 min.
set search_path = chase, extensions, public;

create function pg_temp.h(t text) returns text language sql as
  $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;
create function pg_temp.mk(p_tag text, p_sim boolean, p_settings jsonb default '{}') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := chase.create_session(pg_temp.h('host-' || p_tag), null,
    '{"type":"Polygon","coordinates":[[[10.75,59.91],[10.7518,59.91],[10.7518,59.9109],[10.75,59.9109],[10.75,59.91]]]}',
    '{"type":"Point","coordinates":[10.7509,59.91045]}', null, p_settings => p_settings, p_is_sim => p_sim);
  assert (r ->> 'ok')::boolean, 'mk create: ' || r::text;
  return r;
end $$;

-- demo_gate: 3 per nøkkel per time, avvist uten logging; en annen nøkkel er upåvirket.
do $$
declare r jsonb;
begin
  for i in 1 .. 3 loop
    r := chase.demo_gate(array['k-a'], 3, 100);
    assert (r ->> 'ok')::boolean, 'gate ' || i;
  end loop;
  r := chase.demo_gate(array['k-a'], 3, 100);
  assert r ->> 'error' = 'demo_limit', 'fjerde avvises';
  assert (select count(*) from chase.demo_log where key_hash = 'k-a') = 3, 'avvist logges ikke';
  assert (chase.demo_gate(array['k-b'], 3, 100) ->> 'ok')::boolean, 'annen nøkkel ok';
  -- to nøkler: en brukt opp holder for å avvise, og ingen av dem logges da
  r := chase.demo_gate(array['k-c', 'k-a'], 3, 100);
  assert r ->> 'error' = 'demo_limit', 'lærernøkkel/IP: en av dem er nok';
  assert (select count(*) from chase.demo_log where key_hash = 'k-c') = 0, 'ingen delvis logging';
  -- gamle rader teller ikke
  update chase.demo_log set created_at = now() - interval '2 hours' where key_hash = 'k-a';
  assert (chase.demo_gate(array['k-a'], 3, 100) ->> 'ok')::boolean, 'etter en time er kvoten ny';
  -- tak på aktive demoer
  perform pg_temp.mk('busy', true, '{"demo":true}');
  assert chase.demo_gate(array['k-d'], 3, 1) ->> 'error' = 'demo_busy', 'aktiv-tak';
  assert (chase.demo_gate(array['k-d'], 3, 1000) ->> 'ok')::boolean, 'høyere tak ok';
end $$;

-- demo_refund fjerner siste rad per nøkkel (mislykket opprettelse brenner ikke kvoten).
do $$
begin
  perform chase.demo_gate(array['k-r'], 3, 100);
  perform chase.demo_gate(array['k-r'], 3, 100);
  perform chase.demo_refund(array['k-r']);
  assert (select count(*) from chase.demo_log where key_hash = 'k-r') = 1, 'refund fjerner én rad';
end $$;

-- ingen anonymt sammendrag for sim/demo, men fortsatt for ekte økter.
do $$
declare s jsonb; n0 int;
begin
  select count(*) into n0 from chase.session_summaries;
  s := pg_temp.mk('sum-sim', true, '{"demo":true}');
  perform chase._end_session((s ->> 'session_id')::uuid);
  assert (select status from chase.sessions where id = (s ->> 'session_id')::uuid) = 'ended', 'sim avsluttet';
  assert (select count(*) from chase.session_summaries) = n0, 'sim legger ikke igjen sammendrag';
  s := pg_temp.mk('sum-real', false);
  perform chase._end_session((s ->> 'session_id')::uuid);
  assert (select count(*) from chase.session_summaries) = n0 + 1, 'ekte økt beholder sammendrag';
  assert (select status from chase.sessions where id = (s ->> 'session_id')::uuid) = 'ended' and (select ended_at from chase.sessions where id = (s ->> 'session_id')::uuid) is not null, 'ekte økt avsluttet';
end $$;

-- purge_expired: demo eldre enn 30 min avsluttes, yngre og vanlige sim-økter ikke; gammel demo_log ryddes.
do $$
declare old_d jsonb := pg_temp.mk('p-old', true, '{"demo":true}'); new_d jsonb := pg_temp.mk('p-new', true, '{"demo":true}');
        old_s jsonb := pg_temp.mk('p-sim', true); r jsonb;
begin
  update chase.sessions set created_at = now() - interval '31 minutes' where id in ((old_d ->> 'session_id')::uuid, (old_s ->> 'session_id')::uuid);
  insert into chase.demo_log (key_hash, created_at) values ('gammel', now() - interval '3 hours');
  r := chase.purge_expired();
  assert (r ->> 'demo_ended')::int >= 1, 'demo_ended telt';
  assert (select status from chase.sessions where id = (old_d ->> 'session_id')::uuid) = 'ended', 'gammel demo avsluttet';
  assert (select status from chase.sessions where id = (new_d ->> 'session_id')::uuid) <> 'ended', 'ny demo lever';
  assert (select status from chase.sessions where id = (old_s ->> 'session_id')::uuid) <> 'ended', 'vanlig sim-økt røres ikke';
  assert not exists (select 1 from chase.demo_log where key_hash = 'gammel'), 'demo_log ryddet';
  assert r ? 'ended' and r ? 'deleted', 'basisfeltene består';
end $$;
