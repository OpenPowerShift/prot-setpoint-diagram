import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import GUIDE_HTML from '../../docs/guide.adoc?adoc-html';
import TUTORIAL_HTML from '../../docs/tutorial.adoc?adoc-html';
import SPEC_HTML from '../../spec/spec.adoc?adoc-html';

type Tab = 'tutorial' | 'guide' | 'reference';

@customElement('psdl-guide')
export class PsdlGuide extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  @property({ type: Boolean, reflect: true }) open = false;
  @state() private tab: Tab = 'tutorial';

  private setTab(t: Tab): void {
    this.tab = t;
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private getContent(): string {
    if (this.tab === 'tutorial') return TUTORIAL_HTML;
    if (this.tab === 'guide') return GUIDE_HTML;
    return SPEC_HTML;
  }

  override render() {
    if (!this.open) return html`<div style="display:none"></div>`;
    return html`
      <div class="psdl-guide-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this.close(); }}>
        <div class="psdl-guide-panel">
          <div class="psdl-guide-tabs">
            <button class="psdl-tab ${this.tab === 'tutorial' ? 'is-active' : ''}" @click=${() => this.setTab('tutorial')}>Tutorial</button>
            <button class="psdl-tab ${this.tab === 'guide' ? 'is-active' : ''}" @click=${() => this.setTab('guide')}>Guide</button>
            <button class="psdl-tab ${this.tab === 'reference' ? 'is-active' : ''}" @click=${() => this.setTab('reference')}>Reference</button>
            <span class="psdl-spacer"></span>
            <button class="psdl-btn" @click=${() => this.close()}>Close</button>
          </div>
          <div class="psdl-guide-content psdl-prose">${unsafeHTML(this.getContent())}</div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'psdl-guide': PsdlGuide;
  }
}
