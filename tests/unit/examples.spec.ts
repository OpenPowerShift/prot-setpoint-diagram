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
