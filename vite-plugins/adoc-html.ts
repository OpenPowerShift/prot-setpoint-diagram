/**
 * Vite plugin: turn `.adoc` files into HTML at build time.
 *
 *   import guide from './docs/guide.adoc?adoc-html';
 *
 * Renders the AsciiDoc synchronously through `@asciidoctor/core`. The
 * resulting HTML is wrapped in a `<div class="psdl-guide">` so the
 * playground's global stylesheet can theme it.
 *
 * Image references (`image::name.png[Alt]`) are rewritten so the
 * referenced file is loaded from disk and inlined as a data URI. This
 * keeps the rendered HTML self-contained — the user does not have to
 * serve `spec/images/*` alongside the bundle, and the spec retains
 * the original `image::` directives.
 *
 *   include::path/to.adoc[leveloffset=+1]
 *
 * is also resolved at build time. The included file is read from
 * disk and the `include::` directive is replaced with the rendered
 * HTML before Asciidoctor processes the document. This makes the
 * spec's `include::examples/feeder-setting.psdl[]` line work in the
 * playground without manually copying the example.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

interface AdocHtmlPluginOptions {
  asciidoctorModule?: string;
  attributes?: Record<string, string | boolean>;
}

const INCLUDE_RE = /^include::([^\[]+)\[([^\]]*)\]\s*$/gm;
const IMAGE_RE = /image::([^\[]+)\[([^\]]*)\]\s*$/gm;

function resolveInclude(baseDir: string, target: string): string | null {
  const stripped = target.split(',')[0]!.trim();
  const levelMatch = stripped.match(/^(.+?)\[leveloffset=([+-]?\d+)\]$/);
  let path = stripped;
  if (levelMatch) path = levelMatch[1]!;
  const abs = isAbsolute(path) ? path : resolvePath(baseDir, path);
  return existsSync(abs) ? abs : null;
}

function fileToDataUri(absPath: string, baseDir: string): string {
  const rel = isAbsolute(absPath) ? absPath.slice(baseDir.length).replace(/^[/\\]/, '') : absPath;
  const buf = readFileSync(absPath);
  const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
  const mime =
    ext === 'svg' ? 'image/svg+xml' :
    ext === 'png' ? 'image/png' :
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
    ext === 'gif' ? 'image/gif' :
    ext === 'webp' ? 'image/webp' :
    'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function rewriteIncludes(src: string, baseDir: string): string {
  return src.replace(INCLUDE_RE, (whole, target: string, opts: string) => {
    const abs = resolveInclude(baseDir, target.split(',')[0]!.trim());
    if (!abs) return whole;
    const ext = abs.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'adoc') {
      let sub = readFileSync(abs, 'utf-8');
      sub = rewriteIncludes(sub, dirname(abs));
      return `\n++++\n${sub}\n++++\n`;
    }
    if (ext === 'psdl') {
      const body = readFileSync(abs, 'utf-8');
      return `[source,psdl]\n----\n${body}----\n`;
    }
    if (ext === 'ebnf') {
      const body = readFileSync(abs, 'utf-8');
      return `[source,ebnf]\n----\n${body}----\n`;
    }
    if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) {
      const uri = fileToDataUri(abs, baseDir);
      return `image::${uri}[${opts}]`;
    }
    const body = readFileSync(abs, 'utf-8');
    return `....\n${body}\n....`;
  });
}

function rewriteImages(src: string, baseDir: string, imagesDir: string): string {
  return src.replace(IMAGE_RE, (whole, target: string, opts: string) => {
    const stripped = target.split(',')[0]!.trim();
    if (/^data:/.test(stripped) || /^https?:\/\//.test(stripped)) return whole;
    const abs = isAbsolute(stripped) ? stripped : resolvePath(imagesDir, stripped);
    if (!existsSync(abs)) return whole;
    const uri = fileToDataUri(abs, baseDir);
    return `image::${uri}[${opts}]`;
    void baseDir;
  });
}

export default function adocHtml(opts: AdocHtmlPluginOptions = {}) {
  return {
    name: 'psdl-adoc-html',
    enforce: 'pre' as const,

    async resolveId(id: string, importer?: string) {
      if (id.endsWith('?adoc-html')) {
        const stripped = id.slice(0, -'?adoc-html'.length);
        return this.resolve(stripped, importer, { skipSelf: true });
      }
      return null;
    },

    async load(id: string) {
      if (!id.endsWith('.adoc')) return null;
      const projRoot = process.cwd();
      const file = id.startsWith('/') ? id : resolvePath(projRoot, id);
      let src = readFileSync(file, 'utf-8');
      const baseDir = dirname(file);
      /* Default imagesdir is "images" relative to the .adoc. */
      const imagesDir = resolvePath(baseDir, 'images');
      src = rewriteIncludes(src, baseDir);
      src = rewriteImages(src, baseDir, imagesDir);
      const mod = await import(opts.asciidoctorModule ?? '@asciidoctor/core') as any;
      const asciidoctor = mod.default ?? mod;
      const asciidoctorFn = asciidoctor.convert;
      if (typeof asciidoctorFn !== 'function') {
        throw new Error('asciidoctor module did not expose convert()');
      }
      const html = await asciidoctorFn(src, {
        safe: 'unsafe',
        attributes: {
          ...(opts.attributes ?? {}),
          icons: 'font',
          experimental: true,
          sectids: true,
          idprefix: '',
          idseparator: '-',
        },
      });
      return `export default ${JSON.stringify(html)};`;
    },
  } as any;
  void fileURLToPath; void dirname;
}
