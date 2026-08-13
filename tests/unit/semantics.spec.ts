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

  it('no-selection when a valid interval exists but nothing was selected', () => {
    /* Regression: the resolver used to fall through to `recommended`
     * here, which a renderer could only tell apart from a real approved
     * setting by separately checking Number.isFinite(selection.value_A) —
     * easy to miss, and exactly the bug that showed a RECOMMENDED pill
     * over an analysis-only diagram with no setpoint at all. */
    const src = `diagram "T" {
      below "L" must 5 kA margin 10%
      above "U" must 8 kA margin 10%
      selected "S" none
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('no-selection');
  });

  it('no-selection when midpoint fails to resolve against an unbounded interval', () => {
    const src = `diagram "T" {
      below "L" must 5 kA margin 10%
      selected "S" midpoint
    }`;
    const { resolved } = process(src);
    expect(Number.isFinite(resolved!.selection.value_A)).toBe(false);
    expect(resolved!.status).toBe('no-selection');
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

describe('PSDL semantics — per-quantity voltage override (spec §Per-quantity voltage)', () => {
  it('converts MVA to amps with no diagram-level voltage statement at all', () => {
    const src = `diagram "T" {
      below "L" must 100 MVA @ 33 kV
      above "U" must 300 MVA @ 33 kV
      selected "S" 200 MVA @ 33 kV
    }`;
    const result = process(src);
    expect(result.parseErrors).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    /* 200 MVA at 33 kV = 200_000 / (sqrt(3) * 33) ≈ 3499 A. */
    expect(result.resolved!.selection.value_A).toBeCloseTo(3499, 0);
  });

  it('lets criteria at different voltage levels share one diagram', () => {
    const src = `diagram "T" {
      below "11 kV side" must 50 MVA @ 11 kV
      above "33 kV side" must 300 MVA @ 33 kV
      selected "S" none
    }`;
    const { resolved } = process(src);
    const [lower, upper] = resolved!.constraints;
    /* 50 MVA @ 11 kV ≈ 2624.3 A; 300 MVA @ 33 kV ≈ 5248.6 A — each
     * converted with its OWN voltage, not a shared diagram-level one. */
    expect(lower!.value_A).toBeCloseTo(2624.3, 0);
    expect(upper!.value_A).toBeCloseTo(5248.6, 0);
  });

  it('an inline @ override takes precedence over the declared voltage statement', () => {
    const withOverride = `diagram "T" {
      voltage 33 kV
      below "L" must 100 MVA @ 11 kV
      selected "S" none
    }`;
    const withoutOverride = `diagram "T" {
      voltage 33 kV
      below "L" must 100 MVA
      selected "S" none
    }`;
    const a = process(withOverride).resolved!.constraints[0]!.value_A;
    const b = process(withoutOverride).resolved!.constraints[0]!.value_A;
    /* Same entered MVA, different effective voltage — must resolve to
     * different amps, and the override case must NOT equal what the
     * declared 33 kV alone would give. */
    expect(a).not.toBeCloseTo(b, 0);
    expect(a).toBeCloseTo(5248.6, 0); // 100 MVA @ 11 kV
    expect(b).toBeCloseTo(1749.5, 0); // 100 MVA @ 33 kV (declared)
  });

  it('still requires a voltage (declared or inline) for MVA without either', () => {
    const src = `diagram "T" {
      below "L" must 100 MVA
      selected "S" none
    }`;
    const result = process(src);
    const all = [...result.parseErrors, ...result.diagnostics];
    expect(all.some((d) => d.code === 'PSDL107_UNIT_INCOMPATIBLE')).toBe(true);
  });
});

describe('spec §Selected-setting percentages: signed headroom, one number per edge', () => {
  it('recommended: both preferred edges reported; sign follows the number line, not safety', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" midpoint step 0.05 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('recommended');
    expect(resolved!.selectedPercents).toHaveLength(2);
    // S=6.35 is above the 5.5 kA lower boundary (+) and below the 7.2 kA
    // upper boundary (-) — raw (S-B)/B, no family-based sign flip.
    expect(resolved!.selectedPercents![0]!.text).toBe('5.5 kA +15.5%');
    expect(resolved!.selectedPercents![1]!.text).toBe('7.2 kA -11.8%');
    expect(resolved!.selectedPercents![0]!.crossed).toBe(false);
    expect(resolved!.selectedPercents![1]!.crossed).toBe(false);
    // no ratio+clearance pair — a single signed number, not "115% of ... · 15% above"
    for (const p of resolved!.selectedPercents!) expect(p.text).not.toContain('% of');
  });

  it('caution: `crossed` flags the violated edge independently of the sign shown', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" 7.4 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('caution');
    const [lower, upper] = resolved!.selectedPercents!;
    expect(lower!.text).toBe('5.5 kA +34.5%');
    expect(lower!.crossed).toBe(false);
    // S=7.4 has numerically exceeded the 7.2 kA upper boundary, so the
    // raw sign is POSITIVE here even though this edge is the violated
    // one — `crossed` (not the sign) is what a renderer should colour by.
    expect(upper!.text).toBe('7.2 kA +2.8%');
    expect(upper!.crossed).toBe(true);
    expect(lower!.level).toBe('warning');
    expect(upper!.level).toBe('warning');
  });

  it('reports the actual preferred boundary for a plain `should` with no must+margin counterpart', () => {
    // The preferred lower bound here comes from a bare `should 5 kA`
    // criterion, distinct from the `must 4 kA` mandatory floor — the
    // percentage MUST be measured against 5 kA (what the green zone
    // actually shows), not silently fall back to the 4 kA must value.
    const src = `diagram "T" {
      below "Absolute minimum" must 4 kA
      below "Preferred minimum" should 5 kA
      above "Fault clearance" must 9 kA margin 10%
      selected "S" 4.5 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.preferredInterval.minimum).toBeCloseTo(5000, 6);
    expect(resolved!.status).toBe('caution');
    const lower = resolved!.selectedPercents!.find((p) => p.edge === 'lower');
    expect(lower!.text).toBe('5.0 kA -10%');
    expect(lower!.crossed).toBe(true);
  });

  it('do-not-set: reports only the crossed mandatory boundary, not the healthy far side', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" 9 kA
    }`;
    const { resolved } = process(src);
    expect(resolved!.status).toBe('do-not-set');
    expect(resolved!.selectedPercents).toHaveLength(1);
    // controllingUpper reports the margin-adjusted (preferred) boundary,
    // 7.2 kA, not the raw 8 kA mandatory criterion — pre-existing
    // behaviour, unchanged by this redesign.
    expect(resolved!.selectedPercents![0]!.text).toBe('7.2 kA +25%');
    expect(resolved!.selectedPercents![0]!.crossed).toBe(true);
    expect(resolved!.selectedPercents![0]!.level).toBe('error');
  });
});
