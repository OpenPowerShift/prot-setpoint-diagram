/**
 * Resolve a parsed PSDL diagram into a complete, display-ready model.
 *
 *   AST  ─►  ResolvedDiagram
 *            ├─ settings (voltage, CT, display list)
 *            ├─ constraints (each with computed must / margin-amended values)
 *            ├─ selection (resolved value, status)
 *            ├─ intervals (mandatory, preferred)
 *            ├─ controlling bounds
 *            ├─ axis (scale, range, quantity, unit)
 *            └─ diagnostics (validation findings)
 */

import type {
  ConstraintStatement,
  Diagram,
  ParseError,
  Quantity as AstQuantity,
  SelectionStatement,
  SourceLocation,
} from '../parser/ast.js';
import {
  ResolvedSettings,
  directionEffect,
  formatAmps,
  formatCondition,
  formatPercent,
  formatPlain,
  formatSetting,
  percentMarginValueIsValid,
  resolveSettings,
  toAmps,
  toMVA,
  toSecondaryAmps,
} from './units.js';

export interface PercentLine {
  text: string;
  level: 'info' | 'warning' | 'error';
  /** Which preferred-interval edge this reports against — lets a
   * renderer place a compact annotation at that edge on the diagram
   * itself, rather than only in the text line. */
  edge: 'lower' | 'upper';
  /** Raw signed distance from the boundary, unrounded: (S - boundary) /
   * boundary, NOT flipped by family. Positive means S is numerically
   * above the boundary, negative means numerically below — for a lower
   * boundary that reads as "headroom above the floor" (usually
   * positive), for an upper boundary as "room below the ceiling"
   * (usually negative). Same number `text` renders, exposed separately
   * so a renderer can format it without parsing `text`. */
  percent: number;
  /** Whether S is actually on the wrong side of THIS boundary for its
   * family — independent of `percent`'s sign, since that's no longer
   * safety-normalised. Renderers should colour by this, not by
   * `percent >= 0`. */
  crossed: boolean;
}

export interface Constraint {
  label: string;
  direction: 'below' | 'above';
  requirement: 'must' | 'should' | 'reference';
  /** Original value (entered), in axis amps (A). */
  value_A: number;
  /** Margin-adjusted value, in axis amps (A). Undefined = no margin. */
  boundary_A: number | null;
  /** The original entered value + unit. */
  entered: AstQuantity;
  margin?: {
    kind: 'percentage' | 'absolute';
    value: number;
    /** For absolute: in axis amps (A). For percentage: dimensionless 0..100. */
  };
  loc: SourceLocation;
  /** Convenience helper that returns the colour tokens for this constraint's family. */
  familyColorTokens(): { lower: string; upper: string };
}

export type SelectionKind = 'explicit' | 'midpoint' | 'low' | 'high' | 'none';

export interface Selection {
  kind: SelectionKind;
  label: string;
  /** Resolved selected value in axis amps. NaN if not determined. */
  value_A: number;
  /** Original entered value (if explicit) for display. */
  entered?: AstQuantity;
  step_A?: number;
  defaulted?: boolean;
  snapped?: boolean;
  loc: SourceLocation;
}

export interface Display {
  value_A: number;
  primary: { label: string; text: string };
  secondary?: { label: string; text: string };
  mva?: { label: string; text: string };
  entered?: { label: string; text: string };
}

export interface AxisInterval {
  /** Numerical minimum in axis amps (A). */
  minimum: number;
  /** Numerical maximum in axis amps (A). */
  maximum: number;
}

export interface Axis {
  quantity: 'current';
  unit: 'A' | 'kA';
  scale: 'linear' | 'log' | 'indicative';
  minimum: number;
  maximum: number;
}

export interface ControllingBoundary {
  label: string;
  direction: 'below' | 'above';
  boundary_A: number;
}

export interface Resolved {
  title: string;
  status: Status;
  axis: Axis;
  mandatoryInterval: AxisInterval;
  preferredInterval: AxisInterval;
  constraints: Constraint[];
  selection: Selection;
  controlling: {
    lower: ControllingBoundary | null;
    upper: ControllingBoundary | null;
  };
  /** Lightweight messages for the right-hand pane, e.g. "115% of 5.5 kA lower boundary · 15% above". */
  selectedPercents?: PercentLine[];
  /** `secondary axis` (spec §Secondary axis) — a second calibrated axis
   * on the opposite side of the plot from where it's declared, relabelling
   * the same physical positions in a different quantity/voltage. Renderer
   * support is horizontal-orientation only. */
  secondaryAxis?: { position: 'top' | 'bottom'; quantity: 'kA' | 'MVA'; voltage_kV?: number };
  displayToggle: { showEntered: boolean; showCurrent: boolean; showMva: boolean; showSecondary: boolean; voltage_kV?: number; ct?: { primary: number; secondary: number } };
  display: Display | null;
  diagnostics: Diagnostic[];
  choices: {
    orientation: 'horizontal' | 'vertical';
    view: 'report' | 'compact' | 'rail';
    palette: 'accessible' | 'default' | 'high-contrast' | 'monochrome';
    theme: 'light' | 'dark' | 'print' | 'monochrome';
    zones: 'off' | 'subtle' | 'full';
    connections: 'off' | 'pale' | 'rows';
    title: 'on' | 'off';
    titleAlign: 'left' | 'center' | 'right';
    titlePosition: 'top' | 'bottom';
    arrows: 'on' | 'off';
    boundaryCurrent: 'on' | 'off';
    axis: 'on' | 'off';
    width?: number;
    height?: number;
    words: Partial<Record<import('../parser/ast.js').WordName, string>>;
  };
}

export type Status =
  | 'recommended'
  | 'caution'
  | 'do-not-set'
  | 'no-recommended-setting'
  | 'no-compliant-setting'
  /* Not one of the spec's five normative statuses — those are all
   * defined relative to a selected value's position. `selected "…"
   * none` (spec: "requests analysis without selection") and any
   * selection that fails to resolve (e.g. midpoint against an
   * unbounded preferred interval) have no such position, and reporting
   * `recommended` for that case — which the resolver used to do, by
   * falling through this function's default path — reads as "checked
   * and approved" on a diagram with no setting at all. */
  | 'no-selection';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
}

export interface ResolveResult {
  resolved?: Resolved;
  parseErrors: ParseError[];
  diagnostics: Diagnostic[];
}

