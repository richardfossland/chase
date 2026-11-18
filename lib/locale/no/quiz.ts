// Bokmål strings: quiz. Composed into `no` in ../no.ts.

export const quiz = {
  // Fase 7 (0012): questions at posts, step counter, big screen.
  quiz: {
    title: "Quiz",
    lead: "Svar før tiden går ut. Riktig gir 10 poeng, feil koster ingenting.",
    right: "Riktig! +10",
    wrong: (a: string) => `Riktig svar var: ${a}`,
    late: "Tiden gikk ut",
    left: (s: number) => `${s} s`,
    errors: { not_now: "Spørsmålet er stengt." } as Record<string, string>,
    // Wizard / library.
    editor: "Quiz",
    editorLead: "Et spørsmål etter hver post i Postjakt. Ett spørsmål per avsnitt, så 2–4 svar. Merk det riktige med *.",
    placeholder: "Hovedstaden i Norge?\nBergen\n*Oslo\nTromsø\n\nHva er 3 × 4?\n*12\n14",
    count: (n: number) => (n === 1 ? "1 spørsmål" : `${n} spørsmål`),
    errorsAt: (ns: number[]) => `Sjekk spørsmål ${ns.join(", ")}: 2–4 svar og nøyaktig ett riktig (*).`,
    fromPack: "Hent",
    savePack: "Lagre i biblioteket",
    packs: "Quiz",
    newPack: "Ny quiz",
    ready: {
      open: "Velg ferdig pakke",
      lead: "Ferdige pakker etter LK20. Du kan redigere spørsmålene etterpå.",
      grade: "Trinn",
      subject: "Fag",
      all: "Alle",
      gradeN: (n: number) => `${n}. trinn`,
      grades: (a: number, b: number) => `${a}.–${b}. trinn`,
      questions: (n: number) => `${n} spørsmål`,
      none: "Ingen pakker passer. Prøv et annet trinn eller fag.",
      use: "Bruk",
      replace: "Dette erstatter spørsmålene du har skrevet. Fortsette?",
    },
    needsPosts: "Quiz kommer bare i Postjakt-runder.",
  },
} as const;
