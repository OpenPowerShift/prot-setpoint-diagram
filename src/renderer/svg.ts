import type { Resolved, Constraint } from '../semantics/model.js';
import type { WordName } from '../parser/ast.js';
import { PALETTES, THEMES, buildTicks, valueToPosition, positionToValue } from './theme.js';
import { formatAmps, formatPercent, formatPlain } from '../semantics/units.js';

interface RenderOptions {
  width?: number;
  height?: number;
  fontSize?: number;
}

/**
 * Layout (spec §Layout and §Autorange).
 *
 * The plot is a single horizontal (or vertical) band. Each criterion gets
 * its OWN ROW, vertically distributed so labels don't collide:
 *
 *   top of plot ────────────────────────────────────────
 *     [upper-criteria]  labels on RIGHT, leaders pull left
 *   middle of plot ────────────────────────────────────
 *     [lower-criteria]  labels on LEFT, leaders pull right
 *   bottom of plot ─────────────────────────────────────
 *
 * For lower criteria, the label sits to the LEFT of the markers, with a
 * pale leader line connecting the label to the dot pair. For upper
 * criteria, the label sits to the RIGHT. When a label would collide with
 * a marker, it is moved to the appropriate gutter and a leader line
 * extends to the marker.
 *
 * The status callout sits BELOW the axis, not in the title block.
 * Selected value is a vertical orange line spanning the full plot with
 * an "SELECTED X kA" annotation near the top.
 */
