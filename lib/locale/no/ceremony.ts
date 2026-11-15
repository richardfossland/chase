// Bokmål strings: ceremony. Composed into `no` in ../no.ts.

export const ceremony = {
  // Premieutdeling + «ditt beste» (0006), shared by the teacher panel and the phones.
  ceremony: {
    title: "Premieutdeling",
    intro: "Gjør dere klare …",
    introBody: "Pallene vises én og én.",
    waiting: "Premieutdelingen starter snart. Se mot læreren!",
    of: (i: number, n: number) => `Pall ${i} av ${n}`,
    cats: {
      referee: "Beste dommer",
      explorer: "Utforsker",
      comeback: "Comeback",
      posts: "Flest poster",
      survival_s: "Overlevde lengst",
      catches: "Flest fangster",
      active_s: "Mest aktiv",
      distance_m: "Lengst løpt",
      points: "Flest poeng",
      teamplay: "Lagspiller",
      quiz: "Flest riktige",
      team: "Beste lag",
    } as Record<string, string>,
    value: (cat: string, v: number | null): string => {
      if (v === null) return "";
      switch (cat) {
        case "distance_m": return `${Math.round(v).toLocaleString("nb-NO")} m`;
        case "active_s": return `${Math.round(v / 60)} min`;
        case "survival_s": return `${Math.floor(v / 60)}:${String(Math.round(v) % 60).padStart(2, "0")}`;
        case "posts": return v === 1 ? "1 post" : `${v} poster`;
        case "catches": return v === 1 ? "1 fangst" : `${v} fangster`;
        case "explorer": return `${v} ruter`;
        case "comeback": return `+${v} p`;
        case "teamplay": return v === 1 ? "1 lagbidrag" : `${v} lagbidrag`;
        case "quiz": return v === 1 ? "1 riktig" : `${v} riktige`;
        default: return `${v} p`;
      }
    },
    places: ["1.", "2.", "3."],
    you: "Det er deg!",
    yourTeam: "Det er laget ditt!",
    bestTitle: "Ditt beste",
    best: {
      distance_m: (s: number) => `Topp ${s} % på løpt distanse!`,
      active_s: (s: number) => `Topp ${s} % på aktiv tid!`,
      points: (s: number) => `Topp ${s} % på poeng!`,
      posts: (s: number) => `Topp ${s} % på poster!`,
      catches: (s: number) => `Topp ${s} % på fangster!`,
      survival_s: (s: number) => `Topp ${s} % på å overleve!`,
      explorer: (s: number) => `Topp ${s} % på å utforske området!`,
    } as Record<string, (s: number) => string>,
    plain: {
      active_s: (v: number) => `Du var i bevegelse i ${Math.max(1, Math.round(v / 60))} minutter!`,
      distance_m: (v: number) => `Du løp ${Math.round(v).toLocaleString("nb-NO")} meter!`,
      joined: "Takk for at du var med!",
    },
    onPodium: "Du sto på pallen i dag!",
    again: "Vil du spille igjen?",
    yes: "Ja!",
    no: "Nei",
    thanks: "Takk for svaret!",
    start: "Start premieutdeling",
    spread: "Maks 2 paller per elev (spredning)",
    drum: "Neste pall",
    toCards: "Vis «ditt beste»",
    back: "Tilbake",
    cardsShown: "Alle ser nå sitt «ditt beste»-kort.",
    againCount: (y: number, n: number) => `Vil spille igjen: ${y} ja · ${n} nei`,
    teacherAgain: "Vil du bruke Chase igjen?",
    end: "Avslutt økta",
    none: "Ingen paller i dag. Alle får sitt «ditt beste».",
  },
} as const;
