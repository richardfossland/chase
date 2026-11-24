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

## ADR-010 — Bare GitHub, ingen NAS/Forgejo (2026-11-08)
Som Sjakk og Turnering: GitHub er eneste remote, CI kjører i GitHub Actions (check, build, DB-tester),
og `uptime.yml` sjekker produksjon hvert tiende minutt og åpner en issue ved brudd (kopiert fra Turnering).
Erstatter speilingen til Forgejo i PLAN § 13.

## ADR-011 — Gjenbruk fra Turnering og Sjakk (2026-11-08)
Infrastruktur som er utprøvd i produksjon, kopieres i stedet for å skrives på nytt (med testene):
- Fra **Turnering:** `lib/server/http.ts` (rate limiter med øvre grense, nødvendig på Workers),
  `lib/server/defer.ts` (broadcast etter respons), `lib/client/channelRegistry.ts` og `useChannel.ts`
  (delte, selvreparerende Realtime-kanaler), `refetch.ts` (koalescerende refetch med jitter),
  `useTabHidden.ts`, `sound.ts`, `QRCode.tsx`, `app/api/[...missing]` (JSON-404) og `scripts/probe.mjs`.
- Fra **Sjakk:** `lib/codes.ts` (PIN og gjenopptakskoder uten tvetydige tegn), `lib/server/broadcast.ts`
  (REST-broadcast med timeout), `useCountdown.ts`, `ConfirmDialog.tsx`, `FullscreenToggle.tsx`, feilsidene
  og `cleanup`-mønsteret med pg_cron (0004).

Forskjell: Sjakk og Turnering lagrer verter og spillerkoder i klartekst. Chase hasher dem (CLAUDE.md regel 7).
Neste kandidater for gjenbruk i fase 1: `smoke*.mjs` (Sjakk), `identity.ts`, `api.ts`/`ApiError` og
`useTournament`-mønsteret (poll + Realtime-hint).

## ADR-012 — Testbildet er pinnet til Supabase Postgres 17.6.1.106 (2026-11-08)
Erstatter ADR-007 og avslutter vurderingen i ADR-009. `scripts/test-db.sh` bruker
`public.ecr.aws/supabase/postgres:17.6.1.106`, som har samme PostGIS (3.3.7) og pg_cron som produksjonsprosjektet.
Bildet kjører nativt på arm64 og amd64, så vi trenger ikke emulering lenger.
Migrasjoner og tester kjøres som `postgres` (ikke superbruker), slik som i Supabase, og rollene finnes allerede i bildet.
`CHASE_TEST_IMAGE` kan fortsatt overstyre bildet.

## ADR-013 — Alarmenes livsløp og margin for forbudte soner (2026-11-08, besluttet av Richard)
- Hver spiller har maks én åpen alarm per type. `resolved_at` betyr at tilstanden er over, og `acked_at` betyr
  at læreren har sett alarmen. En alarm **blir stående i varselstripa til den er kvittert**, også når den er løst.
  Ingenting forsvinner usett.
- Hvis eleven er mer enn 100 m utenfor, heves alarmnivået, og kvitteringen nullstilles slik at læreren varsles på nytt.
  SOS løses aldri automatisk. Når læreren kvitterer, løses SOS, og eleven ser «Læreren har sett det» i 60 s.
- Forbudt sone avgjøres som «mulig inne»: Eleven regnes som inne når avstanden til sonen er ≤ `min(acc, 15 m)`.
  Sikkerheten går foran, så noen falske alarmer nær en vei er akseptert.
- Sikkerhetssjekkene kjører i alle tilstander unntatt lobby, også under pause. Distanse og aktiv tid telles bare i `live`.

## ADR-014 — Valg i tick() for fase 1 (2026-11-08)
- Tersklene ligger i `chase.k()`, og `lib/rules/safety.ts` er TS-tvillingen. En test feiler hvis de to ikke stemmer overens.
- Distanse måles mot et ankerpunkt. Ankeret flyttes først når eleven har beveget seg ≥ `max(3 m, acc/2)`, slik at
  GPS-jitter ikke gir meter. Et segment på over 8 m/s flytter ankeret uten å telle. Et opphold på over 30 s starter på nytt.
  Aktiv tid er segmentets varighet når farten er 1,2–7 m/s. `player_stats.active_s` er derfor `real`.
  Ankerglattingen erstatter glattingen over 10 s i PLAN § 5.1.
- Signaltap avledes i `host_snapshot`. Referansepunktet er `greatest(fix_at, live_since)`, slik at «fortsett» etter
  en pause ikke gir falske alarmer. Signalalarmen materialiseres, slik at den kan kvitteres, og den løses ved neste fix.
  Den gjelder bare i `live`, og spillere med rollen `referee` eller `sitting_out` er unntatt.
- `client_ts` brukes bare til å forkaste ticks som kommer i feil rekkefølge (`stale`). All logikk bruker servertid.
- Fase 1 bruker tilstandene lobby → live ⇄ paused/gathering → ended. `start` kjører planens første runde (standard `free`).
  Selve spillelisten kommer i fase 2.
- `end_session` krever opprop når spillet har startet: Alle aktive spillere må være hakket av, eller læreren må velge
  `p_force` («Avslutt likevel»). En økt som avsluttes fra lobbyen, trenger ikke opprop.
- Spillere som er fjernet, kan ikke bli med igjen fra samme `device_id` eller med gjenopptakskoden.
- Ytelse i testbildet: `tick()` tar 0,29 ms og `host_snapshot` 4 ms med 60 spillere og en forbudt sone.

## ADR-015 — API-lag, lokal utvikling og veiviser i fase 1 (2026-11-08)
- **Lokal utvikling bruker lokal Supabase**, besluttet av Richard. Kommandoen er `supabase start` med `supabase/config.toml`
  (prosjekt `chase` på portene 553xx, slik at den kan kjøre samtidig med Sjakks stack), og migrasjonene legges inn automatisk.
  `.env.development.local` peker dev-serveren dit, og fila brukes aldri av `cf:build`. Testdata og sim-boter havner
  derfor aldri i det delte produksjonsprosjektet. Etter endringer i migrasjonene kjøres `supabase db reset`.
- **Alle API-kall med token er POST**, også `snapshot`, som PLAN § 9.2 beskrev som GET. Da havner token og posisjoner
  aldri i URL-er eller tilgangslogger.
- `tick`, `raise_sos` og `player_bootstrap` tar inn `p_session` fra ruten og avviser feil økt **før noe skrives**.
  En gyldig elevtoken kan dermed ikke flytte posisjoner eller sende hint til en annen økt.
- RPC-feil oversettes til HTTP-status i `lib/server/rpc.ts`, og ruter logger aldri forespørselskropper.
  SOS-kall har ingen rate limit, og hintet om SOS sendes før svaret (det utsettes ikke).
- Realtime-topics (`chase:{økt}:all|host|p:{spiller}`) er foreløpig offentlige broadcast-kanaler. Payloadene er derfor
  bare hint (hendelsestype) og inneholder aldri navn, posisjoner eller tokens. Autorisasjon av kanalene etter
  SundayQuiz-mønsteret (PLAN § 9.2) legges inn når meldingene trenger innhold.
- **Veiviseren** (`/ny`) har eget tegneverktøy, besluttet av Richard. Man trykker for å sette hjørner, hjørnene er
  dragbare MapLibre-markører, og det finnes angre-, nullstill- og ferdig-knapper. Kryssende kanter sperres på klienten
  (`ringSelfIntersects`), og serveren sjekker med ST_IsValid.
  Samlingspunktet foreslås minst 30 m fra forbudte soner og kan ikke legges inne i en.
  Sjekklisten må være krysset av før økta kan lages. Fase 1 har bare én runde med fri løping, og læreren velger varigheten.
- Lærernøkkelen (16 tegn uten tvetydige tegn, ca. 79 bit) lages i nettleseren, vises én gang i introduksjonen
  og sendes bare som SHA-256-hash.

## ADR-016 — Innmelding og elevvisning i fase 1 (2026-11-08)
- `/j/[pin]` sender en elev som allerede er innmeldt med samme PIN på denne enheten, rett inn igjen.
  Ellers velger eleven kallenavn. Navn som ligner «Fornavn Etternavn», gir en advarsel, og banneord blokkeres i API-et.
  Gjenopptakskoden vises én gang etter innmelding. `/j` har også «Har du en kode fra før?».
- **«Jeg er klar»** er brukerhandlingen som låser opp lyd, starter GPS og aktiverer Wake Lock. Den må trykkes på nytt
  etter at siden er lastet inn på nytt, fordi iOS krever en brukerhandling.
- **Tick-takt:** 2 s i `live`, `gathering` og `countdown`, og 10 s ellers. Første fix rapporteres med en gang.
  Fixer som er eldre enn 15 s, sendes aldri. `ts` er **sendetidspunktet** og brukes bare til rekkefølge, ikke tidspunktet
  for fixen: Hvis eleven står stille og samme fix sendes igjen, skal den ikke avvises som `stale`.
  GPS-kroken henter ny posisjon med `getCurrentPosition` når fixen er eldre enn 10 s, fordi iOS kan slutte å sende posisjoner når mobilen ligger stille.
  Uten dette ville en elev som står stille, gitt falsk signaltapalarm.
- **Skjermen har én hovedbeskjed etter alvor:** forbudt sone > utenfor > samling > pause > nær grensa > løp > lobby.
  Når eleven går inn i en faresone, gir den summer og vibrasjon. Det er ingen vibrasjon på iOS, så der er lyd og pulserende rødt hovedkanalen.
  Retningspil er utsatt, fordi kompass krever egen tillatelse på iOS. Kartet viser grensa, sonene, samlingspunktet og eleven.
- **SOS** krever at knappen holdes i 1,5 s. Kallet prøves på nytt opptil fem ganger. Skjermen er rød til læreren
  kvitterer, og deretter grønn til eleven trykker OK (eller i maks 10 s). «Ring lærer» (`tel:`) vises når læreren
  har oppgitt nummer.
- **Sim-GPS** (`?simgps=1`, i dev eller med `NEXT_PUBLIC_SIM_ENABLED=1`) bytter ut GPS-kilden med et panel der
  piltastene eller WASD flytter posisjonen, og nøyaktighet og signal kan justeres (PLAN § 11.1). Bot-svermen og `scripts/sim.mjs` kommer i neste steg.

## ADR-017 — Lærerpanelet i fase 1 (2026-11-08)
- `/host/[id]` er **ett panel for hele økta**: lobby (QR, PIN, GPS-sjekk og Start med bekreftelse), spill og slutt.
  Panelet poller `snapshot` hvert 2. sekund (10 s når fanen er skjult) og henter på nytt med en gang ved Realtime-hint.
  Geometrien hentes bare ved første kall (`geo: true`).
- **Kartet** viser elevene som HTML-markører med navnelapp. Stilen har ingen glyph-kilde for tekst i MapLibre, og markører er lette å trykke på.
  Fargene følger samme alvorsrekkefølge som stripa: SOS, forbudt sone og utenfor (pulserende rødt), signaltap (grått),
  avhaket eller mangler under samling (grønn eller gul), sitter over (lilla), nær grensa (gul ring) og ellers blå. Hvis en elev har stått stille
  i over 90 s mens spillet pågår, vises 💤.
- **Varselstripa** viser én rad per elev og type, sortert med ukvitterte først og deretter SOS > forbudt > utenfor > signal.
  «Kvitter» kvitterer alle alarmene i gruppa. Raden viser «over» når tilstanden er avsluttet, men blir stående til den er kvittert (ADR-013).
  Hvis man trykker på raden, flyr kartet dit og spillerkortet åpnes.
- **Alarmlyd:** En ny alarm gir én summer og vibrasjon. En ukvittert SOS gir sirene hvert fjerde sekund til den er kvittert,
  og den kan ikke dempes. Nettleseren krever en brukerhandling før den kan spille lyd, så panelet viser «Slå på alarmlyd» til
  lyden er låst opp, og første trykk hvor som helst låser den opp.
- **Bunnlinja** har Pause/Fortsett, Beskjed (til alle eller én elev, med hurtigvalg), Samling/Fortsett spill og Mer (QR for
  nye elever, elevliste og Avslutt). Under samling viser et oppropskort «x av n er her», og et trykk åpner lista over dem som mangler,
  med knappen «Hak av».
- **Avslutt** krever bekreftelse. Hvis noen ikke er hakket av, vises navnene deres og «Avslutt likevel» (`force`).
- Fra **nettbrettbredde (lg)** vises elevlista alltid som en sidekolonne.
- Verifisert med en kladdesverm på 7 boter (løper, står stille, vandrer ut, forbudt sone, mister signal, SOS). Den egentlige
  simulatoren (`/dev/sim`, `scripts/sim.mjs`, `lib/sim/`) er neste steg.

## ADR-018 — GPS-simulatoren (2026-11-08)
- **`lib/sim/`** er felles kode for nettleseren og Node.
  - `behaviours.ts` har seedede bot-profiler (PLAN § 11.2): runner, hider, wanderer, forbidden, dropout, sos, cheater og jitter.
    Botene beveger seg i et lokalt metrisk plan og rapporterer posisjoner med simulert nøyaktighet og støy.
  - `driver.ts` kjører svermen. Botene er ekte spillere via API-et (join, tick, sos), og ticks spres jevnt over intervallet.
  - Driveren måler tick-latens (p50/p95/p99) og **alarmtid**: tiden fra en bot faktisk er i en tilstand som skal varsles,
    til lærerens snapshot viser alarmen. Tilstandene er SOS trykket, inne i forbudt sone, mer enn 40 m utenfor eller
    60 s uten fix. En gammel alarm som er løst, men ikke kvittert, teller ikke for en ny hendelse.
- **`/dev/sim`** finnes bare i dev eller med `SIM_ENABLED=1`. Siden kan lage en sim-økt (lærertokenet lagres lokalt, så
  lærerpanelet kan åpnes i ny fane) eller koble seg til en PIN. Den kan starte 1–60 boter med valgfri blanding og seed,
  og viser eget kart med botene (farge etter profil, rød kant når serveren melder fare), måletall og tidslinje.
