"use client";

import { useEffect } from "react";

import { installErrorReporting, reportError } from "@/lib/client/errorReport";

export function ErrorReporter() {
  useEffect(() => installErrorReporting(), []);
  return null;
}

/** Brukes i error.tsx / global-error.tsx for å rapportere feil React fanget. */
export function useReportBoundaryError(error: unknown) {
  useEffect(() => reportError(error), [error]);
}
