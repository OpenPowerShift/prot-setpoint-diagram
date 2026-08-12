import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
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
    return this as unknown as HTMLElement;
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
    this.hostEl = this.querySelector('.psdl-editor-host') as HTMLElement | null;
    if (!this.hostEl) return;
    this.view = new EditorView({
      state: this.makeState(),
      parent: this.hostEl,
    });
  }

  private makeState(): EditorState {
    const marksRef = this.marks;
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
        linter(() => this.toCmDiagnostics(marksRef)),
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
    return lineObj.from + Math.max(0, col - 1);
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
