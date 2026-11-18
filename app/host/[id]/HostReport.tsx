"use client";

// Øktrapport til læreren (fase 10.5): utskriftsvennlig A4-side i en dialog.
// Hentes når dialogen åpnes, holdes bare i komponentens minne (aldri
// localStorage), og forsvinner når dialogen lukkes. Ingen posisjoner, kart eller
// ruter, og tabellen er alfabetisk, ikke rangert (PLAN § 0).

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { no } from "@/lib/locale/no";
import { sortAlphabetical, summarize, type ReportData } from "@/lib/rules/report";
import { buttonClass } from "@/lib/client/ui";

const r = no.report;
const nf = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 1 });
const fmt = (n: number) => nf.format(n);

export function HostReport({ load, onClose }: { load: () => Promise<ReportData | null>; onClose: () => void }) {
  const [data, setData] = useState<ReportData | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void load().then((d) => {
      if (!live) return;
      setData(d);
      setFailed(!d);
    });
    return () => {
      live = false;
    };
  }, [load, tick]);

  useEffect(() => {
    document.body.classList.add("printing-report");
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("printing-report");
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const retry = useCallback(() => {
    setFailed(false);
    setTick((t) => t + 1);
  }, []);

  const players = data ? sortAlphabetical(data.players) : [];
  const sum = summarize(players);
  const rows: { label: string; s: { avg: number; median: number; total: number } }[] = [
    { label: r.activeMin, s: sum.activeMin },
    { label: r.distance, s: sum.distance },
    { label: r.posts, s: sum.posts },
    { label: r.catches, s: sum.catches },
    { label: r.quiz, s: sum.quiz },
  ];

  return createPortal(
    <div className="report-portal fixed inset-0 z-[60] overflow-y-auto bg-white p-5 text-black" role="dialog" aria-modal="true" aria-label={r.title} data-testid="host-report">
      <div className="mx-auto max-w-3xl">
        <div className="no-print mb-4 flex gap-2">
          <button className={buttonClass("primary", "md")} disabled={!data} onClick={() => window.print()} data-testid="report-print">
            {r.print}
          </button>
          <button className={buttonClass("secondary", "md")} onClick={onClose}>
            {r.close}
          </button>
        </div>

        {failed ? (
          <div className="no-print">
            <p className="font-bold">{r.failed}</p>
            <button className={buttonClass("secondary", "md", "mt-3")} onClick={retry}>
              {r.retry}
            </button>
          </div>
        ) : !data ? (
          <p>{r.loading}</p>
        ) : (
          <article className="text-[13px] leading-snug">
            <h1 className="text-2xl font-black">Chase · {r.title}</h1>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="font-bold">{r.date}</dt>
              <dd>{new Date(data.started_at).toLocaleDateString("nb-NO", { day: "numeric", month: "long", year: "numeric" })}</dd>
              <dt className="font-bold">{r.duration}</dt>
              <dd>{r.minutes(Math.round(data.duration_s / 60))}</dd>
              <dt className="font-bold">{r.students}</dt>
              <dd>{sum.count}</dd>
              <dt className="font-bold">{r.rounds}</dt>
              <dd>
                {data.rounds.length
                  ? data.rounds.map((x) => (
                      <div key={x.idx}>{r.roundLine(x.idx + 1, no.host.round.modes[x.mode] ?? x.mode, x.duration_s ? Math.round(x.duration_s / 60) : null)}</div>
                    ))
                  : r.noRounds}
              </dd>
            </dl>

            <h2 className="mt-5 mb-1 text-base font-black">{r.summary}</h2>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-black text-left">
                  <th className="py-1 pr-2" />
                  <th className="px-2 text-right">{r.average}</th>
                  <th className="px-2 text-right">{r.medianLabel}</th>
                  <th className="pl-2 text-right">{r.total}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.label} className="border-b border-gray-300">
                    <td className="py-1 pr-2 font-bold">{x.label}</td>
                    <td className="px-2 text-right">{fmt(x.s.avg)}</td>
                    <td className="px-2 text-right">{fmt(x.s.median)}</td>
                    <td className="pl-2 text-right">{fmt(x.s.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h2 className="mt-5 mb-1 text-base font-black">{r.perNickname}</h2>
            {players.length ? (
              <table className="w-full border-collapse" data-testid="report-table">
                <thead>
                  <tr className="border-b border-black text-left">
                    <th className="py-1 pr-2">{r.nickname}</th>
                    <th className="px-1 text-right">{r.activeMin}</th>
                    <th className="px-1 text-right">{r.distance}</th>
                    <th className="px-1 text-right">{r.posts}</th>
                    <th className="px-1 text-right">{r.catches}</th>
                    <th className="px-1 text-right">{r.quiz}</th>
                    <th className="pl-1 text-right">{r.badges}</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={`${p.nickname}-${i}`} className="break-inside-avoid border-b border-gray-300">
                      <td className="py-1 pr-2 font-bold">{p.nickname}</td>
                      <td className="px-1 text-right">{fmt(p.active_s / 60)}</td>
                      <td className="px-1 text-right">{fmt(p.distance_m)}</td>
                      <td className="px-1 text-right">{p.posts}</td>
                      <td className="px-1 text-right">{p.catches}</td>
                      <td className="px-1 text-right">{p.quiz_right}</td>
                      <td className="pl-1 text-right">{p.badges}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>{r.noPlayers}</p>
            )}

            <p className="mt-6 border-t border-gray-400 pt-2 text-xs">{r.privacy}</p>
          </article>
        )}
      </div>
    </div>,
    document.body,
  );
}
