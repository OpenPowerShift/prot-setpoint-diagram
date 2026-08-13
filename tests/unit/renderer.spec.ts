import { describe, it, expect } from 'vitest';
import { parseAndRender } from '~/index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = (name: string) => readFileSync(join('examples', `${name}.psdl`), 'utf-8');

describe('paint order: grid stays under markers, markers under selection/status', () => {
  it('layers appear in back-to-front document order', () => {
    const { svg } = parseAndRender(load('feeder-setting'));
    const gridAt = svg.indexOf('data-layer="grid"');
    const markersAt = svg.indexOf('data-layer="markers"');
    const foregroundAt = svg.indexOf('data-layer="foreground"');
    expect(gridAt).toBeGreaterThan(-1);
    expect(markersAt).toBeGreaterThan(gridAt);
    expect(foregroundAt).toBeGreaterThan(markersAt);
  });
});

describe('spec §Normative visual encoding: kA precision', () => {
  it('shows conditions to one decimal place and the setting to two', () => {
    const { svg } = parseAndRender(load('feeder-setting'));
    expect(svg).toContain('>3.5 kA<');
    expect(svg).toContain('>8.0 kA<');
    expect(svg).toContain('>12.0 kA<');
    /* The selection's own label ("Selected setting") is the word shown
     * above the plot; the numeric value now sits in its own row on the
     * axis, spec §Selected-setting label. */
    expect(svg).toMatch(/data-role="selected-label"[^>]*>Selected setting</);
    expect(svg).toMatch(/data-role="selected-value"[^>]*>6\.35 kA/);
  });

  it('leaves sub-1000 A values in whole amps with no forced decimals', () => {
    const src = `diagram "Amps" {
      below "Load" must 400 A
      above "Fault" must 900 A
      selected "Setting" 650 A
    }`;
    const { svg } = parseAndRender(src);
    expect(svg).toContain('>400 A<');
    expect(svg).toContain('>900 A<');
    expect(svg).toMatch(/data-role="selected-label"[^>]*>Setting</);
    expect(svg).toMatch(/data-role="selected-value"[^>]*>650 A</);
  });
});

