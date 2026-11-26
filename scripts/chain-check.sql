-- Kjedesjekk etter migrasjonskjøring i prod (ADR-037). Kjør via Management API eller psql.
-- Forventet: chain_bad = [], tick_flat = true, tick_like = bare tick og host_snapshot (én rad hver),
-- catch_lock = true, p7_sim = true, triggers = player_stats_practice_ins/_upd + posts_practice,
-- flash_kind = true (posts.kind tillater 'flash'), svc_away = true (host_snapshot_svc fletter inn away), hide_lock = true (0025), mode_check = true, anon_exec = 0, plan_ok = true.
with f(t,i) as (values ('_norm_plan','_norm_plan_hs'),('_norm_plan_hs','_norm_plan_so'),('_mode_begin','_mode_begin_lv'),('_mode_begin_lv','_mode_begin_hs'),('_mode_begin_hs','_mode_begin_so'),
 ('_mode_finish','_mode_finish_lv'),('_mode_finish_lv','_mode_finish_hs'),('_mode_finish_hs','_mode_finish_so'),('_mode_upkeep_team','_mode_upkeep_dl'),('_mode_upkeep_dl','_mode_upkeep_lv'),('_mode_upkeep_lv','_mode_upkeep_hs'),('_mode_upkeep_hs','_mode_upkeep_so'),
 ('_mode_tick','_mode_tick_lv'),('_mode_tick_lv','_mode_tick_hs'),('_mode_tick_hs','_mode_tick_so'),('_round_view','_round_view_hs'),('_round_view_hs','_round_view_so'),
 ('_unfreeze','_unfreeze_lv'),('_unfreeze_lv','_unfreeze_hs'),('_unfreeze_hs','_unfreeze_so'),('_ev_upkeep','_ev_upkeep_hs'),('_ev_upkeep_hs','_ev_upkeep_so'),
 ('host_action','_host_action_lv'),('_host_action_lv','_host_action_hs'),('_host_action_hs','_host_action_so'),('catch','_catch_hide'),('use_powerup','_use_powerup_hs'),
 ('_end_session','_end_session_so'),('_end_session_so','_end_session_p7'),('purge_expired','_purge_expired_p22'),('_posts_upkeep','_posts_upkeep_lv'))
select jsonb_build_object(
 'chain_bad', (select coalesce(jsonb_agg(t),'[]') from f where not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='chase' and proname=t and prosrc like '%chase.'||i||'(%')),
 'tick_like', (select jsonb_agg(proname||'('||pg_get_function_identity_arguments(p.oid)||')') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='chase' and (proname in ('tick','host_snapshot') or proname ~ '^_(tick|host_snapshot)_')),
 'tick_flat', (select prosrc like '%hc_prev_pos%' from pg_proc where proname='tick' and pronamespace='chase'::regnamespace),
 'catch_lock', (select prosrc like '%pg_advisory_xact_lock%' from pg_proc where proname='catch' and pronamespace='chase'::regnamespace),
 'p7_sim', (select prosrc like '%not v_s.is_sim%' from pg_proc where proname='_end_session_p7'),
 'triggers', (select jsonb_agg(tgname order by tgname) from pg_trigger where tgrelid in ('chase.player_stats'::regclass,'chase.posts'::regclass) and not tgisinternal),
 'mode_check', (select pg_get_constraintdef(oid) like '%scoreo%' from pg_constraint where conname='rounds_mode_check'),
 'anon_exec', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where nspname='chase' and has_function_privilege('anon',p.oid,'execute')),
 'plan_ok', (select chase._norm_plan('{"rounds":[{"mode":"posts","duration_s":60,"practice":true},{"mode":"scoreo","duration_s":300},{"mode":"tag","variant":"hide","duration_s":180}]}') is not null),
 'flash_kind', (select pg_get_constraintdef(oid) like '%flash%' from pg_constraint where conrelid = 'chase.posts'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'),
 'svc_away', (select prosrc like '%_snapshot_away%' from pg_proc where proname = 'host_snapshot_svc' and pronamespace = 'chase'::regnamespace),
 'hide_lock', (select prosrc like '%for key share%' from pg_proc where proname = '_mode_upkeep_team' and pronamespace = 'chase'::regnamespace),
 'health', (select chase.health()));
