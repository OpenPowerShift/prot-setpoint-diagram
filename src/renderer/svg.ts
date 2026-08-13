import type { Resolved, Constraint } from '../semantics/model.js';
import type { WordName } from '../parser/ast.js';
import { PALETTES, THEMES, buildTicks, valueToPosition, positionToValue } from './theme.js';
import { formatCondition, formatPercent, formatPlain, formatSetting, mvaToAmps, toMVA } from '../semantics/units.js';

interface RenderOptions {
  width?: number;
  height?: number;
  fontSize?: number;
}

/**
 * Layout (spec §Layout and §Autorange).
 *
 * The plot is a single horizontal (or vertical) band. Each criterion gets
 * its OWN ROW; lower- and upper-family rows now SHARE the same row
 * sequence (lower labels/values sit toward the lower end of the axis,
 * upper toward the higher end, so at typical axis ranges they occupy
 * different x and don't collide) rather than each family getting its own
 * half of the plot — this is what keeps the diagram compact instead of
 * reserving two full stacks' worth of height when there's only one or
 * two criteria per side.
 *
 *   top of plot ────────────────────────────────────────
 *     row 0: lower-family dot (left-ish) ... upper-family dot (right-ish)
 *     row 1: ...
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
 * a "SELECTED" word label near the top and its numeric value(s) on or
 * just below the axis.
 */
