// Realtime topics + event names, shared by API routes and clients.
// Broadcasts are HINTS only ("something changed, refetch"): payloads never
// carry positions, nicknames or tokens (CLAUDE.md rule 3). Clients always
// fetch truth via tick / snapshot.

export const channels = {
  all: (session: string) => `chase:${session}:all`,
  host: (session: string) => `chase:${session}:host`,
  player: (session: string, player: string) => `chase:${session}:p:${player}`,
} as const;

export const events = {
  /** Session state changed (start, pause, resume, gather, end). */
  state: "state",
  /** New message for this channel. */
  message: "message",
  /** Host: a safety alarm was raised or escalated — refetch snapshot now. */
  alarm: "alarm",
  /** Host: someone joined / left / was renamed. */
  roster: "roster",
  /** Player: the teacher acked your alarm. */
  ack: "ack",
} as const;
