// Shared workstation state and synthesis configuration.
export const STORAGE_KEY = "akai_mpk_mk3_fm4_project_v1";

  export const PADS_INFO = [
    { name: "KICK" }, { name: "SNARE" }, { name: "C-HAT" }, { name: "O-HAT" },
    { name: "CLAP" }, { name: "LO-TOM" }, { name: "HI-TOM" }, { name: "RIM" }
  ];

  export const KNOB_SPECS = [
    { id: "ratio", label: "K1 RATIO", dLabel: "K1 TUNE", q: 0.5, cc: 70, min: 0.5, max: 8, fmt: v => v.toFixed(1) + "x" },
    { id: "mod", label: "K2 FM MOD", dLabel: "K2 PUNCH", cc: 71, min: 0, max: 500, fmt: v => Math.round(v) },
    { id: "att", label: "K3 ATTACK", dLabel: "K3 SNAP", cc: 72, min: 0.005, max: 0.5, fmt: v => Math.round(v * 1000) + "ms" },
    { id: "rel", label: "K4 RELEASE", dLabel: "K4 DECAY", cc: 73, min: 0.05, max: 1.5, fmt: v => v.toFixed(2) + "s" },
    { id: "cut", label: "K5 FILTER", dLabel: "K5 FILTER", cc: 74, min: 150, max: 8000, fmt: v => Math.round(v) + "Hz" },
    { id: "res", label: "K6 RESO", dLabel: "K6 RESO", cc: 75, min: 0.5, max: 14, fmt: v => v.toFixed(1) },
    { id: "dly", label: "K7 DELAY", dLabel: "K7 DELAY", cc: 76, min: 0, max: 0.8, fmt: v => Math.round(v * 100) + "%" },
    { id: "vol", label: "K8 VOLUME", dLabel: "K8 VOLUME", cc: 77, min: 0, max: 1, fmt: v => Math.round(v * 100) + "%" }
  ];

  export const WAVES = ["SIN", "TRI", "SAW", "SQR"], OSC_TYPES = ["sine", "triangle", "sawtooth", "square"];
  export const pct = v => Math.round(v * 100) + "%";
  export const WAVE_SPECS = [
    { id: "cw", label: "K1 CAR WAVE", min: 0, max: 3, q: 1, fmt: v => WAVES[Math.round(v)] },
    { id: "mw", label: "K2 MOD WAVE", min: 0, max: 3, q: 1, fmt: v => WAVES[Math.round(v)] },
    { id: "fold", label: "K3 FOLD", min: 0, max: 1, fmt: pct },
    { id: "det", label: "K4 DETUNE", min: 0, max: 40, fmt: v => Math.round(v) + "ct" },
    { id: "sub", label: "K5 SUB", min: 0, max: 1, fmt: pct },
    { id: "noi", label: "K6 NOISE", min: 0, max: 1, fmt: pct },
    { id: "mdec", label: "K7 MOD DEC", min: 0.1, max: 2, fmt: v => v.toFixed(2) + "x" },
    { id: "pe", label: "K8 PITCH ENV", min: 0, max: 12, fmt: v => v.toFixed(1) + "st" }
  ];
  export const PITCH_PATTERNS = [
    { name: "MIN7",  steps: [0, 3, 7, 10, 12] },
    { name: "MAJ7",  steps: [0, 4, 7, 11, 12] },
    { name: "PENTA", steps: [0, 3, 5, 7, 10] },
    { name: "OCT5",  steps: [0, 12, 7, 12, 24] },
    { name: "ACID",  steps: [0, 12, 3, 7, 10] },
    { name: "FALL",  steps: [12, 7, 3, 0, -5] },
    { name: "CHIRP", steps: [24, 12, 7, 3, 0] },
    { name: "4THS",  steps: [0, 5, 10, 15, 12] }
  ];
  export const PITCH_RATES = [
    { name: "1/4",  div: 1 },
    { name: "1/8",  div: 2 },
    { name: "1/12", div: 3 },
    { name: "1/16", div: 4 },
    { name: "1/24", div: 6 },
    { name: "1/32", div: 8 },
    { name: "1/48", div: 12 },
    { name: "1/64", div: 16 }
  ];
  export const PITCH_MODES = ["1-SHOT", "LOOP", "PING"];

  export const PITCH_SPECS = [
    { id: "psteps", label: "K1 STEPS",   min: 1, max: 5,  q: 1, fmt: v => Math.round(v) === 1 ? "OFF" : Math.round(v) + " ST" },
    { id: "pscale", label: "K2 SHAPE",   min: 0, max: 7,  q: 1, fmt: v => PITCH_PATTERNS[Math.round(v)].name },
    { id: "prate",  label: "K3 SPEED",   min: 0, max: 7,  q: 1, fmt: v => PITCH_RATES[Math.round(v)].name },
    { id: "pglide", label: "K4 GLIDE",   min: 0, max: 0.08,     fmt: v => Math.round(v * 1000) + "ms" },
    { id: "ploop",  label: "K5 MODE",    min: 0, max: 2,  q: 1, fmt: v => PITCH_MODES[Math.round(v)] },
    { id: "ptrans", label: "K6 OFFSET",  min: -12, max: 12, q: 1, fmt: v => (v > 0 ? "+" : "") + Math.round(v) + "st" },
    { id: "pfm",    label: "K7 FM STEP", min: 0, max: 1,        fmt: pct },
    { id: "pe",     label: "K8 P-ENV",   min: 0, max: 12,       fmt: v => v.toFixed(1) + "st" }
  ];

  export const PITCH_DEFAULTS = { psteps: 1, pscale: 0, prate: 3, pglide: 0, ploop: 1, ptrans: 0, pfm: 0.35 };
  export const WAVE_DEFAULTS = { cw: 0, mw: 0, fold: 0, det: 0, sub: 0, noi: 0, mdec: 1, pe: 0 };
  export const PAGES = [
    { name: "SOUND", specs: KNOB_SPECS },
    { name: "WAVE", specs: WAVE_SPECS },
    { name: "PITCH", specs: PITCH_SPECS }
  ];

  export const PRESETS = [
    { name: "Sub FM", ratio: 1, mod: 140, att: 0.01, rel: 0.28, cut: 1100, res: 2.5, dly: 0.0 },
    { name: "Acid FM", ratio: 2, mod: 360, att: 0.008, rel: 0.22, cut: 2400, res: 8.5, dly: 0.2 },
    { name: "DX Tines", ratio: 3.5, mod: 115, att: 0.02, rel: 0.75, cut: 3400, res: 1.2, dly: 0.3 },
    { name: "FM Organ", ratio: 2, mod: 185, att: 0.01, rel: 0.35, cut: 4200, res: 1.5, dly: 0.2 },
    { name: "80s Poly", ratio: 1, mod: 260, att: 0.07, rel: 0.45, cut: 3800, res: 3.0, dly: 0.28 },
    { name: "Bell Pad", ratio: 5, mod: 220, att: 0.01, rel: 0.95, cut: 6200, res: 1.0, dly: 0.45 },
    { name: "Chip Lead", ratio: 1.5, mod: 310, att: 0.005, rel: 0.18, cut: 5000, res: 4.0, dly: 0.35 },
    { name: "Dark Pad", ratio: 0.5, mod: 90, att: 0.22, rel: 1.2, cut: 1900, res: 2.0, dly: 0.5 }
  ];

  export const TRACK_COLORS = [
    { c: "#ff3b56", hi: "#ff9aab", glow: "rgba(255,59,86,0.85)",  soft: "rgba(255,59,86,0.5)" },
    { c: "#ffa41f", hi: "#ffd58a", glow: "rgba(255,164,31,0.85)", soft: "rgba(255,164,31,0.5)" },
    { c: "#2fc4f2", hi: "#9fe6fb", glow: "rgba(47,196,242,0.85)", soft: "rgba(47,196,242,0.5)" },
    { c: "#4fcf48", hi: "#a6ee9f", glow: "rgba(79,207,72,0.85)",  soft: "rgba(79,207,72,0.5)" }
  ];
  export const DEFAULT_NOTE = [36, 60, 67, 0];

  export function emptySteps() {
    return Array.from({ length: 16 }, () => []);
  }
  export function emptyPatterns() {
    return Array.from({ length: 4 }, () => emptySteps());
  }
  export const tracks = [
    { name: "BASS", pIdx: 0, muted: false, soloed: false, ratio: 1, mod: 140, att: 0.01, rel: 0.28, cut: 1100, res: 2.5, dly: 0.0, vol: 0.85, patterns: emptyPatterns() },
    { name: "CHORD", pIdx: 2, muted: false, soloed: false, ratio: 3.5, mod: 115, att: 0.02, rel: 0.75, cut: 3400, res: 1.2, dly: 0.3, vol: 0.65, patterns: emptyPatterns() },
    { name: "LEAD", pIdx: 4, muted: false, soloed: false, ratio: 1, mod: 260, att: 0.07, rel: 0.45, cut: 3800, res: 3.0, dly: 0.28, vol: 0.72, patterns: emptyPatterns() },
    { name: "DRUMS", pIdx: 0, muted: false, soloed: false, ratio: 1.0, mod: 180, att: 0.01, rel: 0.25, cut: 7500, res: 1.0, dly: 0.0, vol: 0.9, patterns: emptyPatterns() }
  ];
  tracks.forEach(t => Object.assign(t, WAVE_DEFAULTS, PITCH_DEFAULTS));
  tracks.forEach(t => { t.rat = Array.from({ length: 4 }, () => Array.from({ length: 16 }, () => ({}))); });