export function renderSvg(model: Resolved, opts: RenderOptions = {}): string {
  const fs = opts.fontSize ?? 14;
  const o = model.choices.orientation;
  /* Default canvas size is content-driven rather than a fixed 1400×540 —
   * a 2-criterion diagram doesn't need the same canvas as a 6-criterion
   * one, and vertical orientation needs a narrow, tall canvas (see the
   * spec's own vertical reference figure), not a wide, short one. A
   * `size width`/`size height` statement overrides either axis
   * explicitly (spec §Size); render-time opts (CLI --width) win over
   * that, since they're a more specific, per-render request. */
  const { width: defaultWidth, height: defaultHeight } = defaultCanvasSize(model, o, fs);
  const declareWidth = opts.width ?? model.choices.width ?? defaultWidth;
  const declareHeight = opts.height ?? model.choices.height ?? defaultHeight;
  const theme = THEMES[model.choices.theme] ?? THEMES.print;
  const palette = PALETTES[model.choices.palette] ?? PALETTES.accessible;

  /* Spec §Layout: "The plot MUST reserve asymmetric gutters based on
   * measured labels rather than fixed equal margins." Lower-family
   * labels sit in the left gutter, upper-family in the right, so each
   * side is measured against ITS OWN family — a symmetric gutter (the
   * previous approach) let one long label eat both sides and crush the
   * calibrated axis between them. */
  const { left: leftGutter, right: rightGutter } = horizontalGutters(model, fs);

  const hasSelection = Number.isFinite(model.selection.value_A);
  const hasIndicative = axisIsIndicative(model);

  /* A `secondary axis` (horizontal only) reserves its own line/ticks/
   * labels row on whichever side it's declared, on top of the usual
   * title/axis/status padding. */
  const secondaryAxis = o === 'horizontal' ? model.secondaryAxis : undefined;
  const hasSecondaryTop = secondaryAxis?.position === 'top';
  const hasSecondaryBottom = secondaryAxis?.position === 'bottom';
  /* Horizontal only: the zone percent annotations get their own row
   * immediately adjacent to the plot — criterion rows already fill the
   * plot itself top to bottom, so there's nowhere inside it to put
   * them. `topStackHeight` is the combined height of everything now
   * stacked BELOW the selected label and ABOVE the plot — the label
   * itself stays at its original offset from padT's ORIGINAL (pre-stack)
   * value, so adding rows here pushes the label up rather than
   * shrinking the gap it already had. */
  const hasZonePercent = o === 'horizontal' && !!model.selectedPercents && model.selectedPercents.length > 0;
  const topStackHeight = (hasZonePercent ? ZONE_PERCENT_ROW : 0) + (hasSecondaryTop ? SECONDARY_TOP_ROW : 0);

  const titleOn = model.choices.title !== 'off';
  const titleAtBottom = titleOn && model.choices.titlePosition === 'bottom';
  const titleAtTop = titleOn && !titleAtBottom;

  const padL = PAD_L;
  const padR = PAD_R;
  const padT = (titleAtTop ? 60 : 28) + topStackHeight;  /* title + selected label space */

  /* Bottom stack (horizontal only): axis line/ticks, the selected
   * value's own row (spec: written on/below the axis, not repeated
   * above it), the indicative-scale notice, and an optional secondary
   * axis — each reserved only when actually present, stacked in that
   * order immediately under the plot, with the status callout and an
   * optional bottom title below all of it. */
  const bottomAxisRow = o === 'horizontal' ? AXIS_TICK_ROW : 0;
  const bottomSelectedRow = o === 'horizontal' && hasSelection ? SELECTED_VALUE_ROW : 0;
  const bottomIndicativeRow = o === 'horizontal' && hasIndicative ? INDICATIVE_ROW : 0;
  const bottomSecondary = hasSecondaryBottom ? SECONDARY_AXIS_H : 0;
  const statusArea = o === 'horizontal' ? STATUS_AREA : (hasSelection ? 16 : STATUS_AREA);
  const padB = bottomAxisRow + bottomSelectedRow + bottomIndicativeRow + bottomSecondary + statusArea + (titleAtBottom ? BOTTOM_TITLE_ROW : 0);

  const plotW = declareWidth - padL - padR;
  const plotH = declareHeight - padB - padT;

  const axis = model.axis;
  const ticks = axis.scale === 'indicative' ? collectIndicativeValues(model) : buildTicks(axis.minimum, axis.maximum, axis.scale);

  /* Place each constraint on its own row. Lower- and upper-family rows
   * now SHARE the same row sequence (staggered by half a pitch so their
   * dots don't land at the exact same y even when values happen to be
   * close) rather than each family getting its own half of the plot —
   * see the module doc comment above. */
  const rows = layoutRows(model.constraints, o, plotH, padT);

  /* Background zones — same on every view that requests them. */
  const zoneParts: string[] = [];
  if (model.choices.zones !== 'off') {
    for (const z of zones(model, axis, padL, padT, plotW, plotH, o, palette, leftGutter, rightGutter)) {
      zoneParts.push(z);
    }
  }

  const parts: string[] = [];
  /* width/height attributes give the SVG an intrinsic size, not just an
   * aspect ratio. Without them a viewBox-only SVG has no natural size at
   * all, so a plain `max-width:100%; height:auto` host style stretches
   * it to fill whatever container it lands in — a 2-criterion diagram
   * in a wide pane rendered at 1.8x its authored size, arbitrarily
   * enlarging every label past legibility (and off the viewport, for
   * the longest ones). With explicit dimensions, max-width:100% caps
   * growth at the authored size and still shrinks on narrow viewports. */
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${declareWidth}" height="${declareHeight}" viewBox="0 0 ${declareWidth} ${declareHeight}" data-orientation="${o}" data-status="${model.status}" data-title="${escapeAttr(model.title)}" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif">`);

  /* Explicit paint-order layers, back to front. This is redundant with
   * document order alone (SVG already paints later elements on top) but
   * makes the intended z-order self-documenting so a future change to
   * one layer's contents can't accidentally reorder it relative to the
   * others — e.g. a marker must never end up under the grid it sits on. */
  parts.push(`<g data-layer="background">`);
  parts.push(`<rect x="0" y="0" width="${declareWidth}" height="${declareHeight}" fill="${theme.background}"/>`);
  parts.push(`</g>`);

  parts.push(`<g data-layer="chrome">`);
  /* Title + selected label above the plot */
  if (titleAtTop) parts.push(header(model, declareWidth, padL, padR, fs, theme));

  /* Spec §Scale: indicative scale MUST show a notice that the axis is
   * ordered but not calibrated to value — placed just below the axis
   * (left-aligned, matching normal reading order) rather than floating
   * above the plot disconnected from the axis it describes. */
  if (hasIndicative) {
    parts.push(indicativeNotice(o, padL, padT, plotH, leftGutter, fs, theme, bottomAxisRow + bottomSelectedRow));
  }
  parts.push(`</g>`);

  parts.push(`<g data-layer="grid">`);
  /* Background zones inside the plot */
  for (const z of zoneParts) parts.push(z);

  /* Frame: vertical lines at the gutters, horizontal axis at the bottom */
  parts.push(frame(model, axis, padL, padR, padT, plotW, plotH, o, ticks, fs, theme, leftGutter, rightGutter));

  /* Grid lines — MUST stay under the markers layer below (spec: not on
   * top of a filled criterion dot). */
  parts.push(gridLines(model, axis, padL, padT, plotW, plotH, o, ticks, theme, leftGutter, rightGutter));

  if (secondaryAxis) {
    parts.push(secondaryAxisFrame(model, axis, secondaryAxis, padL, padT, plotW, plotH, fs, theme, leftGutter, rightGutter, hasZonePercent));
  }
  parts.push(`</g>`);

  const selY = o === 'vertical' && hasSelection ? verticalYClamped(model, axis, model.selection.value_A / 1000, padT, plotH) : null;

  /* Spec §Layout step 9: "Combine identical positions into one marker
   * with ×N and list labels in the gutter." Computed once and reused
   * below (for vertical's per-marker declutter/column math) and by the
   * render loop, so both agree on what's actually drawn — a group's
   * secondary members never get their own marker. */
  const constraintGroups = groupConstraints(model.constraints);

  /* Vertical only. Three distinct collision problems, all driven by how
   * close criterion values are on the calibrated axis:
   *  - LABEL TEXT collides: declutterVerticalLabels moves the text (and
   *    its leader) vertically, away from neighbours and the
   *    SELECTED/status block. This alone doesn't stop dots or bars
   *    colliding — it only ever moves text.
   *  - MARKER DOTS / CRITERION BARS overlap: two criteria whose full
   *    [criterion, margin] span overlaps in y (not just their bare
   *    value) render as one indistinguishable blob — a large margin
   *    percentage can pull two otherwise well-separated criteria's
   *    boundary ends into the same few pixels even though their VALUES
   *    are far apart. assignVerticalBarColumns spreads any set of
   *    overlapping bars into a couple of narrow side-by-side columns
   *    (interval-graph colouring on the bar's full span) instead of
   *    only checking the marker dot's own point.
   */
  let vLabelY: number[] | null = null;
  let vMarkerX: number[] | null = null;
  if (o === 'vertical') {
    const repY = constraintGroups.map((g) => verticalYClamped(model, axis, g.representative.value_A / 1000, padT, plotH));
    const bars = constraintGroups.map((g, i) => {
      const c = g.representative;
      if (c.boundary_A === null || !Number.isFinite(c.boundary_A)) return { lo: repY[i], hi: repY[i] };
      const boundaryY = verticalYClamped(model, axis, c.boundary_A / 1000, padT, plotH);
      return { lo: Math.min(repY[i], boundaryY), hi: Math.max(repY[i], boundaryY) };
    });
    const obstacle = selY !== null ? { top: selY - 26, bottom: selY + 20 + fs + 3 } : null;
    const declutteredY = declutterVerticalLabels(repY, obstacle, fs + 5);
    const columnOffset = assignVerticalBarColumns(bars);
    vLabelY = new Array(model.constraints.length).fill(null);
    vMarkerX = new Array(model.constraints.length).fill(0);
    constraintGroups.forEach((g, gi) => {
      const idx = model.constraints.indexOf(g.representative);
      vLabelY![idx] = declutteredY[gi]!;
      vMarkerX![idx] = columnOffset[gi]!;
    });
  }

  parts.push(`<g data-layer="markers">`);
  /* Constraints (each on its own row). Constraints sharing an exact
   * (direction, value, boundary) triple would otherwise draw stacked,
   * indistinguishable markers — draw once per group, at its
   * representative's row, and let the rest of that row's slot go
   * unused rather than reworking the row layout around group count. */
  for (const g of constraintGroups) {
    const i = model.constraints.indexOf(g.representative);
    const row = rows[i];
    parts.push(drawConstraint(g.representative, row, model, axis, padL, padT, plotW, plotH, o, fs, theme, palette, leftGutter, rightGutter, vLabelY ? vLabelY[i] : null, g.names.length > 1 ? g.names : null, vMarkerX ? vMarkerX[i] : 0));
  }
  parts.push(`</g>`);

  parts.push(`<g data-layer="foreground">`);
  /* Selected — orange line + selected label. The status text is anchored
   * to it (spec's own reference figures place both directly against the
   * selected line, not at a fixed canvas position) rather than centred
   * on the whole canvas. */
  if (hasSelection) {
    parts.push(drawSelection(model, axis, padL, padT, plotW, plotH, o, fs, palette, leftGutter, rightGutter, topStackHeight, bottomAxisRow));
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
    parts.push(statusCallout(model, anchorX, declareHeight, fs, theme, palette, titleAtBottom));
  }
  parts.push(`</g>`);

  if (titleAtBottom) {
    parts.push(`<g data-layer="chrome-bottom">`);
    parts.push(header(model, declareWidth, padL, padR, fs, theme, declareHeight));
    parts.push(`</g>`);
  }

  parts.push(`</svg>`);
  return parts.join('\n');
}

function axisIsIndicative(model: Resolved): boolean {
  return model.axis.scale === 'indicative';
}

/* ============================================================ pieces */

/** Outer canvas edge margin — deliberately tight (spec §Layout: "no more
 * than a few pixels of pure dead space at the canvas edge"). Functional
 * space for labels is reserved separately via the measured gutters
 * (horizontalGutters) and the vertical label columns — this is only the
 * blank strip between the outermost content and the SVG boundary. */
const PAD_L = 10;
const PAD_R = 10;
/** Narrowest calibrated axis we will ever render — the canvas grows
 * rather than let long labels squeeze the axis below this. Log scale
 * gets a wider floor: a decade of separation reads as cramped in the
 * same width a linear axis is comfortable with. */
const MIN_AXIS_WIDTH = 400;
const MIN_AXIS_WIDTH_LOG = 560;
/**
 * Vertical distance between criterion rows. Lower- and upper-family rows
 * now share the same row sequence (staggered by half a pitch) instead of
 * each family getting its own half of the plot, so this only needs to
 * clear one row's own value/margin text, not two families stacked
 * end-to-end.
 */
const ROW_PITCH = 38;
/** Extra vertical space a `secondary axis bottom` reserves below the
 * plot — line + ticks + one row of labels, clear of the primary axis's
 * own tick-label row. (`top` uses SECONDARY_TOP_ROW instead — see the
 * horizontal top-of-plot stack below.) */
const SECONDARY_AXIS_H = 76;
/** Horizontal, `secondary axis top` only: height of its own line/ticks/
 * label block, stacked adjacent to the plot (or to the zone percent
 * row, if that's also present) rather than floating far above it. */
const SECONDARY_TOP_ROW = 34;
/** Horizontal only: height of the zone percent annotations' row,
 * immediately adjacent to the plot/green band — two stacked lines (the
 * boundary's kA value, then its signed percentage) so long text has
 * somewhere to go instead of being crushed into a single overflowing
 * line. */
const ZONE_PERCENT_ROW = 34;
/** Horizontal only: axis line + ticks + tick-number row, directly under
 * the plot. */
const AXIS_TICK_ROW = 26;
/** Horizontal only: the selected value's own numeric row, on/just below
 * the axis — spec §Selected-setting label: the value is written at the
 * axis, not repeated above the plot alongside its word label. */
const SELECTED_VALUE_ROW = 20;
/** Height reserved for the "Indicative spacing — not to scale" notice,
 * placed just below the axis rather than floating above the plot. */
const INDICATIVE_ROW = 18;
/** Room for the status callout (state pill + detail line) at the very
 * bottom of the canvas. */
const STATUS_AREA = 56;
/** `style title-position bottom`: height of the title's own row when it
 * renders below everything else instead of above the plot. */
const BOTTOM_TITLE_ROW = 40;

/**
 * Spec §Layout step 9: "Combine identical positions into one marker
 * with ×N and list labels in the gutter." One entry per DISTINCT
 * (direction, value, boundary) triple. `representative` is (any) one
 * of the group's actual Constraint objects — same value_A/boundary_A
 * as every other member, by construction of the grouping key — used
 * where a group needs to be measured or plotted as if it were a single
 * criterion. Shared by the gutter/canvas sizing functions and the main
 * render loop so all three agree on what's actually drawn — sizing
 * gutters from individual labels while drawing combined ones is exactly
 * how a combined label overflows its gutter.
 */
interface ConstraintGroup {
  names: string[];
  representative: Constraint;
}
function groupConstraints(constraints: Constraint[]): ConstraintGroup[] {
  const map = new Map<string, ConstraintGroup>();
  for (const c of constraints) {
    const key = `${c.direction}|${c.value_A}|${c.boundary_A}`;
    const existing = map.get(key);
    if (existing) existing.names.push(c.label);
    else map.set(key, { names: [c.label], representative: c });
  }
  return [...map.values()];
}
function groupDisplayName(g: ConstraintGroup): string {
  return g.names.length > 1 ? g.names.join(', ') : g.names[0];
}

/**
 * Asymmetric label gutters (spec §Layout). Lower-family ("below")
 * labels are drawn in the left gutter and upper-family ("above") in the
 * right, so each side is sized from its own family's widest label. A
 * side with no criteria still reserves a little room for the first/last
 * axis tick label.
 */
function horizontalGutters(model: Resolved, fs: number): { left: number; right: number } {
  const groups = groupConstraints(model.constraints);
  const widest = (dir: 'below' | 'above') =>
    Math.max(0, ...groups.filter((g) => g.representative.direction === dir).map((g) => measureLabel(groupDisplayName(g), fs) + 24));
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
  const order = naturalY.map((_, i) => i).sort((a, b) => naturalY[a] - naturalY[b]);
  const aboveIdx = obstacle ? order.filter((i) => naturalY[i] <= mid) : order;
  const belowIdx = obstacle ? order.filter((i) => naturalY[i] > mid) : [];

  /* Above the obstacle: walk bottom-up, pushing each label further up
   * only when it would collide with the one below it (or the obstacle). */
  let ceiling = obstacle ? obstacle.top - minGap : Number.POSITIVE_INFINITY;
  for (let k = aboveIdx.length - 1; k >= 0; k--) {
    const i = aboveIdx[k];
    const y = Math.min(naturalY[i], ceiling);
    adjusted[i] = y;
    ceiling = y - minGap;
  }

  /* Below the obstacle: walk top-down, pushing each label further down
   * only when it would collide with the one above it (or the obstacle). */
  let floor = obstacle ? obstacle.bottom + minGap : Number.NEGATIVE_INFINITY;
  for (const i of belowIdx) {
    const y = Math.max(naturalY[i], floor);
    adjusted[i] = y;
    floor = y + minGap;
  }

  return adjusted;
}

/**
 * Vertical marker-collision avoidance — distinct from label decluttering
 * above, which only ever moves TEXT. Nothing kept the DOTS/BARS
 * themselves apart: two criteria whose full [criterion, margin] span
 * overlaps in y — which a large margin percentage can produce even when
 * the two criteria's own VALUES are far apart — render as one
 * indistinguishable blob. This does proper interval-graph colouring on
 * each group's full bar span [lo, hi]: sort by lo, and give each bar the
 * lowest-numbered column whose most recent occupant ends clear of this
 * bar's start. Columns cycle back (capped at MARKER_MAX_COLUMNS) for
 * anything denser than that.
 */
const MARKER_COLLISION_GAP = 20; // ~2x dot radius (r=6) plus label-text breathing room
const MARKER_COLUMN_PITCH = 20;
const MARKER_MAX_COLUMNS = 3;

function assignVerticalBarColumns(bars: { lo: number; hi: number }[]): number[] {
  const n = bars.length;
  const colOf = new Array<number>(n).fill(0);
  const order = bars.map((_, i) => i).sort((a, b) => bars[a].lo - bars[b].lo);

  /* Column 0 is the unshifted centre; odd columns step right, even
   * columns (2, 4, ...) step left, so a 3-column cluster reads as
   * centre / right / left rather than marching off in one direction. */
  const columnOffset = (col: number): number => {
    if (col === 0) return 0;
    const magnitude = Math.ceil(col / 2) * MARKER_COLUMN_PITCH;
    return col % 2 === 1 ? magnitude : -magnitude;
  };

  const colEnd: number[] = [];
  for (const i of order) {
    let col = 0;
    while (col < MARKER_MAX_COLUMNS - 1 && col < colEnd.length && colEnd[col] > bars[i].lo - MARKER_COLLISION_GAP) col++;
    colOf[i] = col;
    colEnd[col] = Math.max(colEnd[col] ?? -Infinity, bars[i].hi);
  }
  return colOf.map(columnOffset);
}

/** Content-driven default canvas size — see call site for rationale. */
function defaultCanvasSize(model: Resolved, o: 'horizontal' | 'vertical', fs: number): { width: number; height: number } {
  const groups = groupConstraints(model.constraints);
  const n = Math.max(groups.length, 1);
  if (o === 'vertical') {
    /* Width must fit the widest thing that lands in the label column:
     * a criterion's "name · value (margin X%)" text, or the status
     * detail line (which can run long for extreme log-scale ratios). */
    const labelX = verticalLabelX(40);
    const longestCriterion = Math.max(0, ...groups.map((g) => {
      const c = g.representative;
      const valueText = formatCondition(c.value_A) + (g.names.length > 1 ? ` ×${g.names.length}` : '') + voltageOverrideSuffix(c.entered);
      const m = marginLabel(c);
      const name = groupDisplayName(g);
      return measureLabel(m ? `${name} · ${valueText} (margin ${m})` : `${name} · ${valueText}`, fs);
    }));
    let statusW = 0;
    if (Number.isFinite(model.selection.value_A)) {
      statusW = measureLabel(statusText(model, PALETTES.accessible).detail, fs - 1);
    }
    const width = Math.max(420, labelX + Math.max(longestCriterion, statusW) + 40);
    const titleAllowance = model.choices.title === 'off' ? 90 : 130;
    const logBonus = model.axis.scale === 'log' ? 80 : 0;
    return { width, height: Math.max(320, titleAllowance + logBonus + n * 78) };
  }
  /* Lower- and upper-family rows share the same row sequence (see
   * layoutRows) whenever it's safe to — see canShareRows — so the plot
   * only needs to fit the LARGER family's row count once, rather than
   * both families stacked in separate halves. When it isn't safe, both
   * families still get their own half, so the height needs both. */
  const upperCount = groups.filter((g) => g.representative.direction === 'above').length;
  const lowerCount = groups.filter((g) => g.representative.direction === 'below').length;
  const maxFamily = Math.max(upperCount, lowerCount, 1);
  const shareRows = canShareRows(model.constraints);
  /* Width: gutters are label-driven, so the canvas grows to keep the
   * calibrated axis at least MIN_AXIS_WIDTH rather than squeezing it. */
  const { left, right } = horizontalGutters(model, fs);
  const minAxisWidth = model.axis.scale === 'log' ? MIN_AXIS_WIDTH_LOG : MIN_AXIS_WIDTH;
  const width = Math.max(760, PAD_L + PAD_R + left + right + minAxisWidth);
  /* Height: the shared row sequence needs headroom for its value text
   * (above) and margin text (below) per row; the two-half fallback
   * needs each family's own half, i.e. twice that. */
  const rowsNeed = shareRows ? maxFamily * ROW_PITCH + 40 : 2 * (maxFamily * ROW_PITCH + 40);
  const height = Math.max(240, padTB(model) + rowsNeed);
  return { width, height };
}

/**
 * Whether the lower and upper criterion families can safely share one
 * row sequence (spec §Layout: "much more compact ... numbers adjacent
 * to the dots"). Safe exactly when their MARGIN-ADJUSTED extents don't
 * overlap along the axis — lower values sit to one side, upper to the
 * other, so a shared row never puts one family's marker/text under the
 * other's. When margins are large enough to push the two families'
 * extents into each other (e.g. a preferred-interval conflict, where
 * the two boundaries have crossed by construction), sharing rows would
 * visually collide the two families' bars/text — fall back to the
 * safe two-half stack instead.
 */
function canShareRows(constraints: Constraint[]): boolean {
  const lowerReach = constraints.filter((c) => c.direction === 'below').map((c) => Math.max(c.value_A, c.boundary_A ?? c.value_A));
  const upperReach = constraints.filter((c) => c.direction === 'above').map((c) => Math.min(c.value_A, c.boundary_A ?? c.value_A));
  if (lowerReach.length === 0 || upperReach.length === 0) return true;
  return Math.max(...lowerReach) < Math.min(...upperReach);
}

/** Vertical padding the plot does not get to use (title + axis/status,
 * plus a secondary axis's own line/ticks/labels row and/or the zone
 * percent annotations' row, when present). Must mirror renderSvg's own
 * padT/padB formula, or the default canvas ends up sized for a
 * different stack than what actually gets drawn into it. */
function padTB(model: Resolved): number {
  const o = model.choices.orientation;
  const hasSecondaryTop = o === 'horizontal' && model.secondaryAxis?.position === 'top';
  const hasSecondaryBottom = o === 'horizontal' && model.secondaryAxis?.position === 'bottom';
  const hasZonePercent = o === 'horizontal' && !!model.selectedPercents && model.selectedPercents.length > 0;
  const hasSelection = Number.isFinite(model.selection.value_A);
  const hasIndicative = axisIsIndicative(model);
  const titleOn = model.choices.title !== 'off';
  const titleAtBottom = titleOn && model.choices.titlePosition === 'bottom';
  const titleAtTop = titleOn && !titleAtBottom;

  const topStackHeight = (hasZonePercent ? ZONE_PERCENT_ROW : 0) + (hasSecondaryTop ? SECONDARY_TOP_ROW : 0);
  const padT = (titleAtTop ? 60 : 28) + topStackHeight;

  const bottomAxisRow = o === 'horizontal' ? AXIS_TICK_ROW : 0;
  const bottomSelectedRow = o === 'horizontal' && hasSelection ? SELECTED_VALUE_ROW : 0;
  const bottomIndicativeRow = o === 'horizontal' && hasIndicative ? INDICATIVE_ROW : 0;
  const bottomSecondary = hasSecondaryBottom ? SECONDARY_AXIS_H : 0;
  const statusArea = o === 'horizontal' ? STATUS_AREA : (hasSelection ? 16 : STATUS_AREA);
  const padB = bottomAxisRow + bottomSelectedRow + bottomIndicativeRow + bottomSecondary + statusArea + (titleAtBottom ? BOTTOM_TITLE_ROW : 0);

  return padT + padB;
}

/** Layout one row per constraint. Vertical distributes rows evenly down
 * the whole plot as before. Horizontal now shares ONE row sequence
 * between the lower and upper families (staggered by half a pitch)
 * instead of splitting the plot into two family-only halves — see the
 * module doc comment for why. */
function layoutRows(constraints: Constraint[], o: 'horizontal' | 'vertical', plotH: number, padT: number): { cx: number; cy: number; labelX: number; labelY: number; labelAnchor: 'start' | 'end'; valueAbove: number; valueBelow: number; marginValueX: number }[] {
  const rows: { cx: number; cy: number; labelX: number; labelY: number; labelAnchor: 'start' | 'end'; valueAbove: number; valueBelow: number; marginValueX: number }[] = [];
  if (o !== 'horizontal') {
    for (let i = 0; i < constraints.length; i++) {
      const c = constraints[i];
      const y = padT + ((i + 0.5) / constraints.length) * plotH;
      rows.push({ cx: 0, cy: y, labelX: 0, labelY: 0, labelAnchor: c.direction === 'below' ? 'end' : 'start', valueAbove: 0, valueBelow: 0, marginValueX: 0 });
    }
    return rows;
  }
  /* Horizontal: split lower and upper families. When their margin-
   * adjusted extents don't overlap (canShareRows), let them share the
   * same row pitch, staggered by half a row so same-index dots from
   * each family don't land at the exact same y even when their values
   * happen to be close — this is what makes the common case compact.
   * When the extents DO overlap (large margins, or a preferred/mandatory
   * conflict where the two families' boundaries have crossed by
   * construction), sharing would visually collide the two families'
   * bars/text, so each family falls back to its own half of the plot
   * instead — the safe, previous behaviour. Index by the original
   * constraint position so rows[i] is the row for constraints[i]. */
  const lowerIdx: number[] = [];
  const upperIdx: number[] = [];
  for (let i = 0; i < constraints.length; i++) {
    if (constraints[i].direction === 'below') lowerIdx.push(i);
    else upperIdx.push(i);
  }
  const shareRows = canShareRows(constraints);
  const baseY = padT + ROW_PITCH * 0.5;
  const lowerBaseY = shareRows ? baseY + ROW_PITCH * 0.5 : padT + plotH * 0.5 + ROW_PITCH * 0.5;
  for (let k = 0; k < upperIdx.length; k++) {
    const i = upperIdx[k];
    const cy = baseY + k * ROW_PITCH;
    rows[i] = { cx: 0, cy, labelX: 0, labelY: cy + 4, labelAnchor: 'start', valueAbove: -11, valueBelow: 21, marginValueX: 0 };
  }
  for (let k = 0; k < lowerIdx.length; k++) {
    const i = lowerIdx[k];
    const cy = lowerBaseY + k * ROW_PITCH;
    rows[i] = { cx: 0, cy, labelX: 0, labelY: cy + 4, labelAnchor: 'end', valueAbove: -11, valueBelow: 21, marginValueX: 0 };
  }
  return rows;
}

function measureLabel(text: string, fs: number): number {
  /* Heuristic — sans-serif average character is ~0.55em wide. */
  return text.length * fs * 0.58 + 16;
}

/**
 * Title block. `titleAlign` (spec §Style: title-align) picks left /
 * center / right within the canvas; `bottomY`, when given, renders the
 * title as its own row at the BOTTOM of the canvas (spec: title-position
 * bottom) instead of the usual top-of-canvas block — same text, same
 * alignment rule, a divider on the opposite side of the text from the
 * plot either way.
 */
function header(model: Resolved, width: number, padL: number, padR: number, fs: number, theme: { foreground: string }, bottomY?: number): string {
  const align = model.choices.titleAlign;
  const x = align === 'left' ? padL : align === 'right' ? width - padR : width / 2;
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  if (bottomY !== undefined) {
    const textY = bottomY - 12;
    const lineY = bottomY - 24;
    return `<g data-role="header" data-position="bottom">
      <line x1="${padL}" y1="${lineY}" x2="${width - padR}" y2="${lineY}" stroke="#d0d7de" stroke-width="0.5"/>
      <text x="${x}" y="${textY}" font-size="${fs + 6}" font-weight="700" text-anchor="${anchor}" fill="${theme.foreground}">${escapeText(model.title)}</text>
    </g>`;
  }
  return `<g data-role="header">
    <text x="${x}" y="32" font-size="${fs + 6}" font-weight="700" text-anchor="${anchor}" fill="${theme.foreground}">${escapeText(model.title)}</text>
    <line x1="${padL}" y1="44" x2="${width - padR}" y2="44" stroke="#d0d7de" stroke-width="0.5"/>
  </g>`;
}

/** Spec §Scale: indicative scale MUST show a not-to-scale notice.
 * Anchored just below the axis, left-aligned at the axis's own start —
 * reads as an axis caption rather than a floating annotation, and does
 * the same in both orientations. */
function indicativeNotice(
  o: 'horizontal' | 'vertical',
  padL: number,
  padT: number,
  plotH: number,
  leftGutter: number,
  fs: number,
  theme: { callout: string },
  bottomAxisRow: number,
): string {
  const x = o === 'horizontal' ? padL + leftGutter : verticalAxisX(padL);
  const y = o === 'horizontal' ? padT + plotH + bottomAxisRow + 14 : padT + plotH + 28;
  return `<text data-role="indicative-notice" x="${x}" y="${y}" font-size="${fs - 2}" font-weight="700" text-anchor="start" letter-spacing="0.3" fill="${theme.callout}">Indicative spacing — not to scale</text>`;
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
  /* Signed headroom, annotated adjacent to the green zone itself —
   * "5.5 kA" / "+15.5%" — rather than only as a text line elsewhere on
   * the page (this is now the ONE place these numbers appear; the
   * footer status detail deliberately stops repeating them, see
   * statusText). */
  if (model.selectedPercents && model.selectedPercents.length > 0) {
    out.push(...zonePercentAnnotations(model, axis, padL, padT, plotW, plotH, o, palette, leftGutter, rightGutter));
  }
  void warnColor;
  return out;
}

function zonePercentAnnotations(
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
  const lines = model.selectedPercents ?? [];
  const out: string[] = [];
  /* Colour follows whether S is actually crossed for THIS boundary's
   * family, not the sign of `percent` — that sign now follows the
   * number line (positive = above, negative = below), not safety, so a
   * healthy upper-boundary reading is negative but still green. */
  const colorFor = (line: NonNullable<Resolved['selectedPercents']>[number]) =>
    !line.crossed ? palette.recommended : line.level === 'error' ? palette.conflict : palette.caution;
  /* model.preferredInterval, not model.controlling — the latter is
   * must-only (it exists for the no-compliant-setting text, which is
   * specifically about mandatory criteria) and silently ignores a
   * `should` boundary with no must+margin counterpart. selectedPercents
   * was computed against the SAME preferred-interval candidate set
   * (see controllingPreferredLower/Upper), so this is guaranteed
   * consistent with the percentage already shown. */
  const boundaryFor = (line: NonNullable<Resolved['selectedPercents']>[number]): number | undefined =>
    line.edge === 'lower' ? model.preferredInterval.minimum : model.preferredInterval.maximum;
  const kaText = (boundary_A: number) => formatCondition(boundary_A);
  const pctText = (line: NonNullable<Resolved['selectedPercents']>[number]) => {
    const sign = line.percent >= 0 ? '+' : '';
    return `${sign}${formatPercent(line.percent)}`;
  };

  if (o === 'horizontal') {
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    /* Two lines — the kA value, then the signed percentage beneath it —
     * flush against the plot's top edge, adjacent to the band. */
    const yKa = padT - 4 - 15;
    const yPct = padT - 4;
    const positioned = lines
      .map((line) => {
        const boundary_A = boundaryFor(line);
        if (boundary_A === undefined || !Number.isFinite(boundary_A)) return null;
        const x = xL + scalePos(model, axis, boundary_A / 1000, xR - xL);
        return { line, boundary_A, x, ka: kaText(boundary_A), pct: pctText(line) };
      })
      .filter((v): v is { line: NonNullable<Resolved['selectedPercents']>[number]; boundary_A: number; x: number; ka: string; pct: string } => v !== null)
      .sort((a, b) => a.x - b.x);

    /* Each label is flush against its OWN boundary line, growing INWARD
     * into the green band it describes — the lower edge's text starts
     * at the boundary and grows right, the upper edge's text ends at
     * the boundary and grows left — so the two only compete for space
     * when the green band itself is narrow, rather than always
     * colliding around a shared centre point the way two independently
     * centred labels would. */
    if (positioned.length === 2) {
      const [a, b] = positioned;
      const aWidth = Math.max(measureLabel(a.ka, 11), measureLabel(a.pct, 11));
      const bWidth = Math.max(measureLabel(b.ka, 11), measureLabel(b.pct, 11));
      if (b.x - a.x < aWidth + bWidth - 24) {
        /* Too narrow for both to grow inward without overlapping —
         * merge into one two-line block centred between them. */
        const cx = (a.x + b.x) / 2;
        out.push(`<text data-role="zone-percent" x="${cx}" y="${yKa}" font-size="11" font-weight="700" text-anchor="middle" fill="${colorFor(a.line)}">${escapeText(`${a.ka} · ${b.ka}`)}</text>`);
        out.push(`<text data-role="zone-percent" x="${cx}" y="${yPct}" font-size="11" font-weight="700" text-anchor="middle" fill="${colorFor(a.line)}">${escapeText(`${a.pct} · ${b.pct}`)}</text>`);
        return out;
      }
    }
    for (const p of positioned) {
      const anchor = p.line.edge === 'lower' ? 'start' : 'end';
      const color = colorFor(p.line);
      out.push(`<text data-role="zone-percent" data-edge="${p.line.edge}" x="${p.x}" y="${yKa}" font-size="11" font-weight="700" text-anchor="${anchor}" fill="${color}">${escapeText(p.ka)}</text>`);
      out.push(`<text data-role="zone-percent" data-edge="${p.line.edge}" x="${p.x}" y="${yPct}" font-size="11" font-weight="700" text-anchor="${anchor}" fill="${color}">${escapeText(p.pct)}</text>`);
    }
    return out;
  }

  /* Vertical: hug the axis itself — text starts just to the right of
   * the axis line (spec: "on the axis"), growing into the colour band
   * toward the marker column, with a short pale leader back to the
   * boundary's true position on the axis whenever the label had to move
   * to stay clear of the selected line/label. */
  const zoneX = verticalAxisX(padL) + 6;
  const positioned = lines
    .map((line) => {
      const boundary_A = boundaryFor(line);
      if (boundary_A === undefined || !Number.isFinite(boundary_A)) return null;
      return { line, boundary_A, y: verticalY(model, axis, boundary_A / 1000, padT, plotH), ka: kaText(boundary_A), pct: pctText(line) };
    })
    .filter((v): v is { line: NonNullable<Resolved['selectedPercents']>[number]; boundary_A: number; y: number; ka: string; pct: string } => v !== null);
  if (positioned.length === 0) return out;
  const selY = Number.isFinite(model.selection.value_A)
    ? verticalYClamped(model, axis, model.selection.value_A / 1000, padT, plotH)
    : null;
  const exclusionTop = selY === null ? -Infinity : selY - 26;
  const exclusionBottom = selY === null ? Infinity : selY + 12;
  const clear = (y: number) => y < exclusionTop || y > exclusionBottom;

  const placed = positioned
    .map((p) => {
      const isUpper = p.line.edge === 'upper';
      const inside = p.y + (isUpper ? 12 : -12);
      const outside = p.y + (isUpper ? -12 : 12);
      const y = clear(inside) ? inside : clear(outside) ? outside : null;
      return y === null ? null : { ...p, y };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.y - b.y);

  const emitLeader = (naturalY: number, labelY: number) => {
    if (Math.abs(labelY - naturalY) < 3) return '';
    const axisX = verticalAxisX(padL);
    return `<line data-role="leader" x1="${axisX}" y1="${naturalY}" x2="${zoneX - 4}" y2="${labelY}" stroke="#cdd2d8" stroke-width="0.6"/><circle data-role="leader-end" cx="${axisX}" cy="${naturalY}" r="1.5" fill="#cdd2d8"/>`;
  };

  if (placed.length === 2 && Math.abs(placed[1].y - placed[0].y) < 15) {
    const cyMerged = (placed[0].y + placed[1].y) / 2;
    out.push(emitLeader(placed[0].y, cyMerged));
    out.push(emitLeader(placed[1].y, cyMerged));
    out.push(`<text data-role="zone-percent" x="${zoneX}" y="${cyMerged}" font-size="11" font-weight="700" text-anchor="start" fill="${colorFor(placed[0].line)}">${escapeText(`${placed[0].ka} ${placed[0].pct} · ${placed[1].ka} ${placed[1].pct}`)}</text>`);
    return out;
  }
  for (const p of placed) {
    out.push(emitLeader(p.y, p.y));
    out.push(`<text data-role="zone-percent" data-edge="${p.line.edge}" x="${zoneX}" y="${p.y}" font-size="11" font-weight="700" text-anchor="start" fill="${colorFor(p.line)}">${escapeText(`${p.ka} ${p.pct}`)}</text>`);
  }
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
  const visible = ticks.filter((t) => t >= axis.minimum && t <= axis.maximum);
  /* Spec §Axis: the unit (kA / A) is shown once, on the outermost tick,
   * rather than repeated on every tick — a bare number reads faster
   * once the reader knows the axis's unit, and repeating it on every
   * tick is the more cluttered convention. Only safe when every tick
   * actually shares ONE unit — an indicative or wide-range axis can mix
   * sub-1kA and multi-kA values, where a bare number would be genuinely
   * ambiguous (is "200" 200 A or 200 kA?); those keep a unit on every
   * tick, same as before. */
  const uniformUnit = !mixesUnits(visible);
  const unitTickIndex = visible.length - 1;
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
    visible.forEach((t, idx) => {
      const x = xL + scalePos(model, axis, t, xRange);
      out.push(`<line x1="${x}" y1="${padT + plotH - 4}" x2="${x}" y2="${padT + plotH + 4}" stroke="${theme.axis}" stroke-width="1"/>`);
      const label = !uniformUnit || idx === unitTickIndex ? formatTick(t) : formatTickBare(t);
      out.push(`<text x="${x}" y="${padT + plotH + 22}" font-size="${fs - 1}" text-anchor="middle" fill="${theme.foreground}">${label}</text>`);
    });
  } else {
    /* Calibrated axis on the left, ticks and labels to its left, matching
     * the spec's vertical reference figure. */
    const axisX = verticalAxisX(padL);
    out.push(`<line x1="${axisX}" y1="${padT}" x2="${axisX}" y2="${padT + plotH}" stroke="${theme.axis}" stroke-width="1"/>`);
    /* The topmost tick (largest value) carries the unit — matches the
     * horizontal axis's own "unit on the outermost tick" convention. */
    const topMostIndex = visible.length - 1;
    visible.forEach((t, idx) => {
      const y = verticalY(model, axis, t, padT, plotH);
      out.push(`<line x1="${axisX - 4}" y1="${y}" x2="${axisX + 4}" y2="${y}" stroke="${theme.axis}" stroke-width="1"/>`);
      const label = !uniformUnit || idx === topMostIndex ? formatTick(t) : formatTickBare(t);
      out.push(`<text x="${axisX - 10}" y="${y + 4}" font-size="${fs - 1}" text-anchor="end" fill="${theme.foreground}">${label}</text>`);
    });
  }
  void padR;
  return out.join('\n');
}

/**
 * `secondary axis` (spec §Secondary axis, horizontal only): a second
 * calibrated axis on the opposite side of the plot, relabelling the
 * SAME physical x positions in a different quantity/voltage. Ticks are
 * generated as "nice" round numbers in the secondary quantity's own
 * units, then each one is converted back to its shared amp position —
 * they don't line up with the primary axis's own ticks, by design,
 * since a nice kA number rarely converts to a nice MVA number. Styled
 * to match the primary axis (solid line, same tick length) rather than
 * a visually distinct dashed line, per spec §Axis: "a secondary axis
 * MUST read as an axis, not as a decoration."
 */
function secondaryAxisFrame(
  model: Resolved,
  axis: Resolved['axis'],
  secondaryAxis: NonNullable<Resolved['secondaryAxis']>,
  padL: number,
  padT: number,
  plotW: number,
  plotH: number,
  fs: number,
  theme: { axis: string; foreground: string },
  leftGutter: number,
  rightGutter: number,
  /** `top` only: whether the zone-percent row is also present, so this
   * axis's own block stacks just above IT (rather than above the plot
   * directly) — both end up adjacent to the plot, in the same styled
   * strip, ordered zone-percent innermost. */
  hasZonePercent = false,
): string {
  const out: string[] = [];
  const xL = padL + leftGutter;
  const xR = padL + plotW - rightGutter;
  const xRange = xR - xL;
  const voltage_kV = secondaryAxis.voltage_kV;

  const toSecondaryUnit = (v_kA: number): number =>
    secondaryAxis.quantity === 'kA' || voltage_kV === undefined ? v_kA : toMVA(v_kA * 1000, voltage_kV);
  const toAxisKA = (v_secondary: number): number =>
    secondaryAxis.quantity === 'kA' || voltage_kV === undefined ? v_secondary : mvaToAmps(v_secondary, voltage_kV) / 1000;

  const secA = toSecondaryUnit(axis.minimum);
  const secB = toSecondaryUnit(axis.maximum);
  const secTicks = buildTicks(Math.min(secA, secB), Math.max(secA, secB), axis.scale === 'indicative' ? 'linear' : axis.scale)
    .filter((t) => {
      const posKA = toAxisKA(t);
      return posKA >= axis.minimum && posKA <= axis.maximum;
    });

  const isTop = secondaryAxis.position === 'top';
  /* `top`: adjacent to the plot (or to the zone-percent row, if that's
   * also present, so the two stay stacked together right next to the
   * band rather than either floating apart) — the selected label was
   * already pushed up above this whole stack by topStackHeight in
   * renderSvg, so there's no longer a risk of colliding with it here.
   * `bottom` must additionally clear the PRIMARY axis's own tick-label
   * row, which already occupies padT+plotH+22 (frame()'s own layout). */
  const zoneBoundary = padT - (hasZonePercent ? ZONE_PERCENT_ROW : 0);
  const bandStart = isTop ? zoneBoundary - SECONDARY_TOP_ROW : padT + plotH;
  const lineY = isTop ? zoneBoundary - 14 : bandStart + 40;
  const labelY = isTop ? zoneBoundary - 28 : bandStart + 58;
  const tickDir = isTop ? -1 : 1;

  out.push(`<line data-role="secondary-axis" x1="${xL}" y1="${lineY}" x2="${xR}" y2="${lineY}" stroke="${theme.axis}" stroke-width="1"/>`);
  const unitTickIndex = secTicks.length - 1;
  const uniformSecUnit = secondaryAxis.quantity !== 'kA' || !mixesUnits(secTicks);
  secTicks.forEach((t, idx) => {
    const posKA = toAxisKA(t);
    const x = xL + scalePos(model, axis, posKA, xRange);
    out.push(`<line x1="${x}" y1="${lineY}" x2="${x}" y2="${lineY + tickDir * 4}" stroke="${theme.axis}" stroke-width="1"/>`);
    const showUnit = !uniformSecUnit || idx === unitTickIndex;
    const label = secondaryAxis.quantity === 'kA'
      ? (showUnit ? formatTick(t) : formatTickBare(t))
      : (showUnit ? `${formatPlain(t, 1)} MVA` : formatPlain(t, 1));
    out.push(`<text x="${x}" y="${labelY}" font-size="${fs - 1}" text-anchor="middle" fill="${theme.foreground}">${escapeText(label)}</text>`);
  });
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

/** Same magnitude convention as formatTick, without the unit suffix —
 * used for every tick except the one that carries the axis's unit. */
function formatTickBare(v: number): string {
  if (v <= 0) return '0';
  if (v >= 1000) return formatPlain(v / 1000);
  if (v < 1) return formatPlain(v * 1000);
  return formatPlain(v);
}

/** Whether formatTick would pick a DIFFERENT unit for different ticks in
 * this set (some under 1 kA, shown in A; others 1 kA or over, shown in
 * kA) — an indicative or very-wide-range axis can legitimately span
 * both. Showing the unit only once is only safe when it's the same unit
 * throughout; otherwise a bare number is genuinely ambiguous. */
function mixesUnits(values: number[]): boolean {
  let sawSub1 = false;
  let sawAtOrAbove1 = false;
  for (const v of values) {
    if (v <= 0) continue;
    if (v < 1) sawSub1 = true;
    else sawAtOrAbove1 = true;
  }
  return sawSub1 && sawAtOrAbove1;
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
  /** Spec §Layout step 9: "Combine identical positions into one marker
   * with ×N and list labels in the gutter." Names of every criterion
   * sharing this exact marker position, when there's more than one —
   * null for the (overwhelmingly common) single-criterion case. */
  groupNames: string[] | null,
  /** Vertical only: horizontal shift assigned by
   * assignVerticalBarColumns when this marker's bar would otherwise
   * overlap a neighbour's. 0 for everything else. */
  markerXOffset: number,
): string {
  void plotW;
  const out: string[] = [];
  /* `reference` criteria plot but never enter the mandatory/preferred
   * calculation (spec §Requirement levels) — a neutral colour, distinct
   * from both criterion families, keeps them from reading as a
   * compliance-bearing marker. */
  const isReference = c.requirement === 'reference';
  const family = isReference ? palette.mandatory : c.direction === 'below' ? palette.lower : palette.upper;
  const bg = THEMES[model.choices.theme]?.background ?? '#ffffff';
  /* Spec §Normative visual encoding: "Criterion: filled circle." An
   * open circle in the neutral colour signals "this is something else"
   * without needing a new shape or a legend entry. */
  const criterionDot = (cx: number, cy: number): string =>
    isReference
      ? `<circle data-role="criterion" data-requirement="reference" cx="${cx}" cy="${cy}" r="5" fill="${bg}" stroke="${family}" stroke-width="2"/>`
      : `<circle data-role="criterion" cx="${cx}" cy="${cy}" r="6" fill="${family}"/>`;
  const marginText = marginLabel(c);
  const countSuffix = groupNames && groupNames.length > 1 ? ` ×${groupNames.length}` : '';
  const displayName = groupNames && groupNames.length > 1 ? groupNames.join(', ') : c.label;

  if (o === 'vertical') {
    const markerX = verticalMarkerX(padL) + markerXOffset;
    const critSide = axisClampSide(c.value_A / 1000, axis);
    const yC = verticalYClamped(model, axis, c.value_A / 1000, padT, plotH);
    const marginSide = c.boundary_A !== null && Number.isFinite(c.boundary_A) ? axisClampSide(c.boundary_A / 1000, axis) : null;
    const yM = c.boundary_A !== null && Number.isFinite(c.boundary_A)
      ? verticalYClamped(model, axis, c.boundary_A / 1000, padT, plotH)
      : null;

    if (yM !== null) {
      const lo = Math.min(yC, yM);
      const hi = Math.max(yC, yM);
      out.push(`<line data-role="criterion-bar" x1="${markerX}" y1="${lo}" x2="${markerX}" y2="${hi}" stroke="${family}" stroke-width="6" stroke-linecap="butt" opacity="0.9"/>`);
      if (marginSide !== null) {
        out.push(offRangeTriangleV(markerX, yM, marginSide, family));
      } else {
        /* Open (margin) dot drawn BEFORE the filled criterion dot: a
         * small percentage margin on a log-scale axis can land the two
         * centres only a couple of pixels apart, and the open dot's
         * opaque fill would otherwise erase the filled one drawn under
         * it. */
        out.push(`<circle data-role="margin" cx="${markerX}" cy="${yM}" r="6" fill="${bg}" stroke="${family}" stroke-width="2"/>`);
      }
    }

    if (critSide !== null) {
      out.push(offRangeTriangleV(markerX, yC, critSide, family));
    } else {
      out.push(criterionDot(markerX, yC));
    }

    if (yM !== null && marginSide === null && model.choices.arrows !== 'off') {
      /* Arrow points toward acceptable values: for `below`, acceptable
       * values are higher, i.e. UP the vertical axis (smaller y); for
       * `above`, acceptable values are lower, i.e. DOWN (larger y).
       * Skipped when the margin itself is off-range — its exact
       * boundary position isn't on the visible axis to point from —
       * or when `style arrows off` opts out of them entirely. Sits
       * close against the open dot rather than floating well clear of
       * it, so it still reads as "this dot's direction". */
      const arrowDir = c.direction === 'below' ? -1 : 1;
      const arrowStart = yM + arrowDir * 9;
      const arrowEnd = yM + arrowDir * 17;
      out.push(`<g data-role="arrow" transform="translate(${markerX}, ${arrowStart})">
        <line x1="0" y1="0" x2="0" y2="${arrowEnd - arrowStart}" stroke="${family}" stroke-width="1.5" opacity="0.85"/>
        <polyline points="-3,${arrowEnd - arrowStart + arrowDir * -4} 0,${arrowEnd - arrowStart} 3,${arrowEnd - arrowStart + arrowDir * -4}" fill="none" stroke="${family}" stroke-width="1.5"/>
      </g>`);
    }

    /* Label column to the right, with a pale leader from the criterion
     * dot, aligned left-to-right with the bubble it describes: bubble,
     * then leader, then label text, in reading order. The value (and
     * margin, if any) is inlined into the label text — matching the
     * spec's vertical reference figure — rather than floated
     * separately, which is what caused clutter/overlap. When the
     * declutter pass has moved the label off the marker's true y
     * (vLabelY), the leader angles to follow — spec §Layout: "move it
     * vertically within its row and extend a short pale leader." */
    const labelX = verticalLabelX(padL);
    const labelY = vLabelY ?? yC;
    const valueText = formatCondition(c.value_A) + countSuffix + voltageOverrideSuffix(c.entered);
    const fullLabel = marginText ? `${displayName} · ${valueText} (margin ${marginText})` : `${displayName} · ${valueText}`;
    out.push(`<line data-role="leader" x1="${markerX + 10}" y1="${yC}" x2="${labelX - 6}" y2="${labelY}" stroke="#cdd2d8" stroke-width="0.6"/>`);
    out.push(`<circle data-role="leader-end" cx="${labelX - 6}" cy="${labelY}" r="1.5" fill="#cdd2d8"/>`);
    out.push(`<text data-role="criterion-label" x="${labelX}" y="${labelY + 4}" font-size="${fs}" text-anchor="start" fill="${theme.foreground}">${escapeText(fullLabel)}</text>`);

    return out.join('\n');
  }

  const xL = padL + leftGutter;
  const xR = padL + plotW - rightGutter;
  const xRange = xR - xL;
  const critSide = axisClampSide(c.value_A / 1000, axis);
  const xC = critSide === 'low' ? xL : critSide === 'high' ? xR : xL + scalePos(model, axis, c.value_A / 1000, xRange);
  const marginSide = c.boundary_A !== null && Number.isFinite(c.boundary_A) ? axisClampSide(c.boundary_A / 1000, axis) : null;
  const xM = c.boundary_A !== null && Number.isFinite(c.boundary_A)
    ? (marginSide === 'low' ? xL : marginSide === 'high' ? xR : xL + scalePos(model, axis, c.boundary_A / 1000, xRange))
    : null;
  const y = row.cy;

  /* thick coloured bar between criterion and its margin */
  if (xM !== null) {
    const lo = Math.min(xC, xM);
    const hi = Math.max(xC, xM);
    out.push(`<line data-role="criterion-bar" x1="${lo}" y1="${y}" x2="${hi}" y2="${y}" stroke="${family}" stroke-width="6" stroke-linecap="butt" opacity="0.9"/>`);
    if (marginSide !== null) {
      out.push(offRangeTriangleH(xM, y, marginSide, family));
    } else {
      /* Open (margin) dot drawn BEFORE the filled criterion dot: a
       * small percentage margin on a log-scale axis can land the two
       * centres only a couple of pixels apart, and the open dot's
       * opaque fill would otherwise erase the filled one drawn under
       * it. */
      out.push(`<circle data-role="margin" cx="${xM}" cy="${y}" r="6" fill="${bg}" stroke="${family}" stroke-width="2"/>`);
    }
  }

  if (critSide !== null) {
    out.push(offRangeTriangleH(xC, y, critSide, family));
  } else {
    out.push(criterionDot(xC, y));
  }
  /* value text above the criterion — spec §Range: showing the exact
   * value and unit here is what makes an off-range marker "explicit"
   * rather than a bare clipped glyph. */
  out.push(`<text data-role="criterion-value" x="${xC}" y="${y + row.valueAbove}" font-size="${fs - 1}" text-anchor="middle" font-weight="600" fill="${family}">${escapeText(formatCondition(c.value_A) + countSuffix + voltageOverrideSuffix(c.entered))}</text>`);

  /* margin value text BELOW the open dot, and the direction arrow
   * OUTSIDE the open dot in the acceptable direction. The arrow points
   * TOWARD acceptable values; skipped when the margin is off-range —
   * its exact boundary position isn't on the visible axis to point
   * from — but the value text is kept for the same reason as above. */
  if (xM !== null) {
    if (marginText) {
      out.push(`<text data-role="margin-value" x="${xM}" y="${y + row.valueBelow}" font-size="${fs - 1}" text-anchor="middle" fill="${theme.callout}">${escapeText(marginText)}</text>`);
    }
    if (marginSide === null && model.choices.arrows !== 'off') {
      /* short direction arrow outside the open dot pointing to acceptable
       * values. For `below` constraints the selected must be > criterion,
       * so the arrow at the open margin boundary points RIGHT (toward
       * higher values, which are the acceptable side). For `above` the
       * arrow points LEFT. Sits close against the dot — `style arrows
       * off` removes it entirely for a reader who finds it redundant
       * with the margin value/leader already shown. */
      const arrowDir = c.direction === 'below' ? 1 : -1;
      const arrowStart = xM + arrowDir * 9;
      const arrowEnd = xM + arrowDir * 17;
      out.push(`<g data-role="arrow" transform="translate(${arrowStart}, ${y})">
        <line x1="0" y1="0" x2="${arrowEnd - arrowStart}" y2="0" stroke="${family}" stroke-width="1.5" opacity="0.85"/>
        <polyline points="${arrowEnd - arrowStart + arrowDir * -4},-3 ${arrowEnd - arrowStart},0 ${arrowEnd - arrowStart + arrowDir * -4},3" fill="none" stroke="${family}" stroke-width="1.5"/>
      </g>`);
    }
  }

  /* label on the FAR side with a pale leader to the criterion */
  const labelOnLeft = c.direction === 'below';
  const labelX = labelOnLeft ? xL - 12 : xR + 12;
  const labelY = y + 4;
  const labelAnchor = labelOnLeft ? 'end' : 'start';
  out.push(`<line data-role="leader" x1="${labelOnLeft ? xC : labelX}" y1="${y}" x2="${labelOnLeft ? labelX : xC}" y2="${y}" stroke="#cdd2d8" stroke-width="0.6"/>`);
  out.push(`<circle data-role="leader-end" cx="${labelOnLeft ? labelX : xC}" cy="${y}" r="1.5" fill="#cdd2d8"/>`);
  out.push(`<text data-role="criterion-label" x="${labelX}" y="${labelY}" font-size="${fs}" text-anchor="${labelAnchor}" fill="${theme.foreground}">${escapeText(displayName)}</text>`);

  return out.join('\n');
}

function marginLabel(c: Constraint): string {
  if (!c.margin) return '';
  if (c.margin.kind === 'percentage') return `${formatPlain(c.margin.value)}%`;
  return formatCondition(c.margin.value);
}

/** A kVA/MVA quantity entered with its own `@ X kV` (spec §Per-quantity
 * voltage), converted to amps using that voltage — flag it on the
 * diagram itself, next to the value it produced, rather than leaving it
 * only inferable from the source text. `A`/`kA` quantities MAY also
 * carry `@` syntactically, but spec §Per-quantity voltage says it "has
 * no effect on the resolved value" there, so showing it would imply a
 * dependency that doesn't exist. */
function voltageOverrideSuffix(entered: { unit: string; voltageOverride?: { value: number } } | undefined): string {
  if (!entered?.voltageOverride || (entered.unit !== 'kVA' && entered.unit !== 'MVA')) return '';
  return ` (@ ${formatPlain(entered.voltageOverride.value)} kV)`;
}

/**
 * The selected-value label parts (spec §Displayed quantities). `prefix`
 * is the word/name shown above the plot (task: kept separate from the
 * number so the number can live at the axis instead). `primary` is the
 * main value line (entered quantity, if shown, then the setting value).
 * `above`/`below` carry the MVA and secondary-amp equivalents when
 * requested — split across the two so a diagram with both isn't a
 * single long run-on line.
 */
interface SelectedLabelParts {
  prefix: string;
  primary: string;
  above?: string;
  below?: string;
}

function selectedLabelParts(model: Resolved): SelectedLabelParts {
  const d = model.display;
  const t = model.displayToggle;
  const primaryParts: string[] = [];
  if (t.showEntered && d?.entered) primaryParts.push(d.entered.text);
  const voltageSuffix = t.showEntered && d?.entered ? '' : voltageOverrideSuffix(model.selection.entered);
  primaryParts.push(formatSetting(model.selection.value_A) + voltageSuffix);
  /* `word selected "…"` configures the generic word; the `selected
   * "name"` statement's own label, when given, NAMES the value itself
   * and takes precedence — spec §Selection: "the label, if present,
   * identifies what is being set, and replaces the generic prefix." */
  const prefix = model.selection.label || model.choices.words.selected || 'Selected';
  const above = t.showMva && d?.mva ? d.mva.text : undefined;
  const below = t.showSecondary && d?.secondary ? `${d.secondary.text} sec` : undefined;
  return { prefix, primary: primaryParts.join(' · '), above, below };
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
  /** Horizontal only: combined height of the zone-percent/secondary-axis
   * rows now stacked between the selected label and the plot — the
   * label sits this far above its original padT-12 offset so it stays
   * the TOPMOST element in that stack, per spec's ordering. */
  topStackHeight = 0,
  /** Horizontal only: height of the axis line/ticks/number row directly
   * below the plot — the selected value's own row stacks just under
   * that. */
  bottomAxisRow = 0,
): string {
  const out: string[] = [];
  const parts = selectedLabelParts(model);
  /* `range focus` bounds the axis around the controlling boundaries;
   * the selection is normally within them (spec: focus "focuses on
   * ... the selected value"), but a do-not-set selection can still
   * fall outside — clamp so the line stays on the visible plot rather
   * than vanishing off it (model.ts emits PSDL204 for this too). */
  const selSide = axisClampSide(model.selection.value_A / 1000, axis);
  if (o === 'horizontal') {
    const xL = padL + leftGutter;
    const xR = padL + plotW - rightGutter;
    const xRange = xR - xL;
    const x = selSide === 'low' ? xL : selSide === 'high' ? xR : xL + scalePos(model, axis, model.selection.value_A / 1000, xRange);
    out.push(`<line data-role="selected-line" x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${palette.selected}" stroke-width="2"/>`);
    /* Word label stays above the plot — spec §Selected-setting label:
     * the NUMBER moves to the axis, the word doesn't. */
    out.push(`<text data-role="selected-label" x="${x}" y="${padT - 12 - topStackHeight}" font-size="${fs + 1}" font-weight="700" fill="${palette.selected}" text-anchor="middle">${escapeText(parts.prefix)}</text>`);
    /* On the axis itself, not mid-plot — mid-plot put it in the same
     * lane as whichever criterion row happened to land there, colliding
     * with that row's dot/value text. The axis is a lane nothing else
     * occupies, so anchoring here guarantees no collision regardless of
     * how many criterion rows there are. */
    out.push(`<circle data-role="selected-marker-dot" cx="${x}" cy="${padT + plotH}" r="6" fill="${palette.selected}"/>`);
    /* Numeric value(s) on their own row just below the axis's own
     * tick-label row — spec: "written on the axis or below it, not
     * repeated above the plot." */
    const valueParts = [parts.primary, parts.above, parts.below].filter((v): v is string => !!v);
    const valueY = padT + plotH + bottomAxisRow + 14;
    out.push(`<text data-role="selected-value" x="${x}" y="${valueY}" font-size="${fs - 1}" font-weight="700" fill="${palette.selected}" text-anchor="middle">${escapeText(valueParts.join(' · '))}</text>`);
  } else {
    const y = verticalYClamped(model, axis, model.selection.value_A / 1000, padT, plotH);
    /* The line now runs from the axis to just past the marker column —
     * short enough to stop before the tick-number column on the axis's
     * OTHER side (spec: "MUST NOT cross the vertical scale numbers")
     * and before the far label column, rather than spanning the whole
     * plot width. */
    const axisX = verticalAxisX(padL);
    const lineEndX = verticalMarkerX(padL) + 40;
    out.push(`<line data-role="selected-line" x1="${axisX}" y1="${y}" x2="${lineEndX}" y2="${y}" stroke="${palette.selected}" stroke-width="2"/>`);
    out.push(`<circle data-role="selected-marker-dot" cx="${verticalMarkerX(padL)}" cy="${y}" r="6" fill="${palette.selected}"/>`);
    /* Label sits on the RIGHT of the (now short) line, not in the far
     * label column — primary value on the line itself, MVA above it and
     * secondary amps below it when both are requested, so neither
     * stacks into a single long run-on line. */
    const labelX = lineEndX + 10;
    out.push(`<text data-role="selected-label" x="${labelX}" y="${y + 4}" font-size="${fs + 1}" font-weight="700" fill="${palette.selected}" text-anchor="start">${escapeText(`${parts.prefix} ${parts.primary}`)}</text>`);
    if (parts.above) {
      out.push(`<text data-role="selected-value-above" x="${labelX}" y="${y - 10}" font-size="${fs - 1}" font-weight="600" fill="${palette.selected}" text-anchor="start">${escapeText(parts.above)}</text>`);
    }
    if (parts.below) {
      out.push(`<text data-role="selected-value-below" x="${labelX}" y="${y + 22}" font-size="${fs - 1}" font-weight="600" fill="${palette.selected}" text-anchor="start">${escapeText(parts.below)}</text>`);
    }
  }
  return out.join('\n');
}