- **`scripts/sim.mjs`** er headless og bruker samme kode, buntet med esbuild ved oppstart.
  - `--create` lager og starter en sim-økt og måler alarmtid som lærer.
  - `--rpc` sender ticks rett til PostgREST og måler dermed database og PostgREST uten Next. Det er en øvre grense for tiden i databasen.
  - `--assert` feiler hvis p95 ≥ 50 ms eller hvis en alarm bruker mer enn 5 s.
- `?simgps=1` på `/play/[id]` (ADR-016) er punkt 1 i § 11, og manuell styring av én ekte klient.
- **Funnet med simulatoren:** En elev som står i kanten av en forbudt sone, går inn og ut på grunn av GPS-støy. Hver ny
  inngang laget en ny alarm (over 50 rader og en summer for hver). `_raise_alarm` **gjenåpner** nå den forrige alarmen
  av samme type når den er løst, men ikke kvittert, og varsler ikke på nytt. Først etter at læreren har kvittert, gir en ny
  inngang en ny alarm og et nytt varsel. Dette er dekket av en SQL-test.
- **Fase 1 «Ferdig når», målt 2026-11-08 på lokal Supabase (Mac, Postgres 17 og PostGIS 3.3.7):**
  `node scripts/sim.mjs --create --bots 60 --minutes 20 --seed 42 --rpc --assert` gikk i 1202 s.
  Det ga 35 928 ticks uten feil. **Tick-tiden var p50 7 ms, p95 11 ms og p99 13 ms (maks 57 ms)** målt rundtur mot PostgREST, som er en øvre grense for tiden i databasen.
  Alle alarmtypene nådde læreren innen **1,0 s** (krav: 5 s): SOS 0,9 s, forbudt sone 0,0 s, utenfor 0,0 s og signaltap 1,0 s.
  Lærerens snapshot viste alle 60 botene med posisjon. Gjennom Next dev (uten `--rpc`) var p95 17–19 ms.
  Produksjonsprosjektet og Workers kan gi andre tall, så målingen bør gjentas der før utetesten.
  **Prod 2026-11-09** (Worker-versjon `aaa0e616`, 10 boter i 2 min via `https://chase.sundaysuite.app`): 555 ticks uten feil,
  alle 4 alarmtyper hos læreren innen 0,86 s. Rundtur fra klienten var p50 49 ms og p95 126 ms. Det er nettverk
  klient → Cloudflare → Supabase, ikke tiden i databasen: `/api/health` (ett lett DB-kall) hadde median ~75 ms i samme
  måling. Kravet om p95 under 50 ms gjelder `tick()` i databasen og er dokumentert lokalt. Prod-tallet viser at eleven
  får svar langt innenfor tick-intervallet på 2 s.
- **Konsekvens av «mulig inne» (ADR-013) som simulatoren viste:** Elever som passerer innenfor `min(acc, 15 m)` av
  en forbudt sone, utløser alarm, også om de egentlig er utenfor. Det er bevisst, men det må vurderes etter utetesten.
- Utsatt: CI-røyktest mot lokal Supabase (krever `supabase start` i Actions), seedede scenarioer med fangst (fase 3)
  og Playwright e2e (§ 11.5).

## ADR-019 — Utetestene samles til slutt (2026-11-10)

Eieren har bestemt at utetestene i «Ferdig når» for hver fase ikke kjøres fase for fase. De samles i én felles
utetest når alle fasene er ferdige. Fasene regnes som ferdige når resten av kravene er oppfylt (sim, SQL-tester, CI).
Utetestpunktene står fortsatt i PLAN § 13 og er sjekklista for den felles testen. Varselstøy ved forbudte soner (ADR-018)
vurderes da. Konsekvens: feil som bare viser seg på ekte enheter (GPS i lommen, låst skjerm, iOS-lyd) blir oppdaget
seint, så simulatoren og `useDeviceGps` må dekke så mye som mulig underveis.

## ADR-020 — Spilleliste, Postjakt og poeng (fase 2, 2026-11-10)
Eierens valg 2026-11-10: fysiske QR-poster med **kameraskanner og kode** som reserve, **3 × 6 min postjakt** som
standard spilleliste, og **syntetisert WebAudio** for lyd (ingen lydfiler).

- **Øktklokka** (`0003_playlist_posts_points.sql`): `status` går nedtelling → runde → pustepause → … → samling, og
  `phase_ends_at` sier når fasen er over. `chase._advance()` utfører overgangene lat fra `tick()`, `host_snapshot()`
  og `claim_qr()` (PLAN § 9.2), uten cron. Den henter seg inn eksakt: hver fase starter på forrige `phase_ends_at`,
  ikke på «nå», så en stille periode på serveren gir samme tidslinje. Én advisory xact-lock per økt serialiserer overganger
  og poster. Et kall som ikke får låsen, hopper bare over (neste tick tar det).
  - Pause og samling **fryser** klokka (`frozen_at`). Ved fortsett forskyves rundeslutt, gylden post og utløp med den
    frosne tiden.
  - **Etter siste runde går økta selv til samling med opprop.** Læreren trenger bare Start og Avslutt
    («Ferdig når» i fase 2). «Fortsett spill» finnes ikke da, fordi det ikke er noe å gå tilbake til.
  - Læreren kan trykke «Neste» (hopp over resten av fasen) og «+1 min» (bare i runde).
  - `start` går til nedtelling (standard 10 s). Med `countdown_s: 0` blir det runde med en gang. 0002-testene bruker det.
- **Spillelista** valideres av `chase._norm_plan()`: 1–10 runder, `free` eller `posts`, 60–1800 s, nedtelling 0–30 s,
  pustepause 0–300 s og 0–12 QR-poster. TS-tvillingen er `lib/rules/game.ts` (`GAME` = `chase.kg()`, diffet i test).
- **Postjakt** (PLAN § 3.1):
  - Postene legges inne i området minst 10 m fra grensa og minst 10 m fra forbudte soner, minst 25 m fra spillere med fersk fix og
    minst 30 m fra andre åpne poster. Reglene løsnes i den rekkefølgen i stedet for å feile (`ST_GeneratePoints` med
    30 kandidater).
  - Antall er spillere/4, mellom 3 og 15. En post som tas, erstattes ved neste tick.
  - Verdien er 10 nær sentrum og 20 i ytterkanten (andel sentrum→kant ≥ 0,6). Én **gylden post** (50 p, 60 s,
    ytterkant) dukker opp mellom 35 og 65 % av runder på minst 2 min, og alle telefoner får et hint om den.
  - **Klaim:** innenfor `max(12 m, acc)` på **to påfølgende ticks** (ca. 2 s). Aldri med dårligere fix enn 25 m.
    `UPDATE … WHERE claimed_by IS NULL` gjør at en post aldri kan tas to ganger.
- **Fysiske QR-poster** er kort for hele økta (`round_idx -1`, ingen posisjon) med en kode på 5 tegn uten tvetydige tegn.
  QR-koden er en URL (`/q/<økt>/<kode>`), så telefonens eget kamera også virker. Hver elev kan ta hvert kort
  **én gang per postjakt-runde**: 15 p, og +5 til den første. Ruta begrenser til 20 forsøk i minuttet, så koder ikke
  kan gjettes. Skanneren bruker `BarcodeDetector` der den finnes og ellers zxing-wasm-polyfillen `barcode-detector` (iOS, fra fase 9.2, ADR-036). Utskrift ligger på `/host/[id]/poster`.
  - Kjent svakhet: et bilde av kortet kan deles. Det er godtatt i skolebruk og kan rettes senere med roterende koder.
- **Poeng:** postverdi + **bevegelsespoeng** (+1 per 50 m i runden, maks 20). `player_stats.round_*` holder runden og
  skrives til `per_round` ved rundeslutt. Rundeoppsummeringen vises i pustepausen og etter siste runde.
- **Merker** gis én gang per økt i samme tick: første post, gyllen post, 5 poster i én runde, QR-post, 1 km,
  10 aktive minutter og 25 utforskerruter (20 × 20 m).
- **Personvern (PLAN § 8 oppdatert):** utforskerrutene er et grovt spor, så `end_session()` tømmer `cells` og
  beholder bare antallet (`explorer_n`). Poster og postklaim slettes ved øktslutt.
- **Tilbakemelding:** `lib/client/feedback.ts` samler lyd og vibrasjon for hver hendelse (klaim, gyllen post, «noen
  var først», 3-2-1, start, rundeslutt, merke), med blink på skjermen. iOS har ikke vibrasjon, så alt er også hørbart
  eller synlig. Sikkerhetslydene har forrang.
- **Funnet under testing:** en simulert teleport ga fart > 200 m/s, og hele ticken ble avvist med 400. `speed` er bare
  informativ, så en urimelig verdi blir nå `null` i stedet for å felle posisjonen.
- **Fase 2 i simulatoren, målt 2026-11-10 på lokal Supabase gjennom Next dev:**
  `node scripts/sim.mjs --create --bots 60 --plan posts:360,posts:360,posts:360 --breather 60 --qr 6 --until-done --end --assert`
  gikk i 1273 s med standardblandingen (inkludert SOS-, forbudt-, vandrer- og dropout-boter).
  - **Spillelista gikk fra start til samling uten andre lærerhandlinger:** nedtelling → runde → pustepause ×2 → runde →
    samling. Det ble 38 094 ticks uten feil, 2 571 postklaim, 3 gylne poster og **0 poster tatt to ganger**. 48 ganger var en annen
    først (riktig håndtert som «noen var først»).
  - Tick rundtur gjennom Next var p50 15 ms og p95 42 ms. p99 var 194 ms og maks 1,6 s ved rundeoverganger med mange postplasseringer
    på én gang. Alle fire alarmtypene nådde læreren innen 0,93 s, også midt i postjakt.
  - «Avslutt» ga opprop med 5 savnede: spesialbotene som med vilje ikke går til samlingspunktet. Deretter
    «Avslutt likevel». Med bare vanlige boter (20 boter, 3 × 90 s) gikk Avslutt rett gjennom på opprop.
  - Ikke dekket før den felles utetesten: låst skjerm i pustepausen (ny GPS innen 10 s etter opplåsing) og
    posttvist med ekte GPS. Kameraskanneren er ikke prøvd på ekte telefon, fordi nettleserpanelet ikke har kamera.
    Kodeinntasting er testet.

## ADR-021 — Fase 3: valg og del 1, Smittejakt (2026-11-10)
Eierens valg 2026-11-10:
- Seremonien vises på **lærerens mobil og elevmobilene** samtidig, og storskjerm kommer i fase 7.
- Malen «Full gymtime» er **variert**: fri løping 3 → postjakt 6 → smittejakt 6 → postjakt med sone 6 → sisten med sone 6, med 60 s pauser.
- Fase 3 leveres **i tre deler med deploy**: 1) Smittejakt og synlighet, 2) krympende sone, 3) overstyring, paller, seremoni og maler.
- «Vil spille igjen» lagres bare som **anonym telling**.

**Del 1** (`0004_tag.sql`):
- **Modus `tag`** har variantene `convert` (smitte) og `swap` (sisten). I veiviseren heter de «Smittejakt» og «Sisten».
- **Roller deles ut ved rundestart:** omtrent 15 % jegere, minst 1. Elever som sitter over, er ikke med i utdelingen.
- **Fangstkoder:** alle får en kode på fire sifre som er unik i økta, og alle kodene deles ut samtidig så de ikke kolliderer. Koden roteres etter hver fangst og ved hver runde.
- **`chase.catch()`** kontrollerer rolle, at runden er i gang, avstand ≤ `min(50, max(30, accA + accB))` med ferske posisjoner (under 20 s), immunitet og kode.
  - Jegeren får +15. Andre jegere som var innenfor 30 m av byttet de siste 10 s, får +5 i assist.
  - I sisten bytter jeger og bytte roller, og den nye byttet får 20 s immunitet (ingen tag-back).
  - I smitte blir byttet jeger. Når det siste byttet er tatt, får det +25 og runden slutter.
  - Bytter får +1 per 5 s de overlever. I smitte får de som overlever til tiden er ute, +25 og merket «Overlevde».
- **Fangster serialiseres** med en egen advisory-lock per økt, som tas før noen radlås. Det gir eksakt «siste bytte» og ingen dobbel fangst, og den kan ikke gi deadlock med `tick()`, som låser spiller → økt.
- **Mislykkede forsøk** logges som `catch_fail` med årsak (`too_far`, `no_fix`, `immune`, `bad_code` …). Det er grunnlaget for «90 % uten tvist».
- **Synlighet** (PLAN § 9.3, avgjort i SQL):
  - Jegere får radarping av byttene hvert 30. s, hvert 10. s for et bytte som har stått stille i over 15 s, og pingen hoppes over ved fart over 2 m/s («stealth»).
  - Jegere får også «Bytte i nærheten» når et bytte er under 30 m unna.
  - Bytter ser bare en pulserende ring når en jeger er innenfor 60 m, aldri et punkt.
- **Modus-kroker:** `_mode_begin`, `_mode_finish`, `_mode_upkeep` og `_mode_tick` er utvidelsespunkter, så del 2 (sone) slipper å kopiere `tick()` igjen.
- **Pause** forskyver også overlevelsesklokka og immuniteten.
- **Klient:**
  - Jegeren har rød skjerm med radarprikker som blekner, og en «Fang»-knapp som åpner kameraskanner med sifferfelt.
  - Byttet har blå skjerm, «Vis koden min» med stor QR og fire sifre, varselring og skjoldnedtelling.
  - Begge får blink, lyd og vibrasjon ved fangst, og når rollen deres skifter.