export function resolveDiagram(doc: Diagram): ResolveResult {
  const { settings, diagnostics: settingsDiag } = resolveSettings(doc);
  const parseErrors: ParseError[] = [];
  const diagnostics: Diagnostic[] = [...settingsDiag];

  /* collect statements */
  let orientation: 'horizontal' | 'vertical' = 'horizontal';
  let viewChoice: 'report' | 'compact' | 'rail' = 'compact';
  let scaleChoice: 'auto' | 'linear' | 'log' | 'indicative' = 'auto';
  let rangeChoice:
    | 'auto'
    | 'all'
    | 'focus'
    | { kind: 'explicit'; minimum_A: number; maximum_A: number } = 'auto';
  const constraints: ConstraintStatement[] = [];
  let selectionStmt: SelectionStatement | undefined;
  let secondaryAxisStmt: import('../parser/ast.js').SecondaryAxisStatement | undefined;
  const paletteChoice: { palette: 'accessible' | 'default' | 'high-contrast' | 'monochrome'; theme: 'light' | 'dark' | 'print' | 'monochrome'; zones: 'off' | 'subtle' | 'full'; connections: 'off' | 'pale' | 'rows'; title: 'on' | 'off'; titleAlign: 'left' | 'center' | 'right'; titlePosition: 'top' | 'bottom'; arrows: 'on' | 'off'; boundaryCurrent: 'on' | 'off' } = { palette: 'accessible', theme: 'print', zones: 'subtle', connections: 'pale', title: 'on', titleAlign: 'left', titlePosition: 'top', arrows: 'on', boundaryCurrent: 'off' };
  const wordChoices: Partial<Record<import('../parser/ast.js').WordName, string>> = {};
  let sizeWidth: number | undefined;
  let sizeHeight: number | undefined;
  /* Undefined until an explicit `style axis on|off` is seen — the
   * DEFAULT depends on the resolved scale (indicative defaults to off,
   * everything else to on), so it can't be finalised until chosenScale
   * is known further down; an explicit statement always wins over that
   * default either way. */
  let axisOverride: 'on' | 'off' | undefined;

  for (const stmt of doc.body) {
    switch (stmt.type) {
      case 'orientation':
        orientation = stmt.value;
        break;
      case 'view':
        viewChoice = stmt.value;
        break;
      case 'scale':
        scaleChoice = stmt.value;
        break;
      case 'range':
        if (stmt.value.kind === 'auto') rangeChoice = 'auto';
        else if (stmt.value.kind === 'all') rangeChoice = 'all';
        else if (stmt.value.kind === 'focus') rangeChoice = 'focus';
        else {
          if (stmt.value.minimum.unit === 'kV' || stmt.value.maximum.unit === 'kV') {
            diagnostics.push({
              code: 'PSDL107_UNIT_INCOMPATIBLE',
              severity: 'error',
              message: `Range quantities must be A or kA, got '${stmt.value.minimum.unit}' / '${stmt.value.maximum.unit}'.`,
              line: stmt.loc.line,
              column: stmt.loc.column,
              offset: stmt.loc.offset,
              length: 5,
            });
          }
          rangeChoice = {
            kind: 'explicit',
            minimum_A: toAmps(stmt.value.minimum, settings),
            maximum_A: toAmps(stmt.value.maximum, settings),
          };
        }
        break;
      case 'style':
        applyStyle(diagnostics, stmt);
        if (stmt.property === 'theme' && ['light', 'dark', 'print', 'monochrome'].includes(stmt.value)) {
          paletteChoice.theme = stmt.value as typeof paletteChoice.theme;
        }
        if (stmt.property === 'palette' && ['accessible', 'default', 'high-contrast', 'monochrome'].includes(stmt.value)) {
          paletteChoice.palette = stmt.value as typeof paletteChoice.palette;
        }
        if (stmt.property === 'zones' && ['off', 'subtle', 'full'].includes(stmt.value)) {
          paletteChoice.zones = stmt.value as typeof paletteChoice.zones;
        }
        if (stmt.property === 'connections' && ['off', 'pale', 'rows'].includes(stmt.value)) {
          paletteChoice.connections = stmt.value as typeof paletteChoice.connections;
        }
        if (stmt.property === 'title' && ['on', 'off'].includes(stmt.value)) {
          paletteChoice.title = stmt.value as typeof paletteChoice.title;
        }
        if (stmt.property === 'title-align' && ['left', 'center', 'right'].includes(stmt.value)) {
          paletteChoice.titleAlign = stmt.value as typeof paletteChoice.titleAlign;
        }
        if (stmt.property === 'title-position' && ['top', 'bottom'].includes(stmt.value)) {
          paletteChoice.titlePosition = stmt.value as typeof paletteChoice.titlePosition;
        }
        if (stmt.property === 'arrows' && ['on', 'off'].includes(stmt.value)) {
          paletteChoice.arrows = stmt.value as typeof paletteChoice.arrows;
        }
        if (stmt.property === 'boundary-current' && ['on', 'off'].includes(stmt.value)) {
          paletteChoice.boundaryCurrent = stmt.value as typeof paletteChoice.boundaryCurrent;
        }
        if (stmt.property === 'axis' && ['on', 'off'].includes(stmt.value)) {
          axisOverride = stmt.value as 'on' | 'off';
        }
        break;
      case 'word':
        wordChoices[stmt.name] = stmt.text;
        break;
      case 'size':
        if (stmt.property === 'width') sizeWidth = stmt.value;
        else sizeHeight = stmt.value;
        break;
      case 'constraint':
        constraints.push(stmt);
        break;
      case 'selection':
        selectionStmt = stmt;
        break;
      case 'secondary-axis':
        secondaryAxisStmt = stmt;
        break;
      case 'voltage':
      case 'ct':
      case 'show':
        /* handled in resolveSettings */
        break;
    }
  }

  if (constraints.length === 0) {
    diagnostics.push({
      code: 'PSDL101_NO_CONSTRAINT',
      severity: 'error',
      message: `Diagram contains no criteria.`,
      line: doc.loc.line,
      column: doc.loc.column,
      offset: doc.loc.offset,
      length: doc.title.length,
    });
  }

  /* resolve constraints to amp values */
  const resolved: Constraint[] = [];
  for (const c of constraints) {
    const value_A = toAmps(c.value, settings);
    if (c.value.unit === 'kV') {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Criterion '${c.label}' uses kV; only A, kA, kVA, MVA allowed.`,
        line: c.loc.line,
        column: c.loc.column,
        offset: c.loc.offset,
        length: c.value.unit.length,
      });
      continue;
    }
    if (!Number.isFinite(value_A)) {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Criterion '${c.label}' cannot be converted to amps (voltage required for MVA).`,
        line: c.loc.line,
        column: c.loc.column,
        offset: c.loc.offset,
        length: c.label.length + 2,
      });
      continue;
    }
    if (value_A < 0) {
      diagnostics.push({
        code: 'PSDL102_VALUE_NEGATIVE',
        severity: 'error',
        message: `Criterion '${c.label}' value is negative.`,
        line: c.value.loc.line,
        column: c.value.loc.column,
        offset: c.value.loc.offset,
        length: c.value.expression.length,
      });
    }
    let boundary_A: number | null = null;
    let marginResolved: Constraint['margin'] | undefined;
    if (c.margin) {
      if (c.margin.kind === 'percentage') {
        const pct = c.margin.percent;
        if (!percentMarginValueIsValid(c.direction, pct)) {
          diagnostics.push({
            code: 'PSDL103_MARGIN_PERCENT_RANGE',
            severity: 'error',
            message: `Margin percentage ${pct}% is invalid for '${c.direction}'.`,
            line: c.margin.loc.line,
            column: c.margin.loc.column,
            offset: c.margin.loc.offset,
            length: c.margin.percent.toString().length + 1,
          });
        }
        boundary_A = directionEffect(c.direction, value_A, { value: pct, unit: '%' } as unknown as AstQuantity, true);
        marginResolved = { kind: 'percentage', value: pct };
      } else {
        const m_A = toAmps(c.margin.value, settings);
        if (!Number.isFinite(m_A)) {
          diagnostics.push({
            code: 'PSDL107_UNIT_INCOMPATIBLE',
            severity: 'error',
            message: `Absolute margin on '${c.label}' cannot be converted to amps.`,
            line: c.loc.line,
            column: c.loc.column,
            offset: c.loc.offset,
            length: c.label.length + 2,
          });
        }
        boundary_A = directionEffect(c.direction, value_A, { value: m_A, unit: c.margin.value.unit } as unknown as AstQuantity, false);
        marginResolved = { kind: 'absolute', value: m_A };
      }
      if (!Number.isFinite(boundary_A)) boundary_A = null;
    }
    if (boundary_A !== null && boundary_A < 0) {
      diagnostics.push({
        code: 'PSDL102_VALUE_NEGATIVE',
        severity: 'error',
        message: `Margin-adjusted value for '${c.label}' is negative.`,
        line: c.value.loc.line,
        column: c.value.loc.column,
        offset: c.value.loc.offset,
        length: c.value.expression.length,
      });
    }
    resolved.push({
      label: c.label,
      direction: c.direction,
      requirement: c.requirement,
      value_A,
      boundary_A,
      entered: c.value,
      margin: marginResolved,
      loc: c.loc,
      familyColorTokens() {
        return { lower: '#0f766e', upper: '#1d4ed8' };
      },
    });
  }

  /* intervals */
  const mandatory = computeMandatory(resolved);
  const preferred = computePreferred(resolved);

  /* selection */
  let selection: Selection = {
    kind: 'none',
    label: '',
    value_A: NaN,
    loc: doc.loc,
  };
  if (selectionStmt) {
    selection = resolveSelection(selectionStmt, mandatory, preferred, diagnostics, settings);
  }

  /* status determination */
  const status = determineStatus(mandatory, preferred, selection);

  if (selection.kind !== 'none' && status === 'do-not-set') {
    diagnostics.push({
      code: 'PSDL109_SELECTED_OUTSIDE_MUST',
      severity: 'error',
      message: `Selected value crosses mandatory original criterion.`,
      line: selection.loc.line,
      column: selection.loc.column,
      offset: selection.loc.offset,
      length: 8,
    });
  }

  if (selection.kind === 'midpoint' && (preferred.maximum === Number.POSITIVE_INFINITY || preferred.minimum === Number.NEGATIVE_INFINITY)) {
    if (Number.isNaN(selection.value_A)) {
      diagnostics.push({
        code: 'PSDL111_MIDPOINT_UNAVAILABLE',
        severity: 'warning',
        message: `Preferred interval is unbounded; midpoint selection unavailable.`,
        line: selection.loc.line,
        column: selection.loc.column,
        offset: selection.loc.offset,
        length: 8,
      });
    }
  }

  if (status === 'caution') {
    diagnostics.push({
      code: 'PSDL201_SELECTED_OUTSIDE_PREFERRED',
      severity: 'warning',
      message: `Selected value is cautionary.`,
      line: selection.loc.line,
      column: selection.loc.column,
      offset: selection.loc.offset,
      length: 8,
    });
  }

  if (status === 'no-recommended-setting') {
    diagnostics.push({
      code: 'PSDL202_PREFERRED_INTERVAL_EMPTY',
      severity: 'warning',
      message: `No recommended setting (preferred bounds cross).`,
      line: doc.loc.line,
      column: doc.loc.column,
      offset: doc.loc.offset,
      length: doc.title.length,
    });
  }

  if (status === 'no-compliant-setting') {
    diagnostics.push({
      code: 'PSDL110_MANDATORY_INTERVAL_EMPTY',
      severity: 'error',
      message: `No compliant setting (mandatory bounds cross).`,
      line: doc.loc.line,
      column: doc.loc.column,
      offset: doc.loc.offset,
      length: doc.title.length,
    });
  }

  /* log scale check */
  let chosenScale: 'linear' | 'log' | 'indicative' = 'linear';
  const allValues_A = collectPlotValues(resolved, selection);
  if (scaleChoice === 'auto') {
    const positives = allValues_A.filter((v) => v > 0);
    if (positives.length >= 2) {
      const lo = Math.min(...positives);
      const hi = Math.max(...positives);
      chosenScale = hi / lo >= 20 ? 'log' : 'linear';
      if (chosenScale === 'log') {
        diagnostics.push({
          code: 'PSDL205_AUTO_LOG',
          severity: 'info',
          message: `Auto scale selected logarithmic presentation.`,
          line: doc.loc.line,
          column: doc.loc.column,
          offset: doc.loc.offset,
          length: doc.title.length,
        });
      }
    } else {
      chosenScale = 'linear';
    }
  } else if (scaleChoice === 'log') {
    chosenScale = 'log';
  } else if (scaleChoice === 'indicative') {
    chosenScale = 'indicative';
  } else {
    chosenScale = 'linear';
  }

  /* `style axis` default depends on the resolved scale: indicative
   * scale's positions are ranked, not calibrated, so a bare axis with
   * ticks reads as more precise than it is — off by default there.
   * Linear/log defaults on, as before. An explicit `style axis` always
   * wins over this default either way. */
  const axisChoice: 'on' | 'off' = axisOverride ?? (chosenScale === 'indicative' ? 'off' : 'on');

  if (chosenScale === 'log') {
    const nonPositive = allValues_A.find((v) => v <= 0);
    if (nonPositive !== undefined) {
      diagnostics.push({
        code: 'PSDL108_LOG_NONPOSITIVE',
        severity: 'error',
        message: `Logarithmic scale contains non-positive value.`,
        line: doc.loc.line,
        column: doc.loc.column,
        offset: doc.loc.offset,
        length: doc.title.length,
      });
    }
  }

  /* range */
  let min_A: number;
  let max_A: number;
  if (rangeChoice === 'auto' || rangeChoice === 'all') {
    const lo = Math.min(...allValues_A);
    const hi = Math.max(...allValues_A);
    const span = hi - lo;
    if (span === 0) {
      min_A = lo - 1;
      max_A = hi + 1;
    } else {
      const raw_lo = lo - 0.08 * span;
      const raw_hi = hi + 0.08 * span;
      if (chosenScale === 'log') {
        /* For log scale: pick decade boundaries directly. raw_lo can be
         * negative because of the 8% arithmetic padding; the log scale
         * doesn't need arithmetically-padded bounds, just decades. */
        const logLo = Math.floor(Math.log10(Math.max(lo, 1e-9)));
        const logHi = Math.ceil(Math.log10(Math.max(hi, 1e-9)));
        /* bias down by 1 decade on lo only when raw_lo < 10^logLo */
        const decade_lo = raw_lo > 0 && raw_lo < Math.pow(10, logLo) ? logLo - 1 : logLo;
        min_A = Math.pow(10, decade_lo);
        max_A = Math.pow(10, logHi);
      } else {
        const rangeStep = niceRangeStep(raw_hi - Math.max(raw_lo, 0));
        min_A = niceLo(Math.max(raw_lo, 0), rangeStep);
        max_A = niceHi(raw_hi, rangeStep);
        /* Spec §Design principles: "Autorange ... does not force zero
         * onto a linear axis." Rounding the padded lower bound outward
         * can land it on zero even when the data sits well above it
         * (e.g. a 2 kA minimum with a 2 kA step), which throws away
         * plot width. Refine the step until the bound clears zero. */
        if (min_A === 0 && lo > 0) {
          let step = rangeStep;
          for (let i = 0; i < 8 && step > 1e-9; i++) {
            step /= 2;
            const candidate = Math.floor(Math.max(raw_lo, 0) / step) * step;
            if (candidate > 0) {
              min_A = candidate;
              break;
            }
          }
        }
      }
    }
    if (chosenScale === 'linear' && min_A < 0) min_A = 0;
    diagnostics.push({
      code: 'PSDL303_RANGE_AUTOFIT',
      severity: 'info',
      message: `Axis limits derived.`,
      line: doc.loc.line,
      column: doc.loc.column,
      offset: doc.loc.offset,
      length: doc.title.length,
    });
  } else if (rangeChoice === 'focus') {
    /* Prefer controlling bounds (mandatory). When the mandatory interval
     * is empty (a conflict — status no-compliant-setting), mandatory.minimum
     * is GREATER than mandatory.maximum, so take the numeric min/max of the
     * pair rather than assuming order — otherwise the axis inverts and no
     * ticks fall inside it. Pad by 50% of the controlling span per spec
     * §Range, falling back to a readable span when the bounds coincide. */
    const boundA = mandatory.minimum === Number.NEGATIVE_INFINITY ? Math.min(...allValues_A) : mandatory.minimum;
    const boundB = mandatory.maximum === Number.POSITIVE_INFINITY ? Math.max(...allValues_A) : mandatory.maximum;
    const lo = Math.min(boundA, boundB);
    const hi = Math.max(boundA, boundB);
    const span = hi - lo;
    const pad = span > 0 ? 0.5 * span : Math.max(Math.abs(lo), Math.abs(hi), 1) * 0.1;
    min_A = lo - pad;
    max_A = hi + pad;
    if (chosenScale === 'linear' && min_A < 0) min_A = 0;
  } else {
    min_A = rangeChoice.minimum_A;
    max_A = rangeChoice.maximum_A;
    if (min_A > max_A) {
      diagnostics.push({
        code: 'PSDL110_MANDATORY_INTERVAL_EMPTY',
        severity: 'error',
        message: `Range minimum (${formatAmps(min_A)}) is greater than range maximum (${formatAmps(max_A)}).`,
        line: doc.loc.line,
        column: doc.loc.column,
        offset: doc.loc.offset,
        length: doc.title.length,
      });
    }
  }

  const axis: Axis = {
    quantity: 'current',
    unit: 'kA',
    scale: chosenScale,
    minimum: min_A / 1000,
    maximum: max_A / 1000,
  };

  /* Spec §Range: "A renderer MUST NOT omit a value without an explicit
   * off-range marker containing the exact value and unit." `range
   * focus` and an explicit range can both produce bounds tighter than
   * every plotted value; flag anything that falls outside so the
   * renderer draws an off-range marker instead of silently clipping it
   * (auto/all always include every value by construction, so this is a
   * no-op there). */
  for (const c of resolved) {
    if (c.value_A < min_A || c.value_A > max_A) {
      diagnostics.push({
        code: 'PSDL204_OFF_RANGE_MARKER',
        severity: 'warning',
        message: `Criterion '${c.label}' (${formatAmps(c.value_A, c.value_A < 1000 ? 'A' : 'kA')}) falls outside the calibrated range.`,
        line: c.loc.line,
        column: c.loc.column,
        offset: c.loc.offset,
        length: c.label.length + 2,
      });
    } else if (c.boundary_A !== null && (c.boundary_A < min_A || c.boundary_A > max_A)) {
      diagnostics.push({
        code: 'PSDL204_OFF_RANGE_MARKER',
        severity: 'warning',
        message: `Margin boundary for '${c.label}' (${formatAmps(c.boundary_A, c.boundary_A < 1000 ? 'A' : 'kA')}) falls outside the calibrated range.`,
        line: c.loc.line,
        column: c.loc.column,
        offset: c.loc.offset,
        length: c.label.length + 2,
      });
    }
  }
  if (Number.isFinite(selection.value_A) && (selection.value_A < min_A || selection.value_A > max_A)) {
    diagnostics.push({
      code: 'PSDL204_OFF_RANGE_MARKER',
      severity: 'warning',
      message: `Selected value (${formatAmps(selection.value_A, selection.value_A < 1000 ? 'A' : 'kA')}) falls outside the calibrated range.`,
      line: selection.loc.line,
      column: selection.loc.column,
      offset: selection.loc.offset,
      length: 8,
    });
  }

  /* controlling MANDATORY boundaries — must-only, for the no-compliant-
   * setting detail text (which is specifically about the two must
   * criteria that conflict). */
  const lower = controllingLower(resolved);
  const upper = controllingUpper(resolved);

  /* controlling PREFERRED boundaries — must (with margin) AND should,
   * whichever actually produced model.preferredInterval's bound (see
   * computePreferred). Deliberately separate from lower/upper above:
   * a should criterion with no must+margin counterpart, like a plain
   * `should 5 kA` advisory limit, previously fell through this and
   * silently reported the wrong (must-only) boundary in the percentage
   * annotations. */
  const preferredLower = controllingPreferredLower(resolved);
  const preferredUpper = controllingPreferredUpper(resolved);

  /* selected-value percentages */
  const percents: Resolved['selectedPercents'] =
    selection && Number.isFinite(selection.value_A) ? buildPercents(selection, preferredLower, preferredUpper, mandatory, status) : undefined;

  /* display (current / mva / secondary) */
  let display: Display | null = null;
  if (Number.isFinite(selection.value_A)) {
    display = buildDisplay(selection, settings);
  }

  /* secondary axis (spec §Secondary axis) */
  let secondaryAxis: Resolved['secondaryAxis'];
  if (secondaryAxisStmt) {
    const voltage_kV = secondaryAxisStmt.voltageOverride?.value ?? settings.voltage_kV;
    if (secondaryAxisStmt.quantity === 'MVA' && voltage_kV === undefined) {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Secondary axis in MVA requires a voltage — declare 'voltage' or add '@ X kV' to the secondary axis.`,
        line: secondaryAxisStmt.loc.line,
        column: secondaryAxisStmt.loc.column,
        offset: secondaryAxisStmt.loc.offset,
        length: 9,
      });
    }
    secondaryAxis = { position: secondaryAxisStmt.position, quantity: secondaryAxisStmt.quantity, voltage_kV };
  }

  return {
    resolved: {
      title: doc.title,
      status,
      axis,
      mandatoryInterval: { minimum: mandatory.minimum, maximum: mandatory.maximum },
      preferredInterval: { minimum: preferred.minimum, maximum: preferred.maximum },
      constraints: resolved,
      selection,
      controlling: { lower, upper },
      selectedPercents: percents,
      secondaryAxis,
      displayToggle: {
        showEntered: settings.showEntered,
        showCurrent: settings.display.includes('current'),
        showMva: settings.display.includes('mva'),
        showSecondary: settings.display.includes('secondary'),
        voltage_kV: settings.voltage_kV,
        ct: settings.ct,
      },
      display,
      diagnostics,
      choices: {
        orientation,
        view: viewChoice,
        palette: paletteChoice.palette,
        theme: paletteChoice.theme,
        zones: paletteChoice.zones,
        connections: paletteChoice.connections,
        title: paletteChoice.title,
        titleAlign: paletteChoice.titleAlign,
        titlePosition: paletteChoice.titlePosition,
        arrows: paletteChoice.arrows,
        boundaryCurrent: paletteChoice.boundaryCurrent,
        axis: axisChoice,
        width: sizeWidth,
        height: sizeHeight,
        words: wordChoices,
      },
    },
    diagnostics,
    parseErrors,
  };
}

/* ---------------------------------------------------- helpers */

function computeMandatory(cs: Constraint[]): AxisInterval {
  const belowMust = cs.filter((c) => c.direction === 'below' && c.requirement === 'must').map((c) => c.value_A);
  const aboveMust = cs.filter((c) => c.direction === 'above' && c.requirement === 'must').map((c) => c.value_A);
  const lower = belowMust.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...belowMust);
  const upper = aboveMust.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...aboveMust);
  return { minimum: lower, maximum: upper };
}

function computePreferred(cs: Constraint[]): AxisInterval {
  const belowCandidates: number[] = [];
  const aboveCandidates: number[] = [];
  for (const c of cs) {
    /* `reference` is excluded from banding entirely, even when it
     * carries a margin (spec §Requirement levels) — that margin is
     * display-only, not a preferred-interval boundary. */
    if (c.requirement === 'reference') continue;
    if (c.direction === 'below') {
      if (c.requirement === 'should') belowCandidates.push(c.value_A);
      if (c.boundary_A !== null) belowCandidates.push(c.boundary_A);
    } else {
      if (c.requirement === 'should') aboveCandidates.push(c.value_A);
      if (c.boundary_A !== null) aboveCandidates.push(c.boundary_A);
    }
  }
  const lower = belowCandidates.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...belowCandidates);
  const upper = aboveCandidates.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...aboveCandidates);
  return { minimum: lower, maximum: upper };
}

function controllingLower(cs: Constraint[]): ControllingBoundary | null {
  const belowMust = cs.filter((c) => c.direction === 'below' && c.requirement === 'must');
  if (belowMust.length === 0) return null;
  const top = belowMust.reduce((a, b) => (a.value_A >= b.value_A ? a : b));
  /* preferred is the margin boundary if present, else original */
  const boundary_A = top.boundary_A ?? top.value_A;
  return { label: top.label, direction: 'below', boundary_A };
}

function controllingUpper(cs: Constraint[]): ControllingBoundary | null {
  const aboveMust = cs.filter((c) => c.direction === 'above' && c.requirement === 'must');
  if (aboveMust.length === 0) return null;
  const top = aboveMust.reduce((a, b) => (a.value_A <= b.value_A ? a : b));
  const boundary_A = top.boundary_A ?? top.value_A;
  return { label: top.label, direction: 'above', boundary_A };
}

/* Mirrors computePreferred's own candidate set exactly — must (with
 * margin) AND should — so the result is guaranteed to be the specific
 * constraint that produced preferredInterval.minimum, not just the
 * tightest MUST boundary. A plain `should 5 kA` advisory limit with no
 * must+margin counterpart has no candidate at all in
 * controllingLower/controllingUpper (must-only), which silently
 * reported the wrong boundary for it. */
function controllingPreferredLower(cs: Constraint[]): ControllingBoundary | null {
  let best: { label: string; value: number } | null = null;
  for (const c of cs) {
    if (c.direction !== 'below' || c.requirement === 'reference') continue;
    if (c.requirement === 'should' && (best === null || c.value_A > best.value)) best = { label: c.label, value: c.value_A };
    if (c.boundary_A !== null && (best === null || c.boundary_A > best.value)) best = { label: c.label, value: c.boundary_A };
  }
  return best ? { label: best.label, direction: 'below', boundary_A: best.value } : null;
}

function controllingPreferredUpper(cs: Constraint[]): ControllingBoundary | null {
  let best: { label: string; value: number } | null = null;
  for (const c of cs) {
    if (c.direction !== 'above' || c.requirement === 'reference') continue;
    if (c.requirement === 'should' && (best === null || c.value_A < best.value)) best = { label: c.label, value: c.value_A };
    if (c.boundary_A !== null && (best === null || c.boundary_A < best.value)) best = { label: c.label, value: c.boundary_A };
  }
  return best ? { label: best.label, direction: 'above', boundary_A: best.value } : null;
}

function resolveSelection(
  stmt: SelectionStatement,
  mandatory: AxisInterval,
  preferred: AxisInterval,
  diagnostics: Diagnostic[],
  settings: ResolvedSettings,
): Selection {
  const s: Selection = {
    kind: 'none',
    label: stmt.label,
    value_A: NaN,
    loc: stmt.loc,
  };
  if (stmt.form.kind === 'none') {
    return { ...s, kind: 'none', label: stmt.label };
  }
  if (stmt.form.kind === 'explicit') {
    /* Pass the resolved settings (with voltage and CT) so an MVA value
     * can be converted to amps using the declared voltage. */
    const value_A = toAmps(stmt.form.value, settings);
    if (!Number.isFinite(value_A)) {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Selected value cannot be converted to amps.`,
        line: stmt.loc.line,
        column: stmt.loc.column,
        offset: stmt.loc.offset,
        length: stmt.label.length + 2,
      });
    }
    return { ...s, kind: 'explicit', label: stmt.label, value_A, entered: stmt.form.value };
  }

  /* Derived forms (midpoint, low, high) all share the same step-snapping
   * logic. Each form picks a starting value; snapping rounds that
   * value onto the grid, preferring the side that keeps the result
   * inside the mandatory interval. The step is attached to the form,
   * not to the form's "explicit" payload — pull it out once here. */
  const parseStep = (form: { step?: import('../parser/ast.js').Quantity }): number | undefined => {
    if (!form.step) return undefined;
    let step: number | undefined;
    if (form.step.unit === 'A') step = form.step.value;
    else if (form.step.unit === 'kA') step = form.step.value * 1000;
    else {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Selection step must be A or kA.`,
        line: form.step.loc.line,
        column: form.step.loc.column,
        offset: form.step.loc.offset,
        length: form.step.expression.length,
      });
    }
    if (step !== undefined && step <= 0) {
      diagnostics.push({
        code: 'PSDL112_STEP_INVALID',
        severity: 'error',
        message: `Selection step must be positive.`,
        line: form.step.loc.line,
        column: form.step.loc.column,
        offset: form.step.loc.offset,
        length: form.step.expression.length,
      });
      step = undefined;
    }
    return step;
  };

  if (stmt.form.kind === 'low') {
    /* Lowest compliant setting: equals mandatoryInterval.minimum (the
     * highest must-below original value), rounded up to the next
     * multiple of step. Fails if mandatory is empty. */
    if (!Number.isFinite(mandatory.minimum) || !Number.isFinite(mandatory.maximum) || mandatory.minimum > mandatory.maximum) {
      diagnostics.push({
        code: 'PSDL110_MANDATORY_INTERVAL_EMPTY',
        severity: 'error',
        message: `Cannot pick a low selection: no compliant setting exists.`,
        line: stmt.loc.line,
        column: stmt.loc.column,
        offset: stmt.loc.offset,
        length: stmt.label.length + 2,
      });
      return { ...s, kind: 'low', label: stmt.label, value_A: NaN };
    }
    const base = mandatory.minimum;
    const step = parseStep(stmt.form);
    let value_A = base;
    let snapped = false;
    if (step !== undefined) {
      const r = base / step;
      const ceiled = Math.ceil(r) * step;
      const exact = Math.abs(base - Math.round(r) * step) < 1e-6;
      value_A = exact ? Math.round(r) * step : ceiled;
      if (Math.abs(value_A - base) > 1e-6) {
        snapped = true;
        diagnostics.push({
          code: 'PSDL302_SELECTION_SNAPPED',
          severity: 'info',
          message: `Low selection rounded to step ${formatAmps(step, step < 1000 ? 'A' : 'kA')}.`,
          line: stmt.loc.line,
          column: stmt.loc.column,
          offset: stmt.loc.offset,
          length: stmt.label.length + 2,
        });
      }
    }
    diagnostics.push({
      code: 'PSDL305_LOW_SELECTED',
      severity: 'info',
      message: `Low selection applied (lowest compliant setting).`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: stmt.label.length + 2,
    });
    return { kind: 'low', label: stmt.label, value_A, step_A: step, defaulted: true, snapped, loc: stmt.loc };
  }

  if (stmt.form.kind === 'high') {
    /* Highest compliant setting: equals mandatoryInterval.maximum (the
     * lowest must-above original value), rounded down to the previous
     * multiple of step. Fails if mandatory is empty. */
    if (!Number.isFinite(mandatory.minimum) || !Number.isFinite(mandatory.maximum) || mandatory.minimum > mandatory.maximum) {
      diagnostics.push({
        code: 'PSDL110_MANDATORY_INTERVAL_EMPTY',
        severity: 'error',
        message: `Cannot pick a high selection: no compliant setting exists.`,
        line: stmt.loc.line,
        column: stmt.loc.column,
        offset: stmt.loc.offset,
        length: stmt.label.length + 2,
      });
      return { ...s, kind: 'high', label: stmt.label, value_A: NaN };
    }
    const base = mandatory.maximum;
    const step = parseStep(stmt.form);
    let value_A = base;
    let snapped = false;
    if (step !== undefined) {
      const r = base / step;
      const floored = Math.floor(r) * step;
      const exact = Math.abs(base - Math.round(r) * step) < 1e-6;
      value_A = exact ? Math.round(r) * step : floored;
      if (Math.abs(value_A - base) > 1e-6) {
        snapped = true;
        diagnostics.push({
          code: 'PSDL302_SELECTION_SNAPPED',
          severity: 'info',
          message: `High selection rounded to step ${formatAmps(step, step < 1000 ? 'A' : 'kA')}.`,
          line: stmt.loc.line,
          column: stmt.loc.column,
          offset: stmt.loc.offset,
          length: stmt.label.length + 2,
        });
      }
    }
    diagnostics.push({
      code: 'PSDL306_HIGH_SELECTED',
      severity: 'info',
      message: `High selection applied (highest compliant setting).`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: stmt.label.length + 2,
    });
    return { kind: 'high', label: stmt.label, value_A, step_A: step, defaulted: true, snapped, loc: stmt.loc };
  }

  if (preferred.minimum === Number.NEGATIVE_INFINITY || preferred.maximum === Number.POSITIVE_INFINITY) {
    diagnostics.push({
      code: 'PSDL111_MIDPOINT_UNAVAILABLE',
      severity: 'warning',
      message: `Preferred interval is unbounded; midpoint selection unavailable.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: stmt.label.length + 2,
    });
    return { ...s, kind: 'midpoint', label: stmt.label, value_A: NaN };
  }

  const mid = (preferred.minimum + preferred.maximum) / 2;
  diagnostics.push({
    code: 'PSDL301_SELECTED_DEFAULTED',
    severity: 'info',
    message: `Midpoint selection applied.`,
    line: stmt.loc.line,
    column: stmt.loc.column,
    offset: stmt.loc.offset,
    length: stmt.label.length + 2,
  });

  let step: number | undefined;
  if (stmt.form.step) {
    if (stmt.form.step.unit === 'A') step = stmt.form.step.value;
    else if (stmt.form.step.unit === 'kA') step = stmt.form.step.value * 1000;
    else {
      diagnostics.push({
        code: 'PSDL107_UNIT_INCOMPATIBLE',
        severity: 'error',
        message: `Selection step must be A or kA.`,
        line: stmt.form.step.loc.line,
        column: stmt.form.step.loc.column,
        offset: stmt.form.step.loc.offset,
        length: stmt.form.step.expression.length,
      });
      step = undefined;
    }
    if (step !== undefined && step <= 0) {
      diagnostics.push({
        code: 'PSDL112_STEP_INVALID',
        severity: 'error',
        message: `Selection step must be positive.`,
        line: stmt.form.step.loc.line,
        column: stmt.form.step.loc.column,
        offset: stmt.form.step.loc.offset,
        length: stmt.form.step.expression.length,
      });
      step = undefined;
    }
  }
  let value_A = mid;
  let snapped = false;
  if (step !== undefined) {
    /* Round midpoint to nearest multiple of step; exact ties (within
     * floating-point tolerance) round away from zero per spec. */
    const r = mid / step;
    const fFloor = Math.floor(r) * step;
    const fCeil = Math.ceil(r) * step;
    const distFloor = Math.abs(mid - fFloor);
    const distCeil = Math.abs(mid - fCeil);
    let chosen: number;
    if (distFloor < distCeil) chosen = fFloor;
    else if (distCeil < distFloor) chosen = fCeil;
    else {
      /* exact tie — round away from zero */
      const sign = mid >= 0 ? 1 : -1;
      chosen = sign === 1 ? fCeil : fFloor;
    }
    /* Snap to grid if the midpoint isn't already a multiple of step
     * within tolerance. */
    if (Math.abs(mid - Math.round(mid / step) * step) > 1e-6) {
      value_A = chosen;
    } else {
      value_A = Math.round(mid / step) * step;
    }
    if (Math.abs(value_A - mid) > 1e-6) {
      snapped = true;
      diagnostics.push({
        code: 'PSDL302_SELECTION_SNAPPED',
        severity: 'info',
        message: `Midpoint rounded to step ${formatAmps(step, step < 1000 ? 'A' : 'kA')}.`,
        line: stmt.loc.line,
        column: stmt.loc.column,
        offset: stmt.loc.offset,
        length: stmt.label.length + 2,
      });
    }
  }
  return {
    kind: 'midpoint',
    label: stmt.label,
    value_A,
    step_A: step,
    defaulted: true,
    snapped,
    loc: stmt.loc,
  };
}

