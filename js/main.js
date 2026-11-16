import {
  DEFAULT_NOTE, KNOB_SPECS, PADS_INFO, PAGES, PITCH_DEFAULTS,
  PITCH_MODES, PITCH_PATTERNS, PITCH_RATES, PITCH_SPECS, PRESETS,
  STORAGE_KEY, TRACK_COLORS, WAVES, WAVE_DEFAULTS, WAVE_SPECS,
  hydrateProjectState, serializeProject as serializeProjectState, tracks
} from "./state.js";
import { createAudioEngine } from "./audio.js";
import {
  createSequencer, getChainOrder, getNextPattern, gridToTick, passesProbability,
  tickDurationSeconds, tickToGrid, GRID_TICKS
} from "./sequencer.js";
import { hasWebMIDIAccess } from "./midi.js";
import { renderSegmentDisplay } from "./ui.js";

(() => {
  let recorder = null, chunks = [];
  let isPlaying = false, isOverdub = false, isRecWav = false;
  let bpm = 115, swing = 0, prob = 100;
  let activeTrk = 0;
  let activePat = 0, queuedPat = null;
  let chainEnabled = false, scaleMode = "1/16", page = 0, pageAutoFollow = true;
  let playTick = 0;
  let pitchBend = 0, joyX = 0, joyY = 0, sustainOn = false;

  const activeVoices = new Map();
  const probabilityCache = new Map();
  const sustainedNotes = new Set();
  const heldPads = new Set();
  const heldNotes = new Set();
  const stepEls = new Array(16);
  const padEls = new Array(8);
  const keyEls = new Map();   // slot 48..72 -> elemento del tasto
  const litKeys = new Map();  // nota suonata -> tasto acceso, cosi' si spegne anche se la finestra si sposta
  let viewBase = 48;          // prima nota mostrata dalla tastiera a schermo
  let isEraseHeld = false, didLiveErase = false, eraseHoldTimer = null;
  let isKnobDragging = false, saveDirty = false;
  let lastDrawnStep = -1;

  let activePage = 0;
  const audio = createAudioEngine({
    tracks, activeVoices,
    getBpm: () => bpm,
    getPitchBend: () => pitchBend,
    getActivePage: () => activePage,
    getActiveTrack: () => activeTrk,
    getJoyY: () => joyY,
    isAudible,
    flashPad,
    initializeMIDI: () => initMIDI()
  });
  const specs = () => PAGES[activePage].specs;

  /* Controllo diretto immediato su cambio pagina (SOUND / WAVE / PITCH) + pickup opzionale solo al cambio traccia */
  const pickup = new Array(8).fill(false), hwPrev = new Array(8).fill(null);
  function currentNorm(i) {
    const sp = specs()[i];
    return Math.max(0, Math.min(1, (tracks[activeTrk][sp.id] - sp.min) / (sp.max - sp.min)));
  }
  function armPickup(usePickup = false) {
    pickup.fill(usePickup);
    if (!usePickup) hwPrev.fill(null);
    updateKnobsUI();
  }
  function hwKnob(i, norm) {
    if (pickup[i]) {
      const cur = currentNorm(i), prev = hwPrev[i];
      const crossed = prev !== null && (prev - cur) * (norm - cur) <= 0;
      hwPrev[i] = norm;
      if (Math.abs(norm - cur) > 0.06 && !crossed) return;
      pickup[i] = false;
    }
    hwPrev[i] = norm;
    setKnobNormalized(i, norm);
  }

  function applyTrackColor(i) {
    const k = TRACK_COLORS[i], st = document.getElementById("stepGrid").style;
    st.setProperty("--c", k.c); st.setProperty("--c-hi", k.hi);
    st.setProperty("--c-glow", k.glow); st.setProperty("--c-soft", k.soft);
  }

  const currentSteps = (tIdx = activeTrk) => tracks[tIdx].patterns[activePat];
  const visibleTick = index => gridToTick(index, scaleMode, page);

  function eventMatches(event, value, trackIndex) {
    return trackIndex === 3 ? event.instrument === value : event.note === value;
  }

  function addPatternEvent(trackIndex, tick, value, velocity = trackIndex === 3 ? 0.9 : 0.8) {
    const events = tracks[trackIndex].patterns[activePat];
    if (trackIndex === 0) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].tick === tick) events.splice(i, 1);
      }
    } else if (events.some(event => event.tick === tick && eventMatches(event, value, trackIndex))) {
      return;
    }

    const event = {
      tick,
      instrument: trackIndex === 3 ? value : "fm",
      velocity
    };
    if (trackIndex !== 3) {
      event.note = value;
      event.gateTicks = GRID_TICKS[scaleMode] * 0.75;
    }
    events.push(event);
    events.sort((a, b) => a.tick - b.tick);
  }

  function eventPassesProbability(event, trackIndex) {
    if (event.ratchetGroup === undefined) return passesProbability(prob);
    const key = `${activePat}:${trackIndex}:${event.ratchetGroup}`;
    if (!probabilityCache.has(key)) probabilityCache.set(key, passesProbability(prob));
    return probabilityCache.get(key);
  }

  /* ===== Persistenza differita (zero-jitter durante Play / drag) ===== */
  let saveDebounce = null;
  function flushSave() {
    if (!saveDirty || isPlaying || isKnobDragging) return;
    saveDirty = false;
    saveProjectLocal();
  }
  function scheduleSave() {
    saveDirty = true;
    clearTimeout(saveDebounce);
    if (isPlaying || isKnobDragging) return;
    saveDebounce = setTimeout(flushSave, 400);
  }

  function serializeProject() {
    return serializeProjectState({
      bpm, swing, prob, activePat, chainEnabled, scaleMode, page, tracks
    });
  }

  function saveProjectLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeProject())); } catch (e) {}
  }

  function hydrateProject(data) {
    const transport = hydrateProjectState(
      data, { bpm, swing, prob, activePat, chainEnabled, scaleMode, page }, tracks
    );
    if (!transport) return false;
    bpm = transport.bpm;
    swing = transport.swing;
    prob = transport.prob;
    activePat = transport.activePat;
    chainEnabled = transport.chainEnabled;
    scaleMode = transport.scaleMode;
    page = scaleMode === "1/16" ? 0 : transport.page;
    pageAutoFollow = true;

    tracks.forEach((dst, i) => {
      if (i < 3) document.getElementById(`pName${i}`).textContent = PRESETS[dst.pIdx % PRESETS.length].name;
      const mb = document.querySelector(`.mute-btn[data-m="${i}"]`);
      mb.classList.toggle("muted", !!dst.muted);
      mb.textContent = dst.muted ? "MUTE" : "ON";
      document.querySelector(`.solo-btn[data-s="${i}"]`).classList.toggle("soloed", !!dst.soloed);
    });

    document.getElementById("bpmSlider").value = bpm;
    document.getElementById("swingSlider").value = swing;
    document.getElementById("probSlider").value = prob;
    for (let i = 0; i < 4; i++) audio.syncTrackChannel(i);
    renderBpm(); renderGroove(); renderPatternBtns(); renderTransportControls(); renderSteps(); armPickup();
    return true;
  }

  function updateJoystickVisual() {
    const dot = document.getElementById("joyDot");
    dot.style.transform = `translate(${joyX * 18}px, ${-joyY * 18}px)`;
  }

  /* Leva a schermo: asse orizzontale = pitch bend (+/-2 semitoni), ritorna al centro al rilascio */
  const joyRing = document.querySelector(".joy-ring");
  function setJoy(x, y) {
    joyX = Math.abs(x) < 0.05 ? 0 : Math.max(-1, Math.min(1, x));
    joyY = Math.abs(y) < 0.05 ? 0 : Math.max(-1, Math.min(1, y));
    pitchBend = joyX * 2;
    updateJoystickVisual(); audio.bendLive(); audio.applyPerfFilter();
  }
  const joyDrag = (e) => {
    const r = joyRing.getBoundingClientRect();
    setJoy((e.clientX - (r.left + r.width / 2)) / 18, -(e.clientY - (r.top + r.height / 2)) / 18);
  };
  joyRing.onpointerdown = (e) => { e.preventDefault(); audio.initAudio(); joyRing.setPointerCapture(e.pointerId); joyDrag(e); };
  joyRing.onpointermove = (e) => { if (joyRing.hasPointerCapture(e.pointerId)) joyDrag(e); };
  joyRing.onpointerup = joyRing.onpointercancel = () => setJoy(0, 0);

  function flashKey(note, on) {
    const k = on ? keyEls.get(note - (viewBase - 48)) : (litKeys.get(note) || keyEls.get(note - (viewBase - 48)));
    if (!k) return;
    k.classList.toggle("pressed", on);
    if (on) litKeys.set(note, k); else litKeys.delete(note);
  }

  /* La tastiera a schermo e' una finestra di 25 tasti che segue le note in arrivo (ottava dell'Akai o del PC) */
  function updateKeyLabels() {
    keyEls.forEach((el, slot) => {
      const n = viewBase + (slot - 48);
      el.textContent = n % 12 === 0 ? "C" + (n / 12 - 1) : "";
    });
  }

  function setViewBase(b) {
    if (b === viewBase) return;
    viewBase = b;
    updateKeyLabels();
    refreshKbHints();
  }

  function ensureNoteVisible(note) {
    let b = viewBase;
    while (note < b) b -= 12;
    while (note > b + 24) b += 12;
    setViewBase(b);
  }

  function flashPad(idx) {
    const p = padEls[idx];
    if (!p) return;
    p.classList.add("lit");
    setTimeout(() => p.classList.remove("lit"), 110);
  }

  function eraseAtTick(tick) {
    const position = tickToGrid(tick, scaleMode);
    if (!position) return;
    const start = gridToTick(position.index, scaleMode, position.page);
    const end = start + GRID_TICKS[scaleMode];
    let changed = false;
    if (heldPads.size > 0) {
      const drumEvents = tracks[3].patterns[activePat];
      const remaining = drumEvents.filter(event =>
        event.tick < start || event.tick >= end || !heldPads.has(event.instrument)
      );
      if (remaining.length !== drumEvents.length) {
        tracks[3].patterns[activePat] = remaining;
        changed = true;
      }
    }
    if (heldNotes.size > 0 && activeTrk < 3) {
      const noteEvents = tracks[activeTrk].patterns[activePat];
      const remaining = noteEvents.filter(event =>
        event.tick < start || event.tick >= end || !heldNotes.has(event.note)
      );
      if (remaining.length !== noteEvents.length) {
        tracks[activeTrk].patterns[activePat] = remaining;
        changed = true;
      }
    }
    if (changed) {
      renderSteps();
      scheduleSave();
    }
  }

  function handleNoteOn(note, vel = 0.85, isPad = false, timestamp = null) {
    const eventTick = isPlaying ? tickForTimestamp(timestamp) : visibleTick(0);
    if (isPad || activeTrk === 3) {
      const rawPad = (note >= 36 && note <= 43) ? (note - 36) : (note % 8);
      const pIdx = rawPad;
      heldPads.add(pIdx); renderSteps();
      tracks[3].last = pIdx;
      if (isEraseHeld && isPlaying) {
        didLiveErase = true;
        flashPad(pIdx);
        eraseAtTick(eventTick ?? playTick);
        return;
      }
      audio.triggerDrum(pIdx, vel);
      if (isPlaying && isOverdub) {
        addPatternEvent(3, eventTick, pIdx, vel);
        renderSteps(); scheduleSave();
      }
    } else {
      ensureNoteVisible(note);
      const n = activeTrk === 0 ? note - 12 : note;
      heldNotes.add(n);
      if (isEraseHeld && isPlaying) {
        didLiveErase = true;
        flashKey(note, true);
        eraseAtTick(eventTick ?? playTick);
        return;
      }
      handleNoteOff(note, true);
      tracks[activeTrk].last = n; heldNotes.add(n); renderSteps();
      const v = audio.startVoice(activeTrk, n, vel, null);
      if (v) activeVoices.set(note, v);
      requestAnimationFrame(() => flashKey(note, true));
      if (isPlaying && isOverdub) {
        addPatternEvent(activeTrk, eventTick, n, vel);
        renderSteps(); scheduleSave();
      }
    }
  }

  function handleNoteOff(note, force = false, isPad = false) {
    if (isPad || activeTrk === 3) {
      const rawPad = (note >= 36 && note <= 43) ? (note - 36) : (note % 8);
      const pIdx = rawPad;
      heldPads.delete(pIdx); renderSteps();
      return;
    }
    const n = activeTrk === 0 ? note - 12 : note;
    heldNotes.delete(n); renderSteps();
    if (!force && sustainOn) {
      if (activeVoices.has(note)) sustainedNotes.add(note);
      flashKey(note, false);
      return;
    }
    flashKey(note, false);
    sustainedNotes.delete(note);
    const v = activeVoices.get(note);
    if (v) { v.release(); activeVoices.delete(note); }
  }

  function setSustain(on) {
    sustainOn = on;
    document.getElementById("susBtn").classList.toggle("on", sustainOn);
    if (!sustainOn) {
      sustainedNotes.forEach(n => handleNoteOff(n, true));
      sustainedNotes.clear();
    }
  }

  const knobsGrid = document.getElementById("knobsGrid");
  for (let idx = 0; idx < 8; idx++) {
    const cell = document.createElement("div");
    cell.className = "knob-cell";
    cell.innerHTML = `
      <div class="knob-name" id="kName${idx}"></div>
      <div class="knob-dial"><div class="knob-cap" id="kCap${idx}"></div></div>
      <div class="knob-val" id="kVal${idx}">0</div>
    `;
    let startY = 0, startNorm = 0;
    cell.onpointerdown = (e) => {
      audio.initAudio(); startY = e.clientY;
      startNorm = currentNorm(idx);
      isKnobDragging = true;
      cell.setPointerCapture(e.pointerId);
    };
    cell.onpointermove = (e) => {
      if (!cell.hasPointerCapture(e.pointerId)) return;
      const delta = (startY - e.clientY) / 110;
      const norm = Math.max(0, Math.min(1, startNorm + delta));
      pickup[idx] = false; setKnobNormalized(idx, norm);
    };
    const endKnobDrag = () => {
      if (!isKnobDragging) return;
      isKnobDragging = false;
      flushSave();
    };
    cell.onpointerup = endKnobDrag;
    cell.onpointercancel = endKnobDrag;
    knobsGrid.appendChild(cell);
  }

  /* ===== Profili MIDI per periferica + MIDI learn =====
     Un profilo (salvato per nome del dispositivo) associa: pads "n<canale>:<nota>" o "c<canale>:<cc>" -> pad 0..7,
     knobs "<cc>" -> manopola K1..K8 (0..7), tabs "<cc>" -> pagina (-1 = pagina successiva).
     Un dispositivo sconosciuto parte vuoto: tutte le note suonano il piano e i CC non assegnati vengono ignorati. */
  const PROFILES_KEY = "akai_midi_profiles_v1";
  let profiles = {};
  try { profiles = JSON.parse(localStorage.getItem(PROFILES_KEY) || "{}"); } catch (e) {}
  let learnMode = false, learnTarget = null, activeDevice = "", midiLabel = "";
  const saveProfiles = () => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); } catch (e) {} };

  function defaultProfile(name) {
    const p = { pads: {}, knobs: {}, tabs: {} };
    if (!/akai|mpk/i.test(name)) return p;
    /* Akai MPK Mini: la fila bassa dei pad (note 36-39) corrisponde alla fila bassa della griglia, quindi ^ 4 */
    for (let ch = 1; ch < 16; ch++) for (let n = 36; n <= 43; n++) p.pads[`n${ch}:${n}`] = (n - 36) ^ 4;
    for (let n = 36; n <= 51; n++) p.pads[`n9:${n}`] = (n <= 43 ? n - 36 : n % 8) ^ 4;
    for (let k = 0; k < 8; k++) { p.knobs[70 + k] = k; p.knobs[1 + k] = k; }
    [9, 10, 11, 12].forEach(cc => { p.knobs[cc] = cc - 5; });
    p.knobs[14] = 6; p.knobs[15] = 7;
    for (let cc = 24; cc <= 27; cc++) p.knobs[cc] = cc - 20;
    [[16, 17, 18, 19], [20, 21, 22, 23], [80, 81, 82, 83], [102, 103, 104, 105]]
      .forEach(row => row.forEach((cc, i) => { p.tabs[cc] = i < 3 ? i : -1; }));
    try {   // migra le vecchie mappe globali, poi le elimina
      Object.assign(p.knobs, JSON.parse(localStorage.getItem("akai_mk3_cc_map") || "{}"));
      Object.assign(p.tabs, JSON.parse(localStorage.getItem("akai_mk3_tab_cc") || "{}"));
      localStorage.removeItem("akai_mk3_cc_map"); localStorage.removeItem("akai_mk3_tab_cc");
    } catch (e) {}
    return p;
  }

  function getProfile(name) {
    if (!profiles[name]) { profiles[name] = defaultProfile(name); saveProfiles(); }
    if (/akai|mpk/i.test(name) && !profiles[name].joyFix) {   // profili salvati prima del fix: libera CC1-4
      [1, 2, 3, 4].forEach(cc => { delete profiles[name].knobs[cc]; });
      profiles[name].joyFix = 1; saveProfiles();
    }
    if (/akai|mpk/i.test(name) && profiles[name].knobMapVersion !== 4) {
      for (let k = 0; k < 8; k++) { profiles[name].knobs[70 + k] = k; profiles[name].knobs[1 + k] = k; }
      [9, 10, 11, 12].forEach(cc => { profiles[name].knobs[cc] = cc - 5; });
      profiles[name].knobs[14] = 6; profiles[name].knobs[15] = 7;
      for (let cc = 24; cc <= 27; cc++) profiles[name].knobs[cc] = cc - 20;
      profiles[name].knobMapVersion = 4;
      saveProfiles();
    }
    return profiles[name];
  }

  /* Leva fisica via CC: profile.joy = { "<cc>": 0 su | 1 giu | 2 sinistra | 3 destra }, assegnata con LEARN toccando la leva a schermo */
  const JOY_NAMES = ["JOY SU", "JOY GIU", "JOY SX", "JOY DX"], joyCCv = [0, 0, 0, 0];
  function joyCC(dir, v) {
    joyCCv[dir] = v;
    if (dir < 2) setJoy(joyX, joyCCv[0] - joyCCv[1]);
    else setJoy(joyCCv[3] - joyCCv[2], joyY);
  }

  const pageBar = document.getElementById("pageBar");
  function selectPage(i) {
    activePage = ((i % PAGES.length) + PAGES.length) % PAGES.length;
    pageBar.querySelectorAll(".page-btn").forEach((x, j) => x.classList.toggle("on", j === activePage));
    armPickup(false);
  }

  PAGES.forEach((pg, i) => {
    const b = document.createElement("button");
    b.className = "page-btn" + (i === 0 ? " on" : ""); b.textContent = pg.name;
    b.onclick = () => selectPage(i);
    pageBar.appendChild(b);
  });

  const learnBtn = document.createElement("button");
  learnBtn.className = "cc-learn-btn";
  learnBtn.textContent = "LEARN";
  learnBtn.title = "MIDI learn: tocca un pad, una manopola o una pagina, poi premi o gira il controllo sulla periferica";
  learnBtn.onclick = () => setLearnMode(!learnMode);
  pageBar.appendChild(learnBtn);

  const resetBtn = document.createElement("button");
  resetBtn.className = "cc-learn-btn";
  resetBtn.textContent = "RESET";
  resetBtn.title = "Ripristina il profilo dell'ultima periferica usata";
  resetBtn.hidden = true;
  resetBtn.onclick = () => {
    if (!activeDevice) return;
    delete profiles[activeDevice]; getProfile(activeDevice);
    document.getElementById("midiStatus").textContent = "PROFILO RIPRISTINATO";
    setTimeout(refreshLearnPill, 900);
  };
  pageBar.appendChild(resetBtn);

  const learnEl = t => t.type === "joy" ? joyRing : t.type === "pad" ? padEls[t.idx]
    : t.type === "knob" ? knobsGrid.querySelectorAll(".knob-cell")[t.idx]
    : pageBar.querySelectorAll(".page-btn")[t.idx];

  function refreshLearnPill() {
    if (!learnMode) return;
    const t = learnTarget;
    const what = !t ? "SCEGLI" : t.type === "pad" ? `PAD ${t.idx + 1}` : t.type === "knob" ? `K${t.idx + 1}` : t.type === "joy" ? JOY_NAMES[t.idx] : PAGES[t.idx].name;
    document.getElementById("midiStatus").textContent = `LEARN · ${what}`;
  }

  function setLearnTarget(t) {
    document.querySelectorAll(".learn-target").forEach(el => el.classList.remove("learn-target"));
    learnTarget = t;
    if (t) learnEl(t).classList.add("learn-target");
    refreshLearnPill();
  }

  function setLearnMode(on) {
    learnMode = on;
    learnBtn.classList.toggle("on", on);
    resetBtn.hidden = !on;
    document.body.classList.toggle("learn-mode", on);
    setLearnTarget(null);
    if (!on) {
      if (midiInputCount > 0) document.getElementById("midiStatus").textContent = midiLabel;
      else syncInputMode();
    }
  }

  /* In learn mode i tocchi su pad, manopole e pagine scelgono il bersaglio invece di suonare */
  document.addEventListener("pointerdown", (e) => {
    if (!learnMode) return;
    const el = e.target.closest(".pad, .knob-cell, .page-btn, .joy-ring");
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const idx = list => Array.prototype.indexOf.call(list, el);
    if (el.classList.contains("joy-ring")) setLearnTarget({ type: "joy", idx: 0 });
    else if (el.classList.contains("pad")) setLearnTarget({ type: "pad", idx: Number(el.dataset.p) });
    else if (el.classList.contains("knob-cell")) setLearnTarget({ type: "knob", idx: idx(knobsGrid.querySelectorAll(".knob-cell")) });
    else setLearnTarget({ type: "tab", idx: idx(pageBar.querySelectorAll(".page-btn")) });
  }, true);

  /* Collega al bersaglio il messaggio in arrivo, poi passa al successivo; il messaggio continua a suonare normalmente */
  function learnMidi(profile, cmd, ch, d1, d2) {
    const t = learnTarget;
    if (!t) return;
    const isNote = cmd === 0x90 && d2 > 0, isCc = cmd === 0xB0 && d2 > 0 && d1 !== 64;
    let map = null, key = null;
    if (t.type === "pad" && (isNote || isCc)) { map = profile.pads; key = `${isNote ? "n" : "c"}${ch}:${d1}`; }
    else if (t.type === "knob" && isCc) { map = profile.knobs; key = String(d1); }
    else if (t.type === "tab" && isCc) { map = profile.tabs; key = String(d1); }
    else if (t.type === "joy" && isCc) { map = profile.joy = profile.joy || {}; key = String(d1); delete profile.knobs[d1]; delete profile.tabs[d1]; }
    if (!map) return;
    map[key] = t.idx;
    saveProfiles();
    const total = t.type === "tab" ? PAGES.length : t.type === "joy" ? 4 : 8;
    setLearnTarget(t.idx + 1 < total ? { type: t.type, idx: t.idx + 1 } : null);
  }

  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (!kbMode && e.key === "1") selectPage(0);
    else if (!kbMode && e.key === "2") selectPage(1);
    else if (!kbMode && e.key === "3") selectPage(2);
    else if (e.key === "Tab") { e.preventDefault(); selectPage((activePage + PAGES.length + (e.shiftKey ? -1 : 1)) % PAGES.length); }
  });

  function setKnobNormalized(kIdx, norm) {
    const spec = specs()[kIdx];
    const trk = tracks[activeTrk];
    let val = spec.min + norm * (spec.max - spec.min);
    if (spec.q) val = Math.round(val / spec.q) * spec.q;
    trk[spec.id] = val;
    audio.syncTrackChannel(activeTrk);
    activeVoices.forEach(v => { if (v.tIdx === activeTrk && v.syncLive) v.syncLive(); });
    updateKnobsUI();
    scheduleSave();
  }

  function renderPitchGraph(trk) {
    const viz = document.getElementById("pitchViz");
    const isPitch = activePage === 2;
    viz.classList.toggle("show", isPitch);
    if (!isPitch) return;

    const W = 220, H = 29, topY = 3;
    const cnt = Math.round(trk.psteps || 1);
    const pat = PITCH_PATTERNS[Math.round(trk.pscale || 0)];
    const modeName = PITCH_MODES[Math.round(trk.ploop !== undefined ? trk.ploop : 1)];
    document.getElementById("pitchLegend").innerHTML =
      `<span>${cnt === 1 ? "1-NOTE" : cnt + " STEPS"}</span><span>${pat.name} · ${modeName}</span>`;

    const seq = pat.steps.slice(0, cnt);
    const stepW = W / seq.length;
    const glideW = Math.min(stepW * 0.65, ((trk.pglide || 0) / 0.08) * (stepW * 0.65));
    const semiToY = st => {
      const clamped = Math.max(-12, Math.min(24, st + (trk.ptrans || 0)));
      return H - ((clamped + 12) / 36) * (H - topY);
    };
    let d = `M 0 ${semiToY(seq[0]).toFixed(1)}`;
    for (let i = 0; i < seq.length; i++) {
      const y = semiToY(seq[i]).toFixed(1);
      const xEnd = ((i + 1) * stepW).toFixed(1);
      if (i === 0) {
        d += ` L ${xEnd} ${y}`;
      } else {
        const xStart = (i * stepW).toFixed(1);
        const xGlide = (i * stepW + glideW).toFixed(1);
        d += ` L ${xStart} ${y} L ${xGlide} ${y} L ${xEnd} ${y}`;
      }
    }
    document.getElementById("pitchStepPath").setAttribute("d", d + ` L ${W} ${H} L 0 ${H} Z`);
    const zeroY = semiToY(0).toFixed(1);
    document.getElementById("pitchRefPath").setAttribute("d", `M 0 ${zeroY} L ${W} ${zeroY}`);
  }

  function updateKnobsUI() {
    const trk = tracks[activeTrk];
    const isDrum = activeTrk === 3 && activePage === 0;
    specs().forEach((spec, idx) => {
      const val = trk[spec.id];
      const norm = Math.max(0, Math.min(1, (val - spec.min) / (spec.max - spec.min)));
      const deg = -135 + norm * 270;
      document.getElementById(`kCap${idx}`).style.transform = `rotate(${deg}deg)`;
      document.getElementById(`kVal${idx}`).textContent = spec.fmt(val);
      document.getElementById(`kName${idx}`).textContent = (isDrum && spec.dLabel) ? spec.dLabel : spec.label;
    });
    renderPitchGraph(trk);
  }

  const padsGrid = document.getElementById("padsGrid");
  PADS_INFO.forEach((p, idx) => {
    const el = document.createElement("div");
    el.className = "pad"; el.dataset.p = idx;
    el.setAttribute("aria-label", p.name);
    el.onpointerdown = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      handleNoteOn(36 + idx, 0.9, true);
    };
    const relPad = () => handleNoteOff(36 + idx, true, true);
    el.onpointerup = relPad;
    el.onpointercancel = relPad;
    padEls[idx] = el;
    padsGrid.appendChild(el);
  });

  const keysWrap = document.getElementById("keysWrap");
  const blackNotes = [1, 3, 6, 8, 10];
  for (let n = 48; n <= 72; n++) {
    const isBlack = blackNotes.indexOf(n % 12) !== -1;
    const k = document.createElement("div");
    k.className = "key" + (isBlack ? " black" : "");
    k.dataset.n = n;
    if (n === 48) k.textContent = "C3";
    if (n === 60) k.textContent = "C4";
    if (n === 72) k.textContent = "C5";
    let sounding = null;   // nota effettivamente premuta, anche se la finestra si sposta
    k.onpointerdown = (e) => {
      e.preventDefault();
      k.setPointerCapture(e.pointerId);
      sounding = n + (viewBase - 48);
      handleNoteOn(sounding, 0.85, false);
    };
    const relKey = () => { if (sounding !== null) { handleNoteOff(sounding, false); sounding = null; } };
    k.onpointerup = relKey;
    k.onpointercancel = relKey;
    keyEls.set(n, k);
    keysWrap.appendChild(k);
  }

  const stepGrid = document.getElementById("stepGrid");
  for (let g = 0; g < 4; g++) {
    const grp = document.createElement("div");
    grp.className = "step-group";
    stepGrid.appendChild(grp);
    for (let j = 0; j < 4; j++) {
      const i = g * 4 + j;
      const s = document.createElement("div");
      s.className = "step"; s.textContent = i + 1;
      const subLed = document.createElement("i");
      subLed.className = "step-sub-led";
      s.appendChild(subLed);
      let lpTimer = null, lpFired = false;
      const cycleRatchet = () => {
        const start = visibleTick(i);
        if (start === null) return;
        const end = start + GRID_TICKS[scaleMode];
        const t = tracks[activeTrk];
        const slotEvents = t.patterns[activePat].filter(event => event.tick >= start && event.tick < end);
        const focus = focusElem();
        let values = focus !== null ? [focus] : [...new Set(slotEvents.map(event =>
          activeTrk === 3 ? event.instrument : event.note
        ))];
        if (!values.length) values = [t.last !== undefined ? t.last : DEFAULT_NOTE[activeTrk]];
        const sharedCount = Math.max(
          1,
          ...values.map(value => slotEvents.filter(event => eventMatches(event, value, activeTrk)).length)
        ) % 4 + 1;

        values.forEach(value => {
          const matching = slotEvents.filter(event => eventMatches(event, value, activeTrk));
          const count = focus === null ? sharedCount : (matching.length ? matching.length % 4 + 1 : 2);
          t.patterns[activePat] = t.patterns[activePat].filter(event =>
            event.tick < start || event.tick >= end || !eventMatches(event, value, activeTrk)
          );
          for (let hit = 0; hit < count; hit++) {
            const event = {
              tick: start + Math.round((GRID_TICKS[scaleMode] * hit) / count),
              instrument: activeTrk === 3 ? value : "fm",
              velocity: activeTrk === 3 ? 0.9 * (1 - 0.1 * hit) : 0.8 * (1 - 0.1 * hit),
              ratchetGroup: `${start}:${value}`
            };
            if (activeTrk !== 3) {
              event.note = value;
              event.gateTicks = (GRID_TICKS[scaleMode] / count) * 0.8;
            }
            t.patterns[activePat].push(event);
          }
        });
        t.patterns[activePat].sort((a, b) => a.tick - b.tick);
        const n = values[0];
        if (activeTrk === 3) audio.triggerDrum(n, 0.9);
        else audio.startVoice(activeTrk, n, 0.8, 0.14);
        renderSteps(); scheduleSave();
      };
      const cancelLp = () => clearTimeout(lpTimer);
      s.onpointerdown = () => { lpFired = false; clearTimeout(lpTimer); lpTimer = setTimeout(() => { lpFired = true; cycleRatchet(); }, 300); };
      s.onpointerup = cancelLp; s.onpointerleave = cancelLp; s.onpointercancel = cancelLp;
      s.oncontextmenu = e => e.preventDefault();
      s.onclick = () => {
        if (lpFired) { lpFired = false; return; }
        const start = visibleTick(i);
        if (start === null) return;
        const end = start + GRID_TICKS[scaleMode];
        const f = focusElem();
        const slotEvents = currentSteps(activeTrk).filter(event => event.tick >= start && event.tick < end);
        if (f !== null) {
          const matching = slotEvents.some(event => eventMatches(event, f, activeTrk));
          if (matching) {
            tracks[activeTrk].patterns[activePat] = tracks[activeTrk].patterns[activePat].filter(event =>
              event.tick < start || event.tick >= end || !eventMatches(event, f, activeTrk)
            );
          } else {
            addPatternEvent(activeTrk, start, f);
            if (activeTrk === 3) audio.triggerDrum(f, 0.9);
            else audio.startVoice(activeTrk, f, 0.8, 0.14);
          }
          renderSteps(); scheduleSave(); return;
        }
        if (slotEvents.length) {
          tracks[activeTrk].patterns[activePat] = tracks[activeTrk].patterns[activePat].filter(event =>
            event.tick < start || event.tick >= end
          );
        }
        else {
          const n = tracks[activeTrk].last !== undefined ? tracks[activeTrk].last : DEFAULT_NOTE[activeTrk];
          addPatternEvent(activeTrk, start, n);
          if (activeTrk === 3) audio.triggerDrum(n, 0.9);
          else audio.startVoice(activeTrk, n, 0.8, 0.14);
        }
        renderSteps(); scheduleSave();
      };
      stepEls[i] = s;
      grp.appendChild(s);
    }
  }

  /* Elemento "in primo piano": il pad (DRUMS) o la nota (altre tracce) tenuto premuto in questo momento */
  function focusElem() {
    const set = activeTrk === 3 ? heldPads : heldNotes;
    return set.size ? [...set].pop() : null;
  }

  function renderSteps() {
    const steps = currentSteps(activeTrk);
    const f = focusElem();
    stepGrid.classList.toggle("focus", f !== null);
    for (let i = 0; i < 16; i++) {
      const start = visibleTick(i);
      const visibleEvents = start === null ? [] : steps.filter(event =>
        event.tick >= start && event.tick < start + GRID_TICKS[scaleMode] &&
        (f === null || eventMatches(event, f, activeTrk))
      );
      const on = visibleEvents.length > 0;
      const hasSubHit = scaleMode === "1/16" &&
        steps.some(event =>
          event.tick >= i * 24 + 12 && event.tick < (i + 1) * 24 &&
          (f === null || eventMatches(event, f, activeTrk))
        );
      stepEls[i].classList.toggle("filled", on);
      stepEls[i].classList.toggle("sub-hit", hasSubHit);
      const disabled = scaleMode === "1/16T" && i >= 12;
      stepEls[i].classList.toggle("disabled", disabled);
      stepEls[i].setAttribute("aria-disabled", String(disabled));
      if (visibleEvents.length > 1) stepEls[i].dataset.r = visibleEvents.length; else delete stepEls[i].dataset.r;
    }
  }

  function renderTransportControls() {
    const chainBtn = document.getElementById("chainBtn");
    chainBtn.classList.toggle("on", chainEnabled);
    chainBtn.setAttribute("aria-pressed", String(chainEnabled));
    document.querySelectorAll("[data-scale-led]").forEach(led =>
      led.classList.toggle("on", led.dataset.scaleLed === scaleMode)
    );
    const first = document.getElementById("pageFirstBtn");
    const second = document.getElementById("pageSecondBtn");
    first.classList.toggle("active", page === 0);
    second.classList.toggle("active", page === 1);
    first.setAttribute("aria-pressed", String(page === 0));
    second.setAttribute("aria-pressed", String(page === 1));
    second.disabled = scaleMode === "1/16";
  }

  function renderPatternBtns() {
    document.querySelectorAll(".pat-btn").forEach((b, i) => {
      b.classList.toggle("on", i === activePat && queuedPat !== i);
      b.classList.toggle("queued", i === queuedPat);
    });
  }

  function selectPattern(p) {
    if (isPlaying && p !== activePat) {
      queuedPat = p;
    } else {
      activePat = p; queuedPat = null;
      renderSteps(); scheduleSave();
    }
    renderPatternBtns();
  }

  function setPage(nextPage, manual = true) {
    if (scaleMode === "1/16") {
      page = 0;
      pageAutoFollow = true;
    } else if (manual && nextPage === page) {
      pageAutoFollow = true;
      const position = tickToGrid(playTick, scaleMode);
      if (isPlaying && position) page = position.page;
    } else {
      page = nextPage;
      if (manual) pageAutoFollow = false;
    }
    setPlayheadUI(-1);
    renderTransportControls(); renderSteps();
    scheduleSave();
  }

  document.getElementById("chainBtn").onclick = () => {
    chainEnabled = !chainEnabled;
    renderTransportControls();
    scheduleSave();
  };
  document.getElementById("scaleBtn").onclick = () => {
    const scales = ["1/16", "1/32", "1/16T"];
    scaleMode = scales[(scales.indexOf(scaleMode) + 1) % scales.length];
    page = 0; pageAutoFollow = true;
    setPlayheadUI(-1);
    renderTransportControls(); renderSteps(); scheduleSave();
  };
  document.getElementById("pageFirstBtn").onclick = () => setPage(0);
  document.getElementById("pageSecondBtn").onclick = () => setPage(1);

  document.querySelectorAll(".pat-btn").forEach(b => {
    b.onclick = () => selectPattern(parseInt(b.dataset.pat));
  });

  document.getElementById("copyPatBtn").onclick = () => {
    const nextPat = (activePat + 1) % 4;
    tracks.forEach(t => {
      t.patterns[nextPat] = t.patterns[activePat].map(event => ({ ...event }));
    });
    activePat = nextPat; queuedPat = null;
    renderPatternBtns(); renderSteps(); scheduleSave();
  };

  function selectTrack(i) {
    activeTrk = i;
    document.querySelectorAll(".trk").forEach(c => c.classList.remove("active"));
    document.querySelector(`.trk[data-i="${i}"]`).classList.add("active");
    renderSteps(); armPickup(); applyTrackColor(i);
  }

  function isAudible(i) {
    const anySolo = tracks.some(t => t.soloed);
    return !tracks[i].muted && (!anySolo || !!tracks[i].soloed);
  }

  function toggleSolo(i) {
    tracks[i].soloed = !tracks[i].soloed;
    document.querySelectorAll(".solo-btn").forEach(b =>
      b.classList.toggle("soloed", !!tracks[parseInt(b.dataset.s)].soloed));
    scheduleSave();
  }

  function toggleMute(i) {
    tracks[i].muted = !tracks[i].muted;
    const b = document.querySelector(`.mute-btn[data-m="${i}"]`);
    b.classList.toggle("muted", tracks[i].muted);
    b.textContent = tracks[i].muted ? "MUTE" : "ON";
    scheduleSave();
  }

  function applyPreset(tIdx, pIdx) {
    if (tIdx > 2) return;
    const p = PRESETS[pIdx % PRESETS.length];
    const t = tracks[tIdx];
    t.pIdx = pIdx % PRESETS.length;
    Object.assign(t, WAVE_DEFAULTS, PITCH_DEFAULTS, { ratio: p.ratio, mod: p.mod, att: p.att, rel: p.rel, cut: p.cut, res: p.res, dly: p.dly });
    document.getElementById(`pName${tIdx}`).textContent = p.name;
    audio.syncTrackChannel(tIdx);
    if (activeTrk === tIdx) armPickup();
    scheduleSave();
  }

  const beatLed = document.getElementById("beatLed");
  function blinkBeat() {
    beatLed.classList.add("on");
    setTimeout(() => beatLed.classList.remove("on"), 90);
  }

  /* Display BPM a sette segmenti */
  const SEGMENTS = { a: [2.5, 0, 7, 2], b: [10, 2.5, 2, 7], c: [10, 11.5, 2, 7], d: [2.5, 18, 7, 2], e: [0, 11.5, 2, 7], f: [0, 2.5, 2, 7], g: [2.5, 9, 7, 2] };
  const DIGIT_SEGS = ["abcdef", "bc", "abdeg", "abcdg", "bcfg", "acdfg", "acdefg", "abc", "abcdefg", "abcdfg"];
  const bpmDisplay = document.getElementById("bpmDisplay");
  renderSegmentDisplay(bpmDisplay, SEGMENTS);

  function renderBpm() {
    const str = String(bpm).padStart(3, " ");
    bpmDisplay.querySelectorAll("svg").forEach((svg, i) => {
      const on = str[i] === " " ? "" : DIGIT_SEGS[Number(str[i])];
      svg.querySelectorAll(".seg").forEach(r => r.classList.toggle("on", on.includes(r.dataset.s)));
    });
  }

  function renderGroove() {
    document.getElementById("grooveReadout").textContent = `SW ${swing}% · P ${prob}%`;
  }

  /* Playback events are dispatched from the 96 PPQN clock in sequencer.js. */
  function setPlayheadUI(idx) {
    if (lastDrawnStep >= 0 && lastDrawnStep < 16) stepEls[lastDrawnStep].classList.remove("now");
    if (idx >= 0 && idx < 16) stepEls[idx].classList.add("now");
    lastDrawnStep = idx;
  }

  function tickForTimestamp(timestamp) {
    if (!isPlaying || !audio.ctx) return null;
    const midiTime = Number.isFinite(timestamp) ? timestamp : performance.now();
    const eventTime = audio.ctx.currentTime + (midiTime - performance.now()) / 1000;
    return sequencer.tickAtTime(eventTime);
  }

  function advancePatternAtBar() {
    const previousPattern = activePat;
    if (queuedPat !== null) {
      activePat = queuedPat;
      queuedPat = null;
    } else if (chainEnabled) {
      const order = getChainOrder(tracks, activePat);
      activePat = getNextPattern(order, activePat);
    }
    renderPatternBtns(); renderSteps();
    if (activePat !== previousPattern) scheduleSave();
  }

  function scheduleTick(tick, when) {
    if (tick === 0) probabilityCache.clear();
    if (isEraseHeld && (heldPads.size > 0 || heldNotes.size > 0)) {
      didLiveErase = true;
      eraseAtTick(tick);
    }

    const baseStepSec = 60 / bpm / 4;
    for (let t = 0; t < 3; t++) {
      const trk = tracks[t];
      const pCnt = Math.round(trk.psteps || 1);
      let gateSec = baseStepSec * 0.75;
      if (pCnt > 1) {
        const rateDiv = PITCH_RATES[Math.round(trk.prate !== undefined ? trk.prate : 3)].div;
        const pDur = (60 / bpm) / rateDiv;
        gateSec = Math.max(gateSec, pDur * pCnt * 0.95);
      }
      trk.patterns[activePat].forEach(event => {
        if (event.tick !== tick || !eventPassesProbability(event, t)) return;
        const gridGate = event.gateTicks
          ? tickDurationSeconds(tick, bpm, swing) * event.gateTicks
          : gateSec;
        const eventGate = pCnt > 1 ? Math.max(gridGate, gateSec) : gridGate;
        audio.startVoice(t, event.note, event.velocity, eventGate, when);
      });
    }
    tracks[3].patterns[activePat].forEach(event => {
      if (event.tick === tick && eventPassesProbability(event, 3)) {
        audio.triggerDrum(event.instrument, event.velocity, when);
      }
    });

    const uiDelayMs = Math.max(0, (when - audio.ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!isPlaying) return;
      playTick = tick;
      const position = tickToGrid(tick, scaleMode);
      if (position) {
        if (scaleMode !== "1/16" && pageAutoFollow && page !== position.page) {
          page = position.page;
          renderTransportControls(); renderSteps();
          scheduleSave();
        }
        if (page === position.page) {
          if (position.index !== lastDrawnStep) setPlayheadUI(position.index);
        } else {
          setPlayheadUI(-1);
        }
      }
      if (tick % 96 === 0) blinkBeat();
    }, uiDelayMs);
  }

  const sequencer = createSequencer({
    getAudioContext: () => audio.ctx,
    getBpm: () => bpm,
    getSwing: () => swing,
    onBarStart: advancePatternAtBar,
    onTick: scheduleTick
  });

  document.getElementById("playBtn").onclick = () => {
    audio.initAudio();
    isPlaying = !isPlaying;
    const b = document.getElementById("playBtn");
    b.classList.toggle("playing", isPlaying);
    if (isPlaying) {
      playTick = 0;
      const previousPattern = activePat;
      if (chainEnabled) activePat = getChainOrder(tracks, activePat)[0];
      if (activePat !== previousPattern) scheduleSave();
      renderPatternBtns(); renderSteps();
      sequencer.start();
    } else {
      sequencer.stop();
      if (queuedPat !== null) {
        activePat = queuedPat; queuedPat = null;
        renderPatternBtns(); renderSteps(); scheduleSave();
      }
      setPlayheadUI(-1);
      flushSave();
    }
  };

  document.getElementById("recBtn").onclick = () => {
    isOverdub = !isOverdub;
    document.getElementById("recBtn").classList.toggle("recording", isOverdub);
  };

  const clearBtn = document.getElementById("clearBtn");
  clearBtn.onpointerdown = (e) => {
    e.preventDefault();
    clearBtn.setPointerCapture(e.pointerId);
    isEraseHeld = true;
    didLiveErase = false;
    clearBtn.classList.add("erasing");
    clearTimeout(eraseHoldTimer);
    eraseHoldTimer = setTimeout(() => {
      if (isEraseHeld && isPlaying) didLiveErase = true;
    }, 220);
  };
  const releaseClearBtn = () => {
    if (!isEraseHeld) return;
    clearTimeout(eraseHoldTimer);
    const shouldClearAll = !didLiveErase;
    isEraseHeld = false;
    didLiveErase = false;
    clearBtn.classList.remove("erasing");
    if (shouldClearAll) {
      tracks[activeTrk].patterns[activePat] = [];
      renderSteps(); scheduleSave();
    }
  };
  clearBtn.onpointerup = releaseClearBtn;
  clearBtn.onpointercancel = releaseClearBtn;

  document.getElementById("presetBtn").onclick = () => {
    if (activeTrk < 3) applyPreset(activeTrk, tracks[activeTrk].pIdx + 1);
  };

  document.getElementById("susBtn").onclick = () => setSustain(!sustainOn);

  document.getElementById("bpmSlider").oninput = (e) => {
    bpm = parseInt(e.target.value); renderBpm(); scheduleSave();
  };
  document.getElementById("swingSlider").oninput = (e) => {
    swing = parseInt(e.target.value); renderGroove(); scheduleSave();
  };
  document.getElementById("probSlider").oninput = (e) => {
    prob = parseInt(e.target.value); renderGroove(); scheduleSave();
  };

  document.querySelectorAll(".trk").forEach(el => {
    el.onclick = (e) => { if (e.target.tagName !== "BUTTON") selectTrack(parseInt(el.dataset.i)); };
  });
  document.querySelectorAll(".mute-btn").forEach(b => b.onclick = () => toggleMute(parseInt(b.dataset.m)));
  document.querySelectorAll(".solo-btn").forEach(b => b.onclick = () => toggleSolo(parseInt(b.dataset.s)));

  /* Export / Import JSON */
  document.getElementById("exportJsonBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(serializeProject(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `mpk-fm4-${Date.now()}.json`;
    a.click();
  };

  const jsonInput = document.getElementById("jsonFileInput");
  document.getElementById("importJsonBtn").onclick = () => jsonInput.click();
  jsonInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (hydrateProject(JSON.parse(reader.result))) saveProjectLocal();
      } catch (err) {}
      jsonInput.value = "";
    };
    reader.readAsText(file);
  };

  document.getElementById("wavBtn").onclick = () => {
    audio.initAudio();
    if (!audio.destStream || typeof MediaRecorder === "undefined") return;
    const b = document.getElementById("wavBtn");
    const lbl = b.querySelector("span");
    if (!isRecWav) {
      chunks = []; recorder = new MediaRecorder(audio.destStream.stream);
      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob(chunks, { type: "audio/webm" }));
        a.download = `akai-fm4-${Date.now()}.webm`; a.click();
      };
      recorder.start(); isRecWav = true; b.classList.add("recording"); lbl.textContent = "STOP";
    } else {
      recorder.stop(); isRecWav = false; b.classList.remove("recording"); lbl.textContent = "AUDIO";
    }
  };

  async function initMIDI() {
    const pill = document.getElementById("midiStatus");
    if (!hasWebMIDIAccess()) { midiReady = true; pill.textContent = "TOUCH MODE"; syncInputMode(); return; }
    try {
      const midi = await navigator.requestMIDIAccess();
      const bind = () => {
        let ok = false, count = 0, firstName = "";
        for (let input of midi.inputs.values()) {
          ok = true; count++; firstName = firstName || input.name; activeDevice = activeDevice || input.name;
          input.onmidimessage = (m) => {
            const [st, d1, d2] = m.data;
            if (st >= 0xf0) return;   // clock e messaggi di sistema
            const cmd = st & 0xf0, ch = st & 0x0f;
            activeDevice = input.name;
            const profile = getProfile(input.name);
            if (learnMode) learnMidi(profile, cmd, ch, d1, d2);

            if (cmd === 0x90 || cmd === 0x80) {
              const on = cmd === 0x90 && d2 > 0;
              const pad = profile.pads[`n${ch}:${d1}`];
              const note = pad !== undefined ? 36 + pad : d1;
              if (on) handleNoteOn(note, d2 / 127, pad !== undefined, m.timeStamp);
              else handleNoteOff(note, false, pad !== undefined);
            } else if (cmd === 0xE0) {
              const raw = ((d2 << 7) | d1) - 8192;
              joyX = raw / 8192;
              pitchBend = joyX * 2; audio.bendLive();
              updateJoystickVisual();
            } else if (cmd === 0xB0) {
              if (d1 === 64) { setSustain(d2 >= 64); return; }
              const jd = profile.joy && profile.joy[d1];
              if (jd !== undefined) { joyCC(jd, d2 / 127); return; }
              const pad = profile.pads[`c${ch}:${d1}`];
              if (pad !== undefined) {
                if (d2 > 0) handleNoteOn(36 + pad, d2 / 127, true, m.timeStamp);
                else handleNoteOff(36 + pad, false, true);
                return;
              }
              const tab = profile.tabs[d1];
              if (tab !== undefined) {
                if (d2 > 0 && !learnMode) selectPage(tab === -1 ? (activePage + 1) % PAGES.length : tab);
                return;
              }
              const k = profile.knobs[d1];
              if (k !== undefined) hwKnob(k, d2 / 127);
            } else if (cmd === 0xC0) {
              applyPreset(activeTrk, d1);
            }
          };
        }
        if (!ok) { pill.textContent = "USB READY"; pill.classList.remove("online"); }
        else {
          midiLabel = count === 1 ? firstName.toUpperCase().slice(0, 22) : `${count} MIDI IN`;
          if (!learnMode) { pill.textContent = midiLabel; pill.classList.add("online"); }
        }
        midiInputCount = count; midiReady = true; syncInputMode();
      };
      bind(); midi.onstatechange = bind;
    } catch (e) { midiReady = true; pill.textContent = "TOUCH MODE"; syncInputMode(); }
  }

  /* ===== Tastiera del computer: attiva su desktop quando non c'e' nessun controller MIDI =====
     Piano (25 tasti, uno a uno): fila Z = C3..B3 con i neri su S D G H J, fila Q = C4..C5 con i neri sui numeri 2 3 5 6 7
     Pad: 9 0 - = (fila alta) e O P [ ] (fila bassa)   |   Tracce: K L ; '
     Space = play/stop, ` = overdub, Invio (tenuto) = sustain, , . = ottava -/+, / = pattern successivo
     Frecce sinistra/destra = manopola, su/giu = valore (Shift = fine), Tab = pagina (Shift+Tab = indietro)
     Si usa e.code, quindi vale per ogni layout. */
  const KB_NOTES = {
    KeyZ: [0, "Z"], KeyS: [1, "S"], KeyX: [2, "X"], KeyD: [3, "D"], KeyC: [4, "C"], KeyV: [5, "V"],
    KeyG: [6, "G"], KeyB: [7, "B"], KeyH: [8, "H"], KeyN: [9, "N"], KeyJ: [10, "J"], KeyM: [11, "M"],
    KeyQ: [12, "Q"], Digit2: [13, "2"], KeyW: [14, "W"], Digit3: [15, "3"], KeyE: [16, "E"], KeyR: [17, "R"],
    Digit5: [18, "5"], KeyT: [19, "T"], Digit6: [20, "6"], KeyY: [21, "Y"], Digit7: [22, "7"], KeyU: [23, "U"], KeyI: [24, "I"]
  };
  const KB_PADS = {
    Digit9: [0, "9"], Digit0: [1, "0"], Minus: [2, "-"], Equal: [3, "="],
    KeyO: [4, "O"], KeyP: [5, "P"], BracketLeft: [6, "["], BracketRight: [7, "]"]
  };
  const KB_TRACKS = { KeyK: 0, KeyL: 1, Semicolon: 2, Quote: 3 };
  const KB_ACTIONS = ["Space", "Backquote", "Enter", "Comma", "Period", "Slash", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

  let kbMode = false, kbBase = 48, kbKnob = 0, kbSustain = false, kbToastTimer = null, midiInputCount = 0, midiReady = false;
  const kbDown = new Map();   // code -> { pad, note }, serve a rilasciare la nota giusta anche se cambia l'ottava

  function kbToast(msg) {
    if (learnMode) return;
    const pill = document.getElementById("midiStatus");
    pill.textContent = msg;
    clearTimeout(kbToastTimer);
    kbToastTimer = setTimeout(() => { if (kbMode && !learnMode) pill.textContent = "PC KEYBOARD"; }, 900);
  }

  function refreshKbHints() {
    keyEls.forEach(el => delete el.dataset.kb);
    padEls.forEach(el => delete el.dataset.kb);
    knobsGrid.querySelectorAll(".knob-cell").forEach((c, i) => c.classList.toggle("kb-sel", kbMode && i === kbKnob));
    if (!kbMode) return;
    Object.values(KB_NOTES).forEach(([off, label]) => { const el = keyEls.get(kbBase + off - (viewBase - 48)); if (el) el.dataset.kb = label; });
    Object.values(KB_PADS).forEach(([idx, label]) => { if (padEls[idx]) padEls[idx].dataset.kb = label; });
  }

  function releaseKbAll() {
    kbDown.forEach(h => h.pad ? handleNoteOff(h.note, true, true) : handleNoteOff(h.note, false));
    kbDown.clear();
    if (kbSustain) { kbSustain = false; setSustain(false); }
  }

  function syncInputMode() {
    const desktop = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const next = desktop && midiReady && midiInputCount === 0;
    if (!next) releaseKbAll();
    kbMode = next;
    document.body.classList.toggle("kb-mode", kbMode);
    if (kbMode && !learnMode) {
      const pill = document.getElementById("midiStatus");
      pill.textContent = "PC KEYBOARD"; pill.classList.add("online");
    }
    refreshKbHints();
  }

  function shiftOctave(d) {
    const next = Math.max(24, Math.min(84, kbBase + d));
    if (next === kbBase) return;
    kbBase = next; setViewBase(kbBase); refreshKbHints();
    kbToast(`OCT C${kbBase / 12 - 1}`);
  }

  function moveKbKnob(d) { kbKnob = (kbKnob + d + 8) % 8; refreshKbHints(); }

  function nudgeKbKnob(dir, fine) {
    const sp = specs()[kbKnob];
    const step = Math.max(fine ? 0.01 : 0.05, sp.q ? sp.q / (sp.max - sp.min) : 0);
    pickup[kbKnob] = false;
    setKnobNormalized(kbKnob, Math.max(0, Math.min(1, currentNorm(kbKnob) + dir * step)));
  }

  const isTypingTarget = el => !!(el && el.matches && el.matches('input:not([type="range"]), textarea, select, [contenteditable]'));

  window.addEventListener("keydown", (e) => {
    if (!kbMode || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
    const code = e.code, note = KB_NOTES[code], pad = KB_PADS[code], trk = KB_TRACKS[code];
    if (!(note || pad || trk !== undefined || KB_ACTIONS.includes(code))) return;
    e.preventDefault();
    const focused = document.activeElement;   // evita che un pulsante col focus reagisca anche a Space/Invio
    if (focused && focused !== document.body && focused.blur) focused.blur();
    audio.initAudio();

    if (note || pad) {
      if (e.repeat || kbDown.has(code)) return;
      const n = note ? kbBase + note[0] : 36 + pad[0];
      kbDown.set(code, { pad: !!pad, note: n });
      handleNoteOn(n, pad ? 0.9 : 0.85, !!pad);
      return;
    }
    if (code === "ArrowUp" || code === "ArrowDown") { nudgeKbKnob(code === "ArrowUp" ? 1 : -1, e.shiftKey); return; }
    if (code === "ArrowLeft" || code === "ArrowRight") { moveKbKnob(code === "ArrowLeft" ? -1 : 1); return; }
    if (e.repeat) return;
    if (trk !== undefined) selectTrack(trk);
    else if (code === "Space") document.getElementById("playBtn").click();
    else if (code === "Backquote") document.getElementById("recBtn").click();
    else if (code === "Comma") shiftOctave(-12);
    else if (code === "Period") shiftOctave(12);
    else if (code === "Enter") { kbSustain = true; setSustain(true); }
    else if (code === "Slash") {
      const b = document.querySelector(`.pat-btn[data-pat="${(activePat + 1) % 4}"]`);
      if (b) b.click();
    }
  });

  window.addEventListener("keyup", (e) => {
    const h = kbDown.get(e.code);
    if (h) {
      kbDown.delete(e.code);
      h.pad ? handleNoteOff(h.note, true, true) : handleNoteOff(h.note, false);
    }
    if (e.code === "Enter" && kbSustain) { kbSustain = false; setSustain(false); }
    if (kbMode && e.code === "Space") e.preventDefault();
  });
  window.addEventListener("blur", releaseKbAll);

  /* Ripristino progetto salvato all'avvio */
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) hydrateProject(JSON.parse(saved));
  } catch (e) {}

  window.addEventListener("visibilitychange", () => { if (document.hidden && saveDirty) saveProjectLocal(); });
  document.body.addEventListener("pointerdown", initAudio, { once: true });
  syncInputMode();
  renderSteps(); updateKnobsUI(); applyTrackColor(0); renderBpm(); renderGroove();
  renderPatternBtns(); renderTransportControls();
})();
