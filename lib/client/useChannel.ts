"use client";

import { useCallback, useEffect, useRef } from "react";
import { acquireChannel, sendOnTopic } from "@/lib/client/channelRegistry";

type Handler = (event: string, payload: Record<string, unknown>) => void;

/** Subscribe to a Supabase Realtime topic and invoke `onEvent` for every
 * broadcast on it. Resubscribes when the topic changes. Handlers live in refs
 * so consumers need not memoise them.
 *
 * The channel is shared and ref-counted per topic (channelRegistry): several
 * hooks on one page get ONE channel, and a CLOSED/error channel is recreated
 * with backoff behind the scenes. `onStatus` (optional) sees the subscribe
 * lifecycle so a consumer can refetch authoritative state when broadcasts
 * may have been lost (CHANNEL_ERROR / TIMED_OUT / CLOSED).
 *
 * Returns a stable `send(event, payload)` for ephemeral client broadcasts on
 * the same topic — a no-op until subscribed. Routed by topic through the
 * registry, so a send right after a recreate lands on the live channel. */
export function useChannel(
  topic: string | null,
  onEvent: Handler,
  onStatus?: (status: string) => void,
): (event: string, payload: Record<string, unknown>) => void {
  const handlerRef = useRef(onEvent);
  const statusRef = useRef(onStatus);
  useEffect(() => {
    handlerRef.current = onEvent;
    statusRef.current = onStatus;
  });

  useEffect(() => {
    if (!topic) return;
    // Guard against missing env in local/dev so the UI still renders.
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    const { release } = acquireChannel(topic, {
      onBroadcast: (event, payload) => handlerRef.current(event, payload),
      onStatus: (status) => statusRef.current?.(status),
    });
    return release;
  }, [topic]);

  return useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (topic) sendOnTopic(topic, event, payload);
    },
    [topic],
  );
}