- **Sim:** jegerboter løper mot den ferskeste radarpingen og «tar» et bytte innenfor 12 m med koden til byttet. `--assert` feiler hvis mer enn 10 % av forsøkene avvises som tvist (`too_far` eller `no_fix`). Lokalt med 20 boter og spillelista smitte 150 s + sisten 150 s ble det 38 fangster med 0 tvister, og spillelista gikk til samling av seg selv. `immune` og `bad_code` (utdatert kode i botens visning) er forventet og telles ikke som tvist.
- **Deploy 2026-11-11:** migrasjon 0004 er i prod, og Worker `ae601e48` er bygget fra `d93a652` (rollback `95dce286` = fase 2). Prod-sim med 10 boter, smitte 90 s + sisten 90 s: 11 fangster, 0 feil, tick p95 201 ms, og spillelista gikk til samling av seg selv.
  - En tidligere kjøring samme dag ga 3 × 500 på tick ved overgangen til samling. Det skjedde mens nettlinja var dårlig (`tick_0_network`, og /api/health brukte opptil 1,3 s).
  - Feilen kom ikke igjen, verken lokalt eller i prod med `wrangler tail`. Følg med på den i den felles utetesten.

## ADR-022 — Fase 3 del 2: krympende sone (2026-11-11)
- **Et lag på hvilken som helst runde:** planrunder tar `"zone": true` (Postjakt + sone, Sisten + sone …). Veiviseren har en «⭕ + krympende sone»-knapp per runde.
- **Ren funksjon av tid** (PLAN § 3.3):
  - Ved rundestart lagrer `rounds.state.zone` sentrum, radiene `r[0..3]` og de absolutte fasetidene. Sonen er da `circle(c, r[#{at ≤ t}])`.
  - `lib/rules/zone.ts` (`zoneAt`) og SQL (`_zone_k`/`_zone_r`) testes mot de samme vektorene. Det trengs ingen jobb og ingen klienttimer som fasit.
  - Pause flytter fasetidene, samme mønster som `golden_at`. «+1 min» endrer ikke soneplanen, så siste fase blir bare lengre.
- **Geometri:**
  - Sentrum velges blant 20 kandidater så langt inne at den siste sirkelen får plass, med størst mulig avstand til forbudte soner.
  - `r0` er avstanden til det fjerneste hjørnet, så fase 0 dekker hele området.
  - Deretter kommer 3 sirkler med samme areal som 75/50/25 % av området, aldri under 20 m. Fase k starter ved D·k/4.
- **Poeng:**
  - Utenfor gir −1 per 3 s (`zone_out_since`/`zone_pen_stint`, samme teknikk som overlevelsespoengene), aldri under 0 for runden.
  - Hvem som er inne, avgjøres slik: dist ≤ r + min(acc, 15 m), og et fix dårligere enn 30 m teller som inne (tvilen kommer eleven til gode).
  - Den som er inne i den nye sirkelen ved hvert faseskifte, får +5. Inne ved alle tre skifter gir merket «Sonemester».
  - Faseskiftet betales i `_mode_upkeep` under sesjonslåsen, og det tar igjen flere faser på én gang.
- **Poster** i en sonerunde legges inne i neste sirkel. Åpne poster utenfor en ny sirkel fjernes, og upkeep fyller på.
- **Kroker:** 0004s `_mode_*` er døpt om til `_tag_*`, og nye `_mode_*` kaller både tag og sone. `_norm_plan` og `_unfreeze` pakkes inn på samme måte. Omdøpingen er vernet, så migrasjonen tåler å kjøres to ganger (test-db og provisjoneringsskriptet, som kjører alle migrasjoner i rekkefølge). Ingen kopi av `tick()`.
- **Klient:**
  - Kartet toner alt utenfor sirkelen rødt og viser neste sirkel stiplet 20 s før. Dette laget ligger under forbudte soner og samlingspunktet (regel 4).
  - Stripen viser «Sonen krymper om N s» med pip, og «Utenfor sonen!» med pil mot sentrum og avstand til kanten.
  - Utenfor sonen får skjermen rød kant og lyd. Inne ved krymping kommer +5-blink.
  - Lærerkartet tegner den samme sirkelen fra servertid.
  - Sikkerhetsbanneret går alltid foran.
- **Personvern:** de nye kolonnene er tellere og tidspunkter, ingen posisjoner. Sonesentrum er avledet av området.
- **Sim:** `--plan posts+zone:120,swap+zone:120`. Botene løper mot sentrum når de er utenfor 80 % av neste radius, men «gjemmere» bryr seg ikke. `--assert` krever minst én sonebonus. Lokalt med 20 boter: 104 klaim, 16 fangster, 90 sonebonuser, 126 strafpoeng, 6 krympinger, 15 Sonemester, 0 feil, tick p95 22 ms.
- **Deploy 2026-11-11:** migrasjon 0005 er i prod. Krokene kaller sonelaget, `_zone_radii`/`_zone_offsets` gir de samme vektorene som testene, og anon er nektet. Worker `f9986735` er bygget fra `afb2a2c` (rollback `ae601e48` = del 1).
  - Prod-sim med 10 boter, postjakt + sone 120 s og sisten + sone 120 s: 33 klaim, 5 fangster, 39 sonebonuser, 121 strafpoeng, og spillelista gikk til samling.
  - Tick p95 ble 3,5 s, med 7 nettverksbrudd på klientsiden. Det kom av lokal nettlinje: google.com brukte 35 s og TCP-oppkobling opptil 10 s i samme minutt, så det er ikke Chase. Kjør prod-simen på nytt på stabil linje før den felles utetesten.

## ADR-023 — Fase 3 del 3: seremoni, paller, overstyring, maler (2026-11-11)
Eierens valg 2026-11-11: **læreren starter seremonien**, **læreren trykker «Neste»** for hver pall, og **alle 8 pallene + «Beste dommer»** er med.
- **Flyt:** samling → «🏆 Start seremoni» (status `ceremony`) → én pall per «Neste» (lærermobilen spiller trommevirvel, elevmobilene fanfare) → «ditt beste»-kort og «vil spille igjen» → «Avslutt» sletter som før.
  - Startes seremonien mens en runde pågår, lukkes runden først ved frysepunktet, så poengene teller.
  - Seremonilaget ligger under varselstripa, og nødknappen er alltid synlig (regel 4).
- **Pallene fryses ved start** i `sessions.podiums`. Der ligger bare spiller-id-er og tall, og kallenavn hentes ved visning.
  - Pallene er utforsker, comeback, poster, overlevd, fangster, aktiv, distanse og poeng, i avsløringsrekkefølge med poeng sist. «Beste dommer» kommer først.
  - Topp 3 per pall. Paller uten verdier hoppes over.
  - **Spredningsregel** (maks 2 paller per elev, kan skrus av): plassene deles ut i viktighetsrekkefølge, poeng først. Hvis neste i køen ikke har noe å vise, blir pallen kortere eller faller bort.
  - Ren funksjon `_podiums_from` = `lib/rules/podiums.ts`, testet mot samme vektor.
- **«Ditt beste»:** kategorien med minst topp-andel, avrundet opp til 10 % og vist når den er ≤ 50 %. Ellers blir det alltid en positiv setning: aktive minutter, meter eller «takk for at du var med». Alle får et kort (sim: 20/20).
- **«Vil spille igjen»** telles anonymt i `sessions.again_*` og går videre til `session_summaries`. `players.voted_again` hindrer bare dobbeltstemming.
- **Overstyring** (PLAN § 5.2, § 6):
  - ± poeng med årsak (maks 100, aldri under 0, logget i `events`). Sperret under seremonien fordi pallene er frosset.
  - Jeger/bytte i Smittejakt, dommer og tilbake, og «🏅 Beste dommer» (maks 3).
- **Smittejakt-fiks:**
  - Den som er nøytral i en tag-runde, blir bytte med immunitet. Det gjelder elever som er tilbake fra «sitter over» og elever som kom sent.
  - En runde uten jeger forfremmer et bytte, og hendelsen logges som `tag_promote`.
  - «Sitter over» avslutter overlevelsesstrekket.
  - Alt dette ligger i `_mode_upkeep`.
- **Fartsflagg:** rapportert fart over 25 km/t i 10 s gir en `speed`-alarm (laveste nivå, uten posisjon, uten straff).
- **Maler:**
  - «🌱 Første gang»: postjakt 4 → smitte 5 → postjakt + sone 5 → smitte + sone 6, ca. 24 min spill.
  - «🏟️ Full gymtime»: fri 3 → postjakt 6 → smitte 6 → postjakt + sone 6 → sisten + sone 6, ca. 32 min, så det blir plass til oppstart og seremoni i 45 min.
- **`docs/PILOT.md`**: sjekkliste før og under timen, med reserveplan.
- **Kroker:** `host_action` og `host_snapshot` pakkes inn med vernet omdøping (`_host_action_base`/`_host_snapshot_base`) slik at de tåler dobbel kjøring. `_end_session` er kopiert med `again_*`.
- **Sim:** `--ceremony` kjører seremonien, og botene stemmer. Simmen speiler nå at signalklokka starter på nytt ved hver rundestart (låste mobiler i pustepausen); tidligere ble det en falsk «alarm kom aldri».
  - Lokalt, 20 boter: 8 paller, 16 ulike elever på pall, 20/20 kort og 20 stemmer, tick p95 21 ms.
  - Lokalt, 12 boter: alle krav oppfylt.
- **Deploy 2026-11-11:** migrasjon 0006 er i prod. Wrapperne `host_action`/`host_snapshot`, `vote_again`, `_podiums_from` og `_tag_rebalance` kan bare kjøres av service_role, `kc()` gir 3/2/6.95, og cron `chase-purge-expired` er aktiv. Worker `0d91c315` er bygget fra `be354a7` (rollback `f9986735` = del 2).
  - Prod-sim, 10 boter, poster+sone 90 s og smitte 90 s med `--ceremony`: 20 poster, 8 fangster, 21 sonebonuser, 0 feil, tick p95 185 ms. Seremonien ga 7 paller, alle 10 på pall, 10/10 kort og 10 stemmer (8 ja, 2 nei). Alle forventede alarmer nådde læreren innen 0,9 s. «Avslutt» stoppet på oppropet (5 ikke ved samlingspunktet) og ble tvunget, som forventet.

## ADR-024 — Fase 4: hendelser, power-ups og flere merker (2026-11-11)
Eierens valg 2026-11-11:
- **Hendelser** kommer automatisk hvert 90. sekund, og læreren kan i tillegg utløse dem med ⚡ og ett trykk til.
- **Power-ups** fås bare som premie i hendelser.
- **Fysiske oppdrag** bekreftes med en QR-post eller av læreren.
- Hele fasen leveres **samlet**.

Migrasjon 0007 og tvillingen `lib/rules/events.ts`:
- **Hendelsesmotoren:**
  - Én hendelse om gangen per runde. Den ligger i `rounds.state.ev` med absolutte tider og er en ren funksjon av tid (regel 6), slik sonen er.
  - Pause flytter tidene. Automatikken bruker `plan.event_every_s`: 0 = av, ellers 60–300. Veiviseren foreslår 90.
  - Læreren kan slå automatikken av og på underveis.
  - Det startes ingen ny hendelse når det er for lite igjen av runden. Rundeslutt avslutter hendelsen.
- **Hendelsene** (hvilke som kan velges, avhenger av modus):
  - **Sprint til punkt** (alle moduser): et punkt dukker opp minst 40 m fra alle. De tre første innenfor max(12 m, acc), med en fix bedre enn 25 m, får 20 p og en power-up.
  - **Fysisk oppdrag** (alle moduser): en øvelse der eleven står. Eleven skanner en QR-post, eller trykker «Ferdig» så læreren bekrefter (én og én eller alle). Gir 15 p og merket «Oppdrag». Automatikken velger det bare når økta har QR-poster. Ellers utløser læreren det selv.
  - **Samlingsalarm** (alle moduser): alle som når samlingspunktet innen 60 s, får 10 p. De tre første får en power-up, og de siste får en øvelse på skjermen. Ingen straff (regel 5).
  - **Gyllen post** (Postjakt): en gyllen post nå.
  - **Rollebytte-storm** (Smittejakt): alle roller byttes i 30 s med 5 s immunitet. Fangster følger Sisten-regler, så runden ikke kan ta slutt midt i stormen. Etterpå byttes rollene tilbake.
  - **Mørkelegging** (Smittejakt): jegerne har ingen radar i 45 s.
- **Power-ups:**
  - Inventaret har plass til 2, og de brukes med ett trykk.
  - Skjold (immun i 15 s, bytte) og radar (alle motstandere i 5 s) virker bare i Smittejakt.
  - Lokkedue (falskt radar-ping 40 m unna i 30 s, bytte) virker også bare i Smittejakt.
  - Turbo (dobbel bevegelsespoeng i 30 s) virker i alle moduser.
  - Premien trekkes blant dem som passer for runden. Er inventaret fullt, blir det bare poeng.
- **Merker:** nye merker er 500 m, 5 aktive min, overlevde 60 s, fangst-trippel (3 fangster i én runde), utforsker 10 ruter, sprint, oppdrag, samling og første power-up.
  - **Avvik fra PLAN §4:** merkene lagres med en gang (serveren er sannheten, og eksisterende tester gjelder fortsatt). Mobilen viser høyst ett nytt merke per 30 s og legger resten i kø, så det ikke blir støy.
- **Personvern:** lokkeduens punkt ligger i `player_live`, som slettes ved «Avslutt». Deltakelse i hendelser (`event_entries`) slettes med økta (PLAN §8).
- **Testet lokalt:**
  - DB-testene er grønne for alle migrasjoner (kjørt to ganger), og 126 TS-tester er grønne. Tvillingen `lib/rules/events.ts` gir det samme som SQL-en på de samme testdataene.
  - Sim med 20 boter (Postjakt, Smitte, Sisten + sone, hendelser hvert 60. s, 4 QR-poster, seremoni): 5 hendelser, 78 premier, 36 av 36 oppdrag bekreftet, 9 power-ups vunnet og brukt, tick p95 23 ms, 0 feil.
  - I nettleseren: ⚡ → sprint med to trykk (tre vinnere, så slutt), oppdrag → «Ferdig» → godkjent med +15 og merke, skjold (immun 15 s), og rollebytte-storm med tilbakebytte.
