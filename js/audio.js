import { OSC_TYPES, PITCH_PATTERNS, PITCH_RATES } from "./state.js";

const foldCache = {};
export function foldCurve(a) {
  const k = Math.round(a * 20);
  if (!foldCache[k]) {
    const n = 1024, c = new Float32Array(n), g = 1 + (k / 20) * 7;
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.sin(x * g * Math.PI / 2); }
    foldCache[k] = c;
  }
  return foldCache[k];
}

function makeSoftClipCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 1.35) / Math.tanh(1.35);
  }
  return c;
}

export function createAudioEngine({
  tracks, activeVoices, getBpm, getPitchBend, getActivePage, getActiveTrack,
  getJoyY, isAudible, flashPad, initializeMIDI
}) {
  let ctx = null, masterGain = null, perfHP = null, perfLP = null;
  let delayNode = null, delayFb = null, destStream = null, noiseBuf = null;
  const trkFilters = [], trkDlySends = [];

  function syncTrackChannel(i) {
    if (!ctx || !trkFilters[i]) return;
    const t = tracks[i], now = ctx.currentTime;
    const cutAmt = Math.max(120, Math.min(12000, t.cut));
    trkFilters[i].frequency.setTargetAtTime(cutAmt, now, 0.008);
    trkFilters[i].Q.setTargetAtTime(t.res, now, 0.008);
    trkDlySends[i].gain.setTargetAtTime(t.dly, now, 0.008);
  }

  function initAudio() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    try {
      ctx = new AudioCtx({ latencyHint: "interactive", sampleRate: 48000 });
    } catch (e) {
      ctx = new AudioCtx({ latencyHint: "interactive" });
    }
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    masterGain = ctx.createGain(); masterGain.gain.value = 0.85;
    // Zero-latency analog-style soft limiter (replaces DynamicsCompressorNode's 6ms lookahead delay)
    const limiter = ctx.createWaveShaper();
    limiter.curve = makeSoftClipCurve();
    limiter.oversample = "none";

    delayNode = ctx.createDelay(1.0); delayNode.delayTime.value = 0.26;
    delayFb = ctx.createGain(); delayFb.gain.value = 0.35;
    delayNode.connect(delayFb); delayFb.connect(delayNode);

    // Persistent per-track filters & delay sends (eliminates per-note BiquadFilter allocation)
    for (let i = 0; i < 4; i++) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = tracks[i].cut;
      f.Q.value = tracks[i].res;
      const d = ctx.createGain();
      d.gain.value = tracks[i].dly;
      f.connect(masterGain);
      f.connect(d);
      d.connect(delayNode);
      trkFilters[i] = f;
      trkDlySends[i] = d;
    }

    // Keep Android AAudio Fast-Path thread awake with inaudible DC/sub-zero carrier
    const keepAlive = ctx.createOscillator();
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0.00001;
    keepAlive.frequency.value = 20;
    keepAlive.connect(silentGain);
    silentGain.connect(ctx.destination);
    keepAlive.start();

    perfHP = ctx.createBiquadFilter(); perfHP.type = "highpass"; perfHP.frequency.value = 20; perfHP.Q.value = 1;
    perfLP = ctx.createBiquadFilter(); perfLP.type = "lowpass"; perfLP.frequency.value = 20000; perfLP.Q.value = 1;
    masterGain.connect(perfHP); delayNode.connect(perfHP); perfHP.connect(perfLP); perfLP.connect(limiter);
    limiter.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) {
      destStream = ctx.createMediaStreamDestination();
      limiter.connect(destStream);
    }
    initializeMIDI();
  }

  function applyPerfFilter() {
    if (!ctx || !perfHP) return;
    const now = ctx.currentTime;
    perfHP.frequency.setTargetAtTime(getJoyY() > 0 ? 20 * Math.pow(250, getJoyY()) : 20, now, 0.02);
    perfLP.frequency.setTargetAtTime(getJoyY() < 0 ? 20000 * Math.pow(0.01, -getJoyY()) : 20000, now, 0.02);
  }

  function bendLive() {
    activeVoices.forEach(v => v.bend && v.bend());
  }

  /* ===== Motore FM Zero-Latency su bus traccia pre-allocato ===== */
  function startVoice(tIdx, note, vel = 0.85, autoGateSec = null, when = null) {
    if (!ctx) initAudio();
    else if (ctx.state === "suspended") ctx.resume();
    const t = tracks[tIdx];
    if (!isAudible(tIdx)) return null;
    const now = when !== null ? Math.max(ctx.currentTime, when) : ctx.currentTime;
    let freq = 440 * Math.pow(2, (note + getPitchBend() - 69) / 12);
    const cwI = Math.round(t.cw), pe = Math.pow(2, (t.pe || 0) / 12);
    const trkOut = trkFilters[tIdx];

    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const modGain = ctx.createGain(), env = ctx.createGain();
    const oscs = [car, mod];

    const getCycleInfo = () => {
      const pCount = Math.round(t.psteps || 1);
      const patIntervals = PITCH_PATTERNS[Math.round(t.pscale || 0)].steps;
      const rateDiv = PITCH_RATES[Math.round(t.prate !== undefined ? t.prate : 3)].div;
      const stepDurSec = (60 / getBpm()) / rateDiv;
      const glideSec = Math.min(stepDurSec * 0.85, t.pglide || 0);
      const pMode = Math.round(t.ploop !== undefined ? t.ploop : 1); // 0=1-SHOT, 1=LOOP, 2=PING-PONG
      const pOffset = Math.round(t.ptrans || 0);
      let cycle = [0];
      if (pCount > 1) {
        const baseSeq = patIntervals.slice(0, pCount).map(st => st + pOffset);
        cycle = (pMode === 2 && baseSeq.length > 2)
          ? [...baseSeq, ...baseSeq.slice(1, -1).reverse()]
          : baseSeq;
      }
      return { pCount, stepDurSec, glideSec, pMode, cycle };
    };

    const initInfo = getCycleInfo();

    // Track all pitch-modulated oscillators with their harmonic multiplier (1 for carrier, ratio for mod, 0.5 for sub, etc.)
    const pitchTargets = [];
    const registerPitchOsc = (o, mult) => {
      pitchTargets.push({ o, mult });
      const f0 = freq * mult * Math.pow(2, initInfo.cycle[0] / 12);
      o.frequency.setValueAtTime(f0 * pe, now);
      if (pe !== 1) o.frequency.exponentialRampToValueAtTime(f0, now + Math.min(0.09, initInfo.stepDurSec * 0.8));
    };

    car.type = OSC_TYPES[cwI]; mod.type = OSC_TYPES[Math.round(t.mw)];
    registerPitchOsc(car, 1);
    registerPitchOsc(mod, t.ratio);

    const getModAmt = () => Math.max(1, t.mod * vel);
    let modAmt = getModAmt();
    const modDec = (t.att + t.rel) * (t.mdec || 1);
    modGain.gain.setValueAtTime(modAmt, now);
    modGain.gain.exponentialRampToValueAtTime(1, now + modDec);
    mod.connect(modGain); modGain.connect(car.frequency);

    // Always allocate lightweight live-modulatable nodes so turning ANY knob while holding a note morphs it in real time!
    const postOsc = ctx.createGain();
    postOsc.gain.value = t.det > 0.5 ? 0.6 : 1.0;
    car.connect(postOsc);

    const car2 = ctx.createOscillator();
    car2.type = car.type;
    const car2Gain = ctx.createGain();
    car2Gain.gain.value = t.det > 0.5 ? 1.0 : 0.0;
    registerPitchOsc(car2, Math.pow(2, (t.det || 0) / 1200));
    modGain.connect(car2.frequency);
    car2.connect(car2Gain);
    car2Gain.connect(postOsc);
    oscs.push(car2);

    const ws = ctx.createWaveShaper();
    ws.oversample = "none";
    if (t.fold > 0.02) ws.curve = foldCurve(t.fold);
    postOsc.connect(ws);
    ws.connect(env);

    const sub = ctx.createOscillator(), sg = ctx.createGain();
    registerPitchOsc(sub, 0.5);
    sg.gain.value = t.sub || 0;
    sub.connect(sg);
    sg.connect(env);
    oscs.push(sub);

    let nz = null, ng = null;
    if (noiseBuf) {
      nz = ctx.createBufferSource(); nz.buffer = noiseBuf; nz.loop = true;
      ng = ctx.createGain(); ng.gain.value = (t.noi || 0) * 0.5;
      nz.connect(ng); ng.connect(env);
    }

    const calcPeak = () => t.vol * vel * (tIdx === 1 ? 0.35 : 0.6) * [1, 0.9, 0.55, 0.5][Math.round(t.cw)];
    const peak = calcPeak();
    env.gain.setValueAtTime(0.001, now);
    env.gain.linearRampToValueAtTime(peak, now + t.att);
    env.connect(trkOut);

    oscs.forEach(o => o.start(now));
    if (nz) nz.start(now);

    // Independent BPM-synced Pitch Articulator (completely decoupled from beat bars/steps; repeats infinitely while held)
    let released = false, pitchLoopTimer = null, stepCounter = 1;
    let nextStepTime = now + initInfo.stepDurSec;

    const updatePitchCursor = (idxInCycle, totalInCycle) => {
      if (getActivePage() !== 2 || getActiveTrack() !== tIdx) return;
      const curEl = document.getElementById("pitchCursor");
      if (!curEl) return;
      if (released || totalInCycle <= 1) {
        curEl.setAttribute("opacity", "0");
        return;
      }
      const x = ((idxInCycle + 0.5) / totalInCycle) * 220;
      curEl.setAttribute("x1", x.toFixed(1));
      curEl.setAttribute("x2", x.toFixed(1));
      curEl.setAttribute("opacity", "0.9");
    };

    if (initInfo.pCount > 1) {
      updatePitchCursor(0, initInfo.cycle.length);
    }

    const tickPitchArticulator = () => {
      if (released) return;
      const { pCount, stepDurSec, glideSec, pMode, cycle } = getCycleInfo();
      if (pCount <= 1) {
        nextStepTime = ctx.currentTime + 0.02;
        return;
      }

      // Schedule up to 120ms ahead using pure BPM interval (never resets on beat/bar boundaries)
      const lookahead = (autoGateSec !== null ? now + autoGateSec : ctx.currentTime + 0.12);
      while (nextStepTime <= lookahead) {
        if (pMode === 0 && stepCounter >= cycle.length) {
          if (pitchLoopTimer) { clearInterval(pitchLoopTimer); pitchLoopTimer = null; }
          break;
        }

        const tAt = Math.max(ctx.currentTime, nextStepTime);
        const idxInCycle = stepCounter % cycle.length;
        const semi = cycle[idxInCycle];
        const ratioSemis = Math.pow(2, semi / 12);

        for (let i = 0; i < pitchTargets.length; i++) {
          const { o, mult } = pitchTargets[i];
          const fk = freq * mult * ratioSemis;
          if (glideSec > 0.002) {
            o.frequency.setTargetAtTime(fk, tAt, glideSec * 0.35);
          } else {
            o.frequency.setValueAtTime(fk, tAt);
          }
        }

        const pFmAmt = t.pfm || 0;
        if (pFmAmt > 0.02) {
          modAmt = getModAmt();
          const stepPeak = Math.max(1, modAmt * (0.4 + pFmAmt * 0.8));
          modGain.gain.setValueAtTime(stepPeak, tAt);
          modGain.gain.exponentialRampToValueAtTime(1, tAt + Math.min(modDec, stepDurSec * 0.85));
        }

        const uiDelay = Math.max(0, (tAt - ctx.currentTime) * 1000);
        const lenSnap = cycle.length;
        setTimeout(() => updatePitchCursor(idxInCycle, lenSnap), uiDelay);

        stepCounter++;
        nextStepTime += stepDurSec;
      }
    };

    tickPitchArticulator();
    pitchLoopTimer = setInterval(tickPitchArticulator, 25);

    const release = (atTime = ctx.currentTime) => {
      if (released) return;
      released = true;
      if (pitchLoopTimer) { clearInterval(pitchLoopTimer); pitchLoopTimer = null; }
      updatePitchCursor(0, 1);
      const relDur = Math.max(0.03, t.rel);
      env.gain.cancelScheduledValues(atTime);
      env.gain.setValueAtTime(Math.max(0.0005, env.gain.value), atTime);
      env.gain.exponentialRampToValueAtTime(0.0001, atTime + relDur);
      const stopAt = atTime + relDur + 0.04;
      oscs.forEach(o => { try { o.stop(stopAt); } catch (e) {} });
      if (nz) { try { nz.stop(stopAt); } catch (e) {} }
    };

    const syncLive = () => {
      if (released || !ctx) return;
      const tNow = ctx.currentTime;
      const curCw = OSC_TYPES[Math.round(t.cw)];
      const curMw = OSC_TYPES[Math.round(t.mw)];
      if (car.type !== curCw) car.type = curCw;
      if (car2.type !== curCw) car2.type = curCw;
      if (mod.type !== curMw) mod.type = curMw;

      // Update harmonic ratio & detune multipliers on live pitchTargets
      pitchTargets[1].mult = t.ratio;
      pitchTargets[2].mult = Math.pow(2, (t.det || 0) / 1200);
      const curSemi = getCycleInfo().cycle[(stepCounter - 1) % getCycleInfo().cycle.length] || 0;
      const curSemiRatio = Math.pow(2, curSemi / 12);
      for (let i = 0; i < pitchTargets.length; i++) {
        const { o, mult } = pitchTargets[i];
        o.frequency.setTargetAtTime(freq * mult * curSemiRatio, tNow, 0.01);
      }

      // Live FM Mod depth, Fold, Detune mix, Sub, Noise, and Master Volume
      modAmt = getModAmt();
      modGain.gain.cancelScheduledValues(tNow);
      modGain.gain.setTargetAtTime(modAmt, tNow, 0.012);

      postOsc.gain.setTargetAtTime(t.det > 0.5 ? 0.6 : 1.0, tNow, 0.01);
      car2Gain.gain.setTargetAtTime(t.det > 0.5 ? 1.0 : 0.0, tNow, 0.01);
      ws.curve = t.fold > 0.02 ? foldCurve(t.fold) : null;
      sg.gain.setTargetAtTime(t.sub || 0, tNow, 0.01);
      if (ng) ng.gain.setTargetAtTime((t.noi || 0) * 0.5, tNow, 0.01);
      if (tNow > now + t.att) {
        env.gain.cancelScheduledValues(tNow);
        env.gain.setTargetAtTime(Math.max(0.001, calcPeak()), tNow, 0.012);
      }
    };

    const bend = () => {
      if (released || !ctx) return;
      freq = 440 * Math.pow(2, (note + getPitchBend() - 69) / 12);
      const tNow = ctx.currentTime, cyc = getCycleInfo().cycle;
      const cr = Math.pow(2, (cyc[(stepCounter - 1) % cyc.length] || 0) / 12);
      pitchTargets.forEach(({ o, mult }) => o.frequency.setTargetAtTime(freq * mult * cr, tNow, 0.01));
    };

    if (autoGateSec !== null) release(now + autoGateSec);
    return { release, syncLive, bend, note, tIdx };
  }

  /* ===== Drum Kit modulato da K1-K8 ===== */
  function triggerDrum(pIdx, vel = 0.9, when = null) {
    if (!ctx) initAudio();
    else if (ctx.state === "suspended") ctx.resume();
    const t = tracks[3];
    if (!isAudible(3)) return;
    const now = when !== null ? Math.max(ctx.currentTime, when) : ctx.currentTime;
    const delayMs = Math.max(0, (now - ctx.currentTime) * 1000);
    if (delayMs > 4) setTimeout(() => flashPad(pIdx), delayMs);
    else requestAnimationFrame(() => flashPad(pIdx));
    const vol = t.vol * vel;

    // K1 ratio (0.5..8 -> tune 0.5x..2.2x), K2 mod (punch), K3 att (snap), K4 rel (decay scale), K5 cut, K6 res, K7 dly
    const tune = 0.65 + ((t.ratio - 0.5) / 7.5) * 1.55;
    const punch = 1 + (t.mod / 500) * 1.3;
    const decScale = 0.35 + (t.rel / 1.5) * 1.9;
    const cutFreq = t.cut;
    const qVal = t.res;

    const out = masterGain;

    if (pIdx === 0) {
      const dur = 0.32 * decScale;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(145 * tune * punch, now);
      o.frequency.exponentialRampToValueAtTime(36 * tune, now + 0.12 * decScale);
      g.gain.setValueAtTime(vol, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(g); g.connect(out); g.connect(trkDlySends[3]); o.start(now); o.stop(now + dur + 0.03);
    } else if (pIdx === 1 || pIdx === 4) {
      const dur = 0.22 * decScale;
      const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = pIdx === 1 ? "highpass" : "bandpass";
      f.frequency.value = Math.min(10000, (pIdx === 1 ? 900 : 1400) * tune);
      f.Q.value = qVal;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 0.75, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      n.connect(f); f.connect(g); g.connect(out); g.connect(trkDlySends[3]);
      n.start(now); n.stop(now + dur + 0.02);
    } else if (pIdx === 2 || pIdx === 3) {
      const dur = (pIdx === 2 ? 0.06 : 0.28) * decScale;
      const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = Math.min(12000, Math.max(2500, cutFreq));
      f.Q.value = qVal;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 0.45, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      n.connect(f); f.connect(g); g.connect(out); g.connect(trkDlySends[3]);
      n.start(now); n.stop(now + dur + 0.02);
    } else {
      const dur = 0.18 * decScale;
      const bf = (pIdx === 5 ? 110 : (pIdx === 6 ? 175 : 520)) * tune;
      const o = ctx.createOscillator(); o.type = pIdx === 7 ? "triangle" : "sine";
      const g = ctx.createGain();
      o.frequency.setValueAtTime(bf * punch, now);
      o.frequency.exponentialRampToValueAtTime(bf * 0.5, now + 0.14 * decScale);
      g.gain.setValueAtTime(vol * 0.7, now);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(g); g.connect(out); g.connect(trkDlySends[3]); o.start(now); o.stop(now + dur + 0.02);
    }
  }

  return {
    initAudio,
    syncTrackChannel,
    applyPerfFilter,
    bendLive,
    startVoice,
    triggerDrum,
    get ctx() { return ctx; },
    get destStream() { return destStream; }
  };
}
