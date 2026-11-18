export const demo = {
  demo: {
    badge: "Demo",
    running: (min: number) => `Boter spiller i denne fanen. Avsluttes om ${min} min eller når du lukker panelet.`,
    stopped: "Botene er stoppet.",
    stop: "Stopp boter",
    try: "Prøv med boter",
    tryHint: "Lager en demo-økt der datastyrte elever spiller i denne fanen, så du ser hvordan panelet fungerer uten klasse.",
    count: "Antall boter",
    starting: "Starter demo …",
    note: "Bare for utprøving: økta lagres ikke og avsluttes automatisk etter 30 minutter.",
    errors: {
      demo_limit: "Du har laget tre demoer den siste timen. Prøv igjen litt senere.",
      demo_busy: "Mange prøver demoen akkurat nå. Prøv igjen om noen minutter.",
    },
  },
} as const;