- **Låser:** `_ev_invert` låser spillerradene før statistikken, i samme rekkefølge som `catch()`, så storm og fangst samtidig ikke gir vranglås.
- **Ustabil test:** sone-testen fra 0005 sammenlignet r0, som er rundet til 0,1 m, med eksakt avstand. Den kunne feile når sentrum ble trukket uheldig, så den har nå 0,05 m margin. Migrasjonen er ikke endret.

## ADR-025 — Låserekkefølge ved faseskifte (2026-11-12)
Prod-sim etter deploy av fase 4 (Worker `0aa01b59`, migrasjon 0007) ga 500 rett etter rundestart, med Worker-loggen `40P01 deadlock detected`. Feilen ble gjenskapt i to kjøringer.
- **Hvorfor:** en tick låser sine egne rader i rekkefølgen `players` → `player_live` → `player_stats`. Faseskiftet (`_advance` → `_begin_round`/`_finish_round` og modus-krokene) oppdaterte `player_stats` for alle og *så* `player_live`. Det er samme feilklasse som de uforklarte 500-feilene i ADR-021. `_ev_begin` i 0007 la til enda en slik oppdatering ved rundestart, så feilen ble hyppig.
- **Løsning (0008):** `_advance` pakkes inn. Den som vinner sesjonslåsen og skal skifte fase, låser først alle spillerrader i økta i id-rekkefølge. Tickene holder sin egen `players`-rad før de rører `player_live`/`player_stats`, så sirkelen kan ikke oppstå.
- **Status 2026-11-12:** 0008 er i prod (wrapper og rettigheter er verifisert). Det trengtes ingen ny Worker; `0aa01b59` (bygget fra `e8c7db9`) kjører fortsatt, med rollback `0d91c315` = fase 3.
  - Prod-sim 1 (10 boter, Postjakt 120 s + Smitte 120 s + Sisten 120 s, hendelser hvert 60. s, seremoni): 0 feil, ingen vranglås i Worker-loggen, p95 134 ms, 8 paller, 10/10 kort.
    - Den eneste sjekken som feilet, var «ingen premie». Med runder på 120 s får bare storm (uten premie) plass etter 60 s, så det var riktig oppførsel.
  - Prod-sim 2 (Postjakt 240 s, hendelser hvert 60. s, 2 QR-poster): alle krav oppfylt. Oppdrag og sprint (3 vinnere), 12 premier, 3 power-ups brukt, 9/9 oppdrag bekreftet, p95 119 ms, 0 feil.
- I prod-sim 1 tok ett enkelt tick 16 s (p99 617 ms), og det gjentok seg ikke i sim 2. Den trege alarmen på 58 s gjentok seg ikke heller (maks 1,9 s og 0,9 s). Følg med på dette i utetesten.

## ADR-026 — Fase 5: lag, Flaggjakt, Konge på haugen og lagpall (2026-11-12)
Eierens valg 2026-11-12:
- **Flaggjakt** er «erobre poster», ikke klassisk CTF.
- **Konge på haugen** gir poeng til laget med flertall i sonen, og sonen flytter seg.
- Elevene ser **lagkameratene** og har **hurtigmeldinger**, men ingen fritekst.
- Hele fasen leveres **samlet**.

Migrasjon 0009 og tvillingen `lib/rules/teams.ts`:
- **Lag:**
  - `plan.teams` er 2–4 (standard 2 når spillelista har en lagrunde).
  - En lagrunde er `flag`, `king`, eller en Postjakt/fri runde med `"team": true`. Smittejakt spilles alltid hver for seg, fordi lag gjør roller og synlighet uoversiktlig.
  - `flag`/`king` kan ikke ha krympende sone, siden flaggene og haugen må kunne nås.
  - Lagene fordeles **én gang**: når læreren trykker «Fordel lag», eller når første lagrunde starter. Fordelingen er en slangetrekning på poeng så langt i økta, så størrelsene skiller med høyst 1.
  - Etter første lagrunde er lagene låst mot ny fordeling (`teams_locked`). Læreren kan fortsatt flytte enkeltelever, og nye elever havner på det minste laget ved første tick.
- **Lagpoeng:** alt medlemmene tjener i lagrunder (rundepoeng legges inn ved rundeslutt, én gang per runde), pluss bonuser for flagg som holdes og haug som holdes. Mobilen viser bare eget lag, plassering og egne lagpoeng (PLAN §0, regel 5).
- **Flaggjakt:**
  - Antall flagg er lag + 1 (maks 5), spredt med «lengst-unna»-trekning.
  - Et lag tar et flagg ved å ha flere spillere enn hvert av de andre lagene innenfor max(15 m, acc), med fix ≤ 25 m, i 10 s. Hver av dem får 10 p, merket «Flagg» og et lagbidrag.
  - Et flagg som holdes, gir laget 5 p hvert 30. sekund.
- **Konge på haugen:** haugen har 20 m radius og flytter seg hvert 150. sekund, minst 40 m. Hvert 10. sekund får laget med flest spillere i haugen 3 p, og hver av dem 1 p. Seks slike perioder gir ett lagbidrag og merket «Haug».
- **Tilstand:** flagg og haug ligger i `rounds.state` med absolutte tider, som en ren funksjon av tid (regel 6). Pause flytter tidene.
- **Hurtigmeldinger:** Hjelp!, Kom hit, Jeg tar den og OK, med avsenderens posisjon, bare til eget lag og bare i lagrunder.
  - Maks én per 5 s.
  - Meldingen ligger i `player_live` (UNLOGGED, slettes ved «Avslutt»).
  - Den sendes **ikke** over Realtime (CLAUDE.md, posisjoner aldri i Realtime). Lagkameratene får den med neste tick.
- **Seremoni:** «🤝 Lagspiller» (assists + poster i lagrunder + flagg tatt + minutter på haugen) kommer rett før «Flest poeng», og «👥 Lagpall» med alle lagene til slutt.
  - Lagspiller følger ikke spredningsregelen.
  - Ren funksjon `_team_podiums()` med samme testdata i SQL og TS.
- **Sikkerhet først (regel 4):** lærerens elevprikker beholder sikkerhetsfargene. Lagfargen vises på navnelappen, siden Rød lett forveksles med alarm-rød. Lagstripa ligger under varselstripa.
- **Låser (ADR-025):** all skriving til andre elevers rader (flaggtakere, haugholdere, fordeling, rundeslutt) låser `players`-radene først, i id-rekkefølge.
- **Kartet:** kartfontene har ikke emoji. Flagg og haug tegnes derfor som fargede prikker med tekst («Flagg 1», «Haugen»).
- En gammel 0003-test brukte `flag` som eksempel på en ukjent modus. Den bruker nå `relay`.
- **Testet lokalt 2026-11-12:**
  - DB-testene er grønne for alle 9 migrasjoner (kjørt to ganger), og 135 TS-tester er grønne.
  - Sim med 40 boter og 4 lag (Postjakt som lag 120 s, Flaggjakt 180 s, Konge på haugen 180 s, hendelser hvert 60. s, seremoni): alle krav oppfylt.
    - Lagene ble 10/10/10/10, 16 flagg ble tatt, og haugen ble holdt av 3 forskjellige lag.
    - 217 lagbeskjeder ble sendt og 1 952 vist hos lagkamerater. Lagpoengene ble 1055/1040/930/849.
    - 8 paller med Lagspiller før Poeng og Lagpall (4 lag) til slutt. 40/40 så «ditt beste».
    - Tick p95 34 ms, 0 feil, alarmer maks 1,0 s.
  - I nettleseren: veiviseren med Flaggjakt/Konge/«Som lag»/antall lag og malen «Lagtime». Lærerkartet med flagg i eierfarge og lagfarget navnelapp, lagstripe under varslene og «Flytt til lag». Elevmobilen med en sen elev som havnet på det minste laget, lagstripe («Dere tar flagget … 9»), lagkamerater og hjelpemelding.
- **I prod 2026-11-12:** 0009 er kjørt med provisjoneringsskriptet. 13 av 13 nye funksjoner finnes, `king` er med i modussjekken, `anon` er sperret og `service_role` har tilgang. Worker `cc66a5ff` er bygget fra `86be2a1` (rollback `0aa01b59`), og røyktesten ga 12×200 før og etter.
  - Prod-sim (40 boter, 4 lag, samme spilleliste som lokalt, hendelser hvert 60. s, seremoni): alle krav oppfylt.
    - Lagene ble 10/10/10/10, 13 flagg ble tatt og haugen fikk 5 eierskifter.
    - 220 lagbeskjeder ble sendt og 1 972 vist. Hendelsene ga 35 premier.
    - 8 paller med Lagpall til slutt, og 40/40 så «ditt beste».
    - Tick p95 126 ms, 0 feil, alarmer maks 1,0 s.
  - Worker-loggen viste bare `Ok`, ingen 500 og ingen vranglås.

## ADR-027 — Fase 6: bibliotek, delelenker og egne oppdrag (2026-11-12)
Eierens valg 2026-11-12:
- **Biblioteket fylles automatisk.** Hver økt lagres som «sist brukt», og læreren gir navn til det hen vil beholde.
- **Delelenker** deler opplegget og eventuelt området, og virker til læreren trekker dem tilbake.
- **Startpakker** inneholder opplegg, egne oppdrag og et forslag til område.
- Hele fasen leveres **samlet**.

Migrasjon 0010 og tvillingen `lib/rules/library.ts`:
- **Bibliotek per lærernøkkel** (bare SHA-256-hash på serveren):
  - Områder, opplegg og oppdragspakker.
  - `create_session` er pakket inn og lagrer området og planen som `recent`. Er de identiske med noe som finnes, oppdateres bare `last_used_at`. De 5 nyeste `recent` beholdes per type.
  - «Behold» med navn gjør en rad til `saved`, og den ryddes aldri automatisk. Grensen er 50 lagrede per type.
  - `library_get`, `library_save` (ny eller endre; uten data = gi navn og behold) og `library_delete` gjelder bare egne rader.
- **Delelenker:**
  - `shares` er en **kopi** av planen, og eventuelt området, tatt da lenken ble laget. Endringer i biblioteket etterpå påvirker ikke lenken.
  - Koden er 8 tegn uten tvetydige tegn. «Trekk tilbake» sletter raden.
  - `share_get` returnerer et trygt DTO uten noe om læreren og leses på serveren for `/d/[kode]` (ingen offentlig RLS).
  - «Lag kopi» (`share_copy`) lager mottakerens lærernøkkel om den ikke finnes, og legger kopien som `saved`. Kopier fra andre telles, egne kopier ikke.
- **Egne oppdrag:**
  - `plan.missions` har 1–12 tekster på 2–80 tegn, trimmes og dedupliseres uten hensyn til store og små bokstaver. En tom liste betyr at feltet mangler.
  - Et oppdrag trekker en av tekstene (`ev.mission_text`, via `_ev_start`-wrapper) i stedet for de seks innebygde.
  - Mobilen får teksten via `_mode_tick`-wrapperen. Læreren ser den i ⚡-arket.
- **Startpakker** (`lib/starter.ts`, testet mot `normPlan`): Skolegården (70 m), Skogen (150 m, 3 lag), Park i sentrum (100 m) og Leir (130 m, 4 lag).
  - Hver pakke har en spilleliste, egne oppdrag og tips om forbudte soner.
  - Området blir en sirkel rundt læreren, fordi områder alltid er lokale.
- **Lærernøkkel:**
  - Eksport viser nøkkelen og en QR med `CHASE-KEY:<nøkkel>`. QR-en skannes i appen og er aldri en URL, så nøkkelen havner ikke i nettleserhistorikk eller logger.
  - Import tar skrevet tekst (store eller små bokstaver, med eller uten bindestrek) eller en skannet QR. Den sjekker at nøkkelen finnes (`known`) og ber om bekreftelse før den erstatter et bibliotek som ikke er tomt.
- **Personvern:**
  - Biblioteket har ingen elevdata. Lærere som ikke har vært brukt på 395 dager, slettes med biblioteket sitt (`purge_expired`-wrapper).
  - Malene for databehandleravtale og DPIA (`lib/legal.ts`, `/personvern`) bygger på slettetabellen i PLAN §8 og har tydelige plassholdere. Behandlingsansvarlig må tilpasse og godkjenne dem.
  - Underdatabehandlernes region og overføringsgrunnlag er merket «kontroller».
- **QR-PDF:** A4-utskrift (`@page`) for QR-postene og malene. «Skriv ut / lagre som PDF» bruker nettleserens PDF-utskrift i stedet for et eget PDF-bibliotek.
- **Testet lokalt:**
  - DB-testene er grønne for alle 10 migrasjoner (kjørt to ganger), og TS-testene er grønne.
  - I nettleseren:
    - Startpakken «Skogen» ga radius 150 og fem oppdrag, og økta ble lagret automatisk i biblioteket.
    - «Behold» med navn og deling med område ga en lenke. En ny lærer (ny nøkkel) åpnet `/d/<kode>`, laget en kopi og trykket «Start økt med dette». Økta ble laget uten endringer, med plan, lag, 5 oppdrag og område identiske med lenken.
    - Lærernøkkel A ble importert med små bokstaver og mellomrom på «enhet B», og biblioteket kom fram.
- **I prod 2026-11-13:** fase 6 ble rebaset oppå rammeverksløftet (`d1c562c`: Next 16.4.6, Node 24, compat 2026-11-01). Check er grønn på det nye rammeverket. Pushet som `ded1ccd`.
  - **Migrasjon:** provisjoneringsskriptet fikk `40P01` allerede på 0001, fordi en prod-sim med 40 boter tikket samtidig. 0001 ble rullet tilbake, og ingenting ble endret. Derfor ble bare 0010 kjørt, i én transaksjon og med `notify pgrst, 'reload schema'`. Den rører ingen tabeller tickene bruker, og simen tikket videre.
  - **Sjekket etterpå:** 15 av 15 funksjoner finnes, `shares` og de nye kolonnene er på plass, `anon` er sperret, og cron-jobben finnes.
  - **Worker:** `3c9e80eb` er bygget fra `ded1ccd` med Node 24 (rollback `8d3c735a` = rammeverksløftet). Røyktesten ga 12×200 før og etter, og `/bibliotek`, `/personvern`, `/personvern/dpia` og `/d/<ukjent>` svarer 200 («Lenken virker ikke lenger»).
  - **Ende til ende i prod med to engangsnøkler:** lagre opplegg med eget oppdrag → del → forhåndsvisning på `/d/<kode>` → kopi til nøkkel B (`saved`, lag og oppdrag med, kopien telt) → trekk tilbake → lenken er død. Ugyldig nøkkel gir 400. Testlærerne og dataene deres ble slettet etterpå.
  - **Neste gang:** provisjoneringsskriptet kjører alle migrasjonene på nytt og låser alle tabeller. Kjør det når ingen økter er live, eller kjør bare den nye migrasjonen.

