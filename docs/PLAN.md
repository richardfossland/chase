# Chase – implementeringsplan

> Navn: **Chase**. Domene: **`chase.sundaysuite.app`** (besluttet 2026-11-08).
> Lærerstyrt GPS-jaktspill for store områder (skolegård, skog, sentrum) i Sunday-familien.
> **Dette dokumentet er sannhetskilden.** Bygg i faserekkefølge, og en fase er ikke ferdig før «Ferdig når» er oppfylt.
> Sist oppdatert: 2026-11-07 (etter intervju med Richard).

---

## 0. Beslutninger som er tatt (faste rammer)

| # | Beslutning | Begrunnelse |
|---|---|---|
| 1 | **Mål: fysisk aktivitet.** Spillet skal være så gøy at elevene glemmer at de trener. Faglig innhold kommer senere, som valgfrie pakker. | Produktets eksistensgrunn. |
| 2 | **Målgruppe 5.–10. trinn** og ungdomsgrupper (kirke, leir). Tonen er leken, men ikke barnslig. | De fleste har egen mobil og tåler taktikk og power-ups. |
| 3 | **Opptil 60 spillere per økt** (to klasser). | Dekker kroppsøving og de fleste ungdomsgrupper uten egen skaleringsarkitektur. |
| 4 | **Fangst = GPS-sjekk + kode.** Jegeren må være innenfor ca. 30 m ifølge GPS, og bekrefter ved å skanne offerets QR eller taste en firesifret kode. | GPS på web bommer med 5–30 m. Avstand alene gir krangel. |
| 5 | **Økt = spilleliste av korte runder** (3–6 min) med pustepauser (1–2 min). | Intervalltrening, naturlig variasjon, og mobilen kan låses i pausene (web-GPS dør med låst skjerm). |
| 6 | **Mobilen i hånda under runder, og gjerne i lomma i pauser.** Wake Lock holder skjermen våken under runder. | Web har ikke bakgrunns-GPS. Det åpnes for lomma først når appen blir native. |
| 7 | **MVP-moduser:** Postjakt, Smittejakt, Krympende sone (som lag oppå andre moduser). Lag mot lag og flaggjakt kommer i fase 5. | Postjakt tester GPS-kjernen uten fangst. Smittejakt er hjertet. Sonen holder alle i bevegelse. |
| 8 | **Synlighet velges per modus** (radar-ping / alle ser alle / bare eget lag / ingen). | Ulike moduser trenger ulik informasjon for å være gøy. |
| 9 | **Rangering:** Under spill ser eleven bare egne poeng, egen fremgang, lagets plassering og merker. **Pallene avsløres i en seremoni til slutt**, og alle får et «ditt beste»-kort. | Live-topplister får de svakeste til å gi opp, og det er nettopp dem vi vil ha i bevegelse. |
| 10 | **Ingen permanent utslagning.** Den som blir fanget, bytter rolle. Den som er utenfor sonen, mister poeng, men spiller videre. | Alle skal være i bevegelse hele tiden. |
| 11 | **Område:** Polygon tegnes på kartet, eller «sirkel rundt meg». Forbudte soner tegnes på samme måte. Samlingspunkt er obligatorisk. | Raskt, presist og spontant. |
| 12 | **Nødknapp:** fullskjermalarm og posisjon i lærerpanelet, kvittering tilbake til eleven, og en «Ring lærer»-knapp (`tel:`). Lærerens nummer slettes ved øktslutt. | Den som trykker, må vite at noen har sett det. Telefonen virker selv om appen henger. |
| 13 | **Fotojakt er utsatt** til etter en egen personvernvurdering (DPIA). | Bilder av barn på en server er et stort personvernsteg. |
| 14 | **Ingen kontoer.** Elevene har kallenavn og en gjenopptakskode. Læreren har identitet i localStorage pluss en **lærernøkkel** for gjenoppretting. Deling skjer via offentlige delelenker. | Lav terskel, null persondata om lærere. |
| 15 | **Stacken følger SundayQuiz:** Next 16 (App Router) på Cloudflare via OpenNext, Supabase EU i delt prosjekt med eget `chase`-skjema og PostGIS. Alle skrivinger går via API-ruter med service role, og logikken ligger i atomiske plpgsql-RPC-er med TS-tvilling. | Samme drift, gate og mønstre som spillene som allerede kjører. |
| 16 | **Lærerpanelet er laget for mobil først** og fungerer på nettbrett (ekstra kolonner). | Læreren skal kunne bevege seg og ha tilsyn ute. |
| 17 | **Posisjoner er flyktige.** Det finnes ingen historikk. Live-posisjon slettes ved øktslutt, og bare et anonymt sammendrag beholdes. | Personvern ved design. |

---

## 1. Konsept og designprinsipper

**Elevpitch:** *«Skann QR, velg kallenavn, løp.»* Hver økt er en blanding av korte, intense runder. Du jakter, blir jaget, raser til poster og flykter fra en sone som krymper. Til slutt avsløres pallene, og nesten alle har vunnet *noe*.

**Lærerpitch:** *«En gymtime ute på 2 minutters oppsett, der du ser alle hele tiden.»*

### Designprinsipper (i prioritert rekkefølge)

1. **Sikkerhet slår spill.** Alarmer, geofence og samling skal virke selv om alt annet feiler. Sikkerhetsfunksjoner bygges i fase 1, før det finnes et spill.
2. **Bevegelse belønnes alltid.** Alle moduser gir grunnpoeng for bevegelse. Den som står stille, blir synlig (radar-ping oftere). Det skal aldri lønne seg å gjemme seg i en krok i fem minutter.
3. **Ingen sitter på benken.** Ingen utslagning, korte runder, rollebytte og immunitet etter rollebytte (ingen «tag-back»).
4. **Små belønninger ofte.** Et merke, en lyd eller en fremgangslinje minst hvert 60.–90. sekund for hver spiller.
5. **Mange måter å vinne på.** Mange paller, spredning av pallplasser og et personlig «ditt beste»-kort for alle.
6. **Fem sekunders blikk.** Elevskjermen skal kunne leses i full fart. Store farger hele skjermen, én hovedbeskjed, én hovedknapp, og lyd og vibrasjon der det finnes.
7. **Læreren har alltid siste ord.** Alt kan overstyres: poeng, roller, lag, pause, avslutt.
8. **Serveren er sannheten.** Fangster, postklaim, poeng og soner avgjøres på serveren. Klienten viser bare.
9. **Vi glemmer.** Posisjoner finnes bare mens økta lever.

### Morsomhetsgrep vi bygger inn (forslag fra planleggingen)

- **Stillstandsping:** Den som står stille i mer enn 15 sekunder, pinges hvert 10. sekund i stedet for hvert 30. Den som løper over 2 m/s, får «stealth» og hopper over neste ping.
- **Immunitet etter rollebytte** (20 s) med pulserende skjold på skjermen. Det gir et kort, spennende fluktvindu.
- **Gylne poster** dukker plutselig opp i ytterkanten av området. Det gir lange sprinter og høy belønning.
- **Utforsker-pallen** belønner den som har vært i flest ulike deler av området (rutenett på 20 × 20 m).
- **Comeback-bonus:** Den som er nederst i poeng, får 1,5× poeng i neste runde (skjult for andre).
- **Seremoni med spenning:** pallene avsløres én og én, med trommevirvel på lærerens mobil eller på storskjerm.
- **Fysiske QR-poster:** Læreren skriver ut og henger opp poster. Skanning gir postklaim uten GPS-tvil og kobler skjerm til den virkelige verden.

---

## 2. Brukerreiser

### 2.1 Lærer: onboarding-veiviser (mål: under 2 minutter fra start til PIN)

> **Enkel start (ADR-039, 2026-11-20):** Veiviseren har nå tre steg: **Velg økt → Område → Klar**. «Velg økt» har tre kort: Postjakt, Smittejakt og Gjemsel (3 runder hver, uten overraskelser, quiz eller prøverunde). «Samme som sist» er et lite kort. Rundeeditoren ligger i «Tilpass» på Klar-steget, og der vises bare Postjakt, Smittejakt, Gjemsel og Flaggjakt. Resten (Fri løping, Sisten, Revejakt, Konge, Stafett, Poengorientering og de ferdige oppleggene) ligger bak bryteren «Flere moduser». Overraskelser, quiz, egne øvelser og talte varsler ligger under «Ekstra», faste poster under «Avansert» i område-steget, og demo med boter er en liten lenke. Punktene under beskriver den opprinnelige veiviseren.

