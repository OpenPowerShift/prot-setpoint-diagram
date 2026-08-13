import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, hoverTooltip } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, lintGutter, forceLinting, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { psdlLanguage } from '../highlight/psdl-language.js';
import { psdlEditorAppearance } from '../highlight/psdl-highlight-style.js';

export interface EditorMark {
  line: number;
  column: number;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  length: number;
}

@customElement('psdl-editor')
export class PsdlEditor extends LitElement {
  /* render to light DOM so styles from global.css apply */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  @property({ type: String }) value = '';
  @property({ type: Array }) marks: EditorMark[] = [];

  private view: EditorView | null = null;
  private hostEl: HTMLElement | null = null;
  private updatingFromProp = false;

  override render() {
    return html`<div class="psdl-editor-host"></div>`;
  }

  override firstUpdated(): void {
    this.hostEl = this.querySelector('.psdl-editor-host');
    if (!this.hostEl) return;
    this.view = new EditorView({
      state: this.makeState(),
      parent: this.hostEl,
    });
  }

  private makeState(): EditorState {
    /* The linter's source function is a closure captured once, here, at
     * editor creation. Previously it closed over a snapshot of
     * `this.marks` taken at that moment — every later `marks` update
     * (a new example, or re-parsing as the user types) was silently
     * ignored by the linter, which kept re-checking the FIRST example's
     * diagnostics forever. Reading `this.marks` live fixes the value;
     * making it actually re-run when marks change (not just when the
     * document changes) is handled below in `updated()`. */
    return EditorState.create({
      doc: this.value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        psdlLanguage,
        psdlEditorAppearance,
        autocompletion({
          override: [this.completions.bind(this)],
          activateOnTyping: true,
          maxRenderedOptions: 50,
        }),
        keywordHoverTooltip,
        linter(() => this.toCmDiagnostics(this.marks)),
        lintGutter(),
        EditorView.updateListener.of((v) => {
          if (v.docChanged) {
            const txt = v.state.doc.toString();
            this.updatingFromProp = true;
            this.value = txt;
            this.dispatchEvent(new CustomEvent('change', { detail: txt }));
            this.updatingFromProp = false;
          }
        }),
      ],
    });
  }

  override updated(changed: Map<string, unknown>): void {
    if (!this.view) return;
    if (changed.has('value') && !this.updatingFromProp) {
      const cur = this.view.state.doc.toString();
      if (cur !== this.value) {
        this.view.dispatch({
          changes: { from: 0, to: cur.length, insert: this.value },
        });
      }
    }
    /* Diagnostics were stale until the NEXT keystroke triggered a lint
     * re-run — e.g. switching to a shorter example left the previous,
     * longer example's diagnostics applied to the new (shorter)
     * document, which CodeMirror's linter has no defence against: a
     * diagnostic position past the new document's end throws rather
     * than clamping, taking the whole editor down. forceLinting makes
     * the linter re-run immediately, against whatever `this.marks` and
     * the document both are right now — always in agreement. */
    if (changed.has('marks')) {
      forceLinting(this.view);
    }
  }

  private toCmDiagnostics(marks: EditorMark[]): CmDiagnostic[] {
    const out: CmDiagnostic[] = [];
    for (const m of marks) {
      out.push({
        from: this.lineColToOffset(m.line, m.column),
        to: this.lineColToOffset(m.line, m.column + Math.max(1, m.length)),
        severity: m.severity,
        message: `[${m.code}] ${m.message}`,
      });
    }
    return out;
  }

  private lineColToOffset(line: number, col: number): number {
    if (!this.view) return 0;
    const doc = this.view.state.doc;
    const lineObj = doc.line(Math.max(1, Math.min(doc.lines, line)));
    /* Clamped to the line's own end, not just doc-of-any-length: a
     * diagnostic's column can legitimately run past its line (e.g.
     * `length` computed from a label that isn't literally on this
     * line), and CodeMirror's lint machinery throws on an out-of-range
     * position rather than clamping it — one bad diagnostic used to be
     * able to crash the whole editor. */
    return Math.min(lineObj.to, lineObj.from + Math.max(0, col - 1));
  }

  /* ================================================ completions */

  private completions(context: import('@codemirror/autocomplete').CompletionContext) {
    const word = context.matchBefore(/\w*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;
    const candidates = STATEMENT_COMPLETIONS.slice();
    return {
      from: word.from,
      options: candidates.map((c) => ({ label: c.label, type: c.type, detail: c.detail })),
    };
  }
}

/** Short, hover-only descriptions for PSDL keywords — same words as
 * STATEMENT_COMPLETIONS below, phrased as a one-line explanation rather
 * than a completion snippet. Keyed by the exact word CodeMirror finds
 * under the cursor (so multi-word statements like `orientation` are
 * keyed by their first token, not the whole line). */
