import { readFileSync, writeFileSync } from 'node:fs';
import * as asciidoctor from '@asciidoctor/core';
const src = readFileSync('docs/guide.adoc', 'utf-8');
const html = await asciidoctor.convert(src, { safe: 'unsafe', attributes: { icons: 'font' } });
writeFileSync('/tmp/test.html', html);
console.log('html length:', html.length);