## ADR-028 — Mindre arbeid per tick (2026-11-13)
- **Funn:** prod-simer med 40 boter i lagrunder ga 30–300 s ventetid og 522 fra Supabase. Det gjaldt også i lobbyen, så det var ikke spillogikken.
  - Det delte Supabase-prosjektet kjører på **Nano**: 0,5 GB RAM, ca. 830 MB swap i bruk og load 7. Hele Sunday-familien deler maskinen.
  - Eieren valgte (2026-11-13) å optimalisere koden først, ikke å oppgradere.
- **Målt lokalt** (`pg_stat_user_functions`, 40 boter, lag-Postjakt + Flaggjakt): 5,8 ms per tick.
  - Vedlikeholdet (`_mode_upkeep`) kjørte på 77 % av alle tick, med ca. 1,8 ms hver gang.
  - Lagvisningen (`_team_tick`) kostet 1,1 ms per tick.
- **0011:**
  - Vedlikeholdet kjører høyst én gang i sekundet per økt. Tidspunktet ligger i UNLOGGED `session_clock`, så det gir ingen WAL. Alle vedlikeholdsreglene er allerede funksjoner av tid med minst 5 s oppløsning.
  - Lagvisningen bygges én gang per vedlikehold inn i samme rad, og tickene leser den (høyst 5 s gammel). Er den eldre, bygges den på stedet uten å lagres, så tickene ikke slåss om raden.
  - Intervallet styres av `chase.upkeep_every_ms` (standard 1000). SQL-testene kjører med 0 fordi de tikker mange ganger i én transaksjon. 0011s egen test slår strupingen på.
- **Etter:** 4,2 ms per tick (−28 %). Vedlikeholdet kjører 234 ganger i stedet for 4 824, og lagvisningen koster 0,55 ms. Lokal p95 gikk fra 65 til 45 ms.
- **Fortsatt en risiko:** en full klasse på Nano-maskinen som deles med de andre appene. Kontroll-sim i prod etter deploy. Kommer ventetiden tilbake, er Micro/Small-oppgradering (eiers beslutning) neste steg.

## ADR-029 — Fase 7: faglige pakker, storskjerm og skritteller (2026-11-13)
Eierens valg 2026-11-13:
- **Spørsmål ved poster.**
- **Storskjerm** med kart, lagpoeng og seremoni.
- **Skritteller** er med. Fase 8 venter til etter testrunden.

Migrasjon 0012 og tvillingen `lib/rules/quiz.ts`:
- **Spørsmålspakker:**
  - `plan.quiz` har 1–30 spørsmål `{q, a: 2–4 svar, c}`, trimmet, og svarene må være ulike.
  - Pakken kan legges på **hvilken som helst Postjakt uten kodeendring** («Ferdig når»). Pakkene lagres i biblioteket (`challenge_packs.kind = 'quiz'`) og følger med delelenker.
  - Læreren skriver i et enkelt tekstformat: ett spørsmål per avsnitt, og det riktige svaret merkes `*`.
- **Flyten:** når eleven tar en GPS-post i Postjakt, og ikke har et åpent spørsmål, gir serveren neste spørsmål (`_quiz_pick`). Hver elev starter på sin egen forskyvning, så naboer sjelden får samme spørsmål.
  - Eleven har 60 s. Riktig gir +10, merket «quiz» og pallen «🧠 Flest riktige» (før Lagspiller/Poeng). Feil gir ingen straff (regel 5).
  - **Fasiten forlater aldri serveren før eleven har svart.** Tick sender bare spørsmål, svar og frist, og `plan` går bare til læreren. Svaret logges som spørsmålsnummer og riktig/feil.
  - QR-poster utløser ikke spørsmål (de har eget oppdragsspor).
- **Skritteller:**
  - Klientdetektoren (`lib/client/steps.ts`) teller topper i akselerasjonen: over g + 1,5, ned under g + 0,5, minst 0,25 s mellom. Den er testet med syntetisk gange.
  - iOS-tillatelsen spørres om når eleven trykker «Jeg er klar».
  - Serveren kutter til 4 skritt/s siden forrige rapport (`_steps_accept`) og summerer i `player_live` (UNLOGGED, slettes ved «Avslutt»).
  - `tick()` er pakket inn med en ny siste parameter `p_steps`. Navnebyttet tåler at 0002–0004 kjøres på nytt (testet: én `tick`, ingen overlast).
- **Storskjerm** `/host/[id]/tavle` (⋯ → «Vis på storskjerm»):
  - Lobby: PIN og QR.
  - Spill: stor klokke, runde, kart uten navn (prikker, ikke klikkbare), lagpoeng, flagg og haug, og hendelse med eget oppdrag.
  - Seremoni: pallene i stort format.
  - Bruker lærerens token fra samme nettleser og er bare til visning.
- **Fikset i samme slengen:** merkenavnene for «Flagg» og «Haug» (fase 5) manglet på mobilen. En ny test sjekker at alle merker har navn.
- **Testet lokalt:**
  - DB-testene er grønne for alle 12 migrasjoner (kjørt to ganger), og TS-testene er grønne.
  - Full sim med 40 boter og 4 lag (lag-Postjakt + Flaggjakt + Konge, spørsmål, skritt, hendelser hvert 60. s, seremoni): alle krav oppfylt. 135 spørsmål besvart (= poster), 54 riktige, 9 paller med «Flest riktige», tick p95 61 ms, 0 feil.
  - I nettleseren: spørsmålskortet etter en post, et feil svar (ingen poengtap, registrert som feil), og storskjermen med kart uten navn og lagpoeng.

## ADR-030 — Fase 8: Stafett, Sporing og over 150 spillere (2026-11-14)
Eierens valg 2026-11-14: «Stafett + Sporing» og «Over 150 spillere». Native app og Feide venter. Foto-oppdrag venter på DPIA. Alt bygges før én felles betatest, og deploy er godkjent på forhånd.

Migrasjon 0013 og tvillingen `lib/rules/relay.ts`:
- **Sporing** (Smittejakt-variant `fox`):
  - Én rev, alle andre jager. Rollene deles ut som i Smittejakt, og deretter gjøres byttene om til én rev pluss jegere (`_fox_begin`).
  - Reven ser alle jegere innen 150 m (de 40 nærmeste) som prikker på kartet. Jegerne får en radarping av reven hvert 20. sekund, også når den løper («stealth» gjelder ikke reven).
  - En fangst bytter roller som i sisten: den som fanger, blir rev med 20 s immunitet. `catch()` er kopiert fra 0004 med `fox` behandlet som `swap`.
  - En rev som går ut eller sitter over, erstattes av en tilfeldig jeger med fersk posisjon. Elever som kommer sent, jager.
  - Reven ved fløyta får +25 og merket «🦊 Rev». Reven tjener ellers +1 per 5 s som andre bytter.
  - Rollebytte-storm virker også her (alle blir rev i 30 s). Det er bevisst, siden det er gøy og går over av seg selv.
- **Stafett** (`relay`, alltid lagrunde, ingen sone):
  - Fem poster spredt bort fra samlingspunktet, som er basen. Hvert lag løper postene i fast rekkefølge og starter på hver sin post.
  - Løperen med pinne når posten (innenfor max(15 m, nøyaktighet), fix ≤ 25 m) og får +5. Tilbake ved basen (innenfor max(25 m, nøyaktighet)) er én etappe, som gir +10 til laget.
  - Pinnen går så videre: først til de som står ved basen, deretter til den som har løpt minst.
  - Pinner per lag = ceil(medlemmer / 5), så store lag holder alle i bevegelse. En pinne som ikke kommer hjem innen 3 min, går videre (elev som har gått seg vill eller stoppet). Den eleven havner bakerst i køen.
  - Flest etapper vinner. Etappene teller i «Lagspiller», og merket «🎽 Stafettløper» gis ved 3 etapper.
  - Hendelser i en stafettrunde: bare lærerens oppdrag, ingen sprint eller samling som drar løperne ut av løypa.
  - Alt avgjøres i vedlikeholdet (høyst 1/s, under øktlåsen). Andre spilleres rader låses først i id-rekkefølge (ADR-025). Tick leser bare.
- **Over 150 spillere:**
  - `max_players` 60 → 300, åpne poster opptil 40. IP-grensen for innmelding er 400/min, fordi hele skolen deler NAT.
  - Lagvisningen caches per lag (`team_clock`, UNLOGGED). Hver tick leser bare eget lag og de 20 nærmeste lagkameratene (`_nearest`, flat-jord-avstand). Jegerradaren bærer de 25 nærmeste pingene.
  - Lærerkartet går over i **gruppemodus** fra 80 spillere: vanlige prikker tegnes i ett WebGL-lag og samles i klynger med antall når man zoomer ut. Navn vises tett inne. **Alle som trenger læreren** (SOS, utenfor, forbudt sone, mistet signal, stillstand, ikke møtt ved samling) **beholder navngitt markør** (regel 4).
  - Lobbylista viser bare elever med svak eller manglende GPS («Vis alle» for resten). Spillerlista får søk.
- **Personvernretting:** lagvisnings-cachen fra 0011 inneholdt lagkameratenes posisjoner og ble ikke slettet ved «Avslutt», bare med øktraden etter 24 t. Den var UNLOGGED (aldri i WAL eller backup), men brøt regel 3. `_end_session` sletter nå `team_clock` og `session_clock`, og migrasjonen tømmer cachen for allerede avsluttede økter. PLAN § 8 er oppdatert.
- **Målt lokalt med 300 boter** (direkte mot PostgREST, Stafett 120 s + Sporing 90 s + lag-Postjakt 90 s):
  - Alle krav oppfylt, 0 feil, tick p95 19 ms (ende til ende).
  - Etapper på alle fire lag (34/36/38/28), fangster i Sporing.
  - DB-tid per tick ca. 5,7 ms med 300 boter, PostgREST og databasen på samme Mac. Uten konkurranse om CPU koster lagvisningen 0,42 ms mot 1,8 ms for 0009-versjonen.
  - 300 spillere er ~150 tick/s, altså ca. 0,6–0,9 kjerne databasetid. **Det tåler ikke Nano.** Skal flere klasser spille samtidig i prod, må Supabase oppgraderes (eiers beslutning).
- **Testet:** DB-testene er grønne for alle 13 migrasjoner (kjørt to ganger, med vektorer for Sporing, Stafett, 300-taket og slettingen). Sim med 40 boter over HTTP (Stafett + Sporing + Postjakt med spørsmål, hendelser og seremoni): alle krav oppfylt, p95 46 ms.

## ADR-031 — Nytt design: lyst lærertema, mørkt elevtema og bevegelse (2026-11-14)
Eierens valg 2026-11-14: lys lærerside og mørk elevside, leken bevegelse hos elev og rolig hos lærer, alt i én leveranse. Ingen endring i regler, API eller database.
- **Tema:** appen er lys («papir») som standard. En side blir mørk når den inneholder `.theme-dark` (`html:has(.theme-dark)`): elevskjermene (`/j`, `/play`, `/q`) og storskjermen. `text-ink` heter nå `text-on-accent` (mørk tekst på gull/rollefarge). Farget tekst bruker `*-text`-tokens for kontrast i begge temaer.
- **Bevegelse:** ren CSS (`m-*`-klasser i `globals.css`, områdefiler i `app/styles/`) og View Transitions, uten nytt bibliotek. `prefers-reduced-motion` slår av alt globalt.
- **Delte komponenter:** `lib/client/ui` (Button, Card, Chip, Sheet, Toast, Stepper, Confetti, `useCountUp`, `usePresence`). `classes.ts` er uten `"use client"` så serverkomponenter kan bruke `buttonClass`.
- **Regel 4 (sikkerhet slår spill):** SOS, alarmer, sonevarsel og signaltap har ingen forsinkelse, ingen exit-animasjon og starter aldri usynlige. Alarmprikker på lærerkartet glir ikke, de hopper til sann posisjon. En flash vises ikke mens SOS-overlegget er oppe.
- **Flytendringer:**
  - Lærerkartet: alarmer i én stripe. Alvorligste rad og hver åpne SOS vises alltid, resten bak «+N».
  - Navnelapper bare fra zoom 17, for valgt elev og for elever som trenger læreren.
  - «Start seremoni» er hovedknapp når `playlist_done`.
  - Veiviseren: spillelista er delt i «Runder» og sammenleggbart «Tillegg» (oppdrag, spørsmål).
  - Elev: kompasspil med avstand til nærmeste post, «Ring lærer» som ikonknapp, gråtonekart (`topograatone`).
- **Testet:** `npm run check` grønn (154 tester). Lokal sim med 20 boter (Postjakt 60 s + Smittejakt 60 s): alle krav oppfylt, alarmer hos læreren innen fristen. Skjermbilder av alle skjermer i 390x844 og 1280x800. Lagrunde, Flaggjakt, hendelser, lagark og `prefers-reduced-motion` er kontrollert med skjermbilder i en lokal sim (16 boter, 2 lag, hendelser hvert 60. s, 0 feil), og QR-arket er skrevet ut til A4-PDF. Ikke testet: ekte iPhone.
- **Deploy 2026-11-14:** Worker `544e796c` er bygget fra `main` (rollback `9901dca2` = første designdeploy, før det fase 8). Ingen migrasjon. Prod-sim med 10 boter (Postjakt 60 s + Smitte 60 s, seremoni, avslutt): alle krav oppfylt, 0 feil, tick p95 78 ms, alarmer 4/4 hos læreren.

