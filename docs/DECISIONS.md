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
  kan gjettes. Skanneren bruker `BarcodeDetector` der den finnes og ellers `jsqr` (iOS). Utskrift ligger på `/host/[id]/poster`.
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