1. **Start** – «Ny økt» eller «Gjenbruk forrige». Første gang vises en kort introduksjon og lærernøkkelen.
2. **Område**
   - *Tegn polygon* på kartet (Kartverket topografisk / satellitt som valg), eller *Sirkel rundt meg* (glidebryter 50–400 m).
   - Legg til **forbudte soner** (vei, parkeringsplass, bekk) som egne polygoner.
   - Sett **samlingspunkt** (forhåndsvalgt: midten av området eller der læreren står).
   - Advarsel hvis området er større enn ca. 0,5 km² («Har du tilsyn over hele området?») eller mindre enn ca. 3 000 m² («GPS er for upresis for så lite område»).
3. **Runder (spilleliste)** – velg en ferdig mal:
   - *Første gang (30 min):* Postjakt 4 min → Smittejakt 5 min → Postjakt + sone 5 min → Smittejakt + sone 6 min.
   - *Full gymtime (45 min)*, *Kort intervall (20 min)*.
   - Eller rediger: legg til, flytt og fjern runder, sett varighet, pustepause og modusinnstillinger (med fornuftige standardverdier og «Avansert» lukket).
4. **Sikkerhet** – lærerens mobilnummer (valgfritt, men anbefalt), maks-avstand før alarm og en sjekkliste: «Elevene vet hvor grensen går», «Mobilregler er avklart med skolen», «Samlingspunkt er vist».
5. **Visning** – rangeringsmodus (standard: personlig og lag live, paller til slutt). Valg for storskjermvisning (senere fase).
6. **Klar** – fullskjerm-QR og sekssifret PIN.
   - **Lobbyen** viser hvem som har blitt med, og en **GPS-sjekk** per elev (grønn under 15 m, gul 15–30 m, rød over 30 m eller uten tillatelse).
   - Læreren kan gi nytt navn til eller fjerne en elev før start.

### 2.2 Elev

1. Skanner QR → `/j/123456` → skriver kallenavn (filter mot fullt navn og banneord, og læreren kan gi nytt navn).
2. **«Jeg er klar»-knappen** gjør tre ting i samme brukerhandling: låser opp lyd, ber om GPS-tillatelse og aktiverer Wake Lock. Hvis tillatelsen avslås, vises steg-for-steg-hjelp for iOS og Android.
3. **Lobby:** egen GPS-status, et animert regelkort for runde 1 (15 sekunder) og «Venter på læreren».
4. **Runde:** fargekodet fullskjerm (rød = jeger, blå = bytte, gul = varsel). Kart nederst, hovedhandling øverst (Skann/«Vis koden min»). Fremgangsring for runde og poeng.
5. **Pustepause:** «Pust ut! 💨». Viser egne tall for runden og forklarer neste modus. *«Du kan låse mobilen – lås den opp igjen når læreren blåser i fløyta.»*
   - Når skjermen låses opp, henter klienten GPS og Wake Lock på nytt automatisk (`visibilitychange`).
6. **Slutt:** samlingsskjerm («Gå til samlingspunktet»), deretter seremoni og «ditt beste»-kort.

> **Synkronisering:** Siden vi ikke kan vekke låste telefoner, er lærerens fløyte startsignalet. Rundestart har en nedtelling på 15 sekunder som læreren kan forlenge, og elever som kommer sent, får kort immunitet.

### 2.3 Elever uten fungerende mobil

Alle har mobil, men noen har tomt batteri, ingen data eller ødelagt GPS. Disse kan få rollen **«Postvakt/dommer»**: de står ved en fysisk QR-post eller hjelper læreren. Det er en fullverdig rolle med egen pall («Beste dommer» tildeles manuelt av læreren).

---

## 3. Spillmoduser

Felles for alle moduser: rundetimer, bevegelsespoeng (+1 per 50 m, med tak), synlighetsregel, geofence og sikkerhet.
En **modusdefinisjon** er data (`mode` + `config` jsonb) med TS-validering (zod), slik at nye moduser ikke krever skjemaendringer.

### 3.1 Postjakt (MVP, fase 2)

- Poster dukker opp tilfeldig innenfor området. De legges utenfor forbudte soner, minst 25 m fra nærmeste spiller og minst 30 m fra hverandre.
- Antall aktive poster er ca. spillere / 4 (minst 3, maks 15). En ny post dukker opp når en tas.
- **Klaim:** Spilleren må være innenfor `max(12 m, nøyaktighet)` i to påfølgende posisjoner (ca. 3 s), eller skanne en fysisk QR-post.
- **Verdi:** 10 p nær sentrum og 20 p i ytterkanten (det lønner seg å løpe langt). *Gyllen post* gir 50 p, varer 60 s og varsles til alle.
- Synlighet: alle poster synlige, ingen spillere synlige.

### 3.2 Smittejakt (MVP, fase 3)

- Start: ca. 15 % jegere (minst 1), valgt tilfeldig eller av læreren.
- **Variant** (`onCatch`):
  - `convert` – den fangede blir jeger («smitte»). Runden slutter når tiden er ute eller alle er jegere. Siste overlevende får +25.
  - `swap` – jeger og bytte bytter roller («sisten»). Antall jegere er konstant.
- **Fangstflyt:**
  1. Jegeren ser «Bytte i nærheten» når serveren mener avstanden er under ca. 30 m.
  2. Jegeren tar byttet fysisk (fair play-regel: lett berøring på skulder/rygg) og trykker «Skann». Byttet viser koden sin (stor QR + firesifret kode, alltid ett trykk unna på bytteskjermen).
  3. Serveren validerer:
     - roller,
     - begge er i aktiv runde,
     - avstand ≤ `min(50, max(30, accA + accB))`,
     - byttet er ikke immunt eller skjermet,
     - koden er gyldig (den roterer etter hver fangst og ved hver runde, så den kan ikke deles videre).
  4. Begge får umiddelbar feedback (fullskjerm, lyd og vibrasjon). Byttet får 20 s immunitet etter rollebytte.
- **Poeng:**
  - Bytte: +1 per 5 s overlevd.
  - Jeger: +15 per fangst, og +5 i assist hvis en annen jeger var innenfor 30 m de siste 10 s.
  - En spiller som konverteres, beholder poengene sine.
- **Synlighet (standard):**
  - Jegere ser byttene som radar-ping hvert 30. sekund (10 s ved stillstand, hoppes over ved «stealth»).
  - Byttene ser jegere innenfor 60 m som en pulserende varselring uten nøyaktig punkt.

### 3.3 Krympende sone (MVP, fase 3 – lag oppå 3.1/3.2)

- Ved rundestart velges et sentrum inne i området (vektet bort fra forbudte soner).
- Radius krymper i 3–4 faser til ca. 25 % av startarealet. Hver fase varsles 20 s før.
- Sonen er en **ren funksjon av tid**: `zone(t) = circle(center, r(t)) ∩ område`. Den beregnes identisk i SQL og TS uten noen planlagt jobb.
- Utenfor sonen gir −1 p per 3 s (aldri under 0 for runden), med rød kant og en pil mot sonen. Den som er inne ved faseskifte, får +5.

### 3.5 Gjemsel (fase 10.9)

Variant av Smittejakt (`mode: tag`, `variant: hide`, `head_start_s` 60–90, standard 75). Få jegere (ceil(n/6)), resten gjemmere.
Jegerne står ved møteplassen til slipp (ingen straff, men ingen fangst, Snus eller Termometer før). Etter slipp er gjemmerne usynlige: ingen radar-ping og ingen «Bytte i nærheten».
Se migrasjon 0023 for konstantene (`kv()`).
Stillstand (§ 1 punkt 2): etter 90 s uten å flytte seg mer enn 10 m får jegerne en 100 m-sirkel rundt et forskjøvet punkt. Fangst som i Smittejakt (`convert`).

### 3.4 Senere moduser (fase 5+)

> Siden ADR-039 er Konge, Stafett og Sporing skjult bak «Flere moduser» i veiviseren. Serveren støtter dem fortsatt, og lagrede og delte opplegg spilles som før.

- **Lag mot lag / Flaggjakt** – 2–4 lag, erobre poster eller flagg, laget ser hverandre.
- **Konge på haugen** – hold en sone lengst mulig som lag.
- **Stafett** – laget må besøke poster i rekkefølge, én løper om gangen.
- **Sporing** – én «rev» med bred radar, alle andre jager.

---

## 4. Utfordringer, hendelser og belønninger (fase 4)

Hendelser utløses av læreren (knapp) eller automatisk (konfigurerbar frekvens, standard én per 90 s).

