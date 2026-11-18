import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_MS, mayInterrupt, pickVoice, resetVoiceState, speak, speakKey, speakLines, unlockVoice, voiceLinesFor, type VoiceView } from "@/lib/client/voice";

const base = (o: Partial<VoiceView> = {}): VoiceView => ({
  status: "live",
  role: "prey",
  voice: true,
  safety: { geofence: 0, forbidden: false },
  tag: null,
  zone: null,
  ...o,
});

describe("voiceLinesFor", () => {
  it("sier ingenting når voice er av eller mangler", () => {
    const next = base({ voice: false, safety: { geofence: 3, forbidden: true }, role: "hunter" });
    expect(voiceLinesFor(base(), next)).toEqual([]);
    expect(voiceLinesFor(base(), { ...next, voice: undefined })).toEqual([]);
  });

  it("sier ingenting uten forrige visning eller uten endring", () => {
    expect(voiceLinesFor(null, base({ safety: { geofence: 3, forbidden: false } }))).toEqual([]);
    expect(voiceLinesFor(base(), base())).toEqual([]);
  });

  it("utenfor området (geofence >= 2) sies bare ved overgang", () => {
    const out = base({ safety: { geofence: 2, forbidden: false } });
    expect(voiceLinesFor(base(), out)).toEqual(["outside"]);
    expect(voiceLinesFor(out, base({ safety: { geofence: 3, forbidden: false } }))).toEqual([]);
    expect(voiceLinesFor(base(), base({ safety: { geofence: 1, forbidden: false } }))).toEqual([]);
  });

  it("sperret område går foran utenfor-området", () => {
    const both = base({ safety: { geofence: 2, forbidden: true } });
    expect(voiceLinesFor(base(), both)).toEqual(["forbidden"]);
  });

  it("rollebytte: fanget, ikke under storm; reven", () => {
    expect(voiceLinesFor(base(), base({ role: "hunter" }))).toEqual(["caught"]);
    expect(voiceLinesFor(base(), base({ role: "hunter" }), { storm: true })).toEqual([]);
    expect(voiceLinesFor(base({ role: "hunter" }), base({ role: "prey", tag: { fox: true } }))).toEqual(["foxNow"]);
    expect(voiceLinesFor(base({ role: "hunter" }), base({ role: "prey" }))).toEqual([]);
  });

  it("jeger nær sies når den slår inn", () => {
    expect(voiceLinesFor(base(), base({ tag: { hunter_near: true } }))).toEqual(["hunterNear"]);
    expect(voiceLinesFor(base({ tag: { hunter_near: true } }), base({ tag: { hunter_near: true } }))).toEqual([]);
  });

  it("sone: ut av sonen", () => {
    expect(voiceLinesFor(base({ zone: { inside: true } }), base({ zone: { inside: false } }))).toEqual(["zoneOut"]);
    expect(voiceLinesFor(base({ zone: { inside: false } }), base({ zone: { inside: true } }))).toEqual([]);
  });

  it("rundestart og samling", () => {
    expect(voiceLinesFor(base({ status: "countdown" }), base({ status: "live" }))).toEqual(["go"]);
    expect(voiceLinesFor(base({ status: "breather" }), base({ status: "live" }))).toEqual(["go"]);
    expect(voiceLinesFor(base({ status: "live" }), base({ status: "gathering" }))).toEqual(["gather"]);
    expect(voiceLinesFor(base({ status: "gathering" }), base({ status: "gathering" }))).toEqual([]);
  });

  it("sikkerhet sorteres først når flere utløses", () => {
    const next = base({ status: "live", safety: { geofence: 2, forbidden: false }, tag: { hunter_near: true } });
    expect(voiceLinesFor(base({ status: "countdown" }), next)).toEqual(["outside", "hunterNear", "go"]);
  });
});

describe("pickVoice", () => {
  it("foretrekker nb-NO, så nb/no/nn, ellers null", () => {
    expect(pickVoice([{ lang: "en-US" }, { lang: "no_NO" }, { lang: "nb-NO" }])?.lang).toBe("nb-NO");
    expect(pickVoice([{ lang: "en-US" }, { lang: "no_NO" }])?.lang).toBe("no_NO");
    expect(pickVoice([{ lang: "nn-NO" }])?.lang).toBe("nn-NO");
    expect(pickVoice([{ lang: "en-US" }, { lang: "sv-SE" }])).toBeNull();
  });
});

describe("speak", () => {
  beforeEach(() => resetVoiceState());
  afterEach(() => vi.unstubAllGlobals());

  it("kaster aldri når speechSynthesis mangler", () => {
    vi.stubGlobal("window", {});
    expect(() => {
      unlockVoice();
      speak("Test");
      speakLines(["go"]);
    }).not.toThrow();
  });

  it("kaster aldri når speechSynthesis selv kaster", () => {
    class U {
      constructor(public text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    vi.stubGlobal("window", {
      speechSynthesis: {
        cancel: () => {
          throw new Error("boom");
        },
        speak: () => {
          throw new Error("boom");
        },
        getVoices: () => [],
      },
    });
    expect(() => {
      unlockVoice();
      speak("Test");
      speakLines(["forbidden"]);
    }).not.toThrow();
  });

  it("avbryter forrige ytring og sier norsk tekst", () => {
    const calls: string[] = [];
    class U {
      lang = "";
      constructor(public text: string) {}
    }
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    vi.stubGlobal("window", {
      speechSynthesis: {
        speaking: true,
        pending: false,
        cancel: () => calls.push("cancel"),
        speak: (u: U) => calls.push(`speak:${u.lang}:${u.text}`),
        getVoices: () => [],
      },
    });
    speakLines(["go"]);
    expect(calls).toEqual(["cancel", "speak:nb-NO:Kjør!"]);
  });
});

describe("prioritet", () => {
  beforeEach(() => resetVoiceState());
  afterEach(() => vi.unstubAllGlobals());

  it("mayInterrupt: lavere prioritet kutter ikke en høyere innen holdetiden", () => {
    expect(mayInterrupt(null, 5, 0)).toBe(true);
    expect(mayInterrupt({ rank: 0, at: 1000 }, 3, 1500)).toBe(false);
    expect(mayInterrupt({ rank: 0, at: 1000 }, 3, 1000 + HOLD_MS)).toBe(true);
    expect(mayInterrupt({ rank: 3, at: 1000 }, 0, 1100)).toBe(true);
    expect(mayInterrupt({ rank: 3, at: 1000 }, 3, 1100)).toBe(true);
  });

  it("sone krymper kutter ikke «Sperret område» i samme tick, og cancel kalles bare når noe pågår", () => {
    const calls: string[] = [];
    class U {
      lang = "";
      constructor(public text: string) {}
    }
    const synthStub = {
      speaking: false,
      pending: false,
      cancel: () => calls.push("cancel"),
      speak: (u: U) => calls.push(u.text),
      getVoices: () => [],
    };
    vi.stubGlobal("SpeechSynthesisUtterance", U);
    vi.stubGlobal("window", { speechSynthesis: synthStub });
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    speakKey("forbidden");
    expect(calls).toEqual(["Sperret område. Gå ut."]); // ingenting pågikk: ingen cancel
    synthStub.speaking = true;
    speakKey("zoneShrink");
    expect(calls).toEqual(["Sperret område. Gå ut."]); // droppet
    vi.spyOn(Date, "now").mockReturnValue(50_000 + HOLD_MS + 1);
    speakKey("zoneShrink");
    expect(calls.slice(1)).toEqual(["cancel", "Sonen krymper. Gå inn mot midten."]);
    vi.restoreAllMocks();
  });
});