export function renderSvg(model: Resolved, opts: RenderOptions = {}): string {
  const fs = opts.fontSize ?? 14;
  const o = model.choices.orientation;
  /* Default canvas size is content-driven rather than a fixed 1400×540 —
   * a 2-criterion diagram doesn't need the same canvas as a 6-criterion
   * one, and vertical orientation needs a narrow, tall canvas (see the
   * spec's own vertical reference figure), not a wide, short one. */
  const { width: defaultWidth, height: defaultHeight } = defaultCanvasSize(model, o, fs);
  const declareWidth = opts.width ?? defaultWidth;
  const declareHeight = opts.height ?? defaultHeight;
  const theme = THEMES[model.choices.theme] ?? THEMES.print!;
  const palette = PALETTES[model.choices.palette] ?? PALETTES.accessible!;

  /* Spec §Layout: "The plot MUST reserve asymmetric gutters based on
   * measured labels rather than fixed equal margins." Lower-family
   * labels sit in the left gutter, upper-family in the right, so each
   * side is measured against ITS OWN family — a symmetric gutter (the
   * previous approach) let one long label eat both sides and crush the
   * calibrated axis between them. */
  const { left: leftGutter, right: rightGutter } = horizontalGutters(model, fs);

  const padL = PAD_L;
  const padR = PAD_R;
  const padT = 60;  /* title + selected label space */
  const padB = 80;  /* axis + status callout */

  const plotW = declareWidth - padL - padR;
  const plotH = declareHeight - padB - padT;

  const axis = model.axis;
  const ticks = axis.scale === 'indicative' ? collectIndicativeValues(model) : buildTicks(axis.minimum, axis.maximum, axis.scale);

  /* Place each constraint on its own row. The two families occupy
   * opposite halves of the plot — lower in the lower half, upper in the
   * upper half — but the spec allows for interleaving; the practical
   * outcome is that they never collide. */
  const rows = layoutRows(model.constraints, o, plotW, plotH, padT);

  /* Background zones — same on every view that requests them. */
  const zoneParts: string[] = [];
  if (model.choices.zones !== 'off') {
    for (const z of zones(model, axis, padL, padT, plotW, plotH, o, palette, leftGutter, rightGutter)) {
      zoneParts.push(z);
    }
  }

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${declareWidth} ${declareHeight}" data-orientation="${o}" data-status="${model.status}" data-title="${escapeAttr(model.title)}" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${declareWidth}" height="${declareHeight}" fill="${theme.background}"/>`);

  /* Title + selected label above the plot */
  parts.push(header(model, declareWidth, padT, fs, theme, palette));

  /* Spec §Scale: indicative scale MUST show this notice — the axis is
   * ordered but not calibrated to value. */
  if (axis.scale === 'indicative') {
    parts.push(`<text data-role="indicative-notice" x="${declareWidth - padR}" y="${padT - 12}" font-size="${fs - 2}" font-weight="700" text-anchor="end" letter-spacing="0.3" fill="${theme.callout}">INDICATIVE SPACING — NOT TO SCALE</text>`);
  }

  /* Background zones inside the plot */
  for (const z of zoneParts) parts.push(z);

  /* Frame: vertical lines at the gutters, horizontal axis at the bottom */
  parts.push(frame(model, axis, padL, padR, padT, plotW, plotH, o, ticks, fs, theme, leftGutter, rightGutter));

  /* Grid lines */
  parts.push(gridLines(model, axis, padL, padT, plotW, plotH, o, ticks, theme, leftGutter, rightGutter));

  const hasSelection = Number.isFinite(model.selection.value_A);
  const selY = o === 'vertical' && hasSelection ? verticalY(model, axis, model.selection.value_A / 1000, padT, plotH) : null;

  /* Vertical only: criterion values can sit numerically close together,
   * which on a calibrated axis crowds their labels against each other
   * and against the SELECTED/status text anchored to the line. Declutter
   * label Y positions once, up front, so drawConstraint can offset each
   * label (and its leader) from the marker's true position. */
  let vLabelY: number[] | null = null;
  if (o === 'vertical') {
    const naturalY = model.constraints.map((c) => verticalY(model, axis, c.value_A / 1000, padT, plotH));
    const obstacle = selY !== null ? { top: selY - 26, bottom: selY + 20 + fs + 3 } : null;
    vLabelY = declutterVerticalLabels(naturalY, obstacle, fs + 5);
  }

  /* Constraints (each on its own row) */
  for (let i = 0; i < model.constraints.length; i++) {
    const c = model.constraints[i]!;
    const row = rows[i]!;
    parts.push(drawConstraint(c, row, model, axis, padL, padT, plotW, plotH, o, fs, theme, palette, leftGutter, rightGutter, vLabelY ? vLabelY[i]! : null));
  }

  /* Selected — orange line + selected label. The status text is anchored
   * to it (spec's own reference figures place both directly against the
   * selected line, not at a fixed canvas position) rather than centred
   * on the whole canvas. */
  if (hasSelection) {
    parts.push(drawSelection(model, axis, padL, padT, plotW, plotH, o, fs, palette, leftGutter, rightGutter));
  }

  if (o === 'vertical' && selY !== null) {
    parts.push(verticalStatusText(model, selY, padL, fs, theme, palette));
  } else {
    let anchorX = declareWidth / 2;
    if (o === 'horizontal' && hasSelection) {
      const xL = padL + leftGutter;
      const xR = padL + plotW - rightGutter;
      const selX = xL + scalePos(model, axis, model.selection.value_A / 1000, xR - xL);
      /* Clamp so the pill/text never runs off the canvas edge — the
       * detail line's length varies a lot (a plain percentage vs. a
       * conflict line naming two criteria), so measure it rather than
       * assuming a fixed half-width. */
      const { detail } = statusText(model, palette);
      const halfWidth = Math.max(140, measureLabel(detail, fs - 1) / 2 + 20);
      anchorX = Math.min(Math.max(selX, padL + halfWidth), declareWidth - padR - halfWidth);
    }
    parts.push(statusCallout(model, anchorX, declareHeight, fs, theme, palette));
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

/* ============================================================ pieces */

const PAD_L = 40;
const PAD_R = 40;
/** Narrowest calibrated axis we will ever render — the canvas grows
 * rather than let long labels squeeze the axis below this. */
const MIN_AXIS_WIDTH = 400;
/**
 * Vertical distance between criterion rows of the same family. Each row
 * draws its value text above the marker and its margin text below, so
 * the pitch must clear both — at the previous 22px they overlapped as
 * soon as a family had three or more criteria.
 */
const ROW_PITCH = 42;

/**
 * Asymmetric label gutters (spec §Layout). Lower-family ("below")
 * labels are drawn in the left gutter and upper-family ("above") in the
 * right, so each side is sized from its own family's widest label. A
 * side with no criteria still reserves a little room for the first/last
 * axis tick label.
 */
function horizontalGutters(model: Resolved, fs: number): { left: number; right: number } {
  const widest = (dir: 'below' | 'above') =>
    Math.max(0, ...model.constraints.filter((c) => c.direction === dir).map((c) => measureLabel(c.label, fs) + 24));
  return {
    left: Math.max(90, Math.min(widest('below'), 340)),
    right: Math.max(90, Math.min(widest('above'), 340)),
  };
}

/**
 * Vertical-label declutter (spec §Layout: "If a label collides, move it
 * vertically within its row and extend a short pale leader"). Criterion
 * values can sit numerically close together, which — on a calibrated
 * vertical axis — puts their labels within a few pixels of each other
 * and of the SELECTED/status text anchored to the selected line. This
 * pushes each label's TEXT position away from a fixed obstacle (the
 * selected/status block, if any) and from its neighbours, while the
 * marker dot itself stays at the true calibrated position — a leader
 * line bridges the two when they diverge.
 */
function declutterVerticalLabels(naturalY: number[], obstacle: { top: number; bottom: number } | null, minGap: number): number[] {
  const n = naturalY.length;
  const adjusted = new Array<number>(n).fill(0);
  const mid = obstacle ? (obstacle.top + obstacle.bottom) / 2 : 0;
  const order = naturalY.map((_, i) => i).sort((a, b) => naturalY[a]! - naturalY[b]!);
  const aboveIdx = obstacle ? order.filter((i) => naturalY[i]! <= mid) : order;
  const belowIdx = obstacle ? order.filter((i) => naturalY[i]! > mid) : [];

  /* Above the obstacle: walk bottom-up, pushing each label further up
   * only when it would collide with the one below it (or the obstacle). */
  let ceiling = obstacle ? obstacle.top - minGap : Number.POSITIVE_INFINITY;
  for (let k = aboveIdx.length - 1; k >= 0; k--) {
    const i = aboveIdx[k]!;
    const y = Math.min(naturalY[i]!, ceiling);
    adjusted[i] = y;
    ceiling = y - minGap;
  }

  /* Below the obstacle: walk top-down, pushing each label further down
   * only when it would collide with the one above it (or the obstacle). */
  let floor = obstacle ? obstacle.bottom + minGap : Number.NEGATIVE_INFINITY;
  for (const i of belowIdx) {
    const y = Math.max(naturalY[i]!, floor);
    adjusted[i] = y;
    floor = y + minGap;
  }

  return adjusted;
}

/** Content-driven default canvas size — see call site for rationale. */
function defaultCanvasSize(model: Resolved, o: 'horizontal' | 'vertical', fs: number): { width: number; height: number } {
  const n = Math.max(model.constraints.length, 1);
  if (o === 'vertical') {
    /* Width must fit the widest thing that lands in the label column:
     * a criterion's "name · value (margin X%)" text, or the status
     * detail line (which can run long for extreme log-scale ratios). */
    const labelX = verticalLabelX(40);
    const longestCriterion = Math.max(0, ...model.constraints.map((c) => {
      const valueText = formatAmps(c.value_A, c.value_A < 1000 ? 'A' : 'kA');
      const m = marginLabel(c);
      return measureLabel(m ? `${c.label} · ${valueText} (margin ${m})` : `${c.label} · ${valueText}`, fs);
    }));
    let statusW = 0;
    if (Number.isFinite(model.selection.value_A)) {
      statusW = measureLabel(statusText(model, PALETTES.accessible!).detail, fs - 1);
    }
    const width = Math.max(420, labelX + Math.max(longestCriterion, statusW) + 40);
    return { width, height: Math.max(320, 130 + n * 78) };
  }
  const upperCount = model.constraints.filter((c) => c.direction === 'above').length;
  const lowerCount = model.constraints.filter((c) => c.direction === 'below').length;
  const maxFamily = Math.max(upperCount, lowerCount, 1);
  /* Width: gutters are label-driven, so the canvas grows to keep the
   * calibrated axis at least MIN_AXIS_WIDTH rather than squeezing it. */
  const { left, right } = horizontalGutters(model, fs);
  const width = Math.max(760, PAD_L + PAD_R + left + right + MIN_AXIS_WIDTH);
  /* Height: each family stacks in its own half of the plot at ROW_PITCH
   * spacing, and each row needs headroom for its value text (above) and
   * margin text (below). Solve so the taller family fits its half. */
  const halfNeed = (maxFamily - 1) * ROW_PITCH + 40;
  const height = Math.max(280, padTB() + 2 * halfNeed);
  return { width, height };
}

/** Vertical padding the plot does not get to use (title + axis/status). */
function padTB(): number {
  return 60 + 80;
}

/** Layout one row per constraint. Lower family occupies the lower half
 * of the plot, upper family the upper half. Each constraint on its own
 * row, evenly spaced. The vertical selected line spans the full plot
 * height — i.e. the row layout does NOT change where the line draws. */
function layoutRows(constraints: Constraint[], o: 'horizontal' | 'vertical', plotW: number, plotH: number, padT: number): { cx: number; cy: number; labelX: number; labelY: number; labelAnchor: 'start' | 'end'; valueAbove: number; valueBelow: number; marginValueX: number }[] {
  const rows: { cx: number; cy: number; labelX: number; labelY: number; labelAnchor: 'start' | 'end'; valueAbove: number; valueBelow: number; marginValueX: number }[] = [];
  if (o !== 'horizontal') {
    for (let i = 0; i < constraints.length; i++) {
      const c = constraints[i]!;
      const y = padT + ((i + 0.5) / constraints.length) * plotH;
      rows.push({ cx: 0, cy: y, labelX: 0, labelY: 0, labelAnchor: c.direction === 'below' ? 'end' : 'start', valueAbove: 0, valueBelow: 0, marginValueX: 0 });
    }
    return rows;
  }
  /* Horizontal: split lower and upper families and distribute each
   * family into its own half of the plot so the labels never collide.
   * Index by the original constraint position so rows[i] is the row
   * for constraints[i]. */
  const lowerIdx: number[] = [];
  const upperIdx: number[] = [];
  for (let i = 0; i < constraints.length; i++) {
    if (constraints[i]!.direction === 'below') lowerIdx.push(i);
    else upperIdx.push(i);
  }
  const upperTopY = padT + ROW_PITCH * 0.5;
  const lowerTopY = padT + plotH * 0.5;
  for (let k = 0; k < upperIdx.length; k++) {
    const i = upperIdx[k]!;
    const cy = upperTopY + k * ROW_PITCH;
    rows[i] = { cx: 0, cy, labelX: 0, labelY: cy + 4, labelAnchor: 'start', valueAbove: -10, valueBelow: 22, marginValueX: 0 };
  }
  for (let k = 0; k < lowerIdx.length; k++) {
    const i = lowerIdx[k]!;
    const cy = lowerTopY + k * ROW_PITCH;
    rows[i] = { cx: 0, cy, labelX: 0, labelY: cy + 4, labelAnchor: 'end', valueAbove: -10, valueBelow: 22, marginValueX: 0 };
  }
  void plotW;
  return rows;
}

function measureLabel(text: string, fs: number): number {
  /* Heuristic — sans-serif average character is ~0.55em wide. */
  return text.length * fs * 0.58 + 16;
}

function header(model: Resolved, width: number, padT: number, fs: number, theme: { foreground: string }, palette: { selected: string }): string {
  return `<g data-role="header">
    <text x="40" y="32" font-size="${fs + 6}" font-weight="700" fill="${theme.foreground}">${escapeText(model.title)}</text>
    <line x1="40" y1="44" x2="${width - 40}" y2="44" stroke="#d0d7de" stroke-width="0.5"/>
  </g>`;
  void padT; void palette.selected;
}

function zones(
  model: Resolved,
  axis: Resolved['axis'],
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  palette: { recommended: string; caution: string; conflict: string },
  leftGutter: number,
  rightGutter: number,
): string[] {
  const out: string[] = [];
  /* Spec §View: `rail` shows no zone shading at all; `compact` shows no
   * MANDATORY zone shading specifically (preferred/conflict remain);
   * `report` shows everything. */
  if (model.choices.view === 'rail') return out;
  const r = model.mandatoryInterval;
  const p = model.preferredInterval;
  /* Spec §Normative visual encoding: "A renderer MUST retain marker
   * fill, arrow direction, line form and text labels in monochrome
   * output." Hue alone can't distinguish the zones there, so fall back
   * to greyscale tones at different depths instead of red/green/yellow. */
  const mono = model.choices.theme === 'monochrome' || model.choices.palette === 'monochrome';
  const midColor = mono ? '#9ca3af' : '#fbe5e2';   /* mandatory / not compliant */
  const okColor = mono ? '#d1d5db' : '#e2f2d7';    /* preferred / recommended */
  const warnColor = '#fff2c7';  /* light yellow (caution band) */
  const conflictColor = mono ? '#4b5563' : '#f8c1bd';

  const opacity = model.choices.zones === 'full' ? 0.55 : 0.35;

  /* mandatory interval as a red wash */
  if (model.choices.view !== 'compact' && Number.isFinite(r.minimum) && Number.isFinite(r.maximum) && r.minimum <= r.maximum) {
    out.push(zoneRect(model, axis, r.minimum, r.maximum, padL, padT, plotW, plotH, o, midColor, opacity, leftGutter, rightGutter));
  }
  /* preferred interval as a green wash */
  if (Number.isFinite(p.minimum) && Number.isFinite(p.maximum) && p.minimum <= p.maximum) {
    out.push(zoneRect(model, axis, p.minimum, p.maximum, padL, padT, plotW, plotH, o, okColor, 0.55, leftGutter, rightGutter));
  }
  /* preferred conflict: a red band where the two preferred bounds cross */
  if (Number.isFinite(p.minimum) && Number.isFinite(p.maximum) && p.minimum > p.maximum) {
    out.push(zoneRect(model, axis, Math.min(p.minimum, p.maximum), Math.max(p.minimum, p.maximum), padL, padT, plotW, plotH, o, conflictColor, 0.45, leftGutter, rightGutter));
  }
  void warnColor; void palette;
  return out;
}

function zoneRect(
  model: Resolved,
  axis: Resolved['axis'],
  min: number,
  max: number,
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  fill: string,
  opacity: number,
  leftGutter: number,
  rightGutter: number,
): string {
  if (o === 'horizontal') {
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    const xRange = xR - xL;
    const lo = scalePos(model, axis, min / 1000, xRange);
    const hi = scalePos(model, axis, max / 1000, xRange);
    const x = xL + Math.min(lo, hi);
    const w = Math.abs(hi - lo);
    return `<rect data-zone="mandatory" x="${x}" y="${padT}" width="${w}" height="${plotH}" fill="${fill}" opacity="${opacity}"/>`;
  }
  /* A slim colour column between the axis and the marker column, rather
   * than the full plot width — matches the spec's vertical reference
   * figure and keeps the (much narrower) vertical canvas uncluttered. */
  const lo = verticalY(model, axis, min / 1000, padT, plotH);
  const hi = verticalY(model, axis, max / 1000, padT, plotH);
  const y = Math.min(lo, hi);
  const h = Math.abs(hi - lo);
  const bandX = verticalAxisX(padL) + 12;
  const bandW = verticalMarkerX(padL) - bandX - 24;
  return `<rect data-zone="mandatory" x="${bandX}" y="${y}" width="${bandW}" height="${h}" fill="${fill}" opacity="${opacity}"/>`;
}

function frame(
  model: Resolved,
  axis: Resolved['axis'],
  padL: number,
  padR: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  ticks: number[],
  fs: number,
  theme: { axis: string; foreground: string },
  leftGutter: number,
  rightGutter: number,
): string {
  const out: string[] = [];
  if (o === 'horizontal') {
    /* plot inner edges — vertical pale lines at the gutter positions */
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    out.push(`<line x1="${xL}" y1="${padT}" x2="${xL}" y2="${padT + plotH}" stroke="#e6e8eb" stroke-width="0.5"/>`);
    out.push(`<line x1="${xR}" y1="${padT}" x2="${xR}" y2="${padT + plotH}" stroke="#e6e8eb" stroke-width="0.5"/>`);
    /* horizontal axis line at the bottom */
    out.push(`<line x1="${xL}" y1="${padT + plotH + 0.5}" x2="${xR}" y2="${padT + plotH + 0.5}" stroke="${theme.axis}" stroke-width="1"/>`);
    /* tick labels — placed in the inner axis range (between gutters) */
    const xRange = xR - xL;
    for (const t of ticks) {
      if (t < axis.minimum || t > axis.maximum) continue;
      const x = xL + scalePos(model, axis, t, xRange);
      out.push(`<line x1="${x}" y1="${padT + plotH - 4}" x2="${x}" y2="${padT + plotH + 4}" stroke="${theme.axis}" stroke-width="1"/>`);
      out.push(`<text x="${x}" y="${padT + plotH + 22}" font-size="${fs - 1}" text-anchor="middle" fill="${theme.foreground}">${formatTick(t)}</text>`);
    }
  } else {
    /* Calibrated axis on the left, ticks and labels to its left, matching
     * the spec's vertical reference figure. */
    const axisX = verticalAxisX(padL);
    out.push(`<line x1="${axisX}" y1="${padT}" x2="${axisX}" y2="${padT + plotH}" stroke="${theme.axis}" stroke-width="1"/>`);
    for (const t of ticks) {
      if (t < axis.minimum || t > axis.maximum) continue;
      const y = verticalY(model, axis, t, padT, plotH);
      out.push(`<line x1="${axisX - 4}" y1="${y}" x2="${axisX + 4}" y2="${y}" stroke="${theme.axis}" stroke-width="1"/>`);
      out.push(`<text x="${axisX - 10}" y="${y + 4}" font-size="${fs - 1}" text-anchor="end" fill="${theme.foreground}">${formatTick(t)}</text>`);
    }
  }
  void padR;
  return out.join('\n');
}

function gridLines(
  model: Resolved,
  axis: Resolved['axis'],
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  ticks: number[],
  theme: { grid: string },
  leftGutter: number,
  rightGutter: number,
): string {
  const out: string[] = [];
  if (o === 'horizontal') {
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    const xRange = xR - xL;
    for (const t of ticks) {
      if (t < axis.minimum || t > axis.maximum) continue;
      const x = xL + scalePos(model, axis, t, xRange);
      out.push(`<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${theme.grid}" stroke-width="0.5" opacity="0.5"/>`);
    }
  } else {
    for (const t of ticks) {
      if (t < axis.minimum || t > axis.maximum) continue;
      const y = verticalY(model, axis, t, padT, plotH);
      out.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="${theme.grid}" stroke-width="0.5" opacity="0.5"/>`);
    }
  }
  return out.join('\n');
}

function formatTick(v: number): string {
  if (v <= 0) return '0';
  if (v >= 1000) return formatPlain(v / 1000) + ' kA';
  if (v < 1) return formatPlain(v * 1000) + ' A';
  return formatPlain(v) + ' kA';
}

interface RowPos {
  cx: number;
  cy: number;
  labelX: number;
  labelY: number;
  labelAnchor: 'start' | 'end';
  valueAbove: number;
  valueBelow: number;
  marginValueX: number;
}

function drawConstraint(
  c: Constraint,
  row: RowPos,
  model: Resolved,
  axis: Resolved['axis'],
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  fs: number,
  theme: { foreground: string; callout: string },
  palette: { lower: string; upper: string; mandatory: string },
  leftGutter: number,
  rightGutter: number,
  vLabelY: number | null,
): string {
  void plotW;
  const out: string[] = [];
  const family = c.direction === 'below' ? palette.lower : palette.upper;
  const bg = THEMES[model.choices.theme]?.background ?? '#ffffff';
  const marginText = marginLabel(c);

  if (o === 'vertical') {
    const markerX = verticalMarkerX(padL);
    const yC = verticalY(model, axis, c.value_A / 1000, padT, plotH);
    const yM = c.boundary_A !== null && Number.isFinite(c.boundary_A)
      ? verticalY(model, axis, c.boundary_A / 1000, padT, plotH)
      : null;

    if (yM !== null) {
      const lo = Math.min(yC, yM);
      const hi = Math.max(yC, yM);
      out.push(`<line data-role="criterion-bar" x1="${markerX}" y1="${lo}" x2="${markerX}" y2="${hi}" stroke="${family}" stroke-width="6" stroke-linecap="butt" opacity="0.9"/>`);
      /* Open (margin) dot drawn BEFORE the filled criterion dot: a small
       * percentage margin on a log-scale axis can land the two centres
       * only a couple of pixels apart, and the open dot's opaque fill
       * would otherwise erase the filled one drawn under it. */
      out.push(`<circle data-role="margin" cx="${markerX}" cy="${yM}" r="6" fill="${bg}" stroke="${family}" stroke-width="2"/>`);
    }

    /* filled dot = criterion */
    out.push(`<circle data-role="criterion" cx="${markerX}" cy="${yC}" r="6" fill="${family}"/>`);

    if (yM !== null) {
      /* Arrow points toward acceptable values: for `below`, acceptable
       * values are higher, i.e. UP the vertical axis (smaller y); for
       * `above`, acceptable values are lower, i.e. DOWN (larger y). */
      const arrowDir = c.direction === 'below' ? -1 : 1;
      const arrowStart = yM + arrowDir * 14;
      const arrowEnd = yM + arrowDir * 24;
      out.push(`<g data-role="arrow" transform="translate(${markerX}, ${arrowStart})">
        <line x1="0" y1="0" x2="0" y2="${arrowEnd - arrowStart}" stroke="${family}" stroke-width="1.5" opacity="0.85"/>
        <polyline points="-3,${arrowEnd - arrowStart + arrowDir * -4} 0,${arrowEnd - arrowStart} 3,${arrowEnd - arrowStart + arrowDir * -4}" fill="none" stroke="${family}" stroke-width="1.5"/>
      </g>`);
    }

    /* Label column to the right, with a pale leader from the criterion
     * dot. The value (and margin, if any) is inlined into the label
     * text — matching the spec's vertical reference figure — rather
     * than floated separately, which is what caused clutter/overlap.
     * When the declutter pass has moved the label off the marker's true
     * y (vLabelY), the leader angles to follow — spec §Layout: "move it
     * vertically within its row and extend a short pale leader." */
    const labelX = verticalLabelX(padL);
    const labelY = vLabelY ?? yC;
    const valueText = formatAmps(c.value_A, c.value_A < 1000 ? 'A' : 'kA');
    const fullLabel = marginText ? `${c.label} · ${valueText} (margin ${marginText})` : `${c.label} · ${valueText}`;
    out.push(`<line data-role="leader" x1="${markerX + 10}" y1="${yC}" x2="${labelX - 6}" y2="${labelY}" stroke="#cdd2d8" stroke-width="0.6"/>`);
    out.push(`<circle data-role="leader-end" cx="${labelX - 6}" cy="${labelY}" r="1.5" fill="#cdd2d8"/>`);
    out.push(`<text data-role="criterion-label" x="${labelX}" y="${labelY + 4}" font-size="${fs}" text-anchor="start" fill="${theme.foreground}">${escapeText(fullLabel)}</text>`);

    return out.join('\n');
  }

  const xL = padL + leftGutter;
  const xR = padL + plotW - rightGutter;
  const xRange = xR - xL;
  const xC = xL + scalePos(model, axis, c.value_A / 1000, xRange);
  const xM = c.boundary_A !== null && Number.isFinite(c.boundary_A)
    ? xL + scalePos(model, axis, c.boundary_A / 1000, xRange)
    : null;
  const y = row.cy;

  /* thick coloured bar between criterion and its margin */
  if (xM !== null) {
    const lo = Math.min(xC, xM);
    const hi = Math.max(xC, xM);
    out.push(`<line data-role="criterion-bar" x1="${lo}" y1="${y}" x2="${hi}" y2="${y}" stroke="${family}" stroke-width="6" stroke-linecap="butt" opacity="0.9"/>`);
    /* Open (margin) dot drawn BEFORE the filled criterion dot: a small
     * percentage margin on a log-scale axis can land the two centres
     * only a couple of pixels apart, and the open dot's opaque fill
     * would otherwise erase the filled one drawn under it. */
    out.push(`<circle data-role="margin" cx="${xM}" cy="${y}" r="6" fill="${bg}" stroke="${family}" stroke-width="2"/>`);
  }

  /* filled dot = criterion */
  out.push(`<circle data-role="criterion" cx="${xC}" cy="${y}" r="6" fill="${family}"/>`);
  /* value text above the criterion */
  out.push(`<text data-role="criterion-value" x="${xC}" y="${y - 8}" font-size="${fs - 1}" text-anchor="middle" font-weight="600" fill="${family}">${escapeText(formatAmps(c.value_A, c.value_A < 1000 ? 'A' : 'kA'))}</text>`);

  /* margin value text BELOW the open dot, and the direction arrow
   * OUTSIDE the open dot in the acceptable direction. The arrow points
   * TOWARD acceptable values. */
  if (xM !== null) {
    if (marginText) {
      out.push(`<text data-role="margin-value" x="${xM}" y="${y + 22}" font-size="${fs - 1}" text-anchor="middle" fill="${theme.callout}">${escapeText(marginText)}</text>`);
    }
    /* short direction arrow outside the open dot pointing to acceptable
     * values. For `below` constraints the selected must be > criterion,
     * so the arrow at the open margin boundary points RIGHT (toward
     * higher values, which are the acceptable side). For `above` the
     * arrow points LEFT. */
    const arrowDir = c.direction === 'below' ? 1 : -1;
    const arrowStart = xM + arrowDir * 14;
    const arrowEnd = xM + arrowDir * 24;
    out.push(`<g data-role="arrow" transform="translate(${arrowStart}, ${y})">
      <line x1="0" y1="0" x2="${arrowEnd - arrowStart}" y2="0" stroke="${family}" stroke-width="1.5" opacity="0.85"/>
      <polyline points="${arrowEnd - arrowStart + arrowDir * -4},-3 ${arrowEnd - arrowStart},0 ${arrowEnd - arrowStart + arrowDir * -4},3" fill="none" stroke="${family}" stroke-width="1.5"/>
    </g>`);
  }

  /* label on the FAR side with a pale leader to the criterion */
  const labelOnLeft = c.direction === 'below';
  const labelX = labelOnLeft ? xL - 12 : xR + 12;
  const labelY = y + 4;
  const labelAnchor = labelOnLeft ? 'end' : 'start';
  out.push(`<line data-role="leader" x1="${labelOnLeft ? xC : labelX}" y1="${y}" x2="${labelOnLeft ? labelX : xC}" y2="${y}" stroke="#cdd2d8" stroke-width="0.6"/>`);
  out.push(`<circle data-role="leader-end" cx="${labelOnLeft ? labelX : xC}" cy="${y}" r="1.5" fill="#cdd2d8"/>`);
  out.push(`<text data-role="criterion-label" x="${labelX}" y="${labelY}" font-size="${fs}" text-anchor="${labelAnchor}" fill="${theme.foreground}">${escapeText(c.label)}</text>`);

  return out.join('\n');
}

function marginLabel(c: Constraint): string {
  if (!c.margin) return '';
  if (c.margin.kind === 'percentage') return `${formatPlain(c.margin.value)}%`;
  return formatAmps(c.margin.value, c.margin.value < 1000 ? 'A' : 'kA');
}

function drawSelection(
  model: Resolved,
  axis: Resolved['axis'],
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  o: 'horizontal' | 'vertical',
  fs: number,
  palette: { selected: string },
  leftGutter: number,
  rightGutter: number,
): string {
  const out: string[] = [];
  if (o === 'horizontal') {
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    const xRange = xR - xL;
    const x = xL + scalePos(model, axis, model.selection.value_A / 1000, xRange);
    out.push(`<line data-role="selected-line" x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${palette.selected}" stroke-width="2"/>`);
    out.push(`<text data-role="selected-label" x="${x}" y="${padT - 12}" font-size="${fs + 1}" font-weight="700" fill="${palette.selected}" text-anchor="middle">${escapeText(selectedLabelText(model))}</text>`);
    out.push(`<circle data-role="selected-marker-dot" cx="${x}" cy="${padT + plotH / 2}" r="6" fill="${palette.selected}"/>`);
  } else {
    const y = verticalY(model, axis, model.selection.value_A / 1000, padT, plotH);
    const labelX = verticalLabelX(padL);
    out.push(`<line data-role="selected-line" x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="${palette.selected}" stroke-width="2"/>`);
    out.push(`<text data-role="selected-label" x="${labelX}" y="${y - 8}" font-size="${fs + 1}" font-weight="700" fill="${palette.selected}" text-anchor="start">${escapeText(selectedLabelText(model))}</text>`);
    out.push(`<circle data-role="selected-marker-dot" cx="${verticalMarkerX(padL)}" cy="${y}" r="6" fill="${palette.selected}"/>`);
  }
  return out.join('\n');
}

