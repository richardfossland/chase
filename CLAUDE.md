# Chase — chase.sundaysuite.app

Lærerstyrt GPS-jaktspill for kroppsøving og ungdomsgrupper i Sunday-familien.
Målet er fysisk aktivitet. **Spec og faser: docs/PLAN.md, som er sannhetskilden.**
Bygg i faserekkefølge og respekter «Ferdig når». Beslutninger logges i docs/DECISIONS.md.

## Stack (som SundayQuiz)
- Next 16 App Router + TypeScript, deployet til Cloudflare via OpenNext (`npm run cf:build`).
- Tailwind v4 med Sunday-tokens. Alle UI-strenger på bokmål i `lib/locale/no.ts`.
- Supabase EU i delt prosjekt, eget **`chase`-skjema** og PostGIS (`geography`, SRID 4326).
- MapLibre GL JS med Kartverket-fliser som standard.
- Realtime **Broadcast bare for hendelser**. Posisjoner går via `tick()`-API-et, aldri over Realtime.
- Planlagte jobber: pg_cron (`chase.purge_expired()`).

## Gate
- `npm run check` (tsc + eslint + vitest) må være grønn før commit.
- DB-endringer: `./scripts/test-db.sh` (Docker-Postgres med PostGIS).
- Simulator: `/dev/sim` og `scripts/sim.mjs`. Bruk den før du sier at en spillendring virker.

## Regler
1. **Serveren er sannheten.** Fangst, klaim, poeng, sone og synlighet avgjøres i plpgsql-RPC-er
   (`security definer`, kalles bare via API-ruter med service role). Klienter skriver aldri direkte mot tabeller,
   og all RLS i `chase` er deny-all.
2. **TS-tvillinger** i `lib/rules/` skal holdes i takt med sine RPC-er og testes mot de samme vektorene.
3. **Personvern:** Lagre aldri posisjonshistorikk. `player_live` er UNLOGGED. Posisjoner skal aldri inn i URL-er,
   logger eller Realtime-meldinger. `end_session()` skal slette posisjoner, alarmposisjoner og telefonnummer.
   Nye kolonner med persondata krever en oppdatert slettetabell i PLAN § 8.
4. **Sikkerhet slår spill.** Ingen endring får forsinke eller skjule SOS-, geofence- eller signaltapvarsler.
   Disse har egne tester.
5. **Ingen permanent utslagning** og ingen offentlig live-toppliste som standard (PLAN § 0).
6. Alle tider er servertid. Rundetilstand er en ren funksjon av tid, uten timere på klienten som fasit.
7. Tokens lagres bare som SHA-256-hash. Elever har ingen kontoer, og lærere identifiseres med lærernøkkel.
8. Migrasjoner nummereres `NNNN_beskrivelse.sql` og redigeres aldri etter at de er deployet.
9. Test på ekte iPhone. iOS har ikke vibrasjon, og GPS stopper når skjermen låses.

## Git
GitHub er eneste remote, med CI i GitHub Actions (check, build, DB-tester) og oppetidssjekk (`uptime.yml`). Ingen NAS eller Forgejo. Commit-meldinger: Conventional Commits (`feat:`, `fix:`, `chore(deps):`), korte.
