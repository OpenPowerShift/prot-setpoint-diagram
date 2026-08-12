/**
 * Highlight style + editor theme for PSDL.
 *
 * Every colour is a CSS custom-property variable so the editor
 * re-themes through the cascade without rebuilding CM.
 */

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const style = HighlightStyle.define([
  { tag: t.lineComment, color: 'var(--psdl-syn-comment)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--psdl-syn-keyword)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--psdl-syn-property)' },
  { tag: t.string, color: 'var(--psdl-syn-string)' },
  { tag: t.number, color: 'var(--psdl-syn-number)' },
  { tag: t.unit, color: 'var(--psdl-syn-unit)' },
  { tag: t.atom, color: 'var(--psdl-syn-atom)' },
  { tag: t.variableName, color: 'var(--psdl-syn-variable)' },
  { tag: t.operator, color: 'var(--psdl-syn-operator)' },
  { tag: t.punctuation, color: 'var(--psdl-syn-operator)' },
]);

const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--psdl-bg-sunken)',
    color: 'var(--psdl-fg)',
    fontFamily: 'var(--psdl-font)',
    height: '100%',
  },
  '.cm-content': {
    caretColor: 'var(--psdl-accent)',
    fontFamily: 'var(--psdl-font)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--psdl-bg-elevated)',
    color: 'var(--psdl-fg-muted)',
    border: 'none',
    borderRight: '1px solid var(--psdl-border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(127, 127, 127, 0.08)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(127, 127, 127, 0.08)',
    color: 'var(--psdl-accent)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(127, 200, 255, 0.2) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(127, 200, 255, 0.3) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--psdl-accent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--psdl-bg-elevated) !important',
    color: 'var(--psdl-fg) !important',
    border: '1px solid var(--psdl-border) !important',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    color: 'var(--psdl-fg) !important',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--psdl-accent) !important',
    color: 'var(--psdl-bg) !important',
  },
  '.cm-diagnostic-error': {
    borderLeft: '3px solid var(--psdl-error)',
  },
  '.cm-diagnostic-warning': {
    borderLeft: '3px solid var(--psdl-warning)',
  },
  '.cm-diagnostic-info': {
    borderLeft: '3px solid var(--psdl-accent)',
  },
}, { dark: false });

export const psdlEditorAppearance = [theme, syntaxHighlighting(style, { fallback: true })];