function determineStatus(
  mandatory: AxisInterval,
  preferred: AxisInterval,
  selection: Selection,
): Status {
  const mandatoryEmpty =
    mandatory.minimum > mandatory.maximum && Number.isFinite(mandatory.minimum) && Number.isFinite(mandatory.maximum);
  if (mandatoryEmpty) return 'no-compliant-setting';
  const preferredEmpty =
    preferred.minimum > preferred.maximum && Number.isFinite(preferred.minimum) && Number.isFinite(preferred.maximum);
  if (preferredEmpty) {
    /* mid has not been overridden unless the user asked for explicit/caution */
    if (selection.kind === 'explicit' && selection.value_A >= mandatory.minimum && selection.value_A <= mandatory.maximum) {
      return 'caution';
    }
    return 'no-recommended-setting';
  }
  if (selection.kind === 'none' || !Number.isFinite(selection.value_A)) {
    return 'no-selection';
  }
  if (selection.value_A < mandatory.minimum || selection.value_A > mandatory.maximum) {
    return 'do-not-set';
  }
  if (selection.value_A < preferred.minimum || selection.value_A > preferred.maximum) {
    return 'caution';
  }
  return 'recommended';
}

function collectPlotValues(cs: Constraint[], selection: Selection): number[] {
  const out: number[] = [];
  for (const c of cs) {
    out.push(c.value_A);
    if (c.boundary_A !== null) out.push(c.boundary_A);
  }
  if (Number.isFinite(selection.value_A)) out.push(selection.value_A);
  return out.filter((n) => Number.isFinite(n));
}

