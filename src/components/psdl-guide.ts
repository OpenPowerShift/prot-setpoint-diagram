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
  @state() private query = '';
  @state() private matchCount = 0;
  @state() private matchIndex = 0;

  private searchInput: HTMLInputElement | null = null;

  private setTab(t: Tab): void {
    this.tab = t;
    this.matchIndex = 0;
    /* Highlighting runs against THIS tab's freshly-rendered content —
     * re-run after Lit swaps the content in, not against the outgoing
     * tab's DOM (which is what firing it synchronously here would do). */
    requestAnimationFrame(() => this.applyHighlight(true));
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent('close'));
  }

  private getContent(): string {
    if (this.tab === 'tutorial') return TUTORIAL_HTML;
    if (this.tab === 'guide') return GUIDE_HTML;
    return SPEC_HTML;
  }

  private onSearchInput(e: Event): void {
    this.query = (e.target as HTMLInputElement).value;
    this.matchIndex = 0;
    this.applyHighlight(true);
  }

  private onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.jump(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (this.query) {
        this.query = '';
        this.applyHighlight(true);
      } else {
        this.close();
      }
    }
  }

  private jump(dir: 1 | -1): void {
    if (this.matchCount === 0) return;
    this.matchIndex = (this.matchIndex + dir + this.matchCount) % this.matchCount;
    this.applyHighlight(false);
  }

  /**
   * Highlights every occurrence of `this.query` inside the rendered
   * prose by wrapping matching text-node ranges in `<mark>` — done
   * imperatively over the live DOM (a TreeWalker over text nodes),
   * rather than regex-replacing the HTML string before it's rendered,
   * since a naive string replace can't tell "this text happens to
   * contain the query" apart from "this is inside a tag/attribute" and
   * would corrupt the markup. `rebuild` re-scans from scratch (needed
   * after the query or tab changes); otherwise this only re-applies the
   * "current match" styling and scrolls to it.
   */
  private applyHighlight(rebuild: boolean): void {
    const container = this.querySelector('.psdl-guide-content');
    if (!container) return;
    if (rebuild) {
      unwrapMarks(container);
      this.matchCount = this.query.trim() ? wrapMatches(container, this.query.trim()) : 0;
    }
    const marks = container.querySelectorAll<HTMLElement>('mark.psdl-search-hit');
    marks.forEach((m, i) => m.classList.toggle('is-current', i === this.matchIndex));
    const current = marks[this.matchIndex];
    if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      requestAnimationFrame(() => this.searchInput?.focus());
    }
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
            <div class="psdl-guide-search">
              <input
                type="search"
                placeholder="Search…"
                .value=${this.query}
                @input=${(e: Event) => this.onSearchInput(e)}
                @keydown=${(e: KeyboardEvent) => this.onSearchKeydown(e)}
              />
              ${this.query
                ? html`<span class="psdl-search-count">${this.matchCount > 0 ? `${this.matchIndex + 1}/${this.matchCount}` : '0/0'}</span>
                  <button class="psdl-btn psdl-btn-sm" title="Previous match" @click=${() => this.jump(-1)}>‹</button>
                  <button class="psdl-btn psdl-btn-sm" title="Next match" @click=${() => this.jump(1)}>›</button>`
                : null}
            </div>
            <button class="psdl-btn" @click=${() => this.close()}>Close</button>
          </div>
          <div class="psdl-guide-content psdl-prose">${unsafeHTML(this.getContent())}</div>
        </div>
      </div>
    `;
  }

  override firstUpdated(): void {
    this.searchInput = this.querySelector('.psdl-guide-search input');
  }
}

/** Removes every `<mark class="psdl-search-hit">` inserted by a previous
 * highlight pass, restoring its text to a plain text node — undoes
 * wrapMatches so the next search starts from clean prose rather than
 * stacking marks inside marks. */
function unwrapMarks(root: Element): void {
  const marks = root.querySelectorAll('mark.psdl-search-hit');
  for (const m of marks) {
    const text = m.textContent ?? '';
    m.replaceWith(document.createTextNode(text));
  }
  root.normalize();
}

/** Wraps every case-insensitive occurrence of `query` within `root`'s
 * text nodes in `<mark class="psdl-search-hit">`. Walks a TreeWalker
 * over text nodes only (never touches tags/attributes, so it can't
 * corrupt markup the way a regex replace on the HTML string could) and
 * skips script/style — not relevant here, but cheap to exclude. Returns
 * the number of matches found. */
function wrapMatches(root: Element, query: string): number {
  if (!query) return 0;
  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (text.data.toLowerCase().includes(lowerQuery)) targets.push(text);
  }
  let count = 0;
  for (const textNode of targets) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const lower = textNode.data.toLowerCase();
    const frag = document.createDocumentFragment();
    let cursor = 0;
    let idx: number;
    while ((idx = lower.indexOf(lowerQuery, cursor)) !== -1) {
      if (idx > cursor) frag.appendChild(document.createTextNode(textNode.data.slice(cursor, idx)));
      const mark = document.createElement('mark');
      mark.className = 'psdl-search-hit';
      mark.textContent = textNode.data.slice(idx, idx + query.length);
      frag.appendChild(mark);
      count++;
      cursor = idx + query.length;
    }
    if (cursor < textNode.data.length) frag.appendChild(document.createTextNode(textNode.data.slice(cursor)));
    parent.replaceChild(frag, textNode);
  }
  return count;
}

declare global {
  interface HTMLElementTagNameMap {
    'psdl-guide': PsdlGuide;
  }
}