| Hendelse | Beskrivelse | Belønning |
|---|---|---|
| **Sprint til punkt** | Et punkt dukker opp. De tre første innen 45 s får premien. | Skjold / 20 p |
| **Fysisk oppdrag** | «10 jumping jacks ved nærmeste post». Bekreftes med QR-post eller av læreren i panelet. | 15 p + merke |
| **Samlingsalarm (spill)** | Alle må til samlingspunktet innen 60 s, og de siste må gjøre en øvelse. Dobbelt opp som øvelse i ekte samling. | Bonus for alle som rekker det |
| **Gyllen post** | Se 3.1. | 50 p |
| **Rollebytte-storm** | Alle roller byttes om i 30 s. | – |
| **Mørkelegging** | Radar av i 45 s. | – |

**Power-ups** (inventar på maks 2, brukes med ett trykk):

- **Skjold** – immun i 15 s.
- **Radar** – se alle motstandere i 5 s.
- **Lokkedue** – et falskt radar-ping 40 m unna egen posisjon.
- **Turbo** – dobbel bevegelsespoeng i 30 s.

Fysiske oppdrag gjøres der eleven er, aldri som en betingelse for å slippe straff.

**Merker** (hyppige, små og lokale): Første post, 500 m, 1 km, 5 aktive min, Overlevde 60 s, Fangst-trippel, Utforsker 10 ruter, Sonemester osv. Det gis maks ett merke per 30 s per spiller, så det ikke blir støy.

---

## 5. Poeng, statistikk og paller

### 5.1 Måling

- **Distanse:** Summen av segmenter mellom gode posisjoner. Punkter forkastes hvis nøyaktigheten er over 25 m, eller hvis farten er over 8 m/s (feil eller sykkel).
- **Aktive minutter:** Tid med beregnet fart mellom 1,2 og 7 m/s, glattet over 10 s.
  - En spiller som nettopp ble fanget, får dobbel rate i 30 s, så rollebytte aldri føles som straff.
  - DeviceMotion/skritteller vurderes i fase 7 (krever egen tillatelse på iOS).
- **Juks:** Fart over 25 km/t i mer enn 10 s flagges til læreren (bil, sykkel, sparkesykkel). Ingen automatisk straff.
- **Utforsker:** Antall unike ruter på 20 × 20 m besøkt (lokal projeksjon fra områdets sentrum).

### 5.2 Paller (MVP)

| Pall | Mål |
|---|---|
| 🏆 Poeng | Totale poeng i økta |
| 🏃 Distanse | Meter tilbakelagt |
| ⏱️ Aktive minutter | Tid i bevegelse |
| 🎯 Fangster | Antall fangster |
| 🛡️ Overlevd lengst | Lengste sammenhengende tid som bytte |
| 📍 Poster | Antall poster tatt |
| 🧭 Utforsker | Flest ruter besøkt |
| 🚀 Comeback | Største poengøkning siste runde |
| 👥 Lagpall / Lagspiller | Fase 5 |

- **Spredningsregel:** En spiller kan maks stå på 2 paller. Neste i køen rykker opp. Læreren kan skru den av.
- **«Ditt beste»-kort:** For hver elev velges kategorien der eleven ligger best prosentvis («Du var blant de 20 % som løp lengst!»). Det inneholder alltid minst én positiv setning, også for den som er sist i alt («Du var i bevegelse i 23 minutter!»).
- Læreren kan overstyre poeng (± med årsak, logget) og flytte spillere mellom roller og lag.

---

## 6. Lærerpanelet

**Mobil (standard):**

- Fullskjermkart med alle spillere som prikker (farge = rolle, ring = varselstatus). Trykk på en prikk åpner spillerkortet.
- **Fast bunnlinje med store knapper:** ⏸ Pause/Fortsett · 📣 Beskjed · ⚡ Hendelse (fase 4) · 🧲 Samling · ⋯ Mer (neste runde, avslutt).
- **Varselstripe øverst** (alltid synlig, sortert etter alvor): 🆘 SOS > forbudt sone > utenfor område > signaltap > stillstand over 90 s > fartsflagg.
- **Spillerkort:** kallenavn, rolle, poeng, status, siste posisjon og nøyaktighet. Handlinger:
  - gi nytt navn,
  - fjern,
  - bytt rolle eller lag,
  - juster poeng,
  - **«Sitter over»** (pauser eleven individuelt, for eksempel ved skade eller ved behov for pause, uten poengtap),
  - send beskjed.
- **Beskjeder:** alle / lag / elev, med hurtigvalg («Kom tilbake innenfor grensa», «2 minutter igjen», «Bra jobba!»).

**Nettbrett/PC:** samme panel pluss en sidekolonne med elevliste (filtrering og sortering) og en hendelseslogg.

**Samling og opprop:**

1. «Samling» sender alarm til alle med pil og avstand til samlingspunktet.
2. Elever innenfor 25 m av punktet hakes av automatisk. Læreren kan hake av manuelt.
3. Listen «Mangler» vises med siste kjente posisjon.
4. Økta kan ikke avsluttes før alle er hakket av eller læreren bevisst bekrefter «Avslutt likevel» (med liste over hvem som mangler).

---

## 7. Sikkerhet

| Funksjon | Oppførsel |
|---|---|
| **Geofence, nivå 1** | Innenfor 15 m av grensen: gul kant og «Nær grensa». |
| **Geofence, nivå 2** | Utenfor med margin over nøyaktigheten: rød fullskjerm, pil tilbake, og spilleren regnes som inaktiv (ingen poeng). |
| **Geofence, nivå 3** | Utenfor i over 30 s eller over 40 m: varsel til læreren. Over 100 m: høy alarm hos læreren. |
| **Forbudte soner** | Inne i en forbudt sone (med nøyaktighetsmargin): rød skjerm og **umiddelbar** lærervarsling. |
| **Nødknapp** | Alltid tilgjengelig (hold i 1,5 s for å unngå uhell). Gir fullskjermalarm med lyd hos læreren og posisjonen fremhevet. Eleven ser «Læreren har sett det ✔» når læreren kvitterer, og har en «Ring lærer»-knapp. Alarmen kan ikke dempes før læreren har kvittert. |
| **Signaltap** | Ingen posisjon på 20 s i aktiv runde: «usikker» (grå). Etter 60 s: varsel til læreren med siste kjente posisjon. Eleven ser «Mistet GPS – gå ut i det åpne». |
| **Dårlig nøyaktighet** | Over 50 m: spilleren vises som usikker. Fangst og klaim er sperret for denne spilleren til nøyaktigheten er bedre. |
| **Pause** | Lærerpause stopper all spilllogikk. Skjermen blir nøytral («Pause – stå stille og hør etter»). |
| **Mobilbruk** | Advarsel i veiviseren om å ikke bruke områder med biltrafikk, og regelen «se opp, ikke ned» i regelkortet. Skjermen er designet for blikk, ikke lesing. |

> Sikkerhetsfunksjonene i fase 1 testes med simulatoren (§ 11) **og** med minst tre ekte mobiler ute før fase 2 starter.

---

## 8. Personvern og sletting

**Roller:** Skolen eller organisasjonen er behandlingsansvarlig. Sunday (Richard) er databehandler. Vi lager en mal for databehandleravtale og en kort DPIA-støttetekst (fase 6). Kirker og ungdomsgrupper bruker de samme malene.

**Data vi behandler om elever:**

