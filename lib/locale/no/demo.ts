export const demo = {
  demo: {
    badge: "Demo",
    running: (botMin: number, endMin: number) =>
      `Boter spiller i denne fanen og stopper om ${botMin} min eller når du lukker siden. Økta avsluttes automatisk senest om ${endMin} min.`,
    stopped: "Botene er stoppet.",
    stop: "Stopp boter",
    try: "Prøv med boter",
    tryHint: "Lager en demo-økt der datastyrte elever spiller i denne fanen, så du ser hvordan panelet fungerer uten klasse.",
    count: "Antall boter",
    starting: "Starter demo …",
    note: "Bare for utprøving: økta gir ingen sammendrag og avsluttes automatisk etter 30 til 45 minutter.",
    errors: {
      demo_limit: "Du har laget tre demoer den siste timen. Prøv igjen litt senere.",
      demo_off: "Demo er ikke tilgjengelig akkurat nå.",
      demo_busy: "Mange prøver demoen akkurat nå. Prøv igjen om noen minutter.",
    },
  },
} as const;
