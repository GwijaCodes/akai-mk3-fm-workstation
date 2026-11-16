export function passesProbability(probability) {
  return probability === 100 || Math.random() * 100 < probability;
}

export function swingStepDuration(baseStepSeconds, swing, stepIndex) {
  return baseStepSeconds * (1 + (stepIndex % 2 === 0 ? 1 : -1) * (swing / 100) * 0.66);
}