| Data | Hvor | Levetid |
|---|---|---|
| Kallenavn | `players` | Slettes 24 t etter øktslutt |
| Gjenopptakskode (hash) og enhets-ID (tilfeldig) | `players` | Som over |
| **Live-posisjon** (ett punkt per spiller, ingen historikk), med distanseanker og stillstandsanker (`last_good_pos`, `still_anchor`) | `player_live` (UNLOGGED) | **Slettes ved øktslutt** |
| Alarmposisjon (punkt ved SOS eller geofence) | `alarms` | Nullstilles ved øktslutt |
| Statistikk og poeng | `player_stats` | 24 t etter slutt (for seremoni og eventuell gjenvisning) |
| Utforskerruter (20 × 20 m-ruter besøkt, en grov spor-liste) | `player_stats.cells` | **Tømmes ved øktslutt**, bare antallet (`explorer_n`) beholdes i 24 t |
| Poster (punkt) og postklaim (hvem tok hvilken post når) | `posts`, `post_claims` | **Slettes ved øktslutt** |
| Hendelseslogg | `events` | 24 t etter slutt, uten koordinater |
| Paller og «ditt beste» (spiller-id-er og tall, ingen navn eller posisjoner) | `sessions.podiums`, `player_stats.best` | Som økta / 24 t etter slutt. Kallenavn hentes ved visning og forsvinner med `players`. |
| «Har stemt»-flagg for «vil spille igjen» (bare mot dobbeltstemming, svaret lagres ikke på eleven) | `players.voted_again` | 24 t etter slutt |
| Hendelsesdeltakelse (hvem nådde sprintpunktet eller fullførte oppdraget, når, poeng og power-up) | `event_entries` | 24 t etter slutt, uten koordinater |
| Varmere/kaldere (0017): ett flyktig anker for «posisjon for 20–40 s siden» og ett nyere, med tidspunkt, samt siste bruk for nedkjøling (ingen logg) | `player_live.hc_pos`, `hc_at`, `hc_prev_pos`, `hc_prev_at`, `hc_used_at` (UNLOGGED) | **Slettes ved øktslutt** |
| Lokkedue (falskt punkt 40 m fra eleven) | `player_live.decoy_pos` (UNLOGGED) | **Slettes ved øktslutt** |
| Power-up-inventar og aktive effekter (tider) | `player_stats` | 24 t etter slutt |
| Lagbeskjed (siste hurtigmelding: type, tid og avsenderens posisjon, vises bare for eget lag i 30 s) | `player_live.msg_*` (UNLOGGED) | **Slettes ved øktslutt** |
| Lag (navn, farge, lagpoeng) og elevens lag | `teams`, `players.team_id` | Som økta (24 t etter slutt). Ingen persondata utover koblingen elev ↔ lag. |
| Flagg- og haugposisjoner (punkter i området, ikke elevposisjoner) | `rounds.state` | Som økta |
| Lærerens telefonnummer | `sessions` | Nullstilles ved øktslutt |
| Spørsmål ved poster: hvilket spørsmål eleven har åpent, antall stilt og antall riktige (ikke hvilke svar) | `player_stats.quiz_*` | 24 t etter slutt. Hendelsesloggen har spørsmålsnummer og riktig/feil, uten koordinater. |
| Skritt (sum fra mobilens skritteller, valgfri) | `player_live.steps` (UNLOGGED) | **Slettes ved øktslutt** |
| Stafett: om eleven har pinnen, hvilken post, på vei tilbake, når pinnen ble gitt, antall etapper | `player_stats.relay_*`, `round_relay` | 24 t etter slutt. Ingen posisjoner. |
| Stafettløype (base og poster: punkter i området, ikke elevposisjoner) og etapper per lag | `rounds.state` | Som økta |
| Prøverunde og poengorientering (0020): om statistikken er frosset (`practice`), ankomsttid til møteplassen (`so_home_since`, `so_arrived_at`: tider uten posisjon), forsinkelse og poengtrekk, klaimfremdrift og sum score-O-poeng | `player_stats.practice`, `so_*` | 24 t etter slutt. Ankomsttidene nullstilles ved rundeslutt og i `_end_session`. Ingen posisjoner. |
| Gjemsel (0023): når gjemmeren begynte å gjemme seg, poeng så langt i stinten og lengste tid uoppdaget (tider og tall uten posisjon). Plingene beregnes ved visning fra `player_live` og lagres ikke. | `player_stats.hs_since`, `hs_pts`, `hide_best_s` | 24 t etter slutt. `hs_since` nullstilles ved fangst og rundeslutt. Ingen posisjoner. |
| Lagvisnings-cache (lagkameratenes posisjoner og lagbeskjeder, bygges hvert sekund) | `team_clock`, `session_clock.team_cache` (UNLOGGED) | **Slettes ved øktslutt** (fra 0013; før det fulgte den økta i 24 t) |
| **Lærerbibliotek** (lagrede og sist brukte områder, opplegg, oppdragspakker), knyttet til en anonym lærernøkkel (bare hash lagres). Ingen elevdata. | `teachers`, `areas`, `plans`, `challenge_packs` | Til læreren sletter det, eller **13 måneder uten bruk** (`purge_expired`). Bare de 5 siste «sist brukt» per type beholdes. |
| Delelenker (kopi av et opplegg og ev. et område, ingen info om læreren) | `shares` | Til læreren trekker lenken tilbake (raden slettes), eller med biblioteket |
| Øktrom (Durable Object, ADR-033): siste posisjon per spiller i minnet til den er skrevet (ca. 1 s), sockets med spiller-id og token-hash | `chase-live` (Cloudflare, EU-jurisdiksjon) | **Bare i minnet.** DO-lagring har bare `{session, status, watchdogDue}` og slettes (`deleteAll`) ved øktslutt |
| **Demo-kvote** (fase 10.6): HMAC-SHA256-hash av IP (IPv6 som /64) og lærernøkkel, med tidspunkt, for å begrense «Prøv med boter» til 3 per time. Saltet (`DEMO_SALT`) ligger bare som Worker-secret. Ingen IP eller nøkkel i klartekst. | `demo_log` | **Slettes etter 2 t** (`purge_expired`). Demo-økter (`is_sim`) gir **ikke** anonymt sammendrag og avsluttes automatisk etter 30–45 min. |
| **Anonymt sammendrag** | `session_summaries` | Beholdes: antall spillere, varighet, moduser, total og median distanse og aktive minutter som histogram, og anonym telling av «vil spille igjen» (ja/nei, lærerens svar). **Ingen koordinater, navn eller område.** |

**Tekniske tiltak:**

- `player_live` er en **UNLOGGED**-tabell, så posisjoner havner ikke i WAL, replikering eller backup.
- Ingen posisjonshistorikk lagres noen gang. Distanse og utforskerruter oppdateres inkrementelt.
- `end_session()`-RPC-en sletter posisjoner, nullstiller alarmposisjoner og telefonnummer, og skriver sammendraget i én transaksjon.
- **pg_cron** hvert 15. minutt fungerer som sikkerhetsnett:
  - avslutter og renser økter som har vært live eller i lobby i over 4 t,
  - sletter spillerdata for økter avsluttet for over 24 t siden.
- Posisjoner sendes aldri i URL-er eller query-strenger, og logges ikke. API-ruter logger aldri forespørselskropper.
- Realtime-kanaler bærer **aldri** rå posisjoner. Posisjoner hentes via autentiserte API-kall som filtreres per rolle (§ 9.3).
- Ingen analyseverktøy eller tredjeparts sporing. Kartfliser hentes fra Kartverket (norsk offentlig) som standard.
- Kallenavnsfilteret advarer ved mønster «Fornavn Etternavn», og veiviseren anbefaler kallenavn uten fullt navn.

---

## 9. Arkitektur

### 9.1 Oversikt

```
Elevmobil (PWA)                 Lærermobil (PWA)
  watchPosition ─┐                 │ WebSocket: push av snapshot (2 s) + HTTP-vakthund (10 s)
     WebSocket   ▼                 ▼
   ┌──────── chase-live: ett øktrom (Durable Object) per økt (ADR-033) ────────┐
   │  samler posisjoner → chase.tick_batch() ca. 1/s, pusher visning/snapshot, │
   │  vakthund (DO-alarm 5 s) for signaltap og faseskifte                      │
   └───────────────────────────────▲───────────────────────────────────────────┘
                 service binding   │  (HTTP-reserve: POST /tick via Next)
        Next 16 API-ruter på Cloudflare Workers (OpenNext)
          │  validering (zod), token-hash, rate limit
          ▼
   Supabase Postgres (EU), skjema `chase` + PostGIS
     RPC-er: tick(), attempt_catch(), claim_post(), host_action(), end_session() …
     pg_cron: opprydding
          │
          └─► Realtime Broadcast (bare hendelser, lavt volum):
              pause/fortsett, rundestart, beskjeder, alarm, fangst-varsel, samling
```

### 9.2 Tick-modellen (kjernen)

- Eleven sender `POST /api/s/[id]/tick` med `{lat, lng, acc, speed?, ts}`. Intervallet er 2 s i aktiv runde, 10 s i lobby og pause, og stoppet når skjermen er skjult.
- Kallet kjører `chase.tick()` atomisk, som gjør dette:
  1. **avanserer verden lat:** rundeovergang, soneradius, postspawn og hendelsesutløsning. Dette er tidsbasert og idempotent, og bruker `pg_try_advisory_xact_lock(session)` slik at bare ett kall avanserer om gangen,
  2. oppdaterer `player_live`, distanse, aktive sekunder og utforskerruter,
  3. evaluerer geofence, forbudt sone, postklaim og sone,
  4. returnerer **spillerens personlige visning**: rolle, poeng, synlige objekter etter synlighetsregelen, varsler og servertid.
