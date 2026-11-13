// Templates for the data processing agreement and the DPIA support text
// (PLAN §8 / §13 fase 6). Facts here must match PLAN §8 — the deletion table
// is the source. These are TEMPLATES: the controller (school / organisation)
// adapts and approves them; placeholders are in [hakeparenteser].

export interface LegalDoc {
  slug: "databehandleravtale" | "dpia";
  title: string;
  lead: string;
  sections: { h: string; p?: string[]; list?: string[] }[];
}

const DATA_LIST = [
  "Kallenavn eleven velger selv (ikke fullt navn), en tilfeldig enhets-ID og en gjenopptakskode lagret som hash. Slettes 24 timer etter at økta er avsluttet.",
  "Live-posisjon: ett punkt per elev, ingen historikk. Ligger i en tabell som ikke skrives til logg eller backup, og slettes i det læreren avslutter økta.",
  "Posisjon ved nødknapp eller når en elev går utenfor området. Nullstilles når økta avsluttes.",
  "Spillstatistikk (poeng, distanse, aktive minutter, merker, lag) uten koordinater. Slettes 24 timer etter øktslutt.",
  "Grovt rutenett over besøkte 20 × 20 m-ruter for «utforsker»-poeng. Tømmes ved øktslutt; bare antallet beholdes i 24 timer.",
  "Lagbeskjeder (fire faste hurtigmeldinger, ingen fritekst) med avsenderens posisjon, synlig bare for eget lag i 30 sekunder. Slettes ved øktslutt.",
  "Lærerens mobilnummer (valgfritt, for «Ring lærer»-knappen). Nullstilles ved øktslutt.",
  "Et anonymt sammendrag beholdes: antall spillere, varighet, moduser, distanse- og aktivitetstall som gjennomsnitt/histogram. Ingen navn, koordinater eller område.",
];