## ADR-032 — Enklere design: tre steg, nye navn og ikoner (2026-11-15)
Eierens bestilling 2026-11-15: mer luft, selvforklarende navn, minst mulig tekst og ingen emojier, slik at en lærer som aldri har sett Chase kan opprette en økt. Ingen endring i regler, API eller database.
- **Veiviseren** har 3 steg i stedet for 7: Område · Runder · Klar. Møteplassen settes automatisk og kan dras, sperret område er valgfritt i steg 1, og runder velges som ferdige kort (detaljer bak «Tilpass» og «Flere valg»). Startskjermen («Samme som sist» / «Ny økt») vises bare når biblioteket har innhold. Velkomstskjermen med lærernøkkel er fjernet, nøkkelen ligger i biblioteket.
- **Navn:** Samlingspunkt → Møteplass, Forbudte soner → Sperret område, Spilleliste → Runder (lagret sett = Opplegg), Startpakker/maler → Ferdige opplegg, Hendelser → Overraskelser, Sporing → Revejakt, Egne oppdrag → Egne øvelser, Faglig pakke → Quiz, Seremoni → Premieutdeling. Overraskelsen «Samlingsalarm» heter «Løp til møteplassen». De juridiske malene i `lib/legal.ts` er ikke endret.
- **Ikoner:** felles strekikoner i `lib/client/ui/icons.tsx` erstatter emojier og piltegn i hele grensesnittet (ikke `/dev/sim`).
- **Tekster:** `lib/locale/no.ts` setter sammen `lib/locale/no/*.ts`, én fil per område.
- **Lærerpanelet:** lobby med stor QR og PIN og én Start-knapp. Under spill én rad: Pause, Beskjed, Samle alle, Overraskelse, Mer. «+1 min» ligger i statuslinjen mens runden går, «Neste runde» under «Mer».
- **Regel 4:** alarmstripen har samme plass, farger, rekkefølge og logikk som i ADR-031, med ikon i tillegg til tekst. SOS og «Ring lærer» har egen rad hos eleven.
- **Testet:** `npm run check` grønn (154 tester). Lokal sim med 10 boter (Postjakt 60 s + Smitte 60 s, premieutdeling, avslutt): alle krav oppfylt. Sett i nettleser på 375 px: forside, «Bli med», veiviseren steg 1–3, elevskjerm i Postjakt, lærerpanelets statuslinje med «+1 min» (trykk ga +60 s). Ikke sett: bibliotek med innhold, premieutdeling, bred skjerm. Ikke testet: ekte iPhone.
- **Deploy 2026-11-15:** Worker `70f054c7` er bygget fra `0e11cb3` (rollback `544e796c` = ADR-031). Ingen migrasjon. Prod-sim med 10 boter (Postjakt 60 s + Smitte 60 s, premieutdeling, avslutt): alle krav oppfylt, 0 feil, tick p95 147 ms, alarmer 4/4 hos læreren.
- **Etterkontroll 2026-11-16:** sett i nettleser på 375 og 1280 px: bibliotek med innhold, veiviseren med startskjerm og «Flere valg», lobby, lærerpanel i aktiv runde, samling med opprop, premieutdeling hos lærer, elev og på storskjerm, og «ditt beste»-kortet. Rettet: bibliotekkort bryter knappene ned på egen linje på mobil, navn på pallen brytes i stedet for å kuttes, «Flere valg» ruller inn i panelet når det åpnes, og pallen på storskjerm er forstørret fra 1280 px (`zoom: 1.4`). Ikke testet: ekte iPhone.
- **Deploy 2026-11-16:** Worker `b9c1b836` er bygget fra `d064c4b` (rollback `70f054c7`). Ingen migrasjon. Prod-sim med 10 boter (Postjakt 60 s + Smitte 60 s, premieutdeling, avslutt): alle krav oppfylt, 0 feil, tick p95 138 ms, alarmer 4/4 hos læreren.

## ADR-033 — Øktrom med Durable Objects: posisjoner over WebSocket, samlet skriving (2026-11-16)
Bakgrunn: prod-simer 11-13/11-14 knakk med 522 og 30–300 s ventetid fordi det delte Supabase-prosjektet (Nano, ca. 8 apper) fikk ca. 20 `tick()`-transaksjoner/s per økt pluss polling fra hver lærerskjerm (ADR-028). Eierens valg 11-14: «trinn 1 + måling» før den felles utetesten, SQL-logikken beholdes. Plan: `~/.claude/plans/planlegg-durable-objects-for-wiggly-elephant.md`.
- **Flytte Chase til Sunday-prosjektet: nei.** Ingen kapasitet å hente (også Nano), SSO-utstederen og `custom_access_token_hook` der ville blitt rammet av Chase-last, London i stedet for Stockholm, og PostGIS/pg_cron er nytt der. Trengs isolasjon senere: eget prosjekt (krever Pro).
- **Arkitektur:** egen Worker `chase-live` (`live/`) med én `SessionRoom` per økt (SQLite-basert DO, Hibernation API, `jurisdiction("eu")` fordi det er barns posisjoner). Ingen offentlige ruter. Next-workeren har `worker.ts` som inngang og slipper bare `GET /live/s/<id>/ws` (upgrade) videre via service binding `LIVE`, og bare når `LIVE_TRANSPORT=ws`. `/tick`, `/stats`, `/notify` gir 404 utenfra. To workere deployes og rulles tilbake hver for seg.
- **Samlet skriving (migr 0014):** `chase.tick_batch(session, ticks)` kalles ca. 1/s, maks 50 per kall (subxid-cachen), i spiller-id-rekkefølge med ett unntaksblokk per spiller og `lock_timeout 250ms` → `busy` og nytt forsøk ved neste skriving (andre ruter skriver fortsatt direkte). `hint_all`/`alert_host` regnes ut for hele bolken. **1,9 s-regelen:** samme spiller tikkes tidligst 1,9 s etter forrige gang, ellers ville farten (målt mot `now()` i `_tick_base`) blitt for høy og 8 m/s-regelen slått feil ut.
- **Push:** visningen sendes tilbake som `{t:"view"}`, `{t:"hint"}` betyr «send ny posisjon nå». Lærerskjermer får `host_snapshot_svc` pushet hvert 2. s (ett DB-kall uansett antall lærere, 200 ms debounce ved alarm), og poller HTTP hvert 10. s som vakthund (2 s hvis push uteblir 4,5 s). Et eldre snapshot kan aldri overskrive et nyere (regel 4).
- **Vakthund:** DO-alarm hvert 5. s i aktive faser, også uten tilkoblede, slik at signaltap og faseskifter skjer på serveren.
- **Reserve:** faller socketen, sender mobilen straks ett HTTP-tick og fortsetter på HTTP til socketen er klar. Tick-ruta går via rommet (svar innen 3,5 s) og faller til direkte `tick()`. Nødbryter `LIVE_ENABLED=0` på `chase-live` (lukker med 4003 → HTTP) og `LIVE_TRANSPORT=http` på Next-workeren. SOS går fortsatt direkte over HTTP og venter aldri på rommet.
- **Personvern (regel 3):** posisjoner bare i rommets minne til de er skrevet. DO-lagring har bare `{session, status, watchdogDue}` og slettes ved øktslutt. Token bare i første WebSocket-ramme, aldri i URL. Se PLAN § 8.
- **Terskel (eier 11-16):** fix→view p95 < 2 s, ikke 1,5 s. Halen (ca. 1,6 s) er ekte: 1,9 s-regelen pluss skriving én gang i sekundet. Klientside-timing ga 0,73 s, men gjorde geofence-alarmer tregere i simen og ble tatt ut (regel 4). Gjelder bare elevens egen visning.
- **Testet lokalt** (lokal Supabase + `wrangler dev` + `next dev`): 3 økter × 40 boter med alle sockets drept ved 60 s: 0 feil, `busy` 0, flush p95 ca. 77 ms, ca. 19 posisjoner per DB-kall, alarm maks 1,1 s, alle tilbake på 0,7 s, 0 tapte alarmer. `npm run check` 243 tester.
- **Deploy 2026-11-16:** PR chase#2–#5 merget (`e46d567`). Migr 0014 i prod 11-14 (alene, Management API). `chase-live` `29143e3a`. Next-worker `c8aa0ad9` med `LIVE_TRANSPORT=ws` (rollback `e5533114` = samme kode med http, før det `b9c1b836`).
- **Prod-målinger 2026-11-16:** HTTP, 40 boter: 0 feil, tick p95 145 ms, alarm maks 0,97 s, DB 20,1 transaksjoner/s. WebSocket, 40 boter: 0 feil, fix→view p95 1,59 s, alarm maks 1,9 s, DB **3,4 transaksjoner/s (5,9× færre**, tallene gjelder hele det delte prosjektet). 3 × 40 med drepte sockets i prod (2026-11-17, `--sessions 3 --bots 40 --minutes 2 --seed 7 --kill-at 60`): **alle krav oppfylt**, 0 feil. fix→view p95 1,62/1,69/1,62 s og p99 1,84/1,86/1,83 s, alarm maks 0,95/1,34/1,38 s, alle sockets lukket ved 60 s og tilbake på 1,5–1,7 s uten tapte alarmer. DB 9,8 transaksjoner/s for tre økter (ca. 3,3 per økt, 0 deadlocks, 0 rollback). (`dbstats` meldte først `chase.purge_expired()` med 476 ms i snitt, men det var en målefeil: to rader i pg_stat_statements med samme tekst. Ekte tall: kjøres hvert 15. min, snitt ca. 40 ms, maks 2,9 s én gang 11-13, rettet i `dbstats`.) (To tidligere forsøk 11-16 var ugyldige fordi testmaskinen sovnet.)
- **Ikke testet:** ekte iPhone (låst skjerm, bakgrunn, ny tilkobling etter resume) — legges til i den felles utetesten (ADR-019, `docs/PILOT.md`). `track_functions` er av i prod, så `scripts/dbstats.mjs` gir ikke tall per funksjon.
- **Drift:** aldri deploy `chase-live` midt i en time etter lansering (alle kobles fra, tilbake på under 1 s). Trinn 2 (bevegelse og statistikk i TypeScript i rommet) vurderes bare hvis flush p95 går over 1 s ved 120 boter eller CPU på Nano holder seg over 80 %.

## ADR-034 — Ett nytt forsøk ved tidsavbrudd i databasen (2026-11-18)
- **Funn:** en full prod-sim over WebSocket (40 boter, postjakt og smittejakt med sone, quiz, hendelser, samling, seremoni) ga én gang `ceremony_start` 500 og ett lærer-snapshot 500. Ny kjøring i prod og lokalt (også med en elev som blir med midt i runden) ga 0 feil. pg_stat_statements viser fullførte kall opptil 7,9 s (`tick`) og 6,6 s (`host_snapshot`), og `authenticator` har `statement_timeout` og `lock_timeout` på 8 s. Avbrutte kall telles ikke der. Konklusjon: Nano-databasen hakker av og til, og kall som passerer 8 s blir 500. Samme feilklasse som «3×500 ved overgang til samling» (fase 3) og «enkelt-tick på 16 s» (fase 4).
- **Beslutning:** `rpc()` i API-rutene prøver én gang til etter 200 ms når Postgres svarer 57014 (statement timeout), 55P03 (lock timeout), 40P01 (vranglås) eller 40001 (serialisering). Da er hele transaksjonen rullet tilbake, så et nytt forsøk kan ikke gjøre noe to ganger. Andre feil prøves ikke på nytt. Øktrommet (`chase-live`) har allerede sitt eget nye forsøk.
- **Rotårsaken** (for liten delt databasemaskin) løses bare ved å oppgradere Supabase (eiers beslutning).
- **Små skjermer:** på iPhone SE (375×667) dekket et hendelseskort under smittejakt nesten hele kartet. Hendelseskortet og tittelen er mindre når skjermen er lavere enn 700 px. Sikkerhetsvarsler og SOS-knappen er ikke endret.
- **Ikke en feil:** «ingen fikk premie i hendelsene» i simen kommer av at runder på 120 s bare rekker hendelser uten premie (hendelser startes bare når det er nok tid igjen).
- **Deploy 2026-11-18:** Next-worker `14b3f996` fra `6205194` satte `LIVE_TRANSPORT` tilbake til `http` i ca. 2 min, fordi `wrangler.jsonc` fortsatt sa `http` (ws ble satt bare i deployen 11-16). Rettet med `850a113c` (ws, rollback `c8aa0ad9`). `wrangler.jsonc` sier nå `ws`, så nødbryteren er å sette `"http"` og deploye.