- **Ett kall per tick per spiller**, uten egen broadcast for posisjoner. Ved 60 spillere er det ca. 30 forespørsler/s, som er håndterbart for både Workers og Postgres.
- **Fra ADR-033 (`LIVE_TRANSPORT=ws`):** mobilen sender posisjoner over WebSocket til øktrommet, som kaller `chase.tick_batch()` ca. én gang i sekundet (maks 50 per kall, ≥ 1,9 s mellom hver spillers tick fordi farten måles mot `now()`, `busy` ved låsventing over 250 ms). Visningen pushes tilbake. Faller socketen, går mobilen straks over til `POST /tick`, som rommet også betjener (eller direkte `tick()` hvis rommet ikke svarer). Med `LIVE_TRANSPORT=http` gjelder modellen over uendret.
- Lærerpanelet poller `GET /api/s/[id]/snapshot` hvert 2. sekund (med ws: snapshot pushes hvert 2. s, HTTP hvert 10. s som vakthund, 2 s hvis push uteblir). Signaltap og stillstand utledes ved lesing (`now() - fix_at`), så det trengs ingen cron.
- **Realtime Broadcast** brukes bare til push av hendelser med lavt volum, slik at elevene reagerer umiddelbart (pause, beskjed, alarmkvittering, «du ble fanget»). Klienten henter alltid fasit med neste tick. Broadcasts er bare dytt.
- Kanaler:
  - `chase:{session}:all`,
  - `chase:{session}:host`,
  - `chase:{session}:p:{player}` (private beskjeder).
  - Autorisasjon følger mønsteret fra SundayQuiz (`supabase/migrations/0007_realtime_authz.sql`).

### 9.3 Synlighet og autorisasjon

- Klienter skriver **aldri** direkte mot tabeller. All RLS er deny-all for `anon` og `authenticated`, og API-rutene bruker service role (som SundayQuiz).
- Elevtoken (32 tilfeldige byte i localStorage) lagres som SHA-256 i `players.token_hash`. Lærertoken lagres i `sessions.host_token_hash`.
- `tick()` returnerer bare det spilleren har lov til å se. Synlighetsregelen evalueres i SQL, så klienten får aldri andres posisjoner «for sikkerhets skyld».

### 9.4 Tid og determinisme

- All spilltid er servertid. Klienten får `server_now` i hvert tick og beregner en klokkeforskyvning for nedtellinger.
- Rundetilstand (sone, timer) er en ren funksjon av `round_started_at` og pausetid. **TS-tvillingen** (`lib/rules/*.ts`) og plpgsql må holdes i takt og testes mot de samme testvektorene.

### 9.5 Klient

- **PWA:** manifest, enkel service worker for appskall og **forhåndshenting av kartfliser for området** ved oppstart (svak dekning i skog).
- **Kart:** MapLibre GL JS.
  - Standard bakgrunn er Kartverket topografisk (WMTS, CC BY 4.0).
  - Satellitt er et valg (vilkår og leverandør avklares i fase 0, for eksempel MapTiler).
  - Tegning av polygoner via et lettvekts tegneverktøy (terra-draw eller eget).
- **GPS:** `watchPosition({enableHighAccuracy: true, maximumAge: 0})`. Wake Lock API. `visibilitychange` henter GPS og Wake Lock på nytt.
- **Feedback:**
  - Fullskjermfarger og lyd (Web Audio, låst opp med «Jeg er klar»).
  - `navigator.vibrate` der det finnes. **iOS Safari støtter ikke vibrasjon**, så lyd og blink er primærkanalen.
- **QR-skanning:** `BarcodeDetector` der det finnes, ellers fallback til jsQR via `getUserMedia`. Firesifret kode er alltid alternativet.
- **Geomatte i TS:** egen liten `lib/geo.ts` (haversine, lokal ekvirektangulær projeksjon, punkt-i-polygon) med tester. Turf brukes bare til tegnehjelp.

### 9.6 Ruter (App Router)

| Rute | Formål |
|---|---|
| `/` | Landingsside + «Start økt» |
| `/ny` | Lærerveiviser |
| `/host/[id]` | Lærerpanel (lobby, spill, samling, seremoni) |
| `/j/[pin]` | Elevinngang |
| `/play/[id]` | Elevklient |
| `/d/[kode]` | Delelenke (forhåndsvisning + «Bruk dette») – fase 6 |
| `/dev/sim` | GPS-simulator (bare i dev, eller med `SIM_ENABLED`) |

API under `/api/...`: `sessions` (opprett), `join`, `resume`, `s/[id]/tick`, `s/[id]/catch`, `s/[id]/claim`, `s/[id]/sos`, `s/[id]/snapshot`, `s/[id]/host/*` (pause, fortsett, beskjed, samling, opprop, overstyr, neste runde, avslutt), `library/*` (fase 6).

### 9.7 Kostnad og drift

- En økt på 45 minutter med 60 spillere gir ca. 80 000 API-kall. Det krever **Workers Paid** (5 USD/mnd, 10 M forespørsler), som gir rom for 100+ økter i måneden.
- Med øktrommet (ADR-033) blir det ca. 1 DB-kall/s per økt i stedet for ca. 20. Durable Objects ligger innenfor Workers Paid (ca. 0 kr ekstra ved 100 økter/mnd). **Aldri deploy `chase-live` midt i en time etter lansering:** alle sockets kobles fra (tilbake på under 1 s, men unødvendig).
- Supabase-belastningen er lav, men det må verifiseres at PostGIS-kall i `tick()` holder seg under 15 ms (fase 1-ytelsestest).

---

## 10. Datamodell (skjema `chase`)

Alle tabeller har `uuid` PK (unntatt logg), `timestamptz` og **RLS aktivert uten policyer** (deny-all). All tilgang går via service role i API-ruter.

```sql
-- Identitet og bibliotek
teachers        (id, key_hash unique, created_at, last_seen_at)
areas           (id, teacher_id → teachers, name,
                 boundary geography(Polygon,4326),
                 forbidden geography(MultiPolygon,4326) null,
                 assembly_point geography(Point,4326),
                 share_code text unique null, is_shared bool, created_at, updated_at)
plans           (id, teacher_id, name, rounds jsonb, settings jsonb,
                 share_code, is_shared, created_at, updated_at)
challenge_packs (id, teacher_id, name, items jsonb, share_code, is_shared, …)   -- fase 4/6

-- Økt (snapshot av område/plan, så endringer i biblioteket ikke påvirker en pågående økt)
sessions        (id, join_pin char(6) unique (blant aktive), host_token_hash,
                 teacher_id null,
                 boundary geography, forbidden geography null, assembly_point geography,
                 plan jsonb, settings jsonb,                  -- ranking_mode, safety thresholds …
                 status text check (lobby|countdown|live|breather|paused|gathering|ceremony|ended),
                 round_idx int, round_started_at, paused_at, pause_accum interval,
                 teacher_phone text null,                     -- nullstilles ved slutt
                 created_at, ended_at)
rounds          (session_id, idx, mode, config jsonb, state jsonb,   -- sone-senter, seed, …
                 started_at, ended_at, primary key (session_id, idx))
teams           (id, session_id, name, color)                         -- fase 5

players         (id, session_id, nickname, token_hash, resume_code_hash, device_id,
                 team_id null, role text,                     -- hunter|prey|neutral|sitting_out|referee
                 catch_code char(4), catch_code_rotated_at,
                 immune_until, shield_until, inventory jsonb,
                 status text,                                 -- active|kicked|left
                 checked_in_at null,                          -- opprop
                 joined_at, last_tick_at)

player_live     (player_id pk, session_id,                    -- UNLOGGED
                 pos geography(Point,4326), acc real, speed real,
                 fix_at timestamptz, still_since timestamptz,
                 geofence_state smallint, in_forbidden bool, in_zone bool)

player_stats    (player_id pk, session_id, points int, distance_m real, active_s int,
                 catches int, assists int, times_caught int,
                 longest_survival_s int, current_survival_start timestamptz null,
                 posts int, cells int[], badges text[], per_round jsonb)

posts           (id, session_id, round_idx, pos geography(Point), radius_m real,
                 value int, kind text,                        -- normal|golden|physical_qr
                 qr_secret text null, spawned_at, expires_at null,
                 claimed_by null, claimed_at null)

alarms          (id, session_id, player_id, kind text,        -- sos|forbidden|outside|signal|speed
                 pos geography null,                          -- nullstilles ved slutt
                 created_at, acked_at, resolved_at)

events          (id bigserial, session_id, at, type, actor_player_id null,
                 target_player_id null, payload jsonb)        -- logg + overstyringer + beskjeder

session_summaries (id, teacher_id null, created_at, duration_s, player_count,
                   modes text[], total_distance_m, median_distance_m,
                   median_active_s, active_histogram jsonb, catches_total)
```

