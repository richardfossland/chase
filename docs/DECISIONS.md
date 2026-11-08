# Beslutninger (ADR-logg)

Korte, daterte beslutninger som ikke står i PLAN.md § 0, eller som endrer den.

## ADR-001 — Stack følger SundayQuiz, ikke Next 15 + Vercel (2026-11-07)
Brukeren oppga Next 15 + Vercel, men søskenspillene kjører Next 16 på Cloudflare (OpenNext) med
delt Supabase-prosjekt og RPC-er bak API-ruter. Chase følger det faktiske mønsteret.

## ADR-002 — Navn og domene (2026-11-08)
Produktet heter **Chase** og ligger på **chase.sundaysuite.app**.

## ADR-003 — Next 16.4.5 (2026-11-08)
`@opennextjs/cloudflare@1.20.16` krever `next >=16.4.5` (16.3.x er utelukket). Chase starter på 16.4.5;
SundayQuiz står på 16.3.3 og bør oppgraderes.

## ADR-004 — MapLibre 6 + statisk worker (2026-11-08)
MapLibre ≤ 6.4 har en kritisk XSS-sårbarhet (GHSA-jrc7-96c5-q579), så vi bruker 6.17+.
MapLibre 6 finner workeren via `import.meta.url`, som brekker når Next bundler den. Workeren kopieres
til `public/vendor/` ved `postinstall` og settes med `setWorkerUrl()` i `lib/map/maplibre.ts`.
Last alltid MapLibre via `loadMapLibre()`.

## ADR-005 — maplibre-gl.css slår Tailwind-utilities (2026-11-08)
MapLibre-CSS er ulagdelt og setter `.maplibregl-map { position: relative }`, som vinner over Tailwinds
lagdelte `absolute`. Posisjoner alltid en wrapper og la kartelementet fylle den (`h-full w-full`).

## ADR-006 — RLS ENABLE, ikke FORCE (2026-11-08)
Alle `chase`-tabeller har RLS uten policyer, og anon/authenticated har ikke engang USAGE på skjemaet.
Vi bruker ikke `FORCE ROW LEVEL SECURITY`, fordi security-definer-RPC-er kjører som tabelleier og
ellers ville blitt filtrert i Supabase (testmiljøets superbruker ville skjult feilen).

## ADR-007 — PostGIS-testbilde under emulering på Apple Silicon (2026-11-08)
`postgis/postgis` har kun amd64. `scripts/test-db.sh` kjører det med `--platform linux/amd64` på arm64.
CI (Ubuntu) kjører det nativt.

## ADR-008 — Server-env bakes inn ved OpenNext-bygg (2026-11-08)
OpenNext tar med `.env.local` i Worker-bundelen ved `cf:build`, så `SUPABASE_SERVICE_ROLE_KEY` når
serveren selv uten `wrangler secret put`. Verifisert at nøkkelen **ikke** finnes i `.open-next/assets`
(det nettleseren laster). En Worker-secret med samme navn overstyrer verdien hvis den settes.
Bygg og deploy derfor bare fra en maskin med korrekt `.env.local`, aldri fra CI uten secrets.

## ADR-009 — PostGIS-versjon i produksjon er 3.3.7 (2026-11-08)
Det delte Supabase-prosjektet kjører PostGIS 3.3.7, mens testbildet bruker 3.5. Bruk bare funksjoner som
finnes i 3.3 (ST_DWithin, ST_Covers, ST_Distance, ST_Buffer, ST_Intersection på geography er trygge).
Vurder å pinne `CHASE_TEST_IMAGE` til samme Postgres-/PostGIS-versjon som prosjektet i fase 1.
