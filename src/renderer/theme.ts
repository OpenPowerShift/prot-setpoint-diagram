/**
 * Palette + theme tokens for PSDL.
 *
 * Four themes: light, dark, monochrome, print.
 * Three palettes: accessible (default teal / blue, colour-blind aware),
 * default, high-contrast. A monochrome flag collapses colour to grey
 * while retaining encoding through marker shape and line form.
 *
 * The "monochrome" theme is rendered by every lower-level function: it
 * sets every stroke / fill to the foreground colour with thickness
 * differentiating primary from secondary marks.
 */

export interface ThemeTokens {
  background: string;
  foreground: string;
  axis: string;
  grid: string;
  axisFill: string;
  statusFill: { recommended: string; caution: string; doNotSet: string; conflict: string; selected: string };
  statusStroke: { recommended: string; caution: string; doNotSet: string; conflict: string; selected: string };
  contrast: { lo: string; hi: string; mid: string; selected: string; conflictBand: string };
  hint: string;
  leader: string;
  selected: string;
  selectedLabel: string;
}

export interface PaletteTokens {
  /** Lower criteria family. */
  lower: string;
  /** Upper criteria family. */
  upper: string;
  /** Selected value. */
  selected: string;
  /** Conflict band / cannot-set highlight. */
  conflict: string;
  /** Recommended / pass zone. */
  recommended: string;
  /** Caution / out-of-preferred zone. */
  caution: string;
  mandatory: string;
}

export const PALETTES: Record<string, PaletteTokens> = {
  accessible: {
    lower: '#0f766e',      /* teal */
    upper: '#1d4ed8',      /* deep blue */
    selected: '#c2410c',   /* orange (orange) */
    conflict: '#b91c1c',   /* red */
    recommended: '#057a55',
    caution: '#b45309',
    mandatory: '#1f2937',
  },
  default: {
    lower: '#16a34a',
    upper: '#2563eb',
    selected: '#ea580c',
    conflict: '#dc2626',
    recommended: '#059669',
    caution: '#d97706',
    mandatory: '#111827',
  },
  'high-contrast': {
    lower: '#0f4f8a',
    upper: '#3a1d8a',
    selected: '#a31a1a',
    conflict: '#7a1111',
    recommended: '#0d6e2e',
    caution: '#7a4d00',
    mandatory: '#111111',
  },
  monochrome: {
    lower: '#333333',
    upper: '#666666',
    selected: '#000000',
    conflict: '#222222',
    recommended: '#555555',
    caution: '#888888',
    mandatory: '#000000',
  },
};

export interface Theme {
  background: string;
  foreground: string;
  axis: string;
  grid: string;
  zones: string;
  selected: string;
  callout: string;
}

export const THEMES: Record<string, Theme> = {
  light: {
    background: '#ffffff',
    foreground: '#111111',
    axis: '#222222',
    grid: '#e5e7eb',
    zones: '#f3f4f6',
    selected: '#c2410c',
    callout: '#374151',
  },
  dark: {
    background: '#0f1419',
    foreground: '#f1f5f9',
    axis: '#f1f5f9',
    grid: '#374151',
    zones: '#1f2937',
    selected: '#fb923c',
    callout: '#94a3b8',
  },
  print: {
    background: '#ffffff',
    foreground: '#000000',
    axis: '#000000',
    grid: '#d4d4d8',
    zones: '#f8fafc',
    selected: '#000000',
    callout: '#1f2937',
  },
  monochrome: {
    background: '#ffffff',
    foreground: '#111111',
    axis: '#111111',
    grid: '#cccccc',
    zones: '#eeeeee',
    selected: '#000000',
    callout: '#444444',
  },
};

const NICE_STEPS = [1, 2, 2.5, 5, 10];

export function niceStep(span: number, target = 6): number {
  const raw = span / target;
  const power = Math.floor(Math.log10(raw));
  const base = Math.pow(10, power);
  for (const s of NICE_STEPS) {
    if (base * s >= raw) return base * s;
  }
  return base * 10;
}

export function buildTicks(min: number, max: number, scale: 'linear' | 'log' | 'indicative'): number[] {
  if (scale === 'log') {
    const out: number[] = [];
    const lo = Math.pow(10, Math.floor(Math.log10(Math.max(min, 1e-9))));
    const hi = Math.pow(10, Math.ceil(Math.log10(max)));
    for (let v = lo; v <= hi * 1.0001; v *= 10) out.push(v);
    if (out.length < 3) {
      for (let v = lo; v <= hi * 1.0001; v *= 2) out.push(Math.round(v * 100) / 100);
    }
    return out.filter((v) => v >= min && v <= max);
  }
  const tick = niceStep(max - min, 7);
  const start = Math.ceil(min / tick) * tick;
  const out: number[] = [];
  for (let v = start; v <= max + tick * 0.0001; v += tick) {
    out.push(Math.round(v * 1e6) / 1e6);
  }
  if (out.length < 4) {
    return linearSubdivide(min, max, 7);
  }
  return out;
}

function linearSubdivide(min: number, max: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + (i * (max - min)) / count);
  return out;
}

export function valueToPosition(v: number, range: { min: number; max: number }, axisLength: number, scale: 'linear' | 'log' | 'indicative'): number {
  if (scale === 'log') {
    if (v <= 0) return 0;
    const lmin = Math.log10(range.min);
    const lmax = Math.log10(range.max);
    const lv = Math.log10(v);
    return ((lv - lmin) / (lmax - lmin)) * axisLength;
  }
  return ((v - range.min) / (range.max - range.min)) * axisLength;
}

export function positionToValue(p: number, range: { min: number; max: number }, axisLength: number, scale: 'linear' | 'log' | 'indicative'): number {
  if (axisLength <= 0) return range.min;
  const t = Math.max(0, Math.min(1, p / axisLength));
  if (scale === 'log') {
    return Math.pow(10, Math.log10(range.min) + t * (Math.log10(range.max) - Math.log10(range.min)));
  }
  return range.min + t * (range.max - range.min);
}
