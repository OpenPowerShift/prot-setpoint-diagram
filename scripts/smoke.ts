import { process, parseAndRender } from '../src/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const examples = ['feeder-setting', 'preferred-conflict', 'wide-range'];

for (const name of examples) {
  console.log(`\n=== ${name} ===`);
  const src = readFileSync(`examples/${name}.psdl`, 'utf-8');
  const { svg, result } = parseAndRender(src);
  writeFileSync(`/tmp/psdl-${name}.svg`, svg);

  if (!result.resolved) {
    console.log('NO RESOLVED');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('STATUS:', result.resolved.status);
    console.log('AXIS:', result.resolved.axis);
    console.log('SELECTION:', { kind: result.resolved.selection.kind, value_A: result.resolved.selection.value_A });
    const e = (result.parseErrors.length + result.diagnostics.length);
    console.log(`diagnostics: ${e} (${result.parseErrors.length} parse, ${result.diagnostics.length - result.parseErrors.length < 0 ? 0 : result.diagnostics.length - result.parseErrors.length} other)`);
  }
}
