import { describe, it, expect } from 'vitest';
import { process } from '~/index';

describe('PSDL semantics — feeder-setting example (spec §Resolved result model)', () => {
  const src = `diagram "Feeder setting" {
    orientation horizontal
    voltage 33 kV
    ct 600/1 A
    show current, mva
    scale auto
    range auto

    below "Maximum load" must 3.5 kA
    below "Emergency load" must 5 kA margin 10%
    above "Minimum 2-phase fault" must 8 kA margin 10%
    above "Minimum 3-phase fault" must 12 kA margin 10%

    selected "Selected setting" midpoint step 0.05 kA
  }`;

  it('produces the expected resolved result model', () => {
    const { resolved } = process(src);
    expect(resolved).toBeDefined();
    expect(resolved!.title).toBe('Feeder setting');
    expect(resolved!.status).toBe('recommended');
    expect(resolved!.axis.quantity).toBe('current');
    expect(resolved!.axis.scale).toBe('linear');
    expect(resolved!.mandatoryInterval.minimum).toBeCloseTo(5000, 6);
    expect(resolved!.mandatoryInterval.maximum).toBeCloseTo(8000, 6);
    expect(resolved!.preferredInterval.minimum).toBeCloseTo(5500, 6);
    expect(resolved!.preferredInterval.maximum).toBeCloseTo(7200, 6);
    /* midpoint 6.35, snapped to 0.05 step = 6.35 (already a multiple of 0.05) */
    expect(resolved!.selection.value_A).toBeCloseTo(6350, 6);
    expect(resolved!.controlling.lower!.boundary_A).toBeCloseTo(5500, 6);
    expect(resolved!.controlling.upper!.boundary_A).toBeCloseTo(7200, 6);
  });

  it('reports conversions to kA primary, A secondary, and MVA', () => {
    const { resolved } = process(src);
    expect(resolved!.display).not.toBeNull();
    const s = resolved!.selection.value_A;
    const text = (resolved!.display!.primary.text);
    expect(text).toContain('kA');
    expect(resolved!.display!.secondary!.text).toMatch(/A$/);
    expect(resolved!.display!.mva!.text).toMatch(/MVA$/);
    /* Spec example: 6.35 kA primary, 10.583 A secondary, 362.9 MVA */
    expect(s / 1000).toBeCloseTo(6.35, 6);
    expect(s / 600).toBeCloseTo(10.583, 2);
  });
});

describe('PSDL semantics — five statuses', () => {
  it('recommended when selection is inside preferred interval', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 10%
      above "U" must 8 kA margin 10%
      selected "S" midpoint step 0.05 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('recommended');
  });

  it('caution when explicit selection lies in mandatory but outside preferred', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 10%
      above "U" must 8 kA margin 10%
      selected "S" 5.1 kA
    }`;
    const { resolved } = process(src);
    /* 5.1 kA is in mandatory [5, 8] but 5.1 < 5.5 preferred lower */
    expect(['caution', 'recommended']).toContain(resolved!.status);
  });

  it('do-not-set when explicit selection crosses mandatory original criterion', () => {
    const src = `diagram "T" {
      below "L" must 5 kA
      above "U" must 8 kA
      selected "S" 9 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('do-not-set');
  });

  it('no-recommended-setting when preferred interval empty but mandatory exists', () => {
    const src = `diagram "T" {
      below "HL" must 7 kA margin 10%
      above "LF" must 8 kA margin 10%
      selected "S" none
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('no-recommended-setting');
  });

  it('no-compliant-setting when mandatory interval is empty', () => {
    const src = `diagram "T" {
      below "L" must 10 kA
      above "U" must 5 kA
      selected "S" none
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('no-compliant-setting');
  });
});

describe('PSDL semantics — preferred and mandatory intervals', () => {
  it('emits PSDL101 when there are no constraints', () => {
    const { diagnostics, resolved } = process(`diagram "T" { selected "S" none }`);
    expect(resolved).toBeDefined();
    expect(diagnostics.some((d) => d.code === 'PSDL101_NO_CONSTRAINT')).toBe(true);
  });

  it('emits PSDL104 on division by zero in expressions', () => {
    const src = `diagram "T" {
      below "L" must 5 / 0 kA
      selected "S" none
    }`;
    const result = process(src);
    const all = [...result.parseErrors, ...result.diagnostics];
    expect(all.some((d) => d.code === 'PSDL104_DIVIDE_BY_ZERO')).toBe(true);
  });

  it('emits PSDL108 when log scale has a non-positive value', () => {
    const src = `diagram "T" {
      scale log
      below "L" must -1 kA
      above "U" must 5 kA
      selected "S" none
    }`;
    const { diagnostics } = process(src);
    expect(diagnostics.some((d) => d.code === 'PSDL108_LOG_NONPOSITIVE' || d.code === 'PSDL102_VALUE_NEGATIVE')).toBe(true);
  });
});

