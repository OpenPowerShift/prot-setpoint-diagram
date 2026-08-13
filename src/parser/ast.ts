/**
 * Pure-data AST for Protection Setting Diagram Language (PSDL).
 *
 * Every node carries a `loc: SourceLocation` so diagnostics can point at the
 * exact place in the source. Values additionally carry `valueLoc` so the type
 * of a unit (A vs kA) is independently locatable from a diagnostic.
 */

export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
}

/** Root document – one PSDL file contains exactly one diagram. */
export interface Document {
  type: 'document';
  title: string;
  diagram: Diagram;
  loc: SourceLocation;
}

export interface Diagram {
  type: 'diagram';
  title: string;
  body: Statement[];
  loc: SourceLocation;
}

export type Statement =
  | OrientationStatement
  | VoltageStatement
  | CurrentTransformerStatement
  | ShowStatement
  | ViewStatement
  | ScaleStatement
  | RangeStatement
  | WordStatement
  | StyleStatement
  | SecondaryAxisStatement
  | SizeStatement
  | ConstraintStatement
  | SelectionStatement;

export interface OrientationStatement {
  type: 'orientation';
  value: 'horizontal' | 'vertical';
  loc: SourceLocation;
}

export interface VoltageStatement {
  type: 'voltage';
  value: Quantity;
  loc: SourceLocation;
}

export interface CurrentTransformerStatement {
  type: 'ct';
  primary: number;
  secondary: number;
  loc: SourceLocation;
}

export type DisplayQuantity = 'entered' | 'current' | 'mva' | 'secondary';

export interface ShowStatement {
  type: 'show';
  quantities: DisplayQuantity[];
  loc: SourceLocation;
}

export type ViewKind = 'report' | 'compact' | 'rail';

export interface ViewStatement {
  type: 'view';
  value: ViewKind;
  loc: SourceLocation;
}

export type ScaleKind = 'linear' | 'log' | 'indicative' | 'auto';

export interface ScaleStatement {
  type: 'scale';
  value: ScaleKind;
  loc: SourceLocation;
}

export type RangeKind =
  | { kind: 'auto' }
  | { kind: 'all' }
  | { kind: 'focus' }
  | { kind: 'explicit'; minimum: Quantity; maximum: Quantity };

export interface RangeStatement {
  type: 'range';
  value: RangeKind;
  loc: SourceLocation;
}

export type WordName =
  | 'do-not-set'
  | 'caution'
  | 'recommended'
  | 'selected'
  | 'no-recommended'
  | 'no-compliant';

export interface WordStatement {
  type: 'word';
  name: WordName;
  text: string;
  loc: SourceLocation;
}

export interface StyleStatement {
  type: 'style';
  property: 'theme' | 'palette' | 'zones' | 'connections' | 'title' | 'title-align' | 'title-position' | 'arrows';
  value: string;
  loc: SourceLocation;
}

/**
 * `size width N` / `size height N` (independent, either or both may be
 * given): an explicit pixel dimension for the diagram canvas, overriding
 * the content-driven default. Two statements rather than one `size W x
 * H` — a diagram usually only needs to pin ONE axis (e.g. "make it full
 * width") and let the other stay content-driven.
 */
export interface SizeStatement {
  type: 'size';
  property: 'width' | 'height';
  value: number;
  loc: SourceLocation;
}

export interface SecondaryAxisStatement {
  type: 'secondary-axis';
  position: 'top' | 'bottom';
  quantity: 'kA' | 'MVA';
  voltageOverride?: { value: number; loc: SourceLocation };
  loc: SourceLocation;
}

export type Direction = 'below' | 'above';
export type Requirement = 'must' | 'should' | 'reference';

export interface ConstraintStatement {
  type: 'constraint';
  direction: Direction;
  label: string;
  requirement: Requirement;
  value: Quantity;
  margin?: Margin;
  loc: SourceLocation;
}

export type Margin =
  | { kind: 'percentage'; value: Quantity; percent: number; loc: SourceLocation }
  | { kind: 'absolute'; value: Quantity; loc: SourceLocation };

export type SelectionForm =
  | { kind: 'explicit'; value: Quantity }
  | { kind: 'midpoint'; step?: Quantity }
  | { kind: 'low'; step?: Quantity }
  | { kind: 'high'; step?: Quantity }
  | { kind: 'none' };

export interface SelectionStatement {
  type: 'selection';
  label: string;
  form: SelectionForm;
  loc: SourceLocation;
}

export interface Quantity {
  /** Numeric value of the quantity in its declared unit. */
  value: number;
  /** The literal unit as written (e.g. 'kA', 'MVA', 'kV'). */
  unit: Unit;
  /** The raw text of the expression (e.g. '1.1 * 10'). */
  expression: string;
  loc: SourceLocation;
  /**
   * Optional inline `@ X kV` — the voltage to use when converting THIS
   * quantity's kVA/MVA to amps, in place of the diagram's declared
   * `voltage` statement. Lets criteria measured at different voltage
   * levels (e.g. either side of a transformer) share one diagram
   * without a single diagram-wide voltage being sufficient — and,
   * combined on every quantity that needs one, removes the need for a
   * `voltage` statement at all.
   */
  voltageOverride?: { value: number; loc: SourceLocation };
}

export type Unit = 'A' | 'kA' | 'kVA' | 'MVA' | 'kV' | '%';

/** Anything parse-related that has a position and severity. */
export interface ParseError {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
}
