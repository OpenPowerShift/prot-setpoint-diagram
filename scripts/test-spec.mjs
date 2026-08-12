import * as asciidoctor from '@asciidoctor/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const file = 'spec/spec.adoc';
let src = readFileSync(file, 'utf-8');

// Rewrite image:: refs to data URIs
const IMAGE_RE = /image::([^\[]+)\[([^\]]*)\]\s*$/gm;
const baseDir = resolvePath('spec');
src = src.replace(IMAGE_RE, (whole, target, opts) => {
  const stripped = target.split(',')[0].trim();
  if (/^data:/.test(stripped) || /^https?:\/\//.test(stripped)) return whole;
  const abs = resolvePath(baseDir, stripped);
  try {
    const buf = readFileSync(abs);
    const ext = abs.split('.').pop().toLowerCase();
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'application/octet-stream';
    return `image::data:${mime};base64,${buf.toString('base64')}[${opts}]`;
  } catch (e) {
    console.error('MISSING:', abs);
    return whole;
  }
});

const html = await asciidoctor.convert(src, { safe: 'unsafe', attributes: { icons: 'font' } });
writeFileSync('/tmp/spec.html', html);
console.log('html length:', html.length);
console.log('contains images:', html.includes('<img'));
console.log('img count:', (html.match(/<img /g) || []).length);
