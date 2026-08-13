/**
 * Unit conversion machinery for PSDL.
 *
 * Three-phase apparent power:
 *   I_A = S_MVA * 1000 / (sqrt(3) * V_kV)
 *   S_MVA = sqrt(3) * V_kV * I_A / 1000
 *
 * CT ratio (P primary, S secondary):
 *   I_secondary = I_primary * S / P
 *   I_primary   = I_secondary * P / S
 *
 * PSDL has axes whose quantity is 'current' (the only calibrated axis in
 * v1.0). When an entered value is in MVA it is converted to A using the
 * declared voltage; when 'secondary' is requested it is converted using
 * the declared CT ratio.
 */

import type { Diagram, Direction, Quantity } from '../parser/ast.js';

export type AxisQuantity = 'current';
export type DisplayKind = 'entered' | 'current' | 'mva' | 'secondary';

export interface Settings {
  voltage_kV?: number;
  primaryA?: number;
  secondaryA?: number;
}

const SQRT3 = Math.sqrt(3);

export function axisQuantityOf(_q: Quantity): AxisQuantity {
  return 'current';
}

export function toAmps(value: Quantity, settings: Settings): number {
  /* An inline `@ X kV` on this quantity takes precedence over the
   * diagram's declared `voltage` statement — lets criteria measured at
   * different voltage levels share one diagram, and removes the need
   * for a `voltage` statement at all when every kVA/MVA quantity
   * carries its own. */
  const voltage_kV = value.voltageOverride?.value ?? settings.voltage_kV;
  switch (value.unit) {
    case 'A':
      return value.value;
    case 'kA':
      return value.value * 1000;
    case 'MVA':
      if (voltage_kV === undefined) return NaN;
      return (value.value * 1000) / (SQRT3 * voltage_kV);
    case 'kVA':
      if (voltage_kV === undefined) return NaN;
      return ((value.value) / (SQRT3 * voltage_kV));
    case 'kV':
    case '%':
      return NaN;
  }
}

/** Inverse of toAmps for S_MVA & secondary calculations. */
export function toMVA(amps: number, voltage_kV: number): number {
  return (SQRT3 * voltage_kV * amps) / 1000;
}

/** Inverse of toMVA — e.g. mapping a secondary axis's own "nice" MVA
 * tick values back to the amp position they share with the primary
 * axis. */
export function mvaToAmps(mva: number, voltage_kV: number): number {
  return (mva * 1000) / (SQRT3 * voltage_kV);
}

export function toSecondaryAmps(amps: number, ratio: { primary: number; secondary: number } | undefined): number {
  if (!ratio) return NaN;
  return amps * ratio.secondary / ratio.primary;
}

export function formatQuantityForAxis(value: Quantity, settings: Settings): string {
  switch (value.unit) {
    case 'A':
      return formatPlain(value.value);
    case 'kA':
      return `${formatPlain(value.value)} kA`;
    case 'MVA': {
      const amps = toAmps(value, settings);
      const mva = toMVA(amps, value.voltageOverride?.value ?? settings.voltage_kV ?? NaN);
      return `${formatPlain(mva)} MVA`;
    }
    case 'kVA': {
      const amps = toAmps(value, settings);
      const mva = toMVA(amps, value.voltageOverride?.value ?? settings.voltage_kV ?? NaN);
      return `${formatPlain(mva)} MVA`;
    }
    case '%':
      return formatPlain(value.value);
    case 'kV':
      return `${formatPlain(value.value)} kV`;
  }
}

export function formatAmps(amps: number, unit: 'A' | 'kA' = 'kA', decimals?: number): string {
  if (unit === 'A') return `${formatPlain(amps)} A`;
  const kA = amps / 1000;
  return decimals !== undefined ? `${kA.toFixed(decimals)} kA` : `${formatPlain(kA)} kA`;
}

