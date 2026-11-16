export const PPQN = 96;
export const TICKS_PER_BAR = PPQN * 4;
export const TICKS_PER_HALF_BAR = TICKS_PER_BAR / 2;

export const GRID_TICKS = {
  "1/16": 24,
  "1/32": 12,
  "1/16T": 16
};

const GRID_SLOTS = {
  "1/16": 16,
  "1/32": 16,
  "1/16T": 12
};

export function passesProbability(probability) {
  return probability === 100 || Math.random() * 100 < probability;
}

export function swingStepDuration(baseStepSeconds, swing, stepIndex) {
  return baseStepSeconds * (1 + (stepIndex % 2 === 0 ? 1 : -1) * (swing / 100) * 0.66);
}

export function gridToTick(index, scale, page = 0) {
  const slots = GRID_SLOTS[scale];
  if (!Number.isInteger(index) || !slots || index < 0 || index >= slots) return null;
  if (scale === "1/16") return index * GRID_TICKS[scale];
  if (page !== 0 && page !== 1) return null;
  return page * TICKS_PER_HALF_BAR + index * GRID_TICKS[scale];
}

export function tickToGrid(tick, scale) {
  if (!Number.isInteger(tick) || tick < 0 || tick >= TICKS_PER_BAR || !GRID_TICKS[scale]) return null;
  if (scale === "1/16") {
    return {
      page: 0,
      index: Math.floor(tick / GRID_TICKS[scale]),
      subTick: tick % GRID_TICKS[scale]
    };
  }

  const page = Math.floor(tick / TICKS_PER_HALF_BAR);
  const localTick = tick % TICKS_PER_HALF_BAR;
  return {
    page,
    index: Math.floor(localTick / GRID_TICKS[scale]),
    subTick: localTick % GRID_TICKS[scale]
  };
}

export function tickDurationSeconds(tick, bpm, swing) {
  const sixteenth = Math.floor(tick / GRID_TICKS["1/16"]);
  const swingAmount = (swing / 100) * 0.66;
  const stepDuration = (60 / bpm / 4) * (sixteenth % 2 === 0 ? 1 + swingAmount : 1 - swingAmount);
  return stepDuration / GRID_TICKS["1/16"];
}

export function durationSecondsAtTick(startTick, duration, bpm, swing) {
  if (!Number.isInteger(startTick) || startTick < 0 || startTick >= TICKS_PER_BAR ||
      !Number.isInteger(duration) || duration < 1) {
    return 0;
  }
  let seconds = 0;
  for (let offset = 0; offset < duration; offset++) {
    seconds += tickDurationSeconds((startTick + offset) % TICKS_PER_BAR, bpm, swing);
  }
  return seconds;
}

export function durationTicksBetween(startTick, endTick) {
  if (!Number.isInteger(startTick) || startTick < 0 || startTick >= TICKS_PER_BAR ||
      !Number.isInteger(endTick) || endTick < 0 || endTick >= TICKS_PER_BAR) {
    return null;
  }
  return Math.max(1, (endTick - startTick + TICKS_PER_BAR) % TICKS_PER_BAR);
}

export function tickOffsetSeconds(tick, bpm, swing) {
  let seconds = 0;
  for (let i = 0; i < tick; i++) seconds += tickDurationSeconds(i, bpm, swing);
  return seconds;
}

export function timeToTick(time, barStartTime, bpm, swing) {
  const elapsed = Math.max(0, time - barStartTime);
  let closestTick = 0;
  let closestDistance = Infinity;
  for (let tick = 0; tick < TICKS_PER_BAR; tick++) {
    const distance = Math.abs(tickOffsetSeconds(tick, bpm, swing) - elapsed);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestTick = tick;
    }
  }
  return closestTick;
}

export function getChainOrder(tracks, startPattern) {
  const populated = new Set();
  tracks.forEach(track => {
    track.patterns.forEach((events, patternIndex) => {
      if (events.length) populated.add(patternIndex);
    });
  });

  if (!populated.size) return [startPattern];
  return Array.from({ length: 4 }, (_, offset) => (startPattern + offset) % 4)
    .filter(patternIndex => populated.has(patternIndex));
}

export function getNextPattern(order, currentPattern) {
  if (!order.length) return currentPattern;
  if (order.length === 1) return order[0];
  const currentIndex = order.indexOf(currentPattern);
  return order[(currentIndex + 1 + order.length) % order.length];
}

export function createSequencer({ getAudioContext, getBpm, getSwing, onBarStart, onTick }) {
  let playing = false;
  let nextTick = 0;
  let nextNoteTime = 0;
  let barStarted = false;
  let timer = null;

  function schedule() {
    if (!playing) return;
    const context = getAudioContext();
    while (nextNoteTime < context.currentTime + 0.08) {
      const tick = nextTick;
      if (tick === 0) {
        if (barStarted) onBarStart();
        else barStarted = true;
      }
      onTick(tick, nextNoteTime);
      nextNoteTime += tickDurationSeconds(tick, getBpm(), getSwing());
      nextTick = (nextTick + 1) % TICKS_PER_BAR;
    }
    timer = setTimeout(schedule, 20);
  }

  function start() {
    if (playing) return;
    const context = getAudioContext();
    if (!context) throw new Error("AudioContext must be initialized before starting the sequencer.");
    playing = true;
    nextTick = 0;
    barStarted = false;
    nextNoteTime = context.currentTime + 0.005;
    schedule();
  }

  function stop() {
    playing = false;
    clearTimeout(timer);
  }

  function tickAtTime(time) {
    if (!playing) return null;
    let candidateTick = nextTick;
    let candidateTime = nextNoteTime;
    for (let i = 0; i <= TICKS_PER_BAR; i++) {
      if (candidateTime <= time) break;
      const previousTick = (candidateTick + TICKS_PER_BAR - 1) % TICKS_PER_BAR;
      const previousTime = candidateTime - tickDurationSeconds(previousTick, getBpm(), getSwing());
      if (previousTime <= time) {
        if (time - previousTime < candidateTime - time) candidateTick = previousTick;
        break;
      }
      candidateTick = previousTick;
      candidateTime = previousTime;
    }
    return candidateTick;
  }

  return { start, stop, tickAtTime, get isPlaying() { return playing; } };
}