/**
 * The selected-value label, including any equivalent quantities the
 * diagram asked for (spec §Displayed quantities). Without this the
 * `show current, mva, secondary` statement had no visible effect at
 * all: the conversions were resolved into the model and then never
 * drawn. The entered quantity leads when `show entered` puts it first,
 * since that is the number the engineer actually typed.
 */
function selectedLabelText(model: Resolved): string {
  const d = model.display;
  const t = model.displayToggle;
  const parts: string[] = [];
  if (t.showEntered && d?.entered) parts.push(d.entered.text);
  parts.push(formatAmps(model.selection.value_A));
  if (t.showMva && d?.mva) parts.push(d.mva.text);
  if (t.showSecondary && d?.secondary) parts.push(`${d.secondary.text} sec`);
  return `SELECTED ${parts.join(' · ')}`;
}

/** State word, its colour, and the detail line — shared between the
 * horizontal footer callout and the vertical inline status text. */
function statusText(model: Resolved, palette: { selected: string; caution: string; conflict: string }): { state: string; stateColor: string; detail: string } {
  /* No setpoint means there is nothing to pass judgement on. The
   * resolver still reports `recommended` in that case (status is only
   * meaningful relative to a selection), but rendering a RECOMMENDED
   * pill over a diagram with no selected value reads as "this setting
   * was checked and approved" — the opposite of the truth. Report the
   * compliant window instead, which is the useful answer for an
   * analysis-only diagram (`selected "…" none`). */
  const noSelection = !Number.isFinite(model.selection.value_A);
  const isConflict = model.status === 'no-compliant-setting' || model.status === 'no-recommended-setting';
  if (noSelection && !isConflict) {
    const p = model.preferredInterval;
    const m = model.mandatoryInterval;
    const range = (lo: number, hi: number) => {
      const loTxt = Number.isFinite(lo) ? formatAmps(lo, lo < 1000 ? 'A' : 'kA') : 'unbounded';
      const hiTxt = Number.isFinite(hi) ? formatAmps(hi, hi < 1000 ? 'A' : 'kA') : 'unbounded';
      return `${loTxt} – ${hiTxt}`;
    };
    const hasPreferred = Number.isFinite(p.minimum) || Number.isFinite(p.maximum);
    const detail = hasPreferred
      ? `preferred range ${range(p.minimum, p.maximum)}`
      : `compliant range ${range(m.minimum, m.maximum)}`;
    return { state: 'NO SETTING SELECTED', stateColor: palette.caution, detail };
  }
  const state = (() => {
    const words = model.choices.words;
    const w = (k: WordName, fb: string) => (words[k] ?? fb).toUpperCase();
    switch (model.status) {
      case 'recommended': return w('recommended', 'Recommended');
      case 'caution': return w('caution', 'Caution');
      case 'do-not-set': return w('do-not-set', 'Do not set');
      case 'no-recommended-setting': return w('no-recommended', 'No recommended setting');
      case 'no-compliant-setting': return w('no-compliant', 'No compliant setting');
    }
  })();
  const stateColor =
    model.status === 'do-not-set' || model.status === 'no-compliant-setting' ? palette.conflict :
    model.status === 'caution' || model.status === 'no-recommended-setting' ? palette.caution :
    palette.selected;

  /* detail line — spec §Selected-setting percentages mandates the
   * denominator and direction be stated, e.g. "115% of 5.5 kA lower
   * boundary · 15% above"; model.selectedPercents already carries that
   * exact formatting, so use it instead of recomputing a shorter one. */
  let detail = '';
  if (model.status === 'recommended' || model.status === 'caution' || model.status === 'do-not-set') {
    if (model.selectedPercents && model.selectedPercents.length > 0) {
      detail = model.selectedPercents.map((p) => p.text).join(' · ');
    }
  } else if (model.status === 'no-recommended-setting') {
    /* preferredInterval is already in axis amps — do not rescale again.
     * Spec §Conflicting preferred constraints: conflict% = (lower -
     * upper) / upper * 100. */
    const lo = model.preferredInterval.minimum;
    const hi = model.preferredInterval.maximum;
    const w = Math.abs(hi - lo);
    const pct = Number.isFinite(hi) && hi !== 0 ? ((lo - hi) / hi) * 100 : NaN;
    detail = `conflict ${formatAmps(w, w < 1000 ? 'A' : 'kA')}`;
    if (Number.isFinite(pct)) detail += ` · ${formatPercent(pct)}`;
  } else if (model.status === 'no-compliant-setting') {
    /* mandatoryInterval is already in axis amps — do not rescale again.
     * Spec §Conflicting mandatory constraints requires the absolute and
     * percentage conflict, and the two controlling criteria. */
    const lo = model.mandatoryInterval.minimum;
    const hi = model.mandatoryInterval.maximum;
    const w = Math.abs(hi - lo);
    const pct = Number.isFinite(hi) && hi !== 0 ? ((lo - hi) / hi) * 100 : NaN;
    detail = `conflict ${formatAmps(w, w < 1000 ? 'A' : 'kA')}`;
    if (Number.isFinite(pct)) detail += ` · ${formatPercent(pct)}`;
    if (model.controlling.lower && model.controlling.upper) {
      detail += ` between "${model.controlling.lower.label}" and "${model.controlling.upper.label}"`;
    }
  }
  if (!detail && model.status === 'do-not-set') {
    detail = 'selected value crosses a mandatory criterion';
  }
  return { state, stateColor, detail };
}

