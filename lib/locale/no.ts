// All user-facing strings (bokmål). Components import from here — no inline
// Norwegian copy in JSX, so wording can be tuned in one place.

export const no = {
  brand: "Chase",
  tagline: "GPS-jakt for hele klassen",
  landing: {
    lead: "Lærerstyrt jaktspill for skolegården, skogen og sentrum. Elevene blir med via QR — og glemmer at de trener.",
    comingSoon: "Under bygging",
    phaseNote: "Første spillbare versjon testes i en kroppsøvingstime.",
    tryMap: "Prøv kartet",
    pillars: [
      { title: "Alle i bevegelse", body: "Ingen blir slått ut. Blir du tatt, bytter du rolle og løper videre." },
      { title: "Læreren ser alt", body: "Live-kart, pause, beskjeder, samling og opprop — fra mobilen." },
      { title: "Trygt og glemsomt", body: "Geofence, nødknapp, og posisjoner slettes når økta er ferdig." },
    ],
  },
  common: {
    confirm: "Ja",
    cancel: "Avbryt",
    home: "Til forsiden",
    retry: "Prøv igjen",
    errorTitle: "Noe gikk galt",
    errorBody: "Prøv på nytt. Spillet lever på serveren, så du mister ikke plassen din.",
    notFoundTitle: "Fant ikke siden",
    notFoundBody: "Lenken kan være gammel, eller økta er avsluttet og slettet.",
    fullscreen: "Fullskjerm",
    exitFullscreen: "Avslutt fullskjerm",
  },
  map: {
    title: "Kartprøve",
    hint: "Trykk på posisjonsknappen for å finne deg selv. Sirkelen viser et spillområde på 150 m rundt deg.",
    circleAroundMe: "Sirkel rundt meg",
    radius: (m: number) => `${m} m radius`,
    area: (m2: number) =>
      m2 >= 10_000 ? `${(m2 / 10_000).toFixed(1).replace(".", ",")} hektar` : `${Math.round(m2)} m²`,
    accuracy: (m: number) => `GPS-nøyaktighet: ±${Math.round(m)} m`,
    noGps: "Fant ikke posisjonen din. Sjekk at nettleseren har lov til å bruke posisjon.",
    back: "Tilbake",
  },
} as const;