## ADR-035 — GPS-glatting og hoppsperre i klienten (2026-11-18)
Fase 9, punkt 1 (PLAN § 13). Mål: færre falske alarmer og mindre hopping på kartet uten å gjøre sikkerhetsvarsler tregere (regel 4).
- **Hvor:** `lib/client/gpsFilter.ts`, ren og deterministisk. `useDeviceGps` sender alle fix gjennom filteret, og simulatoren (`lib/sim/driver.ts`) gjør det samme, så prod-sim måler det mobilen faktisk sender. Simulator-GPS-en i `/dev/sim` (`useSimGps`) er ikke filtrert.
- **Hoppsperre:** et fix som krever mer enn 12 m/s utover begge nøyaktighetssirklene holdes tilbake, maks 2 ganger på rad og aldri lenger enn 4 s. Deretter godtas det nye stedet. Mens et fix holdes tilbake, sender `useLiveTick` det forrige på nytt (det gjør den for fix opptil 15 s gamle), så det kan ikke utløse signaltap. Etter mer enn 10 s uten fix (låst skjerm) starter filteret på nytt.
- **Glatting:** et Kalman-filter med konstant fart per akse (akselerasjonsstøy 4 m/s²). Det følger en jevn løper uten etterslep. Utdata holdes innenfor min(acc, 8 m) fra rå-fixet, altså innenfor usikkerheten serveren allerede regner med.
- **Serveren avgjør fortsatt:** `acc` og `speed` sendes alltid rå. Ingen endring i SQL, regler eller API.
- **Testet:** `test/gps-filter.test.ts`: glatting (stillestående RMS-feil < 0,7× rå), løper uten skjevhet, klemming, hoppsperre, lang pause, og en sikkerhetstest over 40 frø × (vandrer, sperret område) med samme regler som `tick()`. Alarmen kommer fra 1 s tidligere til 1 s senere enn uten filter (mindre enn ett tick), i snitt −0,01 s. Falske alarmsekunder: 180 mot 183. Med én villfaren posisjon hvert 23. s (20 løpere × 300 s) går falske utenfor-alarmer fra 118 sekunder til 0.
- **Lokal sim** (30 boter, 3 min, frø 7/13/21, med og uten filter): alle krav oppfylt i alle seks, 0 feil, alarmer 4/4–5/5. Høyeste alarmtid er 1,02 s både med og uten filter. Utenfor-alarmen kom ett tick senere i én kjøring og ett tick tidligere i en annen, samme bilde som i enhetstesten. `npm run check` er grønn (256 tester). Ikke testet: ekte iPhone, legges til i den felles utetesten.
- **Deploy 2026-11-18:** Next-worker `469d7143` fra `638247f` (rollback `850a113c`), `LIVE_TRANSPORT=ws`. Ingen migrasjon, `chase-live` ikke endret. Røyktest før og etter er lik (rot 12×200, /ny, /bibliotek, /personvern og /j gir 200), og filterkoden blir levert. Prod-sim over WebSocket (40 boter, 2 min, frø 7): alle krav oppfylt, 0 feil, alarmer 4/4 med maks 1,34 s, fix→view p50/p95/p99 834/1592/1830 ms.