/** Horizontal (and no-selection fallback) status callout. `anchorX`
 * defaults to the plot centre but is normally the selected line's own
 * x — spec's reference figures place the status directly beneath the
 * selected setpoint, not centred on the whole canvas. */
function statusCallout(model: Resolved, anchorX: number, height: number, fs: number, theme: { callout: string; foreground: string }, palette: { selected: string; caution: string; conflict: string }): string {
  const out: string[] = [];
  const { state, stateColor, detail } = statusText(model, palette);

  const cy = height - 36;

  if (model.choices.view === 'compact') {
    /* Spec §View: compact gets a ONE-LINE status summary — state and
     * detail combined, no separate pill row. */
    const line = detail ? `${state} · ${detail}` : state;
    out.push(`<text x="${anchorX}" y="${cy}" font-size="${fs}" font-weight="600" fill="${stateColor}" text-anchor="middle">${escapeText(line)}</text>`);
    return out.join('\n');
  }

  /* report / rail: state pill plus a full detail line beneath it. */
  out.push(`<rect x="${anchorX - 140}" y="${cy - 16}" width="280" height="22" rx="3" fill="${stateColor}" opacity="0.18"/>`);
  out.push(`<text x="${anchorX}" y="${cy}" font-size="${fs}" font-weight="600" fill="${stateColor}" text-anchor="middle">${escapeText(state)}</text>`);
  if (detail) {
    out.push(`<text x="${anchorX}" y="${cy + 22}" font-size="${fs - 1}" fill="${theme.callout}" text-anchor="middle">${escapeText(detail)}</text>`);
  }

  return out.join('\n');
}