/**
 * State word, its colour, and the detail line — shared between the
 * horizontal footer callout and the vertical inline status text.
 *
 * `state` is null for the two cases the diagram should not pass
 * judgement on at all: no setpoint exists to judge (`no-selection`),
 * or the preferred bounds cross while the mandatory ones still don't
 * (`no-recommended-setting` — correctable by loosening a margin, not
 * a hard error). Both show the relevant numbers instead of a verdict
 * word — what one is "recommended" or "wrong" here is a report-writing
 * decision, not the diagram's to make. `no-compliant-setting` (the
 * mandatory bounds themselves cross — no setting exists that clears
 * every hard criterion) keeps a state word: that is a real error, not
 * a preference gap, and spec §Conflicting mandatory constraints
 * requires it be shown unambiguously.
 */
function statusText(model: Resolved, palette: { selected: string; caution: string; conflict: string }): { state: string | null; stateColor: string; detail: string } {
  const amps = (v: number) => Number.isFinite(v) ? formatCondition(v) : 'unbounded';

  if (model.status === 'no-selection') {
    const p = model.preferredInterval;
    const m = model.mandatoryInterval;
    const hasPreferred = Number.isFinite(p.minimum) || Number.isFinite(p.maximum);
    const detail = hasPreferred
      ? `Preferred range ${amps(p.minimum)} – ${amps(p.maximum)}`
      : `Compliant range ${amps(m.minimum)} – ${amps(m.maximum)}`;
    return { state: null, stateColor: palette.caution, detail };
  }
  if (model.status === 'no-recommended-setting') {
    const p = model.preferredInterval;
    return { state: null, stateColor: palette.caution, detail: `Preferred ${amps(p.minimum)} and ${amps(p.maximum)}` };
  }
  if (model.status === 'recommended') {
    /* Nothing to say here that isn't already obvious from the marker
     * sitting in the green zone, or already stated by the zone percent
     * annotations themselves — a "Recommended" label would just be
     * announcing the diagram's own colour back at the reader. */
    return { state: null, stateColor: palette.selected, detail: '' };
  }

  const state = (() => {
    const words = model.choices.words;
    const w = (k: WordName, fb: string) => words[k] ?? fb;
    switch (model.status) {
      case 'caution': return w('caution', 'Caution');
      case 'do-not-set': return w('do-not-set', 'Do not set');
      case 'no-compliant-setting': return w('no-compliant', 'No compliant setting');
      /* 'no-selection', 'no-recommended-setting' and 'recommended' are
       * handled by the early returns above — excluded from this
       * switch's type by that point, so TS already treats this as
       * exhaustive without them. */
    }
  })();
  /* Only caution/do-not-set/no-compliant-setting reach here —
   * 'recommended' already returned above. */
  const stateColor = model.status === 'caution' ? palette.caution : palette.conflict;

  /* detail line — recommended/caution/do-not-set no longer repeat
   * model.selectedPercents here: those are now annotated directly on
   * the green zone itself (see zonePercentAnnotations), so restating
   * them in the footer would just be the same numbers twice. */
  let detail = '';
  if (model.status === 'no-compliant-setting') {
    /* Named criteria and their values, not a width/percentage "conflict"
     * figure — the two numbers alone (spec's mandatoryInterval bounds)
     * are what actually explains a mandatory-side clash. */
    const m = model.mandatoryInterval;
    const lower = model.controlling.lower ? `"${model.controlling.lower.label}" ${amps(model.controlling.lower.boundary_A)}` : amps(m.minimum);
    const upper = model.controlling.upper ? `"${model.controlling.upper.label}" ${amps(model.controlling.upper.boundary_A)}` : amps(m.maximum);
    detail = `Mandatory ${lower} and ${upper}`;
  }
  if (!detail && model.status === 'do-not-set') {
    detail = 'selected value crosses a mandatory criterion';
  }
  return { state, stateColor, detail };
}