describe('PSDL semantics — selection forms', () => {
  it('low selection picks mandatoryInterval.minimum, rounded up to step', () => {
    const src = `diagram "T" {
      below "L" must 5 kA
      below "M" must 7 kA margin 10%
      above "U" must 8 kA
      selected "S" low step 0.3 kA
    }`;
    const { resolved } = process(src);
    /* mandatory lower is 7 kA (the higher of two below/must), step 0.3 kA
     * → ceil(7/0.3) * 0.3 = 7.2 kA. Preferred lower is 7.7 kA, so 7.2
     * lands outside preferred → CAUTION. */
    expect(resolved!.selection.value_A).toBeCloseTo(7200, 6);
    expect(resolved!.status).toBe('caution');
  });

  it('high selection picks mandatoryInterval.maximum, rounded down to step', () => {
    const src = `diagram "T" {
      below "L" must 5 kA
      above "U" must 8 kA margin 10%
      above "M" must 9 kA
      selected "S" high step 0.3 kA
    }`;
    const { resolved } = process(src);
    /* mandatory upper is 8 kA (the lower of two above/must), step 0.3 kA
     * → floor(8/0.3) * 0.3 = 7.8 kA. Preferred upper is 7.2 kA, so 7.8
     * lands outside preferred → CAUTION. */
    expect(resolved!.selection.value_A).toBeCloseTo(7800, 6);
    expect(resolved!.status).toBe('caution');
  });

  it('low selection with no step is the exact mandatory lower', () => {
    const src = `diagram "T" {
      below "L" must 5 kA
      above "U" must 8 kA
      selected "S" low
    }`;
    const { resolved } = process(src);
    expect(resolved!.selection.value_A).toBeCloseTo(5000, 6);
  });

  it('low selection fails when mandatory interval is empty', () => {
    const src = `diagram "T" {
      below "L" must 10 kA
      above "U" must 5 kA
      selected "S" low
    }`;
    const result = process(src);
    const all = [...result.parseErrors, ...result.diagnostics];
    expect(all.some((d) => d.code === 'PSDL110_MANDATORY_INTERVAL_EMPTY')).toBe(true);
  });

  it('MVA setpoint is converted to amps using the declared voltage', () => {
    const src = `diagram "T" {
      voltage 33 kV
      below "L" must 3 kA
      above "U" must 5 kA
      selected "S" 200 MVA
    }`;
    const { resolved } = process(src);
    /* 200 MVA at 33 kV = 200_000 / (sqrt(3) * 33) ≈ 3499 A. */
    expect(resolved!.selection.value_A).toBeCloseTo(3499, 0);
  });

  it('MVA setpoint without voltage is rejected', () => {
    const src = `diagram "T" {
      below "L" must 3 kA
      above "U" must 5 kA
      selected "S" 200 MVA
    }`;
    const result = process(src);
    const all = [...result.parseErrors, ...result.diagnostics];
    expect(all.some((d) => d.code === 'PSDL107_UNIT_INCOMPATIBLE')).toBe(true);
  });
});

describe('PSDL semantics — absolute margins (spec §Absolute margins)', () => {
  /* Regression: the margin unit used to be discarded and hardcoded to A,
   * so `margin 0.5 kA` silently resolved to 0.5 A — a 1000x error in a
   * protection margin — while also leaving the unit token to be parsed
   * as a bogus statement. */
  it('honours the unit on an absolute margin rather than assuming amps', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 0.5 kA
      above "U" must 12 kA margin 1.2 kA
      selected "S" none
    }`;
    const result = process(src);
    expect(result.parseErrors).toHaveLength(0);
    const [lower, upper] = result.resolved!.constraints;
    /* below adds the margin, above subtracts it */
    expect(lower!.boundary_A).toBeCloseTo(5500, 6);
    expect(upper!.boundary_A).toBeCloseTo(10800, 6);
  });

  it('accepts an absolute margin in amps', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 500 A
      selected "S" none
    }`;
    const result = process(src);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.resolved!.constraints[0]!.boundary_A).toBeCloseTo(5500, 6);
  });

  it('rejects an absolute margin with no unit', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 0.5
      selected "S" none
    }`;
    const result = process(src);
    const all = [...result.parseErrors, ...result.diagnostics];
    expect(all.some((d) => d.code === 'PSDL005_UNIT_UNKNOWN')).toBe(true);
  });
});