/** Vertical status text — placed directly beneath the selected line in
 * the label column, matching the spec's vertical reference figure
 * (SELECTED above the line, state/detail below it, both in the same
 * column as criterion labels). */
function verticalStatusText(model: Resolved, y: number, padL: number, fs: number, theme: { callout: string }, palette: { selected: string; caution: string; conflict: string }): string {
  const { state, stateColor, detail } = statusText(model, palette);
  const x = verticalLabelX(padL);
  const out: string[] = [];
  out.push(`<text x="${x}" y="${y + 20}" font-size="${fs}" font-weight="700" fill="${stateColor}" text-anchor="start">${escapeText(state)}</text>`);
  if (detail) {
    out.push(`<text x="${x}" y="${y + 20 + fs + 3}" font-size="${fs - 1}" fill="${theme.callout}" text-anchor="start">${escapeText(detail)}</text>`);
  }
  return out.join('\n');
}

/**
 * Indicative scale (spec §Scale): "ordered, non-calibrated spacing with
 * minimum marker separation." Every distinct plotted value (criterion,
 * margin boundary, selection) gets an equal-rank position along the
 * axis instead of a value-proportional one — this both orders them
 * correctly and guarantees uniform minimum separation between markers.
 */
function collectIndicativeValues(model: Resolved): number[] {
  const set = new Set<number>();
  const add = (v_A: number) => {
    if (Number.isFinite(v_A)) set.add(Math.round((v_A / 1000) * 1e6) / 1e6);
  };
  for (const c of model.constraints) {
    add(c.value_A);
    if (c.boundary_A !== null) add(c.boundary_A);
  }
  if (Number.isFinite(model.selection.value_A)) add(model.selection.value_A);
  return [...set].sort((a, b) => a - b);
}

