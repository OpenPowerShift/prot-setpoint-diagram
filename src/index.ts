/**
 * Top-level public API for `@openpowershift/prot-setpoint-language`.
 *
 * Three entry points:
 *
 *   process(source)              — complete pipeline: parse → resolve → validate.
 *                                 Returns the resolved model + diagnostics.
 *
 *   parseAndRender(source)       — process() + render SVG. The browser and CLI use this.
 *
 *   renderSvg(model)             — render an already-resolved model.
 */

import type { Document } from './parser/ast.js';
import { parse } from './parser/index.js';
import { resolveDiagram, type ResolveResult, type Resolved } from './semantics/model.js';
import { renderSvg as renderer } from './renderer/svg.js';

export interface ProcessResult {
  document?: Document;
  resolved?: Resolved;
  parseErrors: ReturnType<typeof parse>['errors'];
  diagnostics: ResolveResult['diagnostics'];
}

export function process(source: string): ProcessResult {
  const { document, errors } = parse(source);
  if (!document) return { parseErrors: errors, diagnostics: [], document: undefined };
  const resolveResult = resolveDiagram(document.diagram);
  return {
    document,
    resolved: resolveResult.resolved,
    parseErrors: errors,
    diagnostics: resolveResult.diagnostics,
  };
}

export function parseAndRender(source: string, opts?: Parameters<typeof renderer>[1]): { svg: string; result: ProcessResult } {
  const result = process(source);
  const svg = result.resolved ? renderer(result.resolved, opts) : makeErrorSvg(result.parseErrors, result.diagnostics);
  return { svg, result };
}

export function renderSvg(model: Resolved, opts?: Parameters<typeof renderer>[1]): string {
  return renderer(model, opts);
}

export function makeErrorSvg(parseErrors: { line: number; column: number; message: string }[], diagnostics: { line: number; column: number; message: string }[]): string {
  const lines: string[] = [];
  for (const e of parseErrors) lines.push(`L${e.line}:${e.column}  ${e.message}`);
  for (const d of diagnostics) lines.push(`L${d.line}:${d.column}  ${d.message}`);
  const ts = lines.length === 0 ? 'No content could be parsed.' : lines.join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 360"><rect width="100%" height="100%" fill="#fff7ed"/><text x="20" y="40" font-family="ui-monospace, monospace" font-size="18" fill="#7c2d12">PSDL</text><text x="20" y="80" font-family="ui-monospace, monospace" font-size="13" fill="#1f2937"><tspan x="20" dy="0">${escapeMultiline(ts)}</tspan></text></svg>`;
}

function escapeMultiline(s: string): string {
  return s
    .split('\n')
    .map((l, i) => `<tspan x="20" dy="${i === 0 ? 0 : 16}">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</tspan>`)
    .join('');
}
