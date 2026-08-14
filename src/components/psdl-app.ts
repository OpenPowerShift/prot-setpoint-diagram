import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { process } from '../index.js';
import { renderSvg } from '../renderer/svg.js';
import './psdl-editor.js';
import './psdl-viewer.js';
import './psdl-guide.js';
import type { Status } from '../semantics/model.js';

import FEEDER_SRC from '../../examples/feeder-setting.psdl?raw';
import CONFLICT_SRC from '../../examples/preferred-conflict.psdl?raw';
import WIDE_SRC from '../../examples/wide-range.psdl?raw';
import MANDATORY_CONFLICT_SRC from '../../examples/01-mandatory-conflict.psdl?raw';
import VERTICAL_SRC from '../../examples/02-vertical.psdl?raw';
import CAUTION_SRC from '../../examples/03-caution.psdl?raw';
import COMPACT_SRC from '../../examples/04-compact.psdl?raw';
import WORDS_SRC from '../../examples/05-words.psdl?raw';
import ABSOLUTE_SRC from '../../examples/06-absolute-margin.psdl?raw';
import LOW_SRC from '../../examples/07-low-selection.psdl?raw';
import HIGH_SRC from '../../examples/08-high-selection.psdl?raw';
import MVA_SRC from '../../examples/09-mva-setpoint.psdl?raw';
import SHOULD_SRC from '../../examples/10-should-advisory.psdl?raw';
import INDICATIVE_SRC from '../../examples/11-indicative-scale.psdl?raw';
import RAIL_SRC from '../../examples/12-rail-view.psdl?raw';
import PERQTY_VOLTAGE_SRC from '../../examples/13-per-quantity-voltage.psdl?raw';
import EXPLICIT_RANGE_SRC from '../../examples/14-explicit-range.psdl?raw';
import COINCIDENT_SRC from '../../examples/15-coincident-markers.psdl?raw';
import STYLE_SRC from '../../examples/16-style-customization.psdl?raw';
import TITLE_OFF_SRC from '../../examples/17-title-off.psdl?raw';
import REFERENCE_SRC from '../../examples/18-reference-point.psdl?raw';
import NOMINAL_MVA_SRC from '../../examples/19-nominal-mva.psdl?raw';
import SECONDARY_AXIS_SRC from '../../examples/20-secondary-axis.psdl?raw';

const STARTER_PSDL = FEEDER_SRC;
const SAVE_KEY = 'psdl.savedSource';
/** Not one of EXAMPLES' own ids (those are all bare slugs) — used to
 * pick the saved entry back out of the combined list unambiguously. */
const SAVED_ID = '__saved__';

const EXAMPLES: { id: string; label: string; src: string }[] = [
  { id: 'feeder-setting', label: 'Feeder setting (spec)', src: FEEDER_SRC },
  { id: 'preferred-conflict', label: 'Preferred conflict (spec)', src: CONFLICT_SRC },
  { id: 'wide-range', label: 'Wide range / log (spec)', src: WIDE_SRC },
  { id: '01-mandatory-conflict', label: 'Mandatory conflict', src: MANDATORY_CONFLICT_SRC },
  { id: '02-vertical', label: 'Vertical orientation', src: VERTICAL_SRC },
  { id: '03-caution', label: 'Caution (explicit above preferred)', src: CAUTION_SRC },
  { id: '04-compact', label: 'Compact view', src: COMPACT_SRC },
  { id: '05-words', label: 'Custom status words', src: WORDS_SRC },
  { id: '06-absolute-margin', label: 'Absolute margin', src: ABSOLUTE_SRC },
  { id: '07-low', label: 'Low selection (lowest compliant)', src: LOW_SRC },
  { id: '08-high', label: 'High selection (highest compliant)', src: HIGH_SRC },
  { id: '09-mva', label: 'Setpoint in 3-ph MVA', src: MVA_SRC },
  { id: '10-should', label: 'Advisory (should) vs mandatory (must)', src: SHOULD_SRC },
  { id: '11-indicative', label: 'Indicative scale', src: INDICATIVE_SRC },
  { id: '12-rail', label: 'Rail view', src: RAIL_SRC },
  { id: '13-per-quantity-voltage', label: 'Per-quantity voltage (@ kV)', src: PERQTY_VOLTAGE_SRC },
  { id: '14-explicit-range', label: 'Explicit range', src: EXPLICIT_RANGE_SRC },
  { id: '15-coincident', label: 'Coincident markers (×N)', src: COINCIDENT_SRC },
  { id: '16-style', label: 'Style customization', src: STYLE_SRC },
  { id: '17-title-off', label: 'Title off', src: TITLE_OFF_SRC },
  { id: '18-reference-point', label: 'Reference point (non-condition)', src: REFERENCE_SRC },
  { id: '19-nominal-mva', label: 'Nominal-voltage MVA cross-reference', src: NOMINAL_MVA_SRC },
  { id: '20-secondary-axis', label: 'Secondary axis (MVA)', src: SECONDARY_AXIS_SRC },
];

