"use client";

// Tiny Web Audio sound kit — synthesised tones, no audio files. Used by the
// board for the timer buzzer + result/champion celebrations. Browsers block
// audio until a user gesture, so call unlockAudio() on first interaction.

let ctx: AudioContext | null = null;
let enabled = true;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  return ctx;
}

export function unlockAudio(): void {
  const c = getCtx();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}
export function setSoundEnabled(v: boolean): void {
  enabled = v;
  if (v) unlockAudio();
}
export function isSoundEnabled(): boolean {
  return enabled;
}

function tone(
  freq: number,
  startOffset: number,
  dur: number,
  type: OscillatorType = "sine",
  gain = 0.2,
): void {
  const c = getCtx();
  if (!c || !enabled) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(c.destination);
  const t0 = c.currentTime + startOffset;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** Soft chime when a result is entered. */
export function playDing(): void {
  tone(880, 0, 0.2, "triangle", 0.16);
  tone(1320, 0.06, 0.22, "triangle", 0.1);
}

/** End-of-timer buzzer. */
export function playBuzzer(): void {
  tone(190, 0, 0.55, "sawtooth", 0.22);
  tone(130, 0, 0.55, "square", 0.16);
  tone(190, 0.6, 0.4, "sawtooth", 0.18);
}

/** Champion fanfare. */
export function playFanfare(): void {
  const notes = [523, 659, 784, 1047];
  notes.forEach((f, i) => tone(f, i * 0.14, 0.32, "triangle", 0.2));
  tone(1047, 0.58, 0.7, "triangle", 0.22);
  tone(1568, 0.62, 0.7, "triangle", 0.14);
}

/** SOS siren for the teacher (repeated by the caller until acked). */
export function playSiren(): void {
  for (let i = 0; i < 4; i++) {
    tone(880, i * 0.5, 0.25, "square", 0.25);
    tone(660, i * 0.5 + 0.25, 0.25, "square", 0.25);
  }
}

/** True once the browser lets us make sound (after a user gesture). */
export function audioReady(): boolean {
  return getCtx()?.state === "running";
}

// ── Game feedback (phase 2). Short, distinct, readable at a run. ──

/** Post claimed: bright rising arpeggio. */
export function playClaim(): void {
  [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.07, 0.18, "triangle", 0.2));
}

/** Someone else took the post you were on. */
export function playBlip(): void {
  tone(330, 0, 0.15, "sine", 0.18);
  tone(247, 0.12, 0.25, "sine", 0.16);
}

/** Countdown beep (3-2-1). */
export function playBeep(): void {
  tone(880, 0, 0.12, "square", 0.14);
}

/** Round starts: long high beep. */
export function playGo(): void {
  tone(1320, 0, 0.5, "square", 0.18);
  tone(1760, 0, 0.5, "triangle", 0.1);
}

/** Round over: two-tone whistle. */
export function playWhistle(): void {
  tone(2093, 0, 0.25, "sine", 0.2);
  tone(1760, 0.28, 0.45, "sine", 0.2);
}

/** Badge earned: sparkle. */
export function playBadge(): void {
  [1568, 2093, 2637].forEach((f, i) => tone(f, i * 0.06, 0.22, "sine", 0.12));
}

/** Ceremony drumroll (~1.6 s, speeding up) — synthesised, no files. */
export function playDrumroll(): void {
  let t = 0;
  for (let i = 0; i < 26; i++) {
    tone(96 + (i % 2) * 12, t, 0.07, "triangle", 0.1 + i * 0.006);
    t += Math.max(0.035, 0.09 - i * 0.0025);
  }
  tone(196, t + 0.02, 0.5, "sawtooth", 0.08);   // the «ta-da» hit
}