const KEYWORD_HELP: Record<string, string> = {
  diagram: 'Root statement. One PSDL file contains exactly one `diagram "Title" { ... }`.',
  orientation: 'Axis direction: `horizontal` (default) or `vertical`.',
  voltage: 'Diagram nominal voltage, e.g. `voltage 11 kV` — used to convert MVA criteria to amps.',
  ct: 'Current-transformer ratio, e.g. `ct 400/1 A` — used for `show secondary`.',
  show: 'Which equivalent quantities to display alongside the selected value: `entered`, `current`, `mva`, `secondary`.',
  view: 'Layout density: `report` (full detail), `compact` (near-label, no shading), or `rail` (value rail only).',
  scale: 'Axis scale: `auto`, `linear`, `log`, or `indicative` (ordered, non-calibrated spacing).',
  range: 'Axis bounds: `auto`, `all`, `focus` (around controlling boundaries), or an explicit `LOW to HIGH kA`.',
  word: 'Overrides a status word\'s displayed text, e.g. `word caution "Review"`.',
  style: 'Visual options: `theme`, `palette`, `zones`, `connections`, `title`, `title-align`, `title-position`, `arrows`.',
  size: 'Explicit canvas dimension in pixels: `size width N` and/or `size height N`.',
  secondary: 'Second calibrated axis on the opposite side of the plot: `secondary axis top|bottom kA|MVA`.',
  below: 'A criterion the selected value must stay ABOVE, e.g. `below "Maximum load" must 3.5 kA`.',
  above: 'A criterion the selected value must stay BELOW, e.g. `above "Minimum fault" must 8 kA`.',
  must: 'Mandatory requirement level — violating it is a hard error (`do-not-set` / `no-compliant-setting`).',
  should: 'Advisory requirement level — contributes to the preferred (green) zone, not a hard limit.',
  reference: 'Plots a value for context only — never enters the mandatory/preferred calculation.',
  margin: 'Safety margin on a criterion, as a percentage (`margin 10%`) or absolute quantity (`margin 0.4 kA`).',
  selected: 'The setting being evaluated: an explicit quantity, `midpoint`, `low`, `high`, or `none`. Label is optional and names the value.',
  midpoint: 'Selection form: the midpoint of the preferred interval, optionally snapped with `step N kA`.',
  low: 'Selection form: the lowest compliant setting (mandatoryInterval.minimum), optionally snapped with `step`.',
  high: 'Selection form: the highest compliant setting (mandatoryInterval.maximum), optionally snapped with `step`.',
  step: 'Rounds a derived selection onto a grid, e.g. `midpoint step 0.05 kA`.',
  none: 'Requests analysis without a specific selected value.',
};

/** Hovering a PSDL keyword shows its one-line description — spec §Help:
 * "keyword help MUST be available without leaving the editor." Matches
 * the word under the pointer against KEYWORD_HELP; anything else (a
 * string, number, or criterion label) gets no tooltip. */
const keywordHoverTooltip = hoverTooltip((view, pos) => {
  const { from, to, text } = view.state.doc.lineAt(pos);
  let start = pos, end = pos;
  while (start > from && /\w/.test(text[start - from - 1])) start--;
  while (end < to && /\w/.test(text[end - from])) end++;
  if (start === end) return null;
  const word = text.slice(start - from, end - from);
  const help = KEYWORD_HELP[word];
  if (!help) return null;
  return {
    pos: start,
    end,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'psdl-hover-help';
      dom.textContent = help;
      return { dom };
    },
  };
});

const STATEMENT_COMPLETIONS: { label: string; type: string; detail: string }[] = [
  { label: 'diagram', type: 'keyword', detail: 'diagram "Title" { ... }' },
  { label: 'orientation horizontal', type: 'property', detail: 'horizontal axis (default)' },
  { label: 'orientation vertical', type: 'property', detail: 'vertical axis' },
  { label: 'voltage', type: 'property', detail: 'voltage NNN kV' },
  { label: 'ct', type: 'property', detail: 'ct P/S A (CT ratio)' },
  { label: 'show', type: 'property', detail: 'show entered | current | mva | secondary' },
  { label: 'view report', type: 'property', detail: 'separate criterion rows' },
  { label: 'view compact', type: 'property', detail: 'near-label, no shading' },
  { label: 'view rail', type: 'property', detail: 'value rail' },
  { label: 'scale auto', type: 'property', detail: 'auto-range linear or log' },
  { label: 'scale linear', type: 'property', detail: 'calibrated linear' },
  { label: 'scale log', type: 'property', detail: 'log10 scale' },
  { label: 'range auto', type: 'property', detail: 'include all values' },
  { label: 'range focus', type: 'property', detail: 'focus on controlling bounds' },
  { label: 'range', type: 'property', detail: 'range LL to UU kA' },
  { label: 'word', type: 'property', detail: 'word NAME "value"' },
  { label: 'style', type: 'property', detail: 'style theme print' },
  { label: 'below', type: 'property', detail: 'below "name" must N kA [margin N%]' },
  { label: 'above', type: 'property', detail: 'above "name" must N kA [margin N%]' },
  { label: 'selected', type: 'property', detail: 'selected "name" N kA | midpoint | none' },
  { label: '# ', type: 'function', detail: 'comment' },
];

declare global {
  interface HTMLElementTagNameMap {
    'psdl-editor': PsdlEditor;
  }
}