function indicativeFraction(model: Resolved, v_kA: number): number {
  const values = collectIndicativeValues(model);
  const n = values.length;
  if (n === 0) return 0.5;
  const key = Math.round(v_kA * 1e6) / 1e6;
  const idx = values.indexOf(key);
  if (idx !== -1) return n > 1 ? idx / (n - 1) : 0.5;
  /* Value isn't one of the plotted points (e.g. an off-range reference)
   * — interpolate its rank between the nearest neighbours. */
  let lo = 0;
  while (lo < n && values[lo]! < key) lo++;
  if (lo === 0) return 0;
  if (lo === n) return 1;
  const below = values[lo - 1]!;
  const above = values[lo]!;
  const t = above > below ? (key - below) / (above - below) : 0;
  const rankBelow = n > 1 ? (lo - 1) / (n - 1) : 0.5;
  const rankAbove = n > 1 ? lo / (n - 1) : 0.5;
  return rankBelow + t * (rankAbove - rankBelow);
}

/** Position-mapping dispatcher: calibrated scales delegate to theme.ts;
 * indicative scale uses rank-based, non-calibrated spacing. */
function scalePos(model: Resolved, axis: Resolved['axis'], v_kA: number, axisLength: number): number {
  if (axis.scale === 'indicative') return indicativeFraction(model, v_kA) * axisLength;
  return valueToPosition(v_kA, { min: axis.minimum, max: axis.maximum }, axisLength, axis.scale);
}

/**
 * Vertical orientation (spec §Orientation — "Both orientations MUST use
 * the same criterion, margin, direction and status semantics"). The
 * calibrated axis runs top (axis.maximum) to bottom (axis.minimum) over
 * the full plot height; there is no gutter inset on this axis because,
 * unlike horizontal, criterion labels don't sit at the axis's own ends —
 * they sit in a single column to the right of the markers (see
 * VERTICAL_AXIS_X / VERTICAL_MARKER_X below), matching the spec's own
 * vertical reference figure.
 */
function verticalY(model: Resolved, axis: Resolved['axis'], v_kA: number, padT: number, plotH: number): number {
  return padT + plotH - scalePos(model, axis, v_kA, plotH);
}

/** x of the vertical calibrated-axis line, ticks and tick labels. */
function verticalAxisX(padL: number): number {
  return padL + 56;
}

/** x of the criterion/margin marker column, right of the axis and zone band. */
function verticalMarkerX(padL: number): number {
  return verticalAxisX(padL) + 90;
}

/** x of the criterion-label / SELECTED / status column, right of the
 * marker column and its leader line. */
function verticalLabelX(padL: number): number {
  return verticalMarkerX(padL) + 90;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export { buildTicks, valueToPosition, positionToValue };
