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
    expect(svg).toContain('40 kA');
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
