import { describe, it, expect } from 'vitest';
import { parse } from '~/parser/parser';

describe('PSDL parser', () => {
  it('parses the complete introductory example without errors', () => {
    const src = `diagram "Test" {
      orientation horizontal
      voltage 33 kV
      ct 600/1 A
      show current, mva
      view report
      scale auto
      range auto

      below "Low" must 5 kA margin 10%
      above "Up" must 8 kA margin 10%

      selected "S" midpoint step 0.05 kA
    }`;
    const { document, errors } = parse(src);
    expect(errors).toHaveLength(0);
    expect(document).toBeDefined();
    expect(document!.diagram.body.length).toBeGreaterThan(0);
  });

  it('rejects bad statements with a diagnostic', () => {
    const src = `diagram "T" { foo bar baz }`;
    const { errors } = parse(src);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.code === 'PSDL001_UNKNOWN_STATEMENT')).toBe(true);
  });

  it('rejects an empty constraint label', () => {
    const src = `diagram "T" { below "" must 5 kA }`;
    const { errors } = parse(src);
    expect(errors.some((e) => e.code === 'PSDL003_STRING_REQUIRED')).toBe(true);
  });

  it('flags a duplicate orientation', () => {
    const src = `diagram "T" { orientation horizontal orientation vertical }`;
    const { errors } = parse(src);
    expect(errors.some((e) => e.code === 'PSDL002_DUPLICATE_SINGLETON')).toBe(true);
  });

  it('emits PSDL104 on division by zero', () => {
    const src = `diagram "T" { below "X" must 5 * (1/0) kA }`;
    const { errors } = parse(src);
    expect(errors.some((e) => e.code === 'PSDL104_DIVIDE_BY_ZERO')).toBe(true);
  });

  it('flags an unknown statement', () => {
    const src = `diagram "T" { bogus 5 kA }`;
    const { errors } = parse(src);
    expect(errors.some((e) => e.code === 'PSDL001_UNKNOWN_STATEMENT')).toBe(true);
  });
});
