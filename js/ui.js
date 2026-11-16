export function renderSegmentDisplay(element, segments) {
  element.innerHTML = [0, 1, 2].map(() => `<svg viewBox="0 0 12 20">${
    Object.entries(segments).map(([key, [x, y, width, height]]) =>
      `<rect class="seg" data-s="${key}" x="${x}" y="${y}" width="${width}" height="${height}" rx="0.8"/>`
    ).join("")
  }</svg>`).join("");
}
