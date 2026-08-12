import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

@customElement('psdl-viewer')
export class PsdlViewer extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  @property({ type: String }) svg = '';
  @property({ type: String }) status = 'recommended';
  @property({ type: String }) scale = '';
  @property({ type: String }) diagramTitle = '';
  @property({ type: Array }) percents: { text: string; level: string }[] = [];
  @property({ type: Array }) display: { label: string; text: string }[] = [];

  override render() {
    /* Title and scale are already shown once, by the app shell's pane
     * header above this component — a second copy here (in a different
     * order: "scale · title" vs. the shell's "title / scale") was pure
     * duplication, not a second piece of information. */
    return html`
      <div class="psdl-pane-host">${unsafeHTML(this.svg)}</div>
      ${this.summary()}
    `;
  }

  private summary() {
    const labels: Record<string, string> = {
      'recommended': 'RECOMMENDED',
      'caution': 'CAUTION',
      'do-not-set': 'DO NOT SET',
      'no-recommended-setting': 'NO RECOMMENDED SETTING',
      'no-compliant-setting': 'NO COMPLIANT SETTING',
      'no-selection': 'NO SETTING SELECTED',
    };
    const state = labels[this.status] ?? this.status;
    const cls = `is-${this.status}`;
    const displayLines = this.display && this.display.length > 0
      ? html`
        <div class="psdl-summary">
          ${this.display.map((p) => html`<span><strong>${p.label}:</strong> ${p.text}</span>`)}
        </div>`
      : null;
    return html`
      <div class="psdl-summary">
        <span class="psdl-state ${cls}">${state}</span>
        ${this.percents.map((p) => html`<span>${p.text}</span>`)}
      </div>
      ${displayLines}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'psdl-viewer': PsdlViewer;
  }
}
