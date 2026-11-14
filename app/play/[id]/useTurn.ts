"use client";

import { useState } from "react";

/** Rotation for a direction arrow that always turns the short way round
 * (359° → 1° turns 2°, not 358°), so a CSS transition on it stays smooth. */
export function useTurn(deg: number): number {
  const [rot, setRot] = useState(deg);
  const [prev, setPrev] = useState(deg);
  if (prev !== deg) {
    setPrev(deg);
    setRot(rot + ((((deg - prev) % 360) + 540) % 360) - 180);
  }
  return rot;
}
