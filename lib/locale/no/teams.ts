// Bokmål strings: teams. Composed into `no` in ../no.ts.

export const teams = {
  // Fase 5 (0009): teams, Flaggjakt, Konge på haugen — phones and the teacher panel.
  teams: {
    label: "Lag",
    team: (name: string) => `Lag ${name}`,
    place: (rank: number, of: number) => `${rank}. av ${of}`,
    points: (p: number) => `${p} lagpoeng`,
    flagsMine: (mine: number, all: number) => `Dere har ${mine} av ${all} flagg`,
    flagNear: (m: number) => `Nærmeste flagg ${m} m`,
    taking: (s: number) => `Dere tar flagget … ${s}`,
    losing: (s: number) => `Flagget tas fra dere! ${s}`,
    contested: "Et annet lag tar flagget. Bli flere!",
    flagWon: "Flagget er deres!",
    flagLost: "Dere mistet et flagg",
    hillHold: "Dere holder haugen!",
    hillOther: (name: string) => `Lag ${name} holder haugen`,
    hillFree: "Ingen holder haugen. Løp!",
    hillTo: (m: number) => `${m} m til haugen`,
    hillIn: "Du er på haugen",
    hillMoves: (s: number) => `Flytter seg om ${s} s`,
    hillMoved: "Haugen har flyttet seg!",
    msgTitle: "Laget",
    msgs: { help: "Hjelp!", come: "Kom hit", mine: "Jeg tar den", ok: "OK" } as Record<string, string>,
    /** On the map (map fonts have no emoji). */
    msgsPlain: { help: "Hjelp!", come: "Kom hit", mine: "Jeg tar den", ok: "OK" } as Record<string, string>,
    msgFrom: (nick: string, text: string) => `${nick}: ${text}`,
    msgErrors: { too_soon: "Vent litt før neste beskjed.", not_now: "Beskjeder virker bare i lagrunder." } as Record<string, string>,
    // Teacher panel.
    host: {
      title: "Lag",
      deal: "Fordel lag",
      redeal: "Fordel på nytt",
      dealHint: "Jevnt etter poeng. Lagene låses når første lagrunde starter.",
      notDealt: "Lagene fordeles når første lagrunde starter.",
      locked: "Lagene er låst.",
      move: "Lag",
      members: (n: number) => `${n} ${n === 1 ? "elev" : "elever"}`,
      scores: "Lagpoeng",
      flags: (held: string) => `Flagg: ${held}`,
      hill: (name: string | null) => (name ? `Haugen: lag ${name}` : "Haugen: ingen"),
      noTeam: "Uten lag",
      errors: { teams_locked: "Lagene er låst etter første lagrunde.", no_teams: "Økta har ingen lagrunder." } as Record<string, string>,
    },
  },
} as const;