export const LEGAL: LegalDoc[] = [
  {
    slug: "databehandleravtale",
    title: "Databehandleravtale – Chase (mal)",
    lead: "Avtale mellom [Skolens/organisasjonens navn] (behandlingsansvarlig) og Sunday / [Leverandørens juridiske navn, org.nr.] (databehandler) om behandling av personopplysninger i GPS-spillet Chase.",
    sections: [
      {
        h: "1. Formål og omfang",
        p: [
          "Databehandleren leverer Chase, et lærerstyrt GPS-spill for fysisk aktivitet i kroppsøving og ungdomsarbeid. Avtalen gjelder personopplysninger databehandleren behandler på vegne av den behandlingsansvarlige når Chase brukes i undervisning eller aktiviteter.",
          "Databehandleren skal bare behandle personopplysninger etter dokumenterte instrukser fra den behandlingsansvarlige, slik de går fram av denne avtalen og av Chase sin funksjonalitet.",
        ],
      },
      {
        h: "2. Kategorier av registrerte og opplysninger",
        p: ["Registrerte: elever/deltakere og læreren/lederen som styrer økta. Ingen kontoer; elever identifiseres bare med et selvvalgt kallenavn."],
        list: DATA_LIST,
      },
      {
        h: "3. Formålet med behandlingen",
        list: [
          "Gjennomføre spillet (poster, fangst, lag, poeng).",
          "Sikkerhet: vise læreren hvor elevene er, varsle ved nødknapp, når noen går utenfor området eller inn i forbudte soner, og ved signaltap.",
          "Avslutning: seremoni med paller og «ditt beste»-kort, og et anonymt sammendrag.",
        ],
      },
      {
        h: "4. Varighet og sletting",
        p: [
          "Posisjoner og telefonnummer slettes når læreren avslutter økta. Øvrige opplysninger slettes automatisk senest 24 timer etter øktslutt. Økter som ikke avsluttes, avsluttes og renses automatisk etter 4 timer.",
          "Lærerens bibliotek (lagrede områder og opplegg) er knyttet til en anonym lærernøkkel og inneholder ikke personopplysninger om elever. Det slettes når læreren sletter det, eller etter 13 måneder uten bruk.",
        ],
      },
      {
        h: "5. Sikkerhet",
        list: [
          "All trafikk går kryptert (HTTPS). Tilgang til databasen skjer bare fra serveren; nettlesere har ingen direkte databasetilgang.",
          "Ingen posisjonshistorikk lagres. Live-posisjoner ligger i en tabell som ikke skrives til transaksjonslogg eller sikkerhetskopi.",
          "Posisjoner sendes aldri i lenker, logger eller sanntidsmeldinger.",
          "Tilgangsnøkler lagres bare som hash.",
        ],
      },
      {
        h: "6. Underdatabehandlere",
        p: ["Den behandlingsansvarlige godkjenner følgende underdatabehandlere. Databehandleren varsler om endringer [30] dager i forveien."],
        list: [
          "Supabase Inc. – database (region i EU/EØS). [Kontroller aktuell region og avtalegrunnlag.]",
          "Cloudflare Inc. – drift av nettsiden og nettverk. [Kontroller overføringsgrunnlag, f.eks. EU–US Data Privacy Framework/SCC.]",
        ],
      },
      {
        h: "7. Bistand, avvik og revisjon",
        p: [
          "Databehandleren bistår den behandlingsansvarlige med å oppfylle de registrertes rettigheter og med vurderinger av personvernkonsekvenser (DPIA).",
          "Brudd på personopplysningssikkerheten varsles den behandlingsansvarlige uten ugrunnet opphold, og senest innen [48] timer etter at databehandleren ble kjent med det.",
          "Den behandlingsansvarlige kan be om dokumentasjon på at avtalen etterleves.",
        ],
      },
      {
        h: "8. Avtalens opphør",
        p: ["Ved opphør slettes alle personopplysninger databehandleren har behandlet på vegne av den behandlingsansvarlige, med mindre lov krever lagring. Siden data slettes senest 24 timer etter hver økt, er det normalt ingenting å tilbakelevere."],
      },
      {
        h: "Underskrifter",
        p: ["Sted/dato: ____________________", "For behandlingsansvarlig: ____________________", "For databehandler: ____________________"],
      },
    ],
  },
  {
    slug: "dpia",
    title: "Støttetekst til vurdering av personvernkonsekvenser (DPIA) – Chase (mal)",
    lead: "Til bruk når [Skolens/organisasjonens navn] vurderer om og hvordan Chase kan brukes. Teksten beskriver behandlingen; risikovurderingen og konklusjonen må den behandlingsansvarlige gjøre selv.",
    sections: [
      {
        h: "1. Beskrivelse av behandlingen",
        p: [
          "Chase er et GPS-spill der elevene bruker mobilen ute i et avgrenset område læreren tegner. Elevene blir med med en PIN-kode og et kallenavn – uten konto, e-post eller telefonnummer.",
          "Under spillet sender mobilen posisjonen til serveren omtrent hvert 2. sekund. Serveren avgjør poeng, fangst og sikkerhetsvarsler, og læreren ser elevene på et kart.",
        ],
        list: DATA_LIST,
      },
      {
        h: "2. Nødvendighet og forholdsmessighet",
        list: [
          "Posisjon er nødvendig både for spillet og for sikkerheten (læreren skal se om noen går ut av området eller trykker på nødknappen).",
          "Dataminimering: kallenavn i stedet for navn, ingen kontoer, ingen posisjonshistorikk, ingen bilder, ingen fritekst mellom elever.",
          "Kort lagringstid: posisjoner slettes ved øktslutt, resten innen 24 timer.",
          "Ingen offentlige topplister under spillet; resultater vises i en seremoni med «ditt beste» for alle.",
        ],
      },
      {
        h: "3. Risikoer for de registrerte – og tiltak",
        list: [
          "Kartlegging av elevers bevegelser → ingen historikk lagres, bare siste punkt, slettet ved øktslutt.",
          "Andre elever ser posisjonen min → jegere ser bare forsinkede radarpunkt; lagkamerater ser hverandre bare i lagrunder.",
          "Mobbing via meldinger → ingen fritekst; bare fire faste hurtigmeldinger til eget lag.",
          "Uvedkommende får tilgang → økta krever PIN; lærerpanelet krever en hemmelig nøkkel som bare finnes på lærerens enhet.",
          "Elever ser ned på mobilen og skader seg → område uten biltrafikk, forbudte soner, varsler og regelen «se opp, ikke ned» i lærerens sjekkliste.",
        ],
      },
      {
        h: "4. Elevenes rettigheter",
        p: [
          "Informasjon: elevene og foresatte bør få vite hva Chase lagrer (punktlista over). Innsyn og sletting er i praksis ivaretatt av at alt slettes automatisk innen 24 timer.",
          "Elever som ikke vil eller kan bruke mobil, kan delta uten (for eksempel som dommer eller sammen med en annen) – avklar dette lokalt.",
        ],
      },
      {
        h: "5. Konklusjon (fylles ut av behandlingsansvarlig)",
        p: ["Vurdert av: ____________________   Dato: ____________", "Konklusjon: ☐ Kan brukes  ☐ Kan brukes med tiltak: ____________________  ☐ Skal ikke brukes"],
      },
    ],
  },
];

export function legalDoc(slug: string): LegalDoc | null {
  return LEGAL.find((d) => d.slug === slug) ?? null;
}
