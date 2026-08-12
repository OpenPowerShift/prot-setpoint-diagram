import { parseAndRender } from '../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';

const examples = ['feeder-setting', 'preferred-conflict', 'wide-range'];
for (const name of examples) {
  const src = readFileSync(`examples/${name}.psdl`, 'utf-8');
  const { svg, result } = parseAndRender(src);
  writeFileSync(`examples/${name}.svg`, svg);
  const sel = result.resolved?.selection;
  const selKa = sel && Number.isFinite(sel.value_A) ? (sel.value_A / 1000).toFixed(3) + ' kA' : 'n/a';
  console.log(`${name}: status=${result.resolved?.status} selection=${selKa}`);
}