export function serializeProject({ bpm, swing, prob, activePat, tracks }) {
  return {
    version: 1,
    bpm, swing, prob, activePat,
    tracks: tracks.map(t => ({
      pIdx: t.pIdx, muted: t.muted, soloed: t.soloed,
      ratio: t.ratio, mod: t.mod, att: t.att, rel: t.rel,
      cut: t.cut, res: t.res, dly: t.dly, vol: t.vol,
      cw: t.cw, mw: t.mw, fold: t.fold, det: t.det,
      sub: t.sub, noi: t.noi, mdec: t.mdec, pe: t.pe,
      psteps: t.psteps, pscale: t.pscale, prate: t.prate, pglide: t.pglide, ploop: t.ploop, ptrans: t.ptrans, pfm: t.pfm,
      patterns: t.patterns, rat: t.rat
    }))
  };
}

export function hydrateProjectState(data, transport, targetTracks) {
  if (!data || !Array.isArray(data.tracks) || data.tracks.length !== 4) return null;

  const nextTransport = { ...transport };
  if (typeof data.bpm === "number") nextTransport.bpm = Math.max(60, Math.min(180, data.bpm));
  if (typeof data.swing === "number") nextTransport.swing = Math.max(0, Math.min(75, data.swing));
  if (typeof data.prob === "number") nextTransport.prob = Math.max(10, Math.min(100, data.prob));
  if (typeof data.activePat === "number") nextTransport.activePat = Math.max(0, Math.min(3, data.activePat));

  data.tracks.forEach((src, i) => {
    const dst = targetTracks[i];
    ["pIdx", "muted", "soloed", "ratio", "mod", "att", "rel", "cut", "res", "dly", "vol",
      "cw", "mw", "fold", "det", "sub", "noi", "mdec", "pe",
      "psteps", "pscale", "prate", "pglide", "ploop", "ptrans", "pfm"].forEach(k => {
      if (src[k] !== undefined) dst[k] = src[k];
    });
    if (Array.isArray(src.patterns) && src.patterns.length === 4) {
      dst.patterns = src.patterns.map(pat =>
        Array.isArray(pat) && pat.length === 16 ? pat.map(s => Array.isArray(s) ? [...s] : []) : emptySteps()
      );
    } else if (Array.isArray(src.steps) && src.steps.length === 16) {
      dst.patterns[0] = src.steps.map(s => Array.isArray(s) ? [...s] : []);
    }
    if (Array.isArray(src.rat) && src.rat.length === 4) dst.rat = src.rat.map((r, p) => Array.isArray(r) && r.length === 16 ? r.map((v, st) => { if (v && typeof v === "object") return { ...v }; const o = {}; if ((v | 0) > 1) (dst.patterns[p][st] || []).forEach(e => { o[e] = Math.min(4, v | 0); }); return o; }) : Array.from({ length: 16 }, () => ({})));
  });

  return nextTransport;
}