function applyStyle(diagnostics: Diagnostic[], stmt: import('../parser/ast.js').StyleStatement) {
  if (stmt.property === 'theme' && !['light', 'dark', 'print', 'monochrome'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown theme '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'palette' && !['accessible', 'default', 'high-contrast', 'monochrome'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown palette '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 7,
    });
  }
  if (stmt.property === 'zones' && !['off', 'subtle', 'full'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown zones value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'connections' && !['off', 'pale', 'rows'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown connections value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 10,
    });
  }
  if (stmt.property === 'title' && !['on', 'off'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown title value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'title-align' && !['left', 'center', 'right'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown title-align value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'title-position' && !['top', 'bottom'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown title-position value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'arrows' && !['on', 'off'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown arrows value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'boundary-current' && !['on', 'off'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown boundary-current value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
  if (stmt.property === 'axis' && !['on', 'off'].includes(stmt.value)) {
    diagnostics.push({
      code: 'PSDL001_UNKNOWN_STATEMENT',
      severity: 'error',
      message: `Unknown axis value '${stmt.value}'.`,
      line: stmt.loc.line,
      column: stmt.loc.column,
      offset: stmt.loc.offset,
      length: 5,
    });
  }
}

/**
 * The "nice" step is the spec's `{1, 2, 2.5, 5} × 10^n` set, sized from
 * the SPAN (targeting ~7 major ticks) and then applied to BOTH bounds —
 * not derived independently from each bound's own magnitude. Deriving
 * lo/hi steps independently (the previous approach) could pick wildly
 * different step sizes for each end and badly overshoot — e.g. a span
 * of 3.5-12 kA rounding out to 2.5-20 kA, doubling the axis for no
 * reason. A single span-derived step keeps both ends proportionate.
 */
const NICE_LADDER = [1, 2, 2.5, 5, 10];

function niceRangeStep(span: number, target = 7): number {
  if (span <= 0) return 1;
  const raw = span / target;
  const power = Math.floor(Math.log10(raw));
  const base = Math.pow(10, power);
  for (const s of NICE_LADDER) {
    if (s * base >= raw) return s * base;
  }
  return 10 * base;
}

function niceLo(x: number, step: number): number {
  if (x <= 0) return 0;
  return Math.floor(x / step) * step;
}
function niceHi(x: number, step: number): number {
  if (x <= 0) return 0;
  return Math.ceil(x / step) * step;
}

function buildPercents(
  selection: Selection,
  lower: ControllingBoundary | null,
  upper: ControllingBoundary | null,
  mandatory: AxisInterval,
  status: Status,
): NonNullable<Resolved['selectedPercents']> {
  const out: NonNullable<Resolved['selectedPercents']> = [];
  if (!lower && !upper) return out;
  if (status === 'no-compliant-setting') return out;
  const s = selection.value_A;

  /* A must-criterion is already broken — report only the crossed
   * mandatory boundary. The healthy far side isn't useful context once
   * a hard limit has been crossed, and the two mandatory bounds can't
   * both be crossed at once (mandatory is non-empty here). */
  if (Number.isFinite(mandatory.minimum) && s < mandatory.minimum && lower) {
    return [percentLine(s, lower, 'error')];
  }
  if (Number.isFinite(mandatory.maximum) && s > mandatory.maximum && upper) {
    return [percentLine(s, upper, 'error')];
  }

  /* Every mandatory criterion is satisfied — annotate BOTH edges of the
   * green (preferred) zone relative to the selected value, whether S
   * sits inside them (headroom, positive) or has crossed one (caution,
   * negative). One signed number per edge, not a ratio+clearance pair:
   * e.g. "+15.5%" / "-11.8%" reads directly as margin remaining /
   * margin exceeded, without a second number to reconcile against it. */
  const level = status === 'caution' ? 'warning' : 'info';
  if (lower) out.push(percentLine(s, lower, level));
  if (upper) out.push(percentLine(s, upper, level));
  return out;
}

function percentLine(s: number, boundary: ControllingBoundary, level: 'info' | 'warning' | 'error'): PercentLine {
  /* Spec §Selected-setting percentages: a single signed percentage of
   * the boundary itself — "5.5 kA +15.5%" — rather than a ratio ("115%
   * of...") paired with a redundant clearance figure. The sign is the
   * plain (S - boundary) / boundary, NOT flipped by family: a lower
   * boundary reads positive when S sits above it (the normal case), an
   * upper boundary reads NEGATIVE when S sits below it (the normal
   * case) — the sign follows the number line, not "is this safe". */
  const boundStr = formatCondition(boundary.boundary_A);
  const boundaryWord = boundary.direction === 'below' ? 'lower' : 'upper';
  const signedPct = (s - boundary.boundary_A) / boundary.boundary_A * 100;
  const sign = signedPct >= 0 ? '+' : '';
  /* Crossed means "on the wrong side for this family" — used for
   * colour, kept independent of signedPct's sign since that's no
   * longer safety-normalised. */
  const crossed = boundary.direction === 'below' ? s < boundary.boundary_A : s > boundary.boundary_A;
  return {
    text: `${boundStr} ${sign}${formatPercent(signedPct)}`,
    level,
    edge: boundaryWord,
    percent: signedPct,
    crossed,
  };
}

function buildDisplay(selection: Selection, settings: { voltage_kV?: number; ct?: { primary: number; secondary: number } }): Display {
  const value_A = selection.value_A;
  /* If the entered quantity carried its own `@ X kV`, converting the
   * selection back to MVA for display with a DIFFERENT (diagram) voltage
   * would not reproduce the entered figure — confusing without an
   * obvious reason why. Prefer the entered override so "entered 200 MVA
   * @ 11 kV" and the displayed MVA stay the same number. */
  const overrideVoltage_kV = selection.entered?.voltageOverride?.value;
  const mvaVoltage_kV = overrideVoltage_kV ?? settings.voltage_kV;
  return {
    value_A,
    primary: { label: 'Current', text: formatSetting(value_A) },
    /* Display precision, not internal precision: three decimals on an
     * MVA figure ("362.951 MVA") is false precision for a setting
     * report. Spec §Resolved result model shows MVA to one decimal;
     * secondary amps keep three, where the extra digits are real. */
    secondary: settings.ct
      ? { label: 'Secondary', text: formatPlain(toSecondaryAmps(value_A, settings.ct), 3) + ' A' }
      : undefined,
    mva: mvaVoltage_kV !== undefined
      ? { label: 'MVA', text: formatPlain(toMVA(value_A, mvaVoltage_kV), 1) + ' MVA' + nominalMvaSuffix(value_A, overrideVoltage_kV, settings.voltage_kV) }
      : undefined,
    entered: selection.entered
      ? {
          label: 'Entered',
          text: `${formatPlain(selection.entered.value)} ${selection.entered.unit}${selection.entered.voltageOverride ? ` @ ${formatPlain(selection.entered.voltageOverride.value)} kV` : ''}`,
        }
      : undefined,
  };
}

/**
 * When a setting's MVA was converted at its own `@` override voltage
 * rather than the diagram's nominal one, the displayed MVA figure isn't
 * directly comparable to another set point that used the nominal
 * voltage — the same current reads as a different MVA at each voltage.
 * Cross-reference what this current would read as at the diagram's own
 * nominal voltage, so set points from either side of a transformer stay
 * comparable at a glance. Omitted when there's no override, or the
 * override happens to equal the nominal voltage — the figure already
 * shown would just repeat itself.
 */
function nominalMvaSuffix(value_A: number, overrideVoltage_kV: number | undefined, nominalVoltage_kV: number | undefined): string {
  if (overrideVoltage_kV === undefined || nominalVoltage_kV === undefined || overrideVoltage_kV === nominalVoltage_kV) return '';
  const nominalMva = toMVA(value_A, nominalVoltage_kV);
  return ` (${formatPlain(nominalMva, 1)} MVA @ ${formatPlain(nominalVoltage_kV)} kV nominal)`;
}