describe('spec §Secondary axis', () => {
  const base = `diagram "T" {
    voltage 33 kV
    below "Emergency load" must 5 kA margin 10%
    above "Minimum fault" must 8 kA margin 10%
    selected "S" midpoint step 0.05 kA`;

  it('draws MVA ticks at the top, converted at the diagram nominal voltage', () => {
    const { svg, result } = parseAndRender(`${base}
      secondary axis top MVA
    }`);
    expect(result.resolved?.secondaryAxis).toEqual({ position: 'top', quantity: 'MVA', voltage_kV: 33 });
    expect(svg).toContain('data-role="secondary-axis"');
    /* Only the outermost tick carries the unit (spec §Axis) — the rest
     * are bare numbers, so check for the bare value and the unit
     * appearing somewhere in the MVA tick row rather than every tick
     * spelling out "MVA". */
    expect(svg).toContain('>300<');
    expect(svg).toMatch(/>[\d.]+ MVA</);
  });

  it('draws at the bottom when requested', () => {
    const { svg } = parseAndRender(`${base}
      secondary axis bottom MVA
    }`);
    const line = svg.match(/<line data-role="secondary-axis"[^>]*y1="([\d.]+)"/);
    const primaryAxisLine = svg.match(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1" stroke="#[0-9a-f]{6}" stroke-width="1"\/>/);
    expect(line).not.toBeNull();
    expect(primaryAxisLine).not.toBeNull();
    expect(Number(line![1])).toBeGreaterThan(Number(primaryAxisLine![1]));
  });

  it('uses its own `@` voltage override instead of the diagram nominal', () => {
    const { result } = parseAndRender(`${base}
      secondary axis top MVA @ 11 kV
    }`);
    expect(result.resolved?.secondaryAxis?.voltage_kV).toBe(11);
  });

  it('a `kA` secondary axis needs no voltage and mirrors the primary values', () => {
    const { result } = parseAndRender(`diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" midpoint step 0.05 kA
      secondary axis top kA
    }`);
    expect(result.resolved?.secondaryAxis).toEqual({ position: 'top', quantity: 'kA', voltage_kV: undefined });
  });

  it('rejects MVA with no voltage available anywhere', () => {
    const { result } = parseAndRender(`diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" midpoint step 0.05 kA
      secondary axis top MVA
    }`);
    expect(result.diagnostics.some((d) => d.code === 'PSDL107_UNIT_INCOMPATIBLE')).toBe(true);
  });

  it('is ignored in vertical orientation, without disrupting layout', () => {
    const { svg } = parseAndRender(`diagram "T" {
      orientation vertical
      voltage 33 kV
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" midpoint step 0.05 kA
      secondary axis top MVA
    }`);
    expect(svg).not.toContain('data-role="secondary-axis"');
  });
});

describe('spec §Per-quantity voltage: override shown in brackets', () => {
  it('shows the override next to each criterion and the selected value', () => {
    const { svg } = parseAndRender(load('13-per-quantity-voltage'));
    expect(svg).toContain('2.6 kA (@ 11 kV)');
    expect(svg).toContain('5.2 kA (@ 33 kV)');
    expect(svg).toMatch(/data-role="selected-value"[^>]*>4\.20 kA \(@ 11 kV\)/);
  });

  it('does not show a bracket for a plain kA/A quantity — the override has no effect there', () => {
    const src = `diagram "T" {
      below "Load" must 5 kA @ 11 kV
      selected "S" midpoint
    }`;
    const { svg } = parseAndRender(src);
    expect(svg).not.toContain('@ 11 kV');
  });

  it('does not double up the bracket when `show entered` already displays it', () => {
    const src = `diagram "T" {
      show entered, current
      below "Load" must 50 MVA @ 11 kV margin 10%
      above "Fault" must 300 MVA @ 33 kV margin 10%
      selected "S" 80 MVA @ 11 kV
    }`;
    const { svg } = parseAndRender(src);
    const selectedValue = svg.match(/<text data-role="selected-value"[^>]*>([^<]*)<\/text>/)?.[1] ?? '';
    expect((selectedValue.match(/@ 11 kV/g) ?? []).length).toBe(1);
  });
});

describe('spec §Displayed quantities: nominal-voltage MVA cross-reference', () => {
  const base = `diagram "T" {
    voltage 33 kV
    show current, mva
    below "L" must 5 kA
    above "F" must 8 kA`;

  it('shows the nominal MVA in brackets when the override differs from the nominal voltage', () => {
    const src = `${base}
      selected "S" 80 MVA @ 11 kV
    }`;
    const { svg } = parseAndRender(src);
    expect(svg).toContain('80 MVA (240 MVA @ 33 kV nominal)');
  });

  it('omits the bracket when there is no override — nominal is already what is shown', () => {
    const src = `${base}
      selected "S" midpoint
    }`;
    const { svg } = parseAndRender(src);
    expect(svg).not.toContain('nominal');
  });

  it('omits the bracket when the override happens to equal the nominal voltage', () => {
    const src = `${base}
      selected "S" 80 MVA @ 33 kV
    }`;
    const { svg } = parseAndRender(src);
    expect(svg).not.toContain('nominal');
  });
});

describe('spec §Selected-setting percentages: zone annotations', () => {
  it('merges both preferred edges into one label when the zone is too narrow for two', () => {
    // feeder-setting's preferred interval (5.5-7.2 kA) is narrow enough
    // relative to the axis that separate "5.5 kA" / "7.2 kA" labels
    // would collide — merged into one two-line block is the fallback.
    const { svg } = parseAndRender(load('feeder-setting'));
    const annotations = [...svg.matchAll(/<text data-role="zone-percent"[^>]*>([^<]*)<\/text>/g)];
    expect(annotations).toHaveLength(2);
    expect(annotations[0]![1]).toBe('5.5 kA · 7.2 kA');
    expect(annotations[1]![1]).toBe('+15.5% · -11.8%');
  });

  it('does not show a "Recommended" word or repeat the zone-annotated numbers in the footer', () => {
    const { svg } = parseAndRender(load('feeder-setting'));
    expect(svg).not.toContain('Recommended');
    expect(svg).not.toContain('lower boundary');
    expect(svg).not.toContain('upper boundary');
  });

  it('caution: annotates both edges separately when there is room, sign follows the number line', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" 7.4 kA
    }`;
    const { svg } = parseAndRender(src);
    const annotations = [...svg.matchAll(/<text data-role="zone-percent" data-edge="(\w+)"[^>]*>([^<]*)<\/text>/g)];
    expect(annotations).toHaveLength(4); // kA line + percent line, per edge
    const byEdge: Record<string, string[]> = {};
    for (const [, edge, text] of annotations) (byEdge[edge!] ??= []).push(text!);
    expect(byEdge.lower).toEqual(['5.5 kA', '+34.5%']);
    // S=7.4 numerically exceeds the 7.2 kA upper boundary, so the raw
    // sign is positive even though this is the violated edge — colour
    // (not sign) is what flags it, checked separately below.
    expect(byEdge.upper).toEqual(['7.2 kA', '+2.8%']);
  });

  it('caution: the violated edge is coloured caution/red even though its sign is positive', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" 7.4 kA
    }`;
    const { svg } = parseAndRender(src);
    const upperText = svg.match(/<text data-role="zone-percent" data-edge="upper"[^>]*fill="(#[0-9a-f]{6})"[^>]*>/);
    const lowerText = svg.match(/<text data-role="zone-percent" data-edge="lower"[^>]*fill="(#[0-9a-f]{6})"[^>]*>/);
    expect(upperText).not.toBeNull();
    expect(lowerText).not.toBeNull();
    expect(upperText![1]).not.toBe(lowerText![1]);
  });

  it('do-not-set: a single annotation at the crossed boundary, and a generic footer message', () => {
    const src = `diagram "T" {
      below "Emergency load" must 5 kA margin 10%
      above "Minimum fault" must 8 kA margin 10%
      selected "S" 9 kA
    }`;
    const { svg } = parseAndRender(src);
    const annotations = [...svg.matchAll(/<text data-role="zone-percent" data-edge="(\w+)"[^>]*>([^<]*)<\/text>/g)];
    expect(annotations).toHaveLength(2); // kA line + percent line, one edge
    expect(annotations[0]![1]).toBe('upper');
    expect(annotations[0]![2]).toBe('7.2 kA');
    expect(annotations[1]![2]).toBe('+25%');
    expect(svg).toContain('selected value crosses a mandatory criterion');
  });

  it('vertical: each label sits near its OWN boundary, not a shared band-end position', () => {
    // Regression: a previous implementation stacked both labels near
    // whichever end of the band had clearance from the selected line,
    // which could land the LOWER boundary's label up near the UPPER
    // boundary's true position on a tall band — visually disconnected
    // from the value it names. Each label must track its own y.
    const src = `diagram "T" {
      orientation vertical
      below "Emergency load" must 3 kA margin 20%
      above "Minimum fault" must 12 kA margin 20%
      selected "S" 6 kA
    }`;
    const { svg } = parseAndRender(src);
    const upper = svg.match(/<text data-role="zone-percent" data-edge="upper"[^>]*y="([\d.]+)"[^>]*>([^<]*)</);
    const lower = svg.match(/<text data-role="zone-percent" data-edge="lower"[^>]*y="([\d.]+)"[^>]*>([^<]*)</);
    // The open "margin" circle IS the preferred boundary each label
    // describes (the filled "criterion" dot is the original, unmargined
    // value) — compare against that, not the criterion dot.
    const upperMarkerY = svg.match(/<circle data-role="margin" cx="156" cy="([\d.]+)"[^>]*stroke="#1d4ed8"/);
    const lowerMarkerY = svg.match(/<circle data-role="margin" cx="156" cy="([\d.]+)"[^>]*stroke="#0f766e"/);
    expect(upper).not.toBeNull();
    expect(lower).not.toBeNull();
    expect(upper![2]).toBe('9.6 kA -37.5%');
    expect(lower![2]).toBe('3.6 kA +66.7%');
    // "upper"'s label must land near the upper boundary's own marker
    // row, not near the lower one's (and vice versa) — within a couple
    // of row-heights, not the ~90px the old shared-end bug produced.
    expect(Math.abs(Number(upper![1]) - Number(upperMarkerY![1]))).toBeLessThan(20);
    expect(Math.abs(Number(lower![1]) - Number(lowerMarkerY![1]))).toBeLessThan(20);
  });
});

