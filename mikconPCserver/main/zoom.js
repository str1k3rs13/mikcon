// Zoom, clamped so it can never collapse the desk layout.
//
// The shared UI's desk layout is @media (min-width:900px) and the window's minWidth is also 900.
// Effective CSS width is contentWidth / zoomFactor, so at minimum width ANY zoom-in drops below 900
// and flips MikconPC to the phone layout — bottom tab bar, two-line rows. That is a real, tested
// layout, but a strange reward for pressing Ctrl+ to read better.

// The familiar browser ladder.
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// Kept separate from window-state's MIN_WIDTH on purpose: that one is how narrow the window may be,
// this one is where the stylesheet changes layout. They share the number 900 today and are free to
// move apart.
export const MIN_CSS_WIDTH = 900;

export function maxFactorFor(contentWidth, minCss = MIN_CSS_WIDTH) {
  const w = Number(contentWidth);
  if (!Number.isFinite(w) || w <= 0) return 1;
  return w / minCss;
}

function nearestStepIndex(factor) {
  const f = Number.isFinite(Number(factor)) ? Number(factor) : 1;
  let best = 0, bestDelta = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - f);
    if (d < bestDelta) { bestDelta = d; best = i; }
  }
  return best;
}

export function nextZoomFactor(current, dir, contentWidth, minCss = MIN_CSS_WIDTH) {
  if (dir === 0) return 1;
  const i = nearestStepIndex(current);
  if (dir < 0) return ZOOM_STEPS[Math.max(i - 1, 0)];
  const next = ZOOM_STEPS[Math.min(i + 1, ZOOM_STEPS.length - 1)];
  // Refuse the step that would cross the breakpoint; stay where we are rather than jumping past it.
  return next <= maxFactorFor(contentWidth, minCss) ? next : ZOOM_STEPS[i];
}

// For the resize path: the largest step at or below both the current factor and the ceiling.
export function clampZoomFactor(current, contentWidth, minCss = MIN_CSS_WIDTH) {
  const max = maxFactorFor(contentWidth, minCss);
  for (let j = nearestStepIndex(current); j >= 0; j--) if (ZOOM_STEPS[j] <= max) return ZOOM_STEPS[j];
  return ZOOM_STEPS[0];
}