interface Mark {
  line: number;
  column: number;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  length: number;
}

/** Turns a diagram title into a safe download filename stem: runs of
 * anything that isn't a letter or digit collapse to a SINGLE underscore
 * (not one per character), so "Feeder OCR — 51P!!" becomes
 * "Feeder_OCR_51P" rather than "Feeder_OCR____51P__". */
function slugifyTitle(title: string): string {
  const cleaned = title.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'diagram';
}

/** Best-effort label for the saved-work dropdown entry: the diagram's
 * own title, when the saved source still parses, so it reads like any
 * other named example instead of a generic placeholder. */
function deriveSavedLabel(src: string): string {
  try {
    const result = process(src);
    return result.resolved?.title ? `★ ${result.resolved.title} (saved)` : '★ Saved diagram';
  } catch {
    return '★ Saved diagram';
  }
}

type PendingSwitch = { type: 'example'; id: string } | { type: 'reset' };

@customElement('psdl-app')
export class PsdlApp extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  @state() private source = STARTER_PSDL;
  @state() private activeExampleId = 'feeder-setting';
  @state() private svg = '';
  @state() private status: Status = 'recommended';
  @state() private diagramTitle = '';
  @state() private scale = '';
  @state() private percents: { text: string; level: string }[] = [];
  @state() private display: { label: string; text: string }[] = [];
  @state() private marks: Mark[] = [];
  @state() private guideOpen = false;
  @state() private savedFlash = false;
  @state() private copiedFlash = false;
  private savedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private copiedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  /* The saved-work dropdown entry, when a save exists — kept as its own
   * state field rather than mutating the module-level EXAMPLES array,
   * since it's per-browser working state, not a bundled example. */
  @state() private savedEntry: { id: string; label: string; src: string } | null = null;
  /* What `this.source` was the last time it was freshly LOADED (an
   * example picked, the saved entry restored/loaded, or a successful
   * Save) — differing from this is what "unsaved changes" means, not
   * differing from any particular example. */
  @state() private loadedBaseline = STARTER_PSDL;
  /* Set when the user tries to switch away from a dirty diagram — shows
   * the save/discard/cancel prompt; cleared once they resolve it. */
  @state() private pendingSwitch: PendingSwitch | null = null;
  /* Tracks the theme as Lit state, not read from the DOM at render time:
   * document.documentElement.dataset.theme is invisible to Lit's
   * reactivity, so the toggle button's own label went stale after every
   * click — it kept reading "Light" after switching to light theme. */
  @state() private lightTheme = document.documentElement.dataset.theme === 'light';

  override connectedCallback(): void {
    super.connectedCallback();
    try {
      const saved = localStorage.getItem('psdl.splitLeft');
      if (saved) document.documentElement.style.setProperty('--psdl-split-left', saved);
    } catch {
      /* localStorage can throw (privacy mode, disabled storage) — the
       * split position is a nice-to-have, not worth failing over. */
    }
    try {
      const savedSource = localStorage.getItem(SAVE_KEY);
      if (savedSource) {
        this.savedEntry = { id: SAVED_ID, label: deriveSavedLabel(savedSource), src: savedSource };
        this.source = savedSource;
        this.loadedBaseline = savedSource;
        /* Not one of EXAMPLES' ids — the picker shows the saved entry
         * selected instead, correct since this is the user's own saved
         * work, not a bundled example. */
        this.activeExampleId = SAVED_ID;
      }
    } catch {
      /* same as above — restoring saved work is best-effort only. */
    }
    this.parseAndRender();
    document.addEventListener('keydown', this.onGlobalKeydown);
  }

  override disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onGlobalKeydown);
    super.disconnectedCallback();
  }

  /** `?` opens the guide from anywhere in the app — except while the
   * user is actually typing (in the source editor, the guide's own
   * search box, or any other text input), where `?` is an ordinary
   * character. Bound once as an instance property (not a method
   * reference re-created each render) so add/removeEventListener see
   * the same function identity. */
  private onGlobalKeydown = (e: KeyboardEvent): void => {
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable || !!target?.closest?.('.cm-editor');
    if (isEditable) return;
    e.preventDefault();
    this.guideOpen = true;
  };

  private onSourceChange(e: CustomEvent<string>): void {
    this.source = e.detail;
    this.parseAndRender();
  }

  private isDirty(): boolean {
    return this.source !== this.loadedBaseline;
  }

  /** Entry point for both the Examples picker and Reset — goes straight
   * through when there's nothing to lose, otherwise holds the request
   * and shows the save/discard/cancel prompt. */
  private requestSwitch(action: PendingSwitch): void {
    if (this.isDirty()) {
      this.pendingSwitch = action;
    } else {
      this.performSwitch(action);
    }
  }

  private performSwitch(action: PendingSwitch): void {
    if (action.type === 'example') {
      const ex = action.id === SAVED_ID ? this.savedEntry : EXAMPLES.find((e) => e.id === action.id);
      if (!ex) return;
      this.source = ex.src;
      this.activeExampleId = ex.id;
      this.loadedBaseline = ex.src;
    } else {
      this.source = STARTER_PSDL;
      this.activeExampleId = 'feeder-setting';
      this.loadedBaseline = STARTER_PSDL;
    }
    this.parseAndRender();
  }

  private resolvePendingSave(): void {
    if (!this.pendingSwitch) return;
    this.saveSource();
    const action = this.pendingSwitch;
    this.pendingSwitch = null;
    this.performSwitch(action);
  }

  private resolvePendingDiscard(): void {
    if (!this.pendingSwitch) return;
    const action = this.pendingSwitch;
    this.pendingSwitch = null;
    this.performSwitch(action);
  }

  private resolvePendingCancel(): void {
    this.pendingSwitch = null;
  }

  private parseAndRender(): void {
    const result = process(this.source);
    const marks: Mark[] = [];
    for (const e of result.parseErrors) {
      marks.push({ line: e.line, column: e.column, code: e.code, severity: e.severity === 'warning' ? 'warning' : 'error', message: e.message, length: e.length });
    }
    for (const d of result.diagnostics) {
      marks.push({ line: d.line, column: d.column, code: d.code, severity: d.severity, message: d.message, length: d.length });
    }
    this.marks = marks;

    if (result.resolved) {
      this.svg = renderSvg(result.resolved);
      this.status = result.resolved.status;
      this.diagramTitle = result.resolved.title;
      this.scale = `${result.resolved.axis.scale}${result.resolved.axis.scale === 'log' ? '·10ⁿ' : ''} · ${result.resolved.axis.minimum}–${result.resolved.axis.maximum} kA`;
      this.percents = (result.resolved.selectedPercents ?? []).map((p) => ({ text: p.text, level: p.level }));
      const items: { label: string; text: string }[] = [];
      if (result.resolved.display) {
        if (result.resolved.display.entered) items.push(result.resolved.display.entered);
        if (result.resolved.display.primary) items.push(result.resolved.display.primary);
        if (result.resolved.display.mva) items.push(result.resolved.display.mva);
        if (result.resolved.display.secondary) items.push(result.resolved.display.secondary);
      }
      this.display = items;
    } else {
      this.svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><rect width="100%" height="100%" fill="#fff7ed"/><text x="20" y="40" font-family="monospace" font-size="14" fill="#7c2d12">No PSDL diagram parsed. See diagnostics below.</text></svg>';
      this.status = 'do-not-set';
      this.diagramTitle = '';
      this.scale = '';
      this.percents = [];
      this.display = [];
    }
  }

  private toggleTheme(): void {
    const root = document.documentElement;
    const next = this.lightTheme ? 'dark' : 'light';
    if (next === 'dark') root.removeAttribute('data-theme');
    else root.dataset.theme = next;
    this.lightTheme = next === 'light';
  }

  /** Persists the current source to the browser so it survives a reload
   * — restored in connectedCallback. Distinct from "Download": this
   * keeps working state in THIS browser, not a portable file. Also
   * updates (or creates) the saved-work entry in the Examples picker
   * and marks the current source as no longer dirty, so switching
   * diagrams right after a Save doesn't immediately re-prompt. */
  private saveSource(): void {
    try {
      localStorage.setItem(SAVE_KEY, this.source);
    } catch {
      /* privacy mode / disabled storage — saving is best-effort, same
       * as the split-position persistence above. */
    }
    this.savedEntry = { id: SAVED_ID, label: deriveSavedLabel(this.source), src: this.source };
    this.loadedBaseline = this.source;
    this.activeExampleId = SAVED_ID;
    this.savedFlash = true;
    if (this.savedFlashTimer) clearTimeout(this.savedFlashTimer);
    this.savedFlashTimer = setTimeout(() => { this.savedFlash = false; }, 1500);
  }

  private downloadPsdlSource(): void {
    const blob = new Blob([this.source], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyTitle(this.diagramTitle)}.psdl`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private downloadSvg(): void {
    const blob = new Blob([this.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyTitle(this.diagramTitle)}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private downloadPng(): void {
    const img = new Image();
    const svgBlob = new Blob([this.svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width || 1100;
      canvas.height = img.height || 580;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const urlPng = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = urlPng;
        a.download = `${slugifyTitle(this.diagramTitle)}.png`;
        a.click();
        URL.revokeObjectURL(urlPng);
      });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  /** Renders the SVG at a print-quality resolution (~600 DPI, i.e.
   * ~6.25x a browser's baseline 96 CSS DPI) and copies it to the system
   * clipboard as a PNG, for pasting straight into a report or email
   * without an intermediate downloaded file. */
  private copyPngToClipboard(): void {
    const DPI_SCALE = 600 / 96;
    const img = new Image();
    const svgBlob = new Blob([this.svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round((img.width || 1100) * DPI_SCALE);
      canvas.height = Math.round((img.height || 580) * DPI_SCALE);
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(async (blob) => {
        URL.revokeObjectURL(url);
        if (!blob) return;
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          this.copiedFlash = true;
          if (this.copiedFlashTimer) clearTimeout(this.copiedFlashTimer);
          this.copiedFlashTimer = setTimeout(() => { this.copiedFlash = false; }, 2000);
        } catch {
          /* Clipboard permission denied, insecure context, or an
           * unsupported browser — copying is a convenience, not worth
           * surfacing a hard error for. */
        }
      });
    };
    img.src = url;
  }

  override render() {
    const savedOption = this.savedEntry;
    return html`
      <div class="psdl-header">
        <div class="psdl-header-row">
          <div class="psdl-title"><span class="psdl-accent">PSDL</span> — Protection Setting Diagram Language</div>
          <label class="psdl-picker">
            <span class="psdl-picker-label">Examples</span>
            <select
              class="psdl-select"
              .value=${this.activeExampleId}
              @change=${(e: Event) => this.requestSwitch({ type: 'example', id: (e.target as HTMLSelectElement).value })}
            >
              ${savedOption ? html`<option value=${savedOption.id}>${savedOption.label}</option>` : null}
              ${EXAMPLES.map((ex) => html`<option value=${ex.id}>${ex.label}</option>`)}
            </select>
          </label>
          <button class="psdl-btn" @click=${() => this.toggleTheme()}>${this.lightTheme ? 'Dark' : 'Light'}</button>
          <button class="psdl-btn" @click=${() => this.downloadSvg()}>Download SVG</button>
          <button class="psdl-btn" @click=${() => this.downloadPng()}>Download PNG</button>
          <button class="psdl-btn" title="Copy a print-quality PNG (~600 DPI) to the clipboard" @click=${() => this.copyPngToClipboard()}>${this.copiedFlash ? 'Copied' : 'Copy'}</button>
          <button class="psdl-btn" title="Open the guide (or press ?)" @click=${() => { this.guideOpen = true; }}>Guide <span class="psdl-kbd">?</span></button>
          <button class="psdl-btn" @click=${() => this.requestSwitch({ type: 'reset' })}>Reset</button>
        </div>
      </div>
      <div class="psdl-main">
        <div class="psdl-side" style="flex: 0 0 var(--psdl-split-left);">
          <div class="psdl-side-title">
            <strong>Source</strong>
            <span class="psdl-small">.psdl</span>
            <span class="psdl-spacer"></span>
            <button class="psdl-btn psdl-btn-sm" @click=${() => this.saveSource()}>${this.savedFlash ? 'Saved' : 'Save'}</button>
            <button class="psdl-btn psdl-btn-sm" @click=${() => this.downloadPsdlSource()}>Download</button>
          </div>
          <psdl-editor
            .value=${this.source}
            .marks=${this.marks}
            @change=${(e: CustomEvent<string>) => this.onSourceChange(e)}
          ></psdl-editor>
          ${this.renderDiagnostics()}
        </div>
        <div class="psdl-splitter" @mousedown=${(e: MouseEvent) => this.beginDrag(e)}></div>
        <div class="psdl-side" style="flex: 1 1 auto;">
          <div class="psdl-side-title">
            <strong>${this.diagramTitle || 'Diagram'}</strong>
            <span class="psdl-small">${this.scale}</span>
          </div>
          <psdl-viewer
            .svg=${this.svg}
            .status=${this.status}
            .scale=${this.scale}
            .diagramTitle=${this.diagramTitle}
            .percents=${this.percents}
            .display=${this.display}
          ></psdl-viewer>
        </div>
      </div>
      <psdl-guide
        .open=${this.guideOpen}
        @close=${() => { this.guideOpen = false; }}
      ></psdl-guide>
      ${this.renderPendingSwitchDialog()}
    `;
  }

  private renderPendingSwitchDialog() {
    if (!this.pendingSwitch) return null;
    return html`
      <div class="psdl-guide-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this.resolvePendingCancel(); }}>
        <div class="psdl-confirm-panel">
          <div class="psdl-confirm-title">Unsaved changes</div>
          <p class="psdl-confirm-body">This diagram has changes that haven't been saved. Save them before switching?</p>
          <div class="psdl-confirm-actions">
            <button class="psdl-btn" @click=${() => this.resolvePendingCancel()}>Cancel</button>
            <button class="psdl-btn" @click=${() => this.resolvePendingDiscard()}>Discard</button>
            <button class="psdl-btn is-active" @click=${() => this.resolvePendingSave()}>Save</button>
          </div>
        </div>
      </div>
    `;
  }

  private beginDrag(e: MouseEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const root = document.documentElement;
    const initialLeft = parseFloat(getComputedStyle(root).getPropertyValue('--psdl-split-left')) || 38;
    const onMove = (ev: MouseEvent) => {
      const total = document.documentElement.clientWidth;
      const dx = ((ev.clientX - startX) / total) * 100;
      const left = Math.min(70, Math.max(20, initialLeft + dx));
      root.style.setProperty('--psdl-split-left', left + '%');
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('psdl.splitLeft', root.style.getPropertyValue('--psdl-split-left')); } catch {
        /* same as connectedCallback's read — best effort only */
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  private renderDiagnostics() {
    const items = this.marks.filter((m) => m.severity === 'error' || m.severity === 'warning');
    if (items.length === 0) return null;
    return html`
      <div class="psdl-diagnostics">
        <ul>
          ${items.map((m) => html`
            <li class="is-${m.severity}">
              <span class="psdl-loc">L${m.line}:${m.column}</span>
              <span class="psdl-icon">${m.severity === 'error' ? '!' : '?'}</span>
              <span class="psdl-message">${m.message} <span class="psdl-code">${m.code}</span></span>
            </li>
          `)}
        </ul>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'psdl-app': PsdlApp;
  }
}