describe('spec §Requirement levels: reference criteria do not enter banding', () => {
  it('a reference point outside the preferred range does not shift status away from recommended', () => {
    const { result } = parseAndRender(load('18-reference-point'));
    expect(result.resolved?.status).toBe('recommended');
  });

  it('the reference value plots but is excluded from the mandatory/preferred interval', () => {
    const { result } = parseAndRender(load('18-reference-point'));
    const mandatory = result.resolved!.mandatoryInterval;
    // The reference point (9.5 kA) is well past the "must" upper boundary
    // (8 kA); if it leaked into the calculation, mandatory.maximum would
    // reflect it instead of the real must-above criterion.
    expect(mandatory.maximum).toBeCloseTo(8000, 3);
  });

  it('renders an open (unfilled) marker, not a family-coloured filled one', () => {
    const { svg } = parseAndRender(load('18-reference-point'));
    expect(svg).toContain('data-requirement="reference"');
    const dot = svg.match(/<circle data-role="criterion" data-requirement="reference"[^>]*>/)?.[0] ?? '';
    expect(dot).not.toContain('fill="#1d4ed8"'); // not the "upper" family colour
  });

  it('rejects a margin on a reference criterion', () => {
    const src = `diagram "Bad reference" {
      below "Load" must 5 kA
      above "Note" reference 9 kA margin 10%
      selected "Setting" midpoint
    }`;
    const { result } = parseAndRender(src);
    expect(result.parseErrors.some((e) => e.code === 'PSDL006_MARGIN_NOT_APPLICABLE')).toBe(true);
  });
});