**Indekser:**

- GIST på alle `geography`-kolonner.
- `players(session_id)`, `player_live(session_id)`, `posts(session_id, round_idx) where claimed_by is null`.
- `alarms(session_id) where resolved_at is null`.

**RLS-matrise:**

| Tabell | anon | authenticated | service_role |
|---|---|---|---|
| Alle i `chase` | ingen | ingen | full |
| Realtime-kanaler `chase:*` | bare via autorisasjonspolicy på `realtime.messages` (topic-prefiks + signert kanaltoken) | samme | send |

> Offentlige delelenker (`/d/[kode]`) leses via API-rute som returnerer en trygg DTO. Det finnes ingen offentlig RLS-policy.

**Viktige RPC-er** (alle `security definer`, `search_path = chase, public`, kalles bare av service role):

| RPC | Gjør |
|---|---|
| `create_session(...)` | Oppretter økt og returnerer PIN |
| `join_session(pin, nickname, ...)` | Lar eleven bli med |
| `resume_player(...)` | Gjenopptar en elev |
| `tick(player, token_hash, lat, lng, acc, speed, client_ts)` → jsonb | Se § 9.2 |
| `attempt_catch(hunter, code)` → jsonb | Validerer og utfører fangst (§ 3.2) |
| `claim_post(player, post_id \| qr_secret)` → jsonb | Validerer postklaim |
| `raise_sos(player)` / `ack_alarm(session, alarm, host)` | Nødknapp og kvittering |
| `host_action(session, host_token_hash, action, payload)` | Pause, fortsett, beskjed, samling, opprop, overstyr, neste runde, sitter over, fjern |
| `host_snapshot(session, host_token_hash)` → jsonb | Lærerpanelets visning |
| `end_session(session, host)` | Sletting og sammendrag (§ 8) |
| `purge_expired()` | Kjøres av pg_cron |

---

## 11. GPS-simulator (testing hjemme)

Uten simulator må hver endring testes ute, så den er en førsteklasses del av fase 1.

1. **Mock-GPS for én ekte klient:** `?simgps=1` på `/play/[id]` (bare dev, eller når økta er merket `sim`) erstatter `navigator.geolocation` med en dragbar markør og en joystick (WASD). Nøyaktighet og signaltap kan justeres med glidebrytere.
2. **Bot-sverm i nettleseren** (`/dev/sim`): Kobler seg til en økt og starter N bots (1–60). Hver bot er en ekte spiller via API-et (join + tick + catch/claim) med en atferdsprofil:
   - `runner` (løper 2–4 m/s og jager poster eller bytter),
   - `hider` (står stille i en krok),
   - `wanderer` (vandrer ut av området),
   - `forbidden` (går inn i forbudt sone),
   - `dropout` (mister signal i 90 s),
   - `sos` (trykker nødknapp etter X min),
   - `cheater` (25 km/t),
   - `jitter` (dårlig nøyaktighet, 30–60 m støy).

   Simulatoren viser sitt eget kart med alle bots og en tidslinje.
3. **Headless lasttest:** `scripts/sim.mjs --session <id> --bots 60 --minutes 20 --seed 42` med samme atferdsmodul (delt TS i `lib/sim/`). Brukes til ytelsestest av `tick()` og i CI-røyktest mot lokal Supabase.
4. **Deterministiske scenarioer:** Seedede scenarioer (`lib/sim/scenarios/*.ts`) for automatiske tester, for eksempel «jeger fanger bytte på 25 m med acc 10 → OK» og «på 45 m med acc 5 → avvist».
5. **Playwright e2e** med `context.setGeolocation()` for flere samtidige nettleserkontekster (lærer + tre elever).

---

## 12. Prosjektstruktur

```
chase/
  app/            (ruter, se § 9.6)
  lib/
    geo.ts        haversine, projeksjon, punkt-i-polygon
    rules/        TS-tvillinger: zone.ts, scoring.ts, catch.ts, visibility.ts, podiums.ts
    modes/        modusdefinisjoner + zod-skjema for config
    client/       gps.ts, wakelock.ts, audio.ts, qr.ts, tick-loop.ts
    server/       supabase-admin, auth (token-hash), rate-limit, dto
    sim/          bot-atferd, scenarioer
    locale/no.ts  alle UI-strenger (bokmål)
  supabase/migrations/  0001_schema.sql, 0002_tick.sql, …
  scripts/        test-db.sh, sim.mjs, smoke.mjs
  test/           vitest (unit + twin-vektorer), sql/, e2e/
  docs/           PLAN.md, DECISIONS.md
```

---

## 13. Byggefaser

Fase 1–3 gir **spillbar MVP for kroppsøvingstimen**. Hver fase avsluttes med `npm run check` grønn, DB-tester grønne og deploy til preview.

### Fase 0 – Grunnmur (1–2 dager)

- Repo `chase` på GitHub (eneste remote, som Sjakk og Turnering). CI i GitHub Actions: check, build og DB-tester.
- Next 16 + OpenNext/Cloudflare, Tailwind v4, Sunday-tokens, `lib/locale/no.ts`.
- `chase`-skjema og PostGIS i det delte Supabase-prosjektet. `scripts/test-db.sh` (Docker-Postgres med PostGIS).
- MapLibre-kart med Kartverket-fliser. Avklar vilkår for satellittleverandør.

**Ferdig når:** `npm run check` og `test-db.sh` er grønne lokalt og i CI, preview-URL viser et kart over skolegården på mobil, og migrasjon 0001 kjører rent.

### Fase 1 – Økt-skall, posisjon, sikkerhet og simulator

- Lærerveiviser (område med polygon og sirkel, forbudte soner, samlingspunkt, telefon, enkel spilleliste med én «fri løping»-runde). Lærernøkkel.
- PIN/QR-join, kallenavn, «Jeg er klar»-flyt, gjenopptakskode, lobby med GPS-sjekk.
- `tick()`, `player_live`, distanse og aktive minutter, geofence nivå 1–3, forbudte soner, signaltap, nødknapp med kvittering og ring-lærer, pause, beskjeder, samling og opprop, `end_session()` med sletting, pg_cron-opprydding.
- Lærerpanel (mobil): kart, varselstripe, spillerkort.
- **GPS-simulator** (§ 11, punkt 1–3).

**Ferdig når:**

- 60 sim-bots kjører i 20 minutter med `tick()` p95 under 50 ms i databasen, og lærerpanelet viser alle bots.
- Varsler for SOS, forbudt sone, utenfor område og signaltap når læreren innen **5 s** i simulatoren.
- En SQL-test beviser at `player_live`, alarmposisjoner og telefonnummer er tomme etter `end_session()`.
- **Utetest (utsatt til felles utetest, ADR-019):** 3 ekte mobiler (iPhone + Android) på skolegården, der alle sikkerhetsvarsler utløses og kvitteres riktig, og opprop fungerer.

### Fase 2 – Spilleliste, Postjakt og poeng

- Spilleliste med runder: nedtelling, timer, pustepause, rundeoverganger lat i `tick()`, lærerkontroll (neste runde, forleng).
- Postjakt komplett (spawn-regler, klaim, gylne poster, fysiske QR-poster med utskrift).
- Poeng, bevegelsespoeng, `player_stats` per runde, enkle merker, elevens rundeoppsummering i pustepausen.
- Lyd, blink og vibrasjon som feedback-system.

**Ferdig når** (utetesten er utsatt til den felles utetesten, ADR-019; sim-delen er dekket, ADR-020): En utetest med minst 5 personer kjører en spilleliste med 3 postjakt-runder fra start til slutt **uten at læreren gjør noe annet enn å trykke Start og Avslutt**. Ingen posttvist der GPS-nøyaktigheten er under 15 m. Pustepausen fungerer med låst mobil (ny GPS innen 10 s etter opplåsing).

### Fase 3 – Smittejakt, krympende sone og seremoni → **MVP**

- Smittejakt (`convert`/`swap`), QR-skanner med kodefallback, roterende koder, immunitet, assist.
- Synlighetsmotor per modus (radar-ping, stillstandsping, stealth, nærvarsling).
- Krympende sone som lag (TS- og SQL-tvilling med testvektorer).
- Lærerens overstyring av poeng og roller, «sitter over», fartsflagg.
- Paller med spredningsregel, seremoni (avsløring én og én), «ditt beste»-kort, anonymt sammendrag.
- Ferdige maler: «Første gang 30 min» og «Full gymtime 45 min».
- Sjekkliste før kroppsøvingstimen (`docs/PILOT.md`): batteri, data, mobilregler, informasjon til elevene og en reservelek hvis teknikken svikter.

