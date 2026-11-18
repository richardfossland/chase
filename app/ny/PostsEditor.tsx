"use client";

import { useState } from "react";

import { Button, cx } from "@/lib/client/ui";
import { IconFlag, IconPrinter, IconX } from "@/lib/client/ui/icons";
import { no } from "@/lib/locale/no";
import { POSTS_MAX, POST_NAME_MAX, type FixedPost } from "@/lib/rules/library";

import { Note, field } from "./parts";

const t = no.wizard.fixedPosts;

/** «Faste poster» in the wizard's area step: list + options. The map itself (tap to place, drag to move) lives in Wizard. */
export function PostsEditor(props: {
  posts: FixedPost[];
  placing: boolean;
  outside: number;
  canSave: boolean;
  saveError: boolean;
  onPlacing: (on: boolean) => void;
  onChange: (posts: FixedPost[]) => void;
  onSavePrint: (name: string) => void;
}) {
  const { posts, placing } = props;
  const [name, setName] = useState<string>(t.areaNameDefault);
  const set = (i: number, patch: Partial<FixedPost>) => props.onChange(posts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const hasQr = posts.some((p) => p.qr);

  return (
    <section className="mt-6 border-t border-line pt-5" data-testid="fixed-posts">
      <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-txt-dim">
        <IconFlag size={16} />
        {t.title}
        {posts.length > 0 && <span className="font-semibold normal-case">· {t.count(posts.length)}</span>}
      </h3>
      <p className="mt-1 text-sm text-txt-dim">{placing ? t.placing : t.lead}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant={placing ? "primary" : "secondary"}
          size="sm"
          className="min-h-12 gap-2"
          disabled={!placing && posts.length >= POSTS_MAX}
          onClick={() => props.onPlacing(!placing)}
          data-testid="add-posts"
        >
          {placing ? t.done : t.add}
        </Button>
      </div>
      {posts.length >= POSTS_MAX && <p className="mt-2 text-sm text-txt-dim">{t.max}</p>}

      {posts.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {posts.map((p, i) => (
            <li key={i} className="rounded-2xl bg-ink p-3" data-testid="fixed-post">
              <div className="flex items-center gap-2">
                <span className="grid size-9 flex-none place-items-center rounded-full bg-gold text-sm font-black text-on-accent">{i + 1}</span>
                <input
                  className={cx(field, "min-h-11 flex-1")}
                  value={p.name ?? ""}
                  maxLength={POST_NAME_MAX}
                  placeholder={t.namePlaceholder}
                  aria-label={`${t.name} ${t.marker(i + 1)}`}
                  onChange={(e) => set(i, { name: e.target.value || undefined })}
                />
                <button
                  type="button"
                  className="ui-press grid size-11 flex-none place-items-center rounded-full text-txt-dim hover:bg-ink-3"
                  aria-label={t.remove(i + 1)}
                  onClick={() => props.onChange(posts.filter((_, j) => j !== i))}
                >
                  <IconX size={18} />
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-4 text-sm font-bold">
                <label className="flex min-h-10 items-center gap-2">
                  <input type="checkbox" className="size-5 accent-gold" checked={p.kind === "golden"} onChange={(e) => set(i, { kind: e.target.checked ? "golden" : "normal" })} />
                  {t.golden}
                </label>
                <label className="flex min-h-10 items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-5 accent-gold"
                    checked={p.qr}
                    onChange={(e) => set(i, { qr: e.target.checked })}
                  />
                  {t.qr}
                </label>
              </div>
            </li>
          ))}
        </ul>
      )}
      {posts.length > 0 && <p className="mt-2 text-xs text-txt-dim">{t.qrHint}</p>}
      {props.outside > 0 && <Note tone="danger">{t.outsideNote}</Note>}

      {hasQr && props.canSave && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="min-w-40 flex-1 text-sm font-bold">
            {t.areaName}
            <input className={cx(field, "mt-1")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button variant="secondary" size="sm" className="min-h-12 gap-2" onClick={() => props.onSavePrint(name)} data-testid="save-print">
            <IconPrinter size={18} />
            {t.savePrint}
          </Button>
        </div>
      )}
      {props.saveError && <Note tone="danger">{t.saveFailed}</Note>}
    </section>
  );
}
