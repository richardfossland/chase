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