**Ferdig når:** En **kroppsøvingstime (45 min) med en ekte klasse** gjennomføres med malen «Full gymtime»:

- minst 90 % av fangstforsøkene blir registrert uten tvist (målt i `events`),
- ingen elev står uten en pall eller et «ditt beste»-kort,
- medianen av aktive minutter er minst 20,
- ingen sikkerhetsvarsel blir oversett,
- alle posisjoner er slettet etterpå (verifisert),
- læreren og et utvalg elever svarer «vil spille igjen» (kort tilbakemelding i appen etter seremonien).

### Fase 4 – Utfordringer, hendelser og power-ups

- Hendelsesmotor (lærerutløst og automatisk), Sprint til punkt, Fysiske oppdrag (QR- eller lærerbekreftelse), Samlingsalarm som spill, Rollebytte-storm, Mørkelegging.
- Power-ups (skjold, radar, lokkedue, turbo) med inventar. Utvidet merkesystem.

**Ferdig når:** En utetest med en hendelse hvert 90. sekund gir målbart flere aktive minutter (sammenlignet med fase 3 på samme sted og med samme gruppe). Alle hendelser kan utløses fra lærermobilen med maks 2 trykk.

### Fase 5 – Lag mot lag og flaggjakt

- Lag (auto-fordeling etter antall og balansert etter tidligere poeng i økta, eller manuelt), lagfarger, lagbeskjeder, lagsynlighet.
- Flaggjakt og Konge på haugen. Lagpall og Lagspiller-pall (assists og poster for laget).

**Ferdig når:** En økt med 4 lag og 40 sim-bots pluss en utetest med 2 lag gir riktig lagpoeng og -pall. Lagbalansering gir maks 1 spiller differanse.

### Fase 6 – Bibliotek og deling

- Lærernøkkel med eksport og import (QR og ordkode), lagre områder, opplegg og utfordringspakker.
- Delelenker `/d/[kode]` med forhåndsvisning og «Lag kopi», og kuraterte startpakker (skolegård, skog, sentrum, kirkeleir).
- Maler for databehandleravtale og DPIA. Utskrift av QR-poster som PDF.

**Ferdig når:** En lærer på enhet B kan importere nøkkelen fra enhet A og se biblioteket sitt. En delelenke åpnet av en annen lærer gir en fungerende kopi som kan startes uten endringer.

### Fase 7 – Faglige pakker og storskjerm

- Utfordringspakker med faglig innhold (spørsmål ved poster, kanskje gjenbruk av SundayQuiz-sett), storskjermvisning av kart og seremoni, eventuell DeviceMotion/skritteller.

**Ferdig når:** En faglig pakke kan legges til en hvilken som helst postjakt uten kodeendring.

### Fase 8 – Senere (egne beslutninger)

- ✅ **Stafett og Sporing** (§ 3.4) og **over 150 spillere** (aggregering og soneinndeling): bygget 2026-11-14, migrasjon 0013, ADR-030.
- ⏸ Native app (Capacitor eller Expo) for bakgrunns-GPS og «mobil i lomma». Eier valgte å vente (2026-11-14).
- ⏸ Foto-oppdrag etter DPIA. Venter på DPIA (eiers valg 2026-11-14).
- ⏸ Feide-innlogging. Eier valgte å vente (krever registrering i Feide kundeportal).

### Fase 9 – Inspirasjon fra lignende apper og åpen kildekode

Godkjent av eier 2026-11-18 etter en gjennomgang av Actionbound, Loquiz, Goosechase, MapRun, Stolpejakten, Jet Lag (gjemsel) / Map Calipers og Zombies, Run!. Ingen åpne GPS-jaktspill var modne nok til å bygge på, så vi henter ideer og bruker små biblioteker. Én PR per punkt, i denne rekkefølgen (lavest risiko først):

1. **GPS-glatting.** Et enkelt Kalman-filter i klienten (egen kode), vektet med `acc`. Fix med hopp over ca. 12 m/s eller nøyaktighet over 50 m forkastes før de sendes. Testvektorer og GPS-støy i simulatoren. Filteret får ikke gjøre geofence-alarmene tregere (§ 7, regel 4 i CLAUDE.md). Berører: `lib/client/gps.ts`, `lib/sim`.
2. **Bedre QR-skanner.** `barcode-detector`-polyfill (zxing-wasm, MIT) erstatter jsQR. Wasm-filen lastes først når skanneren åpnes. Innebygd `BarcodeDetector` brukes fortsatt der den finnes. Berører: `lib/client/QrScanner.tsx`.
3. **Talte varsler** (fra Zombies, Run!). `speechSynthesis` på nb-NO for sone, alarm, rollebytte og «jeger nær». Låses opp i «Jeg er klar»-trykket (iOS). Læreren slår det av og på. Lyd og blink er fortsatt hovedkanalen (prinsipp 6). Berører: `lib/client/feedback.ts`, `sound.ts`, locale.
4. **Faste poster og utskrift** (fra MapRun og Stolpejakten). Læreren lagrer et sett med poster per sted i biblioteket og gjenbruker det. En utskriftsside (print-CSS, A4, QR og postnavn) blir til PDF i nettleseren, uten ny avhengighet. Berører: ny migrasjon, `lib/rules/library.ts`, `/bibliotek`.
5. **Varmere/kaldere-power-up** (fra Jet Lag og Map Calipers). I Sporing og Smittejakt: «radar» (er målet innenfor X m? ja eller nei) og «termometer» (varmere eller kaldere enn for 30 s siden) i stedet for å vise posisjonen. Avgjøres på serveren, med TS-tvilling og ADR. Eier velger rekkevidde og nedkjøling i ADR-en. Berører: ny migrasjon, `lib/rules/*`, elevskjermen.
6. **Offline-kart og PWA.** En service worker henter Kartverket-fliser for områdets bbox (z14–18) på forhånd når økta starter, så kartet virker i skog med dårlig dekning (§ 14, «Dekning i skog»). **Først:** sjekk at Kartverkets vilkår tillater forhåndshenting. Hvis ikke, bruker vi et PMTiles-utsnitt av OSM på R2 (Protomaps) i stedet. Berører: ny service worker, `lib/map/style.ts`.
7. **Turf.js / Supercluster (spike).** Kjør geo-testene og lærerkartets klynging mot bibliotekene. Vi bytter bare ut egen kode der den taper på presisjon eller ytelse. Spiken kan ende uten endring. Berører: `lib/geo.ts`, lærerkartet.

**Status 2026-11-18:** ✅ alle sju punktene er levert og live (punkt 1: ADR-035; punkt 2–7: ADR-036). Punkt 6 lagrer bare viste fliser (Geovekst-forbeholdet). Punkt 7 endte uten endring.

**Åpne spørsmål:** Kartverkets vilkår for forhåndshenting (punkt 6, foreløpig bare viste fliser). Kvaliteten på norske stemmer på iPhone og Android prøves i den felles utetesten (ADR-019).
**Ikke med:** bakgrunns-GPS (`@capgo/background-geolocation`, MIT) hører til native-appen, som venter. Foto venter på DPIA.

**Ferdig når:** Alle sju punktene er levert eller avsluttet med begrunnelse i DECISIONS. Prod-sim er grønn etter hver deploy. Talte varsler, QR-skanning og offline-kart er prøvd på ekte iPhone.


### Fase 10 – Drift, lærerverktøy og nye moduser

Valgt av eier 2026-11-18. Sonnet-agenter bygger, én samlet Opus-review, én deploy (som fase 9).

