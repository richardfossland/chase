"use client";

import { useEffect } from "react";

import { attachDemoPanel } from "@/lib/client/demoBots";

/**
 * Alltid montert på lærersiden (page.tsx), uavhengig av lasteskjermer i HostPanel:
 * botene lever så lenge siden er åpen og stoppes når den lukkes.
 */
export default function DemoLifecycle({ sessionId }: { sessionId: string }) {
  useEffect(() => attachDemoPanel(sessionId), [sessionId]);
  return null;
}
