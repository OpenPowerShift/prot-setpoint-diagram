import { process, renderSvg } from '../src/index.ts';
import { readFileSync, writeFileSync } from 'node:fs';
for (const name of ['07-low-selection', '08-high-selection', '09-mva-setpoint']) {
  const src = readFileSync(`examples/${name}.psdl`, 'utf-8');
  const result = process(src);
  const sel = result.resolved?.selection;
  const value_A = sel?.value_A;
  const value_kA = value_A ? (value_A / 1000).toFixed(3) : 'n/a';
  const value_MVA = value_A ? (Math.sqrt(3) * 33 * value_A / 1000).toFixed(2) : 'n/a';
  console.log(`${name}: status=${result.resolved?.status} selection=${value_kA} kA (${value_MVA} MVA)`);
  for (const d of result.diagnostics) {
    if (d.severity === 'error' || d.severity === 'warning') console.log(`  [${d.severity}/${d.code}] ${d.message}`);
  }
  if (result.resolved) {
    writeFileSync(`examples/${name}.svg`, renderSvg(result.resolved));
  }
}