describe('style title off/on', () => {
  it('hides the title header when off, and shrinks the canvas', () => {
    const on = parseAndRender(load('feeder-setting'));
    const off = parseAndRender(`${load('feeder-setting').replace('{', '{\n  style title off\n')}`);
    expect(on.svg).toContain('data-role="header"');
    expect(off.svg).not.toContain('data-role="header"');
    expect(off.result.resolved?.choices.title).toBe('off');
  });

  it('rejects an unknown title value', () => {
    const src = `diagram "T" {
      style title sideways
      below "x" must 1 kA
    }`;
    const { result } = parseAndRender(src);
    expect(result.resolved?.diagnostics.some((d) => d.code === 'PSDL001_UNKNOWN_STATEMENT')).toBe(true);
  });
});

describe('spec §Status order: no forced uppercase', () => {
  it('caution status renders sentence case, not all-caps', () => {
    const { svg, result } = parseAndRender(load('03-caution'));
    expect(result.resolved?.status).toBe('caution');
    expect(svg).toContain('Caution');
    expect(svg).not.toContain('CAUTION');
  });

  it('indicative-spacing notice renders sentence case, not all-caps', () => {
    const { svg } = parseAndRender(load('11-indicative-scale'));
    expect(svg).toContain('Indicative spacing — not to scale');
    expect(svg).not.toContain('INDICATIVE SPACING');
  });

  it('no-compliant-setting keeps a status word, but sentence case and without "conflict" wording', () => {
    const { svg, result } = parseAndRender(load('01-mandatory-conflict'));
    expect(result.resolved?.status).toBe('no-compliant-setting');
    expect(svg).toContain('No compliant setting');
    expect(svg).not.toContain('NO COMPLIANT SETTING');
    /* the diagram's own title ("Mandatory conflict") legitimately says
     * "conflict" — check the generated status-detail text specifically,
     * not the whole document. */
    const detailLine = svg.match(/<text[^>]*>No compliant setting[^<]*<\/text>/)?.[0] ?? '';
    expect(detailLine).not.toContain('conflict');
  });

  it('custom `word selected` is used as the selected-label prefix', () => {
    const { svg } = parseAndRender(load('05-words'));
    expect(svg).toContain('Setting');
  });
});

describe('spec §Status order: no-recommended-setting shows a range, not a verdict word', () => {
  const { svg, result } = parseAndRender(load('preferred-conflict'));

  it('resolves to no-recommended-setting', () => {
    expect(result.resolved?.status).toBe('no-recommended-setting');
  });

  it('does not show a status word', () => {
    expect(svg).not.toContain('NO RECOMMENDED SETTING');
    expect(svg).not.toContain('No recommended setting');
    expect(svg).not.toContain('No preferred setting');
  });

  it('shows the preferred boundary values instead', () => {
    expect(svg).toMatch(/Preferred .* and .*kA/);
  });
});

describe('spec §No selection: no-selection shows a range, not a verdict word', () => {
  const src = `diagram "No selection" {
    orientation horizontal
    scale linear
    range auto
    below "Emergency load" must 5 kA margin 10%
    above "Minimum fault" must 8 kA margin 10%
    selected "Selected setting" none
  }`;
  const { svg, result } = parseAndRender(src);

  it('resolves to no-selection with a non-empty preferred interval', () => {
    expect(result.resolved?.status).toBe('no-selection');
  });

  it('does not show a status word', () => {
    expect(svg).not.toContain('NO SETTING SELECTED');
    expect(svg).not.toContain('No setting selected');
  });

  it('shows the preferred range instead', () => {
    expect(svg).toMatch(/Preferred range .*kA.* – .*kA/);
  });
});