/** Horizontal (and no-selection fallback) status callout. `anchorX`
 * defaults to the plot centre but is normally the selected line's own
 * x — spec's reference figures place the status directly beneath the
 * selected setpoint, not centred on the whole canvas. `titleAtBottom`
 * shifts the callout up so it stays clear of the bottom title row. */
function statusCallout(model: Resolved, anchorX: number, height: number, fs: number, theme: { callout: string; foreground: string }, palette: { selected: string; caution: string; conflict: string }, titleAtBottom = false): string {
  const out: string[] = [];
  const { state, stateColor, detail } = statusText(model, palette);

  const cy = height - 36 - (titleAtBottom ? BOTTOM_TITLE_ROW : 0);

  if (state === null) {
    /* no-recommended-setting / no-selection: no verdict word, just the
     * range values as plain neutral text (no pill, no bold).
     * `recommended` also lands here with an empty detail — nothing to
     * say that isn't already shown by the marker and zone annotations,
     * so skip the element entirely rather than emit empty text. */
    if (detail) {
      out.push(`<text x="${anchorX}" y="${cy}" font-size="${fs - 1}" fill="${theme.callout}" text-anchor="middle">${escapeText(detail)}</text>`);
    }
    return out.join('\n');
  }

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

/** Vertical status text — placed beneath the (now shortened) selected
 * line, in the same right-of-line column as the selected label, always
 * leaving room for a 3-line selected-value stack (primary + optional
 * above/below) so it doesn't need to know exactly which of those lines
 * are present. */
function verticalStatusText(model: Resolved, y: number, padL: number, fs: number, theme: { callout: string }, palette: { selected: string; caution: string; conflict: string }): string {
  const { state, stateColor, detail } = statusText(model, palette);
  const x = verticalMarkerX(padL) + 50;
  const baseY = y + 40;
  const out: string[] = [];
  if (state === null) {
    /* no-recommended-setting / no-selection: no verdict word, just the
     * range values as plain neutral text. `recommended` also lands
     * here with an empty detail — skip the element entirely. */
    if (detail) {
      out.push(`<text x="${x}" y="${baseY}" font-size="${fs - 1}" fill="${theme.callout}" text-anchor="start">${escapeText(detail)}</text>`);
    }
    return out.join('\n');
  }
  out.push(`<text x="${x}" y="${baseY}" font-size="${fs}" font-weight="700" fill="${stateColor}" text-anchor="start">${escapeText(state)}</text>`);
  if (detail) {
    out.push(`<text x="${x}" y="${baseY + fs + 3}" font-size="${fs - 1}" fill="${theme.callout}" text-anchor="start">${escapeText(detail)}</text>`);
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
  while (lo < n && values[lo] < key) lo++;
  if (lo === 0) return 0;
  if (lo === n) return 1;
  const below = values[lo - 1];
  const above = values[lo];
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
 * Spec §Range: "A renderer MUST NOT omit a value without an explicit
 * off-range marker containing the exact value and unit." `range focus`
 * sizes the axis around the controlling boundaries, which can leave a
 * remote criterion's value outside [axis.minimum, axis.maximum] — this
 * says which edge it fell off, so the caller can clamp the marker's
 * position there and draw an off-range glyph instead of a normal dot
 * (model.ts emits PSDL204_OFF_RANGE_MARKER for the same condition).
 */
function axisClampSide(v_kA: number, axis: Resolved['axis']): 'low' | 'high' | null {
  if (v_kA < axis.minimum) return 'low';
  if (v_kA > axis.maximum) return 'high';
  return null;
}

/** Off-range marker for horizontal orientation: a triangle flush with
 * the plot edge, tip pointing outward toward where the real value lies. */
function offRangeTriangleH(x: number, y: number, side: 'low' | 'high', color: string): string {
  const dir = side === 'low' ? -1 : 1;
  const tipX = x + dir * 9;
  return `<polygon data-role="off-range-marker" points="${tipX},${y} ${x},${y - 6} ${x},${y + 6}" fill="${color}"/>`;
}

/** Off-range marker for vertical orientation: 'low' clamps to the
 * bottom of the axis (tip pointing down), 'high' to the top (tip up). */
function offRangeTriangleV(x: number, y: number, side: 'low' | 'high', color: string): string {
  const dir = side === 'low' ? 1 : -1;
  const tipY = y + dir * 9;
  return `<polygon data-role="off-range-marker" points="${x},${tipY} ${x - 6},${y} ${x + 6},${y}" fill="${color}"/>`;
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

/** verticalY, but clamped to the plot's top/bottom for an off-range
 * value — matching where drawConstraint actually plots the marker, so
 * the label-declutter pass (which runs before drawConstraint and needs
 * to agree with it) doesn't place a label at some wild unclamped
 * position far off the canvas. */
function verticalYClamped(model: Resolved, axis: Resolved['axis'], v_kA: number, padT: number, plotH: number): number {
  const side = axisClampSide(v_kA, axis);
  if (side === 'high') return padT;
  if (side === 'low') return padT + plotH;
  return verticalY(model, axis, v_kA, padT, plotH);
}

/** x of the vertical calibrated-axis line, ticks and tick labels. */
function verticalAxisX(padL: number): number {
  return padL + 56;
}

/** x of the criterion/margin marker column, right of the axis and zone band. */
function verticalMarkerX(padL: number): number {
  return verticalAxisX(padL) + 90;
}

/** x of the criterion-label column, right of the marker column and its
 * leader line. */
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
