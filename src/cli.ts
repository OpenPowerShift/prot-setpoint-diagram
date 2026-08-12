/**
 * PSDL command-line interface.
 *
 * Usage:
 *   psdl render <file>             # SVG
 *   psdl render <file> --png       # PNG
 *   psdl render <file> --pdf       # PDF
 *   psdl report <file>             # text status report
 *   psdl check <file>              # exit code only
 *   psdl check <file> --json       # machine-readable findings
 *
 * Exit codes (per the spec's CI-gate convention):
 *   0 — clean
 *   1 — validation errors (no compliant setting or hard failures)
 *   2 — usage or I/O failure
 *   3 — study is valid but selects a CAUTION or DO NOT SET
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { process as processPsdl } from './index.js';
import { renderSvg } from './renderer/svg.js';

const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
})();

function die(msg: string, code = 2): never {
  console.error(`psdl: ${msg}`);
  process.exit(code);
}

interface Options {
  input: string;
  output?: string;
  format: 'svg' | 'png' | 'pdf';
  quiet: boolean;
  json: boolean;
  width?: number;
  help: boolean;
}

function parseArgs(argv: string[]): { command: string; options: Options } | undefined {
  let command = '';
  const opts: Options = { input: '', format: 'svg', quiet: false, json: false, help: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; i++; continue; }
    if (a === '-q' || a === '--quiet') { opts.quiet = true; i++; continue; }
    if (a === '--json') { opts.json = true; i++; continue; }
    if (a === '--png') { opts.format = 'png'; i++; continue; }
    if (a === '--svg') { opts.format = 'svg'; i++; continue; }
    if (a === '--pdf') { opts.format = 'pdf'; i++; continue; }
    if (a === '-o' || a === '--output') { opts.output = argv[++i]; i++; continue; }
    if (a === '--width') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 200 || v > 20000) die(`--width must be 200..20000 (got ${argv[i]})`);
      opts.width = v;
      i++;
      continue;
    }
    if (a.startsWith('--')) die(`unknown option: ${a}`);
    if (!command) command = a;
    else if (!opts.input) opts.input = a;
    else die(`unexpected extra argument: ${a}`);
    i++;
  }
  if (opts.help) return undefined;
  return { command, options: opts };
}

function help(): string {
  return `psdl — Protection Setting Diagram Language

Usage:
  psdl render <file.psdl> [--png|--svg|--pdf] [-o out]
  psdl report <file.psdl>
  psdl check  <file.psdl> [--json] [-q]

Options:
  -h, --help       show this help
  -q, --quiet      suppress non-error output
  -o, --output     output path (default: <input>.<format>)
  --width <px>     SVG render width (200..20000, default 1100)
  --svg            output SVG (default for render)
  --png            output PNG via resvg
  --pdf            output PDF via jsPDF
  --json           emit machine-readable JSON

Exit codes:
  0  clean study, all statuses OK or RECOMMENDED
  1  validation errors (no compliant setting)
  2  usage or I/O failure
  3  study is valid but selects a CAUTION / DO NOT SET
`;
}

interface CheckResult {
  command: string;
  source: string;
  title: string | null;
  status: string | null;
  axis: { minimum: number; maximum: number; scale: string; unit: string } | null;
  mandatoryInterval: { minimum: number; maximum: number };
  preferredInterval: { minimum: number; maximum: number };
  selected: { value_A: number; label: string; snapped?: boolean; defaulted?: boolean } | null;
  controlling: { lower: { label: string; boundary_A: number } | null; upper: { label: string; boundary_A: number } | null };
  diagnostics: { code: string; severity: string; line: number; column: number; message: string }[];
  exitCode: number;
}

function check(source: string, command: string): CheckResult {
  const result = processPsdl(source);
  const errors = result.parseErrors.filter((e) => e.severity === 'error');
  const allDiagnostics = [
    ...result.parseErrors.map((e) => ({ code: e.code, severity: e.severity, line: e.line, column: e.column, message: e.message })),
    ...result.diagnostics.map((d) => ({ code: d.code, severity: d.severity, line: d.line, column: d.column, message: d.message })),
  ];

  let exitCode = 0;
  if (errors.length > 0) exitCode = 1;
  else if (result.resolved && (result.resolved.status === 'do-not-set' || result.resolved.status === 'no-compliant-setting')) exitCode = 1;
  else if (result.resolved && (result.resolved.status === 'caution' || result.resolved.status === 'no-recommended-setting')) exitCode = 3;

  return {
    command,
    source: source.slice(0, 100) + (source.length > 100 ? '…' : ''),
    title: result.resolved?.title ?? null,
    status: result.resolved?.status ?? null,
    axis: result.resolved?.axis
      ? { minimum: result.resolved.axis.minimum, maximum: result.resolved.axis.maximum, scale: result.resolved.axis.scale, unit: result.resolved.axis.unit }
      : null,
    mandatoryInterval: result.resolved
      ? { minimum: result.resolved.mandatoryInterval.minimum, maximum: result.resolved.mandatoryInterval.maximum }
      : { minimum: Infinity, maximum: -Infinity },
    preferredInterval: result.resolved
      ? { minimum: result.resolved.preferredInterval.minimum, maximum: result.resolved.preferredInterval.maximum }
      : { minimum: Infinity, maximum: -Infinity },
    selected: result.resolved && Number.isFinite(result.resolved.selection.value_A)
      ? {
          value_A: result.resolved.selection.value_A,
          label: result.resolved.selection.label,
          snapped: result.resolved.selection.snapped,
          defaulted: result.resolved.selection.defaulted,
        }
      : null,
    controlling: result.resolved
      ? {
          lower: result.resolved.controlling.lower
            ? { label: result.resolved.controlling.lower.label, boundary_A: result.resolved.controlling.lower.boundary_A }
            : null,
          upper: result.resolved.controlling.upper
            ? { label: result.resolved.controlling.upper.label, boundary_A: result.resolved.controlling.upper.boundary_A }
            : null,
        }
      : { lower: null, upper: null },
    diagnostics: allDiagnostics,
    exitCode,
  };
}

function reportText(r: CheckResult): string {
  const lines: string[] = [];
  if (r.title) lines.push(r.title);
  if (r.status) lines.push(`status: ${r.status.toUpperCase()}`);
  if (r.axis) lines.push(`axis: ${r.axis.scale} ${r.axis.minimum}–${r.axis.maximum} ${r.axis.unit}`);
  if (r.selected) {
    const v = r.selected.value_A;
    const unit = r.axis?.unit ?? 'A';
    const val = unit === 'kA' ? (v / 1000).toFixed(3) : v.toFixed(0);
    lines.push(`selected: ${val} ${unit} (${r.selected.label})${r.selected.snapped ? ' [snapped]' : ''}${r.selected.defaulted ? ' [defaulted]' : ''}`);
  }
  if (r.controlling.lower || r.controlling.upper) {
    const lower = r.controlling.lower ? `lower=${r.controlling.lower.label}@${(r.controlling.lower.boundary_A / 1000).toFixed(3)} kA` : '';
    const upper = r.controlling.upper ? `upper=${r.controlling.upper.label}@${(r.controlling.upper.boundary_A / 1000).toFixed(3)} kA` : '';
    lines.push(`controlling: ${lower} ${upper}`);
  }
  if (r.diagnostics.length > 0) {
    lines.push('');
    lines.push('diagnostics:');
    for (const d of r.diagnostics) {
      lines.push(`  L${d.line}:${d.column} [${d.severity}/${d.code}] ${d.message}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  if (!isMain) return;
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(help());
    process.exit(0);
  }
  const { command, options } = args;
  if (!command) { console.log(help()); process.exit(2); }
  if (command !== 'render' && command !== 'report' && command !== 'check') die(`unknown command: ${command}`);
  if (!options.input) die(`missing <file>`);

  let source: string;
  try { source = readFileSync(options.input, 'utf-8'); }
  catch (e) { die(`cannot read ${options.input}: ${(e as Error).message}`); }

  const r = check(source, command);

  if (command === 'check') {
    if (options.json) {
      console.log(JSON.stringify(r, null, 2));
    } else if (r.diagnostics.length > 0 && !options.quiet) {
      console.log(reportText(r));
    } else if (!options.quiet) {
      console.log(`${r.title ?? 'PSDL'}: ${r.status?.toUpperCase() ?? 'NO RESOLVED MODEL'}`);
    }
    process.exit(r.exitCode);
  }

  if (command === 'report') {
    if (options.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(reportText(r));
    }
    if (r.diagnostics.some((d) => d.severity === 'error') && !options.quiet) {
      // continue — report is informational
    }
    process.exit(r.exitCode);
  }

  if (command === 'render') {
    if (!r.title) die(`cannot render: no resolved model`);
    if (r.diagnostics.some((d) => d.severity === 'error') && !options.quiet) {
      for (const d of r.diagnostics) {
        if (d.severity === 'error') console.error(`L${d.line}:${d.column} [${d.severity}/${d.code}] ${d.message}`);
      }
    }
    const result = processPsdl(source);
    if (!result.resolved) die('no resolved model', 1);
    const svg = renderSvg(result.resolved, { width: options.width });
    const outBase = options.output ?? join('.', basename(options.input, extname(options.input)));
    if (options.format === 'svg') {
      const out = options.output ? options.output : `${outBase}.svg`;
      writeFileSync(out, svg, 'utf-8');
      if (!options.quiet) console.error(`wrote ${out}`);
    } else if (options.format === 'png') {
      const { Resvg } = await import('@resvg/resvg-js');
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: options.width ?? 1100 } }).render().asPng();
      const out = options.output ? options.output : `${outBase}.png`;
      writeFileSync(out, png);
      if (!options.quiet) console.error(`wrote ${out}`);
    } else if (options.format === 'pdf') {
      const { jsPDF } = await import('jspdf');
      const { svg2pdf } = await import('svg2pdf.js');
      const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
      const root = { width: doc.internal.pageSize.getWidth(), height: doc.internal.pageSize.getHeight() } as unknown as Element;
      const parser = new DOMParser();
      const dom = parser.parseFromString(svg, 'image/svg+xml');
      const svgEl = dom.documentElement as unknown as Element;
      await svg2pdf(svgEl, doc, { x: 0, y: 0, width: doc.internal.pageSize.getWidth(), height: doc.internal.pageSize.getHeight() });
      const out = options.output ? options.output : `${outBase}.pdf`;
      const data = doc.output('arraybuffer');
      writeFileSync(out, Buffer.from(data));
      if (!options.quiet) console.error(`wrote ${out}`);
      void root;
    }
    process.exit(r.exitCode);
  }
}

main().catch((e) => die((e as Error).message, 2));
