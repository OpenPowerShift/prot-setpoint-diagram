import { describe, it, expect } from 'vitest';
import { parseAndRender } from '~/index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = 'examples';
const sources = ['feeder-setting', 'preferred-conflict', 'wide-range'];

for (const name of sources) {
  describe(`spec example: ${name}`, () => {
    const src = readFileSync(join(SRC_DIR, `${name}.psdl`), 'utf-8');
    it('renders without throwing', () => {
      const { svg, result } = parseAndRender(src);
      expect(svg).toMatch(/<svg /);
      expect(svg.length).toBeGreaterThan(500);
      expect(result.parseErrors).toHaveLength(0);
    });
    it('produces a resolved model', () => {
      const { result } = parseAndRender(src);
      expect(result.resolved).toBeDefined();
    });
    it('contains the expected encoding shapes (markers, axis, status)', () => {
      const { svg } = parseAndRender(src);
      expect(svg).toMatch(/data-role="/);
      expect(svg).toMatch(/data-zone="(mandatory|preferred|axis|header)"/);
    });
  });
}

describe('spec §Range: off-range markers', () => {
  /* Regression: `range focus` sizes the axis around the controlling
   * boundaries only. A non-controlling criterion well outside that
   * window used to compute a marker position via unclamped
   * value-to-pixel math, placing it far outside the SVG's own viewBox —
   * effectively an invisible, silently omitted value, which spec
   * §Range forbids ("MUST NOT omit a value without an explicit
   * off-range marker containing the exact value and unit"). */
  const src = `diagram "Off-range" {
    range focus
    below "Maximum load" must 2 kA
    below "Emergency load" must 5 kA margin 10%
    above "Minimum fault" must 8 kA margin 10%
    above "Remote check" must 40 kA
    selected "Pickup" midpoint
  }`;

  it('emits PSDL204_OFF_RANGE_MARKER for the remote criterion', () => {
    const { result } = parseAndRender(src);
    expect(result.diagnostics.some((d) => d.code === 'PSDL204_OFF_RANGE_MARKER')).toBe(true);
  });

  it('draws an off-range marker with the exact value rather than clipping it', () => {
    const { svg } = parseAndRender(src);
    expect(svg).toMatch(/data-role="off-range-marker"/);
    expect(svg).toContain('40.0 kA');
  });

  it('keeps the off-range label within the canvas in vertical orientation', () => {
    const { svg } = parseAndRender(src.replace('range focus', 'orientation vertical\n    range focus'));
    const heightMatch = svg.match(/height="([\d.]+)"/);
    expect(heightMatch).not.toBeNull();
    const height = Number(heightMatch![1]);
    for (const m of svg.matchAll(/data-role="criterion-label" x="[\d.]+" y="(-?[\d.]+)"/g)) {
      const y = Number(m[1]);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(height);
    }
  });
});

describe('spec §Layout step 9: combine identical positions', () => {
  const src = `diagram "Coincident values" {
    below "Load A" must 5 kA
    below "Load B" must 5 kA
    below "Load C" must 5 kA
    above "Fault" must 8 kA
    selected "Pickup" 6 kA
  }`;

  it('draws one marker with ×N instead of three stacked ones', () => {
    const { svg } = parseAndRender(src);
    expect(svg).toContain('5.0 kA ×3');
    expect((svg.match(/data-role="criterion"/g) ?? []).length).toBe(2); // combined + Fault
  });

  it('lists every combined name in the gutter, not truncated', () => {
    const { svg } = parseAndRender(src);
    expect(svg).toContain('Load A, Load B, Load C');
  });

  it('does not combine criteria that share a value but not a margin', () => {
    const distinctMargins = `diagram "T" {
      below "Load A" must 5 kA margin 10%
      below "Load B" must 5 kA margin 5%
      above "Fault" must 8 kA
      selected "S" 6 kA
    }`;
    const { svg } = parseAndRender(distinctMargins);
    expect(svg).not.toContain('×2');
    expect((svg.match(/data-role="criterion"/g) ?? []).length).toBe(3);
  });

  it('sizes the gutter to the combined label so it is not clipped', () => {
    /* Regression: gutters/canvas used to be sized from each individual
     * label, then the render loop drew the combined ", "-joined one —
     * fine for one name, an overflow as soon as a group had two. */
    const { svg } = parseAndRender(src);
    const m = svg.match(/data-role="criterion-label"[^>]*x="([\d.]+)"/);
    expect(m).not.toBeNull();
    const labelX = Number(m![1]);
    expect(labelX).toBeGreaterThan(0);
  });
});

describe('vertical marker-collision avoidance (distinct from label decluttering)', () => {
  /* Regression: label decluttering only ever moved TEXT. Criteria close
   * enough in value that their ~12px dots would land on top of each
   * other (but NOT identical — those combine into one ×N marker
   * instead, see above) had nothing keeping the dots themselves apart. */
  const src = `diagram "Near-coincident dots" {
    orientation vertical
    below "Load A" must 5.00 kA
    below "Load B" must 5.02 kA
    below "Load C" must 5.04 kA
    above "Fault" must 8 kA
    selected "Pickup" 6 kA
  }`;

  it('spreads colliding dots into distinct x positions rather than stacking them', () => {
    const { svg } = parseAndRender(src);
    const xs = [...svg.matchAll(/data-role="criterion" cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBe(4); // Load A, B, C + Fault
    const belowXs = new Set(xs.slice(0, 3).map((x) => Math.round(x)));
    expect(belowXs.size).toBe(3); // three distinct x positions, not one
  });

  it('leaves well-separated values untouched (all markers on the same x)', () => {
    const separated = `diagram "T" {
      orientation vertical
      below "Load A" must 5 kA
      above "Fault" must 8 kA
      selected "S" 6 kA
    }`;
    const { svg } = parseAndRender(separated);
    const xs = [...svg.matchAll(/data-role="criterion" cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(xs.map((x) => Math.round(x))).size).toBe(1);
  });
});