1. **Rydde tick-kjeden** (migr. 0018). `tick` og `host_snapshot` blir én funksjon hver igjen i stedet for wrappere i flere lag (0012/0015/0017), med likhetstest mot de gamle. Den ustabile 0013-testen rettes.
2. **Sikkerhetsheadere.** CSP, HSTS, Permissions-Policy (posisjon og kamera bare for egen side), frame-ancestors og Referrer-Policy, uten å ødelegge kart, WebSocket, QR (wasm), storskjerm eller cast.
3. **Feillogging fra mobilen.** JS-feil sendes til Worker-loggene uten posisjoner, token eller kallenavn, med rate-limit.
4. **Ferdige quizpakker.** 8–12 pakker etter LK20 (5.–10. trinn), som velges i veiviseren og legges på Postjakt.
5. **Øktrapport.** Ved premieutdeling eller avslutning: aktive minutter, distanse, poster og fangster for klassen og per kallenavn, til utskrift eller PDF. Rapporten lages i lærerens nettleser før økta slettes og lagres ikke (§ 8 er uendret).
6. **Prøv med boter.** Lærere kan starte en demo-økt (`is_sim`) med 8–20 simulerte elever i nettleseren, med tak og rate-limit. Prod-simer merkes også `is_sim`.
7. **Prøverunde** (migr. 0020). En rundetype på 60 s som ikke teller, med hint om knappene, posten og fangst. Flagget `practice` på en Postjakt- eller Smittejakt-runde: poeng, merker og fangst-/postantall fryses i databasen, distanse og aktive sekunder teller.
8. **Poengorientering** (migr. 0020, modus `scoreo`). 12 poster med verdi 10/20/30/40 etter avstand fra møteplassen, hver spiller tar hver post én gang, fast tidsgrense (rundens lengde) og 120 s innkomst. For sent tilbake på møteplassen: −5 p per påbegynte 10 s, aldri mer enn rundens poeng; ikke inne innen fasen er slutt = alle rundepoengene. Pall «Orienterer».
9. **Gjemsel** (migr. 0023; nummer 0021 ble ikke brukt). En variant av Smittejakt (`tag`/`hide`): få jegere (ceil(n/6)), gjemmerne får 60–90 s forsprang (standard 75) og er usynlige for jegerne (ingen radar, ingen «Bytte i nærheten»). Jegerne snevrer inn med Snus og Termometer (30 s nedkjøling, bare etter slipp) og fanger med kode. Gjemmere som står stille i 90 s gir jegerne et «pling»: en 100 m-sirkel rundt en tilfeldig forskjøvet posisjon (20–70 m fra gjemmeren, regnet ved visning, aldri lagret). Poeng: 10 per minutt gjemt + 25 til de som ikke er funnet; jegere 15 per fangst. Pall «Mestergjemmer». Ingen sone, lag, prøverunde eller hendelser i Gjemsel.

**Ferdig når:** alle ni punktene er levert, prod-sim er grønn, og ekte-iPhone-punktene står i PILOT.md.

**Status 2026-11-19:** ✅ alle ni punktene er levert og live (ADR-037). Next-worker `8722341f`, migrasjon 0018–0023 i prod. Gjenstår: ekte iPhone (PILOT.md, «Fase 10»).


### Fase 11 – Inspirasjon fra SCRAM: Hide and Seek

Valgt av eier 2026-11-19 etter en gjennomgang av SCRAM (Moveera, iOS/Android, versjon 1.0.5). SCRAM er en native app med konto for den som arrangerer. Chase forblir i nettleseren og uten innlogging, så vi tar bare ideer som virker under de vilkårene. Én PR per punkt, samme oppskrift som fase 9/10.

1. **Plinger med alder i Gjemsel.** Læreren velger pling hvert 1., 2. eller 3. minutt, eller av (standard 2 min). Ved pling får jegerne hver gjemmers posisjon som et punkt merket med alder («for 40 s siden»), og punktet blekner til neste pling. Gjemmerne får «Pling om 10 s» før hver pling. Plingen regnes ved visning fra `player_live` og et tidsvindu, akkurat som stillstandssirkelen fra 0023, og lagres aldri. Bestem i ADR-en om plingen viser eksakt posisjon eller er forskjøvet (som stillstandssirkelen), og hvordan det henger sammen med Snus/Termometer. Berører: ny migrasjon (`kv()`-konstanter og `config`), `lib/rules/hide.ts`, veiviseren, elevskjermen.
2. **Spillkonsekvens for å være utenfor området.** Etter 30 s utenfor (samme klokke som dagens «utenfor»-alarm) blir spilleren **avslørt**: synlig live for jegerne til hen er inne igjen. Etter 2 min utenfor i Smittejakt `convert` og Gjemsel blir hen **smittet** (jeger), aldri utslått (regel 5 i CLAUDE.md). I Postjakt og Poengorientering beholder vi minuspoengene. Lærervarselet er uendret og blir ikke tregere (regel 4). Berører: ny migrasjon (`tick`), `lib/rules/safety.ts`/`tag.ts`, elevskjermen.
3. **Stille modus for gjemmere.** I Gjemsel og for bytter i Smittejakt er talte varsler og spillyder av som standard for gjemmeren. Telefonen skal ikke avsløre noen. Varsler vises med blink og fullskjermfarge (iOS har ikke vibrasjon). Eleven kan slå lyden på selv. Lyd for SOS-kvittering og lærerbeskjed går **alltid** gjennom (regel 4). Berører: `lib/client/feedback.ts`, `sound.ts`, elevskjermen.
4. **Ruta mi på sluttkortet.** Telefonen tar vare på egne fix i minnet (ikke `localStorage`, ikke serveren) og tegner ruta på kart på «ditt beste»-kortet sammen med distanse og hvor lenge man overlevde. Ruta forsvinner når fanen lukkes. Ingenting nytt sendes eller lagres, så § 8 er uendret. Ingen deling ut av appen. Berører: `useDeviceGps`, sluttkortet.
5. **Hvor er jeg? på nødskjermen.** Når nødknappen er trykket, viser elevskjermen koordinatene (desimalgrader, store tall til å lese opp), retning og avstand til møteplassen, og navnet på nærmeste post. Det regnes lokalt fra data telefonen allerede har. **Adresse** (Kartverkets adresse-API, `punktsok`) krever at posisjonen går i en URL til en ekstern tjeneste. Det strider mot regel 3, så det gjøres bare hvis en ADR godkjenner det (for eksempel et kall fra Worker som ikke logges, og bare ved aktiv SOS). Berører: SOS-skjermen, `lib/geo.ts`.

**Ikke med:** taleradio og fritekst (de fire hurtigmeldingene holder for skole), konto, venner og ranglister (ingen innlogging, § 0), lommelykt (virker ikke i iOS Safari).
**Senere, egne beslutninger:** Imposter-modus (hemmelige roller, møter og avstemning, men avstemning kan bli ubehagelig i en klasse), tilskuermodus for fangede (krever en variant der fangede går ut, jf. regel 5), satellittkart til å tegne område (sjekk vilkårene for Norge i bilder).
**Begrensning:** SCRAM deler posisjon når skjermen er låst. Det kan ikke nettleseren. En gjemmer som står stille, vil gjerne låse skjermen, og det kan gi mange signaltapvarsler og blinde plinger. Prøves i den felles utetesten (ADR-019). Hvis det skjer, avgjør vi i en egen ADR om Gjemsel skal tåle signaltap mildere, uten å skjule varselet for læreren.

**Ferdig når:** alle fem punktene er levert eller avsluttet med begrunnelse i DECISIONS, prod-sim er grønn (inkludert alarmtidene fra ADR-038), og iPhone-punktene står i PILOT.md («Fase 11»).

---

## 14. Risikoer og tiltak

| Risiko | Tiltak |
|---|---|
| GPS-støy gir urettferdige fangster eller klaim | Kodebekreftelse, marginer basert på nøyaktighet, sperre ved over 50 m, testvektorer |
| iOS-særheter (ingen vibrasjon, Wake Lock, lydopplåsing, GPS stopper med låst skjerm) | «Jeg er klar»-flyt, lyd og blink som primærkanal, rundestruktur, testing på ekte iPhone i hver fase |
| Mobilforbud på skolen | Veiviseren minner om at bruken avklares med skoleledelsen. Pitchmateriale om aktivitet som formål |
| Elever ser ned i skjermen og løper inn i ting | Blikkdesign, lyd fremfor tekst, varsel om «se opp» i regelkort, forbudte soner rundt farer |
| Batteri | Tick hvert 2. sekund bare i runder, mørk elevskjerm, varsel ved under 20 % batteri (Battery API der det finnes) |
| Dekning i skog | Forhåndshentede fliser, tick-kø med siste posisjon (ikke historikk), «Mistet nett»-status |
| Personvern og tillit | Sletting ved design, UNLOGGED, ingen historikk, DPIA-mal, ingen sporing |
| Kostnad ved vekst | Workers Paid, måle `tick()`-kostnad i fase 1, mulighet for adaptiv tick-rate |

---

## 15. Åpne spørsmål (blokkerer ikke MVP)

1. Leverandør og vilkår for satellittfliser.
2. ~~Skal storskjermvisning (gymsal/prosjektor) prioriteres før fase 7?~~ Avklart: bygget i fase 7 (`/host/[id]/tavle`, ADR-029).
3. Pilotskole og klasse for testen i fase 3.