## ADR-036 — Fase 9.2–9.7: QR, talte varsler, faste poster, Snus/Termometer, offline-fliser (2026-11-18)
Runde med Sonnet-agenter (én per punkt, egen Sonnet-review for PR-ene med databaseendringer) og én samlet Opus-review før én deploy (eiers valg). PR chase#16–#22.
- **9.2 QR (#17):** `barcode-detector@3.2.3` (zxing-wasm) erstatter jsQR. Innebygd `BarcodeDetector` brukes først. Wasm lastes lazy fra egen origin (`/vendor/zxing_reader.wasm`, kopieres i postinstall), uten CDN. Prod leverer den som `application/wasm`.
- **9.3 Talte varsler (#18, migr. 0015):** læreren slår dem av og på for hele økta (`sessions.settings.voice`, veiviseren og panelet, `set_voice` + `POST /api/s/[id]/voice`). `tick` og `host_snapshot` er wrappere som legger på `voice`. `lib/client/voice.ts` bruker `speechSynthesis` nb-NO, låses opp i «Jeg er klar», og har prioritet (sikkerhet først; en lavere ytring kutter aldri en høyere innen 2 s). Buzzer, blink og alarmstripe er uendret (regel 4).
- **9.4 Faste poster (#19, migr. 0016):** `areas.posts` i biblioteket (autosave oppdaterer bare `recent`), plassering i veiviserens Område-steg, A4-utskrift på `/bibliotek/omrade/[id]/utskrift` og `/q/[kode]`. Faste GPS-poster gjenbrukes i Postjakt med 60 s hvile etter klaim. Hviler alle, kommer ingen tilfeldig post. Ingen poster i eller nær sperret område. Faste QR-kort har stabil kode og krever derfor at spilleren er der: fix yngre enn 60 s, acc ≤ 25 m og innenfor max(100 m, acc). Ellers `too_far`.
- **9.5 Snus/Termometer (#21, migr. 0017):** eget verktøy (ikke power-up) i tag-runder med 60 s nedkjøling. Snus: er nærmeste motpart innenfor 50 m (ja/nei). Termometer: varmere/kaldere/likt mot målets nåværende posisjon, sammenlignet med egen posisjon for 20–40 s siden (terskel max(5 m, acc)). Fix maks 10 s gammel og acc ≤ 25 m (`bad_acc`). Bevisst: ignorerer stealth og lokkedue, som `radar_live`. Ankeret er to flyktige punkter på UNLOGGED `player_live` (hc_*), oppdateres bare i tag-runder med god acc og slettes ved øktslutt (PLAN § 8). Svaret dekker aldri SOS, fare, sonevarsel eller GPS-tap, og ikke topplinjen eller SOS-knappen (regel 4).
- **9.6 Offline-fliser (#20):** Kartverkets vilkår: deler av z12–20 er Geovekst-data som ikke kan kopieres i bulk uten tillatelse. Derfor lagrer `public/sw.js` bare fliser kartet allerede har hentet (stale-while-revalidate, maks 3000), aldri forhåndshenting. Scope `/play/`, og `/api/*` og navigasjoner går rett til nett (Static Routing API der nettleseren har det). Nødbryter: publiser en `sw.js` som kaller `self.registration.unregister()`. 👤 Eier kan spørre kundesenter@kartverket.no om forhåndshenting senere.
- **9.7 Turf/Supercluster:** spiken viste at vår `lib/geo.ts` er korrekt (0 inne/ute-avvik, under 4 cm på 1 km) og rask nok. Turf ville lagt til ca. 6 kB gzip og er tregere på avstand til kant. Klyngingen bruker allerede Supercluster via MapLibre. **Ingen endring.**
- **Opus-review (#22):** én blokker (hotcold-svar over farevarsler) og tre BØR-punkter (SW-scope, faste poster ble gradvis byttet ut med tilfeldige, QR-nærvær uten acc-grense) er rettet før deploy.
- **Testet:** `npm run check` 308 tester, DB-tester grønne. Lokal sim med migrasjonene kjørt som i prod: 40 boter Postjakt, Smittejakt og Sporing med quiz, QR-kort og premieutdeling (alarmer 21/21, maks 0,99 s, Snus/Termometer 96 bruk), lag 3 × flaggjakt og Stafett (alarmer 3/3), og en lang runde med overraskelser. (Overraskelser starter ikke i runder på 90 s med intervall 60 s. Det er ikke en feil, `event_every_s` er 60–300.)
- **Deploy 2026-11-18:** 0015 → 0016 → 0017 kjørt hver for seg via Management API, hver i én transaksjon med `notify pgrst`. Kjedesjekk: `tick` peker til `_tick_voice`, og anon har ikke tilgang. Next-worker `f1e2a9de` fra `9c00152` (rollback `469d7143`), `LIVE_TRANSPORT=ws`, `chase-live` uendret. Røyk før og etter er lik. Prod-sim over ws (40 boter, Postjakt, Smittejakt og Sporing med quiz og QR): alle krav oppfylt, 0 feil, alarmer 14/14 med maks 1,37 s, fix→view p95 1,75 s, Snus/Termometer 102 bruk.
- **Runbook:** kjøres 0015 på nytt alene etter 0017, mister `tick` hotcold-ankeret uten feilmelding. Etter all migrasjonskjøring: `select prosrc like '%_tick_voice%' from pg_proc where proname='tick' and pronamespace='chase'::regnamespace` skal gi `t`.
- **Ikke testet:** ekte iPhone (stemme, QR-skanning i dårlig lys, offline-kart, utskrift på papir). Legges til i den felles utetesten (`docs/PILOT.md`).

## ADR-037 — Fase 10: drift, lærerverktøy og nye moduser (2026-11-19)

**Kontekst:** Eier valgte ni punkter 2026-11-18 (PLAN § 13, fase 10). Samme oppskrift som fase 9: Sonnet-agenter i egne worktrees, Sonnet-review per PR med databaseendringer, én samlet Opus-review, én deploy.

**Beslutning (PR #24–#33):**
- **Flat tick (0018):** `tick` og `host_snapshot` er igjen én funksjon hver. Mellomleddene `_tick_*` og `_host_snapshot_*` fra 0012/0015/0017 er slettet. Likhetstesten sammenligner med de gamle på felles vektorer, med radarlista sortert.
- **Sikkerhetsheadere (#28):** CSP i `lib/security/headers.ts`, med `wasm-unsafe-eval` for zxing og `unsafe-inline` for Next. Den tillater Kartverket, Supabase (https og wss) og `frame-ancestors 'none'`. I tillegg kommer HSTS og Permissions-Policy, der posisjon, kamera og skjermlås bare er tillatt for siden selv. `/sw.js` har sin egen, smalere CSP i `public/_headers`.
- **Feillogging (#25):** `POST /api/log` vasker meldingen (`lib/errorSanitize.ts`) og har rate-limit. Den lagrer ingen posisjoner, tokener eller kallenavn, og loggene går bare til Worker-observability.
- **Øktrapport (0019):** `session_report` blir lest i lærerens nettleser og lagres ikke. § 8 er uendret.
- **Quizpakker (#27):** 10 LK20-pakker som statisk TS-data.
- **Demo med boter (0022):** `demo_gate` har HMAC med `DEMO_SALT`, IPv6 som /64, maks 10 aktive og 3 per time. `_end_session_p7` lager ikke sammendrag for `is_sim`. Prod-simer blir merket `is_sim` når headeren `x-sim-key` stemmer med `SIM_KEY`.
- **Prøverunde og Poengorientering (0020):** Flagget `practice` setter en hviteliste-trigger på `player_stats`. Den fryser poeng og tellere, mens distanse, aktive sekunder og quizspørsmålet (`quiz_q`/`quiz_until`/`quiz_asked`) fortsatt oppdateres. Score-O bruker `ks()` og `lib/rules/scoreo.ts`.
- **Gjemsel (0023):** Gjemsel er en variant av Smittejakt (`tag`/`hide`) og bruker `kv()` og `lib/rules/hide.ts`. Plingen beregnes ved visning og lagres aldri. Pling-id-en er saltet med øktsaltet.

**Opus-review (#33):**
- Blokker: en vranglås mellom `catch` og ticken som avslutter runden. `catch` tok jeger- og byttelåsene i vilkårlig rekkefølge, mens `_advance` låser alle spillere `order by id`. `catch` tar nå sesjonslåsen og alle spillerrader i id-rekkefølge først, som 0008. Tick prøver bare låsen og venter aldri.
- Gjemsel satte `ping_at = null`, så upkeep pinget alle gjemmere på nytt hvert sekund. Nå settes `ping_at = now()`.
- `lock_timeout 3s` før `ALTER TABLE` i 0020 og 0023.
- Pling-id-en er saltet.
- Prøverunden viser quizspørsmål.
- Rapporten viser Gjemsel og «(prøverunde)» riktig.
- Ny rad i § 8 for `hs_since`, `hs_pts` og `hide_best_s`.

**Testet:**
- Vitest 391/391 og DB-tester grønne.
- Lokal sim med migrasjonene i prod-rekkefølge, 40 boter i Gjemsel og Smittejakt: før fiksen var det ikke mulig å gjenskape 500-feilene. Etter fiksen var det 58 fangster og 0 feil, p95 23 ms og alarmer 23/23.
- Hele planen (prøve-Postjakt, Poengorientering, Gjemsel og Smittejakt, med quiz, QR og premieutdeling) gikk uten 500-feil. Quizen fikk 55 svar, hvorav 22 riktige. Den kjøringen hadde et opphold på 170 s fordi Macen sov på batteri, så p95 fra den teller ikke.

**Deploy 2026-11-19:**
- Det var ingen aktive økter. Først ble secrets satt: `SIM_KEY` og `DEMO_SALT` på Worker `chase`.
- Migrasjonene 0018 → 0019 → 0020 → 0022 → 0023 ble kjørt hver for seg via Management API, hver i én transaksjon med `notify pgrst`. Nummer 0021 er ikke brukt.
- Kjedesjekken (`scripts/chain-check.sql`) var grønn: alle 23 lag kaller riktig indre funksjon, tick er flat, catch har låsen, triggerne finnes, og anon har 0 funksjoner.
- Next-worker `8722341f` er deployet fra `8758cb9` (rollback `3b5cafa7` = fase 9-koden med de nye secrets), med `LIVE_TRANSPORT=ws`. `chase-live` er uendret.
- Røyktesten var lik før og etter. CSP, HSTS og Permissions-Policy er på `/`, `/play/*` og `/sw.js`, og det var ingen CSP-feil i konsollen på `/` og `/ny`.
- **Prod-sim over ws** (merket `is_sim`, `SIM_KEY` virker):
  - Full plan med 40 boter (prøve-Postjakt, Poengorientering, Gjemsel og Smittejakt, med quiz, QR og premieutdeling): 0 feil, 52 fangster, 57 quizsvar, 0 dobbeltklaim i score-O og 0 Gjemsel-lekkasjer. Alarmene kom alle fram (37/37). SOS kom på 0,33 s og sperret område på maks 2,08 s, men **«utenfor» kom på maks 3,68 s**, så kravet p95 < 3 s ble ikke oppfylt.
  - Kontrollkjøring uten fangster (score-O og Postjakt): «utenfor» kom på 3,73 s, så det er ikke catch-låsen.
  - Fase 9-konfigurasjonen (frø 7, 2 min): alle krav oppfylt, alarm maks 1,70 s.
  - Forsinkelsen gjelder bare «utenfor» med frø 42 over ws. Lokalt over HTTP er den ≤ 1,03 s. Koden for alarmen (0002 → 0018), `chase-live` og GPS-filteret er uendret i fase 10.
  - Mest sannsynlig skyldes forsinkelsen tre ting som legges sammen: simen måler fra sann posisjon mens serveren ser den glattede, DO-en utsetter fix (1,9 s-regelen per spiller), og lærerpushen kommer i tillegg. Se oppfølging.

**Runbook:** Kjør aldri 0004, 0012, 0015 eller 0017 alene etter 0018, for de gjenoppretter gamle lag. Etter all migrasjonskjøring skal `scripts/chain-check.sql` være grønn. Den gamle sjekken med `_tick_voice` er utgått: nå skal `tick`-prosrc inneholde `hc_prev_pos`, og `_tick_voice` skal ikke finnes. Kjør `provision-shared.mjs` bare når ingen økter er aktive, fordi den gir mellomtilstander mellom filene.

**Kjent, ikke gjort:**
- **Oppfølging (regel 4), løst i ADR-038:** «utenfor»-alarmen bruker opptil 3,7 s over ws når eleven går sakte over 40 m-grensen. Undersøk om `chase-live` bør sende en fix videre straks når den krysser grensen eller en sperret sone, i stedet for å vente på 1,9 s-regelen.
- `connect-src 'self'` dekker kanskje ikke `wss` mot samme opphav i eldre WebKit. Da faller klienten tilbake til HTTP. Det er ingen sikkerhetsrisiko, men gir høyere DB-last.
- `_so_tick` gjør én ekstra spørring per tick i alle moduser. Den må måles under full last.
- `provision-shared.mjs` bør nekte å kjøre når det finnes aktive økter.
- Ekte iPhone er ikke testet. Sjekklisten står i `docs/PILOT.md`.

## ADR-038 — Hastefix: et fix som utløser en grense- eller sonealarm sendes med en gang (2026-11-19)
**Kontekst:** I prod-simen etter fase 10 (ADR-037) brukte «utenfor»-alarmen opptil 3,7 s over ws. Simen har fått en oppdeling per «utenfor»-alarm (`outsideStages`: gps/telefon/rom/lærer). Lokalt med `wrangler dev` viser den at tiden går på tre steder. **Rom:** opptil 1,3 s fordi `chase-live` venter på 1,9 s-regelen per spiller og 1 s-takten. **Telefon:** opptil 1,9 s når fixet havner bak klientens 1,9 s-sperre etter et hint. **GPS:** opptil 2,0 s, som er en måleeffekt. Simen starter klokka når den *sanne* posisjonen er 40 m ute, men serveren dømmer den støyete, glattede posisjonen, og den kan ligge under 40 m ett 2 s-sample til. Det er samme regel som før, og serveren kan ikke varsle om et sted den ikke har fått høre om. Lærerpushen var ikke en del av problemet, for `alert_host` henter et nytt øyeblikksbilde med en gang.

**Beslutning:**
- `lib/live/urgent.ts`: `fixSafety()` regner ut det `tick()` vil gjøre med fixet, uten 30 s-regelen. Den bruker samme terskler som `lib/rules/safety.ts` og geometrien telefonen allerede har fra bootstrap. `escalates()` er sann når fixet starter eller øker en alarm sammenlignet med det serveren sist fikk: utenfor med mer enn acc (30 s-klokka starter), mer enn 40 m ute, eller inn i en sperret sone. Å komme tilbake haster ikke.
- **Telefonen** (`useLiveTick`): et slikt fix sendes straks med `urgent: true`, forbi 1,9 s-sperren. Et nytt GPS-fix som eskalerer, venter heller ikke på neste 2 s-intervall. HTTP-tick sender samme flagg.
- **Rommet** (`RoomCore`): et hastefix skrives med en gang (egen flush når den som eventuelt kjører er ferdig), forbi spillerens 1,9 s-regel og 1 s-takten. Takten for de andre flyttes ikke. Vakt: maks ett hastefix per spiller per `URGENT_EVERY_MS` = 3 s. En klient som merker alt, får vanlig tempo og vanlig DB-last. Et hastefix som får `busy` eller RPC-feil, prøves igjen i vanlig tempo.
- **Ingen endring i SQL eller alarmregelen.** Flagget styrer bare *når* et fix skrives, ikke hva det betyr. Kostnaden er spillregnskap: et kortere gap kan få `tick()` til å lese én strekning som for rask og hoppe over distansen for den. Geofence-avgjørelsen bruker ikke gapet.
- **Simen** speiler telefonen (`--no-urgent` gir den gamle oppførselen for før/etter-kjøringer). Den teller også en alarm som allerede sto hos læreren da boten kom dit, som 0 s (`early`). Før ventet den på neste 2 s-push. Dette gjaldt sperret sone, der serveren regner med en margin på min(acc, 15 m).

**Testet lokalt** (`wrangler dev` + `next dev`, ws, 40 boter med 12 vandrere og 4 i sperret sone, 3 min, før = `--no-urgent`):
- Frø 42: «utenfor» maks 3,14 s → 2,19 s. Transportdelen (telefon + rom + lærer) maks 1,28 s → 0,20 s. Resten er GPS-steget på 2,00 s (sann posisjon over 40 m ett sample før den rapporterte), likt før og etter. Alarmer 17/17, 0 feil. Rommet skrev 65 hastefix, og fix→view p95 var 1434 ms mot 1454 ms før.
- Frø 7: rom-steget maks 1,31 s → 0,58 s, og «utenfor» maks 1,32 s → 1,39 s (ingen GPS-forsinkelse i den kjøringen, så ingen gevinst å hente).
- Standardmiksen med frø 42 (én vandrer): 0,37 s → 0,035 s.
- Sperret sone: alle 4 sto allerede hos læreren da den sanne posisjonen kom inn (`early`). Før ble de målt til ~1,8 s, som var ventetiden på neste push.
- På en ekte telefon kommer GPS omtrent hvert sekund, og et eskalerende fix sendes nå straks. Da blir GPS-steget ≤ 1 s, mens simen bare sampler hvert 2. s.

**Deploy 2026-11-19 (eier sa ja):**
- chase#35 er merget (`68ca7a0`). Ingen migrasjon siden forrige deploy.
- `chase-live` er deployet først: `a0afb4a6` (rollback `29143e3a`).
- Ny `SIM_KEY` er satt på Worker `chase`.
- Next-workeren er deployet: `a18f28c7` fra `68ca7a0` (rollback `8722341f`), med `LIVE_TRANSPORT=ws`. Bygget med Node 22 fra en løsrevet worktree, uten secrets i env.
- Portene var grønne: ingen secret-navn eller -verdier i bunten, bare `localhost:9999` (auth-js-standard) og prod-`BASE_URL`.
- Røyktesten var lik før og etter (rot 12×200, /ny, /bibliotek, /personvern, /j og /sw.js gir 200). Konsollen på /j og /ny var uten feil.

**Prod-sim over ws** (40 boter, merket `is_sim`):
- Frø 42 med standardmiks: alarmer 4/4, maks 0,39 s. «Utenfor» kom på **0,39 s** (før: 3,68–3,73 s). Fix→view p95/p99 1607/1840 ms, 0 feil.
- Frø 7: alarmer 4/4, maks 0,46 s, 0 feil.
- Frø 42 med 12 vandrere og 4 i sperret sone, 3 min: alarmer 17/17. «Utenfor» maks 2,29 s, der transportdelen var maks 0,46 s og GPS-steget 2,00 s (simens 2 s-sampling). Sperret sone 4/4 sto allerede hos læreren (`early`). Fix→view p95 1633 ms, 0 feil.
- Kjørt på batteri med `caffeinate -dims`.

**Ikke gjort:** ekte iPhone (utetesten, `docs/PILOT.md`).

Tester: `test/live-urgent.test.ts` (terskler, eskalering, wire-format) og `test/live-core.test.ts` (hastefix skrives straks, takten flyttes ikke, vakt, koalesering, busy, `alert_host`).

## ADR-039 — Enkel start: skjul, ikke slett (2026-11-20)

**Kontekst:** Eier syntes Chase var forvirrende og gjorde for mye. I lobbyen falt Start-knappen under skjermkanten på PC: gridet i `HostPanel` hadde én implisitt `auto`-rad, så venstrekolonnen vokste til innholdshøyden, og den absolutte bunnlinja ble klippet. Eier valgte 2026-11-19/20: synlige moduser er Postjakt, Smittejakt, Gjemsel og Lag/Flaggjakt. Resten skal skjules bak «Flere moduser», ikke slettes. Oppstarten skal være «velg én ferdig økt». Hendelser, quiz, seremoni og bibliotek skal ut av standardvisningen. Slutten skal være et enkelt resultatkort, og elevskjermen skal vise én ting om gangen.

**Beslutning (bare klient, ingen SQL, tvillingene er uendret):**
- **Lobby:** `lg:grid-rows-[minmax(0,1fr)]` på roten og `min-h-0 overflow-hidden` på venstrekolonnen. Kompakt QR (180 px) og PIN, og spillerbrikkene vises bare under `lg`. «Overraskelse» står i bunnlinja bare når `event_every_s > 0`, ellers i «…». TeamsChip vises bare med lagrunder. Etter siste runde er hovedknappen «Vis resultater» (øktrapport med «Avslutt økt»). Premieutdelingen ligger under «…» → Mer.
- **Veiviser:** Velg økt → Område → Klar. Nye maler `postjakt`, `smittejakt` og `gjemsel` i `TEMPLATES`, uten hendelser, quiz, oppdrag eller prøverunde. «Standard» (`DEFAULT_PLAN` med overraskelser hvert 90. s) er tatt ut av velgeren. `DEFAULT_PLAN` er uendret som API-fallback. `lib/client/visibleModes.ts` (`usesHiddenModes`): et opplegg med en skjult modus åpner «Tilpass» og «Flere moduser» av seg selv.
- **Elevskjerm (`lib/client/playChrome.ts`):** meter og skritt vises bare i Postjakt. Snus/Termometer vises i alle tag-varianter unntatt `convert`. Lagstripe og hurtigmeldinger vises bare i lagrunder. Hendelsesstripe og power-ups vises bare når serveren har sendt noe. Etter siste runde viser `SessionCard` totalene for hele økta fra `TickView.stats` (distanse, aktive sekunder, poster) og eventuelt poengorienteringslinja. Sikkerhetstonene, SOS og footeren er uendret.

**Ikke med:** fangster og «lengst gjemt» på resultatkortet (finnes ikke i tick-svaret, så det krever SQL). En kortere lærervisning enn hele øktrapporten. BigScreen er uendret (den viste allerede bare aktive hendelser og paller under seremonien).

**Testet:** `npm run check` (431 tester, nye: `test/simpleStart.test.ts`, `test/play-chrome.test.ts`, `test/host-plan.test.ts`). I nettleser lokalt: Velg økt → Gjemsel → Område → Klar → demo med 20 boter. Start var synlig ved 1440×700, 1440×900, 2000×1150 og 375×812. Bunnlinja live uten «Overraskelse», SOS-alarm synlig, tre runder, deretter samling, «Vis resultater» og øktrapport.

**Ikke gjort:** ekte iPhone og projektor (PILOT.md).

## ADR-040 — Live-belønning: åpen skjerm lønner seg (2026-11-20)

**Kontekst:** En låst iPhone sender ingen posisjon. I Smittejakt (+1 per 5 s, 0004) og Gjemsel (10 per min, 0023) ble tidspoeng regnet fra veggklokka og betalt i ettertid ved neste tick, så den stille tiden ble betalt fullt ut. En låst telefon ble dessuten usynlig etter 20 s (pling, radar og «Bytte i nærheten» krever `fix_fresh_s`), og overlevelsesbonusen gikk også til låste. Det lønte seg altså å låse skjermen. Eier valgte å gi gulrøtter i stedet for å fjerne moduser.

**Beslutning (migrasjon 0024, bare guardede wrappere; flat `tick`/`host_snapshot` urørt, så likhetstesten for 0018 holder):**
- **Tunables `klv()` / tvilling `lib/rules/live.ts`:** gap 20 s, trinn 120/240 s, ×1,25/×1,5, avslørt etter 20 s, jegervarsel 30 m, lynpost hvert 90 ± 20 s i 30 s for 25 p (30–90 m fra en tilfeldig live spiller), lagbonus 0,25.
- **Live-regnskap i ytterste `_mode_tick`:** `player_live.lv_at`/`lv_acc_s`. Ved gap > 20 s i aktiv runde nullstilles rekka, og `current_survival_start`/`hs_since` flyttes fram med den stille tiden (samme grep som pause), så den indre regelen bare betaler live-tid.
- **Multiplikator:** `delta = points − lv_base`, med brøkrest i `lv_frac`. Den gjelder alle poeng som kommer inn i aktiv runde (bevegelse, poster, fangster, oppdrag, premier); prinsippet er «det du tjener mens du er live, gir bonus». `adjust_points` flytter `lv_base` og ganges ikke. Poeng utenfor aktiv runde tas opp i basen. Ved deploy blir `lv_base` fylt inn med dagens poeng, så en deploy midt i en runde ikke gir bonus på gamle poeng.
- **Pauser:** `_mode_begin`/`_unfreeze` flytter `lv_at` med pauselengden. Rekka er frosset, og stille tid før en pause betales ikke.
- **Rundeslutt:** overlevelsesbonusen (convert +25 / Gjemsel `survivor_pts`) trekkes tilbake fra spillere som ikke var live ved fløyta, også når en storm byttet rollene. Revejakt er unntatt.
- **Avslørt:** `tag.revealed` (bare for jegere, i Gjemsel først etter slipp): siste posisjon fra `player_live` og samme saltede id som pling, som erstatter pling for den spilleren. Den lagres ikke.
- **Lås-merke:** `/api/s/[id]/away` (`sendBeacon`, token i body, `text/plain`) → `mark_away` setter `player_live.away_at`. `host_snapshot_away`/`host_snapshot_svc` fletter inn `away`/`away_s`. HTTP-ruten faller tilbake til `host_snapshot` hvis 0024 mangler. Signaltapalarmen er uendret (60 s, regel 4).
- **Lynposter:** `posts.kind = 'flash'`, `expires_at`, `hint_all` som gullposten. Ikke i prøverunder, de siste 30 s eller med faste poster.
- **Lagbonus:** wrapper på `_mode_upkeep_team` (flagg/konge), bare når alle aktive lagmedlemmer har fix ≤ 20 s.

**Kjent begrensning:** «live» betyr at det kommer tick, ikke at skjermen er på. Klienten sender siste fix i opptil 15 s, så en telefon med skjermen på men uten GPS (inne, tett skog) blir avslørt og mister rekka etter ca. 35 s. Det står i regelkortet. Utetesten avgjør om terskelen må opp.

**Testet:** se PR-en (DB-tester, vitest, lokal sim med `--live-rewards`, prod-sim).
