"use client";

import { useEffect, useState } from "react";

import { identity } from "@/lib/client/identity";

import QrClaim from "./[code]/QrClaim";

/** Claims a session-independent card in the session of the phone's own player. */
export default function CodeClaim({ code }: { code: string }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only
    setSessionId(identity.player()?.sessionId ?? "");
  }, []);
  if (sessionId === null) return null;
  return <QrClaim sessionId={sessionId} code={code} />;
}