/**
 * Criterion, margin-boundary and mandatory/preferred-range values — the
 * diagram's "conditions" — always to one decimal place in kA, so a
 * column of them lines up instead of mixing "5 kA" with "6.35 kA".
 * Sub-1000 A values stay in A with no forced decimals; whole amps are
 * the natural unit there and rarely carry a fraction.
 */
export function formatCondition(amps: number): string {
  return amps < 1000 ? formatAmps(amps, 'A') : formatAmps(amps, 'kA', 1);
}

/**
 * The selected setting value — always to two decimal places in kA, one
 * more digit than a condition since a setting is what actually gets
 * dialled into a relay and the extra precision is real.
 */
export function formatSetting(amps: number): string {
  return amps < 1000 ? formatAmps(amps, 'A') : formatAmps(amps, 'kA', 2);
}

export function formatPlain(n: number, maxDecimals = 3): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  /* Round, then drop trailing zeros so a 3-decimal formatter prints
   * 6.35 rather than 6.350, and 5 rather than 5.000. */
  const factor = Math.pow(10, maxDecimals);
  const rounded = Math.round(n * factor) / factor;
  if (rounded === Math.trunc(rounded)) return String(Math.trunc(rounded));
  return String(rounded);
}

/**
 * Format a percentage to one decimal place, dropping trailing zeros.
 * Ratios this is used for (selected value vs. a boundary, or a conflict
 * width vs. its boundary) can blow up when the boundary is small — e.g.
 * a wide-range log-scale diagram can produce "4140.9%". Past 1000% that
 * reads better as a multiple: "41.4×" rather than "4140.9%".
 */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) {
    const multiple = n / 100;
    const rounded = Math.round(multiple * 10) / 10;
    return rounded === Math.trunc(rounded) ? `${Math.trunc(rounded)}×` : `${rounded}×`;
  }
  const rounded = Math.round(n * 10) / 10;
  if (rounded === Math.trunc(rounded)) return `${Math.trunc(rounded)}%`;
  return `${rounded}%`;
}

export interface ResolvedSettings {
  voltage_kV?: number;
  ct?: { primary: number; secondary: number };
  display: DisplayKind[];
  showEntered: boolean;
}

export function resolveSettings(d: Diagram): { settings: ResolvedSettings; diagnostics: import('../parser/ast.js').ParseError[] } {
  const diagnostics: import('../parser/ast.js').ParseError[] = [];
  const settings: ResolvedSettings = {
    display: ['current', 'mva'],
    showEntered: false,
  };
  for (const stmt of d.body) {
    if (stmt.type === 'voltage') {
      settings.voltage_kV = stmt.value.value;
    } else if (stmt.type === 'ct') {
      if (stmt.primary <= 0 || stmt.secondary <= 0) {
        diagnostics.push({
          code: 'PSDL106_CT_INVALID',
          severity: 'error',
          message: `CT ratio side must be positive (${stmt.primary}/${stmt.secondary}).`,
          line: stmt.loc.line,
          column: stmt.loc.column,
          offset: stmt.loc.offset,
          length: `${stmt.primary}/${stmt.secondary}`.length,
        });
      } else {
        settings.ct = { primary: stmt.primary, secondary: stmt.secondary };
      }
    } else if (stmt.type === 'show') {
      settings.display = stmt.quantities.length > 0 ? stmt.quantities : ['current', 'mva'];
      settings.showEntered = settings.display[0] === 'entered';
    }
  }
  return { settings, diagnostics };
}

export function directionEffect(direction: Direction, value: number, margin: Quantity | undefined, asPercent = true): number {
  if (!margin) return value;
  if (asPercent && margin.unit === '%') {
    const pct = margin.value / 100;
    return direction === 'below'
      ? value * (1 + pct)
      : value * (1 - pct);
  }
  /* absolute */
  return direction === 'below'
    ? value + margin.value
    : value - margin.value;
}

export function percentMarginValueIsValid(direction: Direction, percent: number): boolean {
  if (percent < 0) return false;
  if (direction === 'above' && percent >= 100) return false;
  return true;
}
