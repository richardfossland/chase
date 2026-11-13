import type { Metadata } from "next";
import Link from "next/link";

import { AreaThumb } from "@/lib/client/AreaThumb";
import type { SharePreview } from "@/lib/client/api";
import { planSummary } from "@/lib/client/planSummary";
import { no } from "@/lib/locale/no";
import { parseShareCode } from "@/lib/rules/library";
import { rpc } from "@/lib/server/rpc";

import ShareActions from "./ShareActions";

// Public share link (0010, PLAN §9.6): a safe preview (plan + optional area,
// nothing about the teacher) and «Lag kopi». Read server-side with the
// service role through chase.share_get — no public RLS policy.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Delt opplegg — Chase", robots: { index: false, follow: false } };

const s = no.share;

export default async function SharePage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = parseShareCode(raw);
  const r = code ? await rpc("share_get", { p_code: code }).catch(() => null) : null;
  const share = r?.ok ? (r as unknown as SharePreview) : null;

  if (!share) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <h1 className="text-3xl font-black">{s.title}</h1>
        <p className="mt-4 rounded-2xl border border-line bg-ink-2 p-4 font-bold">{s.notFound}</p>
        <Link href="/" className="mt-6 inline-block text-txt-dim underline">
          {no.common.home}
        </Link>
      </main>
    );
  }

  const sum = planSummary(share.plan);
  const modes = no.wizard.playlist.modes;
  return (
    <main className="mx-auto max-w-xl px-4 py-10 pb-24">
      <p className="text-sm font-bold uppercase tracking-widest text-gold">{s.title}</p>
      <h1 className="mt-2 text-4xl font-black">{share.name}</h1>
      <p className="mt-2 text-txt-dim">{s.lead}</p>

      <section className="mt-6 rounded-2xl border border-line bg-ink-2 p-4">
        <h2 className="font-black">{s.rounds}</h2>
        <ol className="mt-2 space-y-1">
          {share.plan.rounds.map((r, i) => (
            <li key={i} className="flex justify-between gap-3 font-bold">
              <span>
                {i + 1}. {r.mode === "tag" ? modes[r.variant ?? "convert"] : modes[r.mode]}
                {r.team ? ` ${no.wizard.playlist.team}` : ""}
                {r.zone ? ` ${no.wizard.playlist.zone}` : ""}
              </span>
              <span className="text-txt-dim">{Math.round(r.duration_s / 60)} min</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-sm text-txt-dim">
          {s.total(sum.minutes)}
          {share.plan.teams ? ` · ${s.teams(share.plan.teams)}` : ""}
          {share.plan.event_every_s ? ` · ${s.events(share.plan.event_every_s)}` : ""}
        </p>
      </section>

      {share.plan.missions?.length ? (
        <section className="mt-4 rounded-2xl border border-line bg-ink-2 p-4">
          <h2 className="font-black">{s.missions}</h2>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {share.plan.missions.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-4 flex items-center gap-4 rounded-2xl border border-line bg-ink-2 p-4">
        {share.area ? (
          <>
            <AreaThumb area={share.area} size={96} />
            <div>
              <h2 className="font-black">{s.area}</h2>
              <p className="text-sm text-txt-dim">{no.map.area(share.area.area_m2)}</p>
            </div>
          </>
        ) : (
          <p className="text-sm text-txt-dim">{s.noArea}</p>
        )}
      </section>

      <ShareActions code={share.code} />
    </main>
  );
}
