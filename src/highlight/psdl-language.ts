/**
 * Hand-written StreamLanguage for PSDL.
 *
 * Hand-written because the language is small and line-oriented, and
 * highlighting should work mid-edit when parsing fails.
 */

import { StreamLanguage, type StreamLanguage as SLType } from '@codemirror/language';

export interface PsdlState {
  inComment: boolean;
  depth: number;
}

const KEYWORDS = new Set(['diagram', 'orientation', 'voltage', 'ct', 'show', 'view', 'scale', 'range', 'word', 'style']);

const PROPERTY_NAMES = new Set([
  'horizontal', 'vertical',
  'must', 'should',
  'below', 'above',
  'auto', 'linear', 'log', 'indicative',
  'report', 'compact', 'rail',
  'midpoint', 'step', 'none',
  'theme', 'palette', 'zones', 'connections',
  'monochrome',
  'off', 'subtle', 'full', 'pale', 'rows',
  'entered', 'current', 'mva', 'secondary',
  'margin', 'to',
]);

const ATOM_VALUES = new Set([
  'light', 'dark', 'print',
  'accessible', 'default', 'high-contrast',
]);

const UNITS = new Set(['A', 'kA', 'kVA', 'MVA', 'kV']);

export const psdlLanguage: SLType<PsdlState> = StreamLanguage.define<PsdlState>({
  startState() {
    return { inComment: false, depth: 0 };
  },

  token(stream, state) {
    if (state.inComment) {
      while (!stream.eol()) stream.next();
      state.inComment = false;
      return 'lineComment';
    }

    if (stream.eatSpace()) return null;

    /* newline */
    if (stream.match(/\n/, false)) {
      stream.next();
      return null;
    }

    /* comment */
    if (stream.match('#', false)) {
      while (!stream.eol()) stream.next();
      return 'lineComment';
    }

    /* structural */
    if (stream.match(/[{}[\]()*,/]/, false)) {
      stream.next();
      return 'punctuation';
    }
    const op = stream.match(/[*/]/, false);
    if (op) {
      stream.next();
      return 'operator';
    }
    if (stream.match('%', false)) {
      stream.next();
      return 'number';
    }
    if (stream.match('@', false)) {
      stream.next();
      return 'operator';
    }

    /* identifier / keyword / property / unit */
    if (stream.match(/[a-zA-Z][\w-]*/, false)) {
      const word = stream.current();
      stream.next();
      if (KEYWORDS.has(word)) return 'keyword';
      if (word === 'do-not-set') return 'keyword';
      if (PROPERTY_NAMES.has(word) || ATOM_VALUES.has(word)) {
        if (UNITS.has(word)) return 'unit';
        if (ATOM_VALUES.has(word)) return 'atom';
        return 'propertyName';
      }
      if (UNITS.has(word)) return 'unit';
      /* inferred element/constraint name? */
      if (word.includes('-')) return 'variableName';
      return 'variableName';
    }

    /* string */
    if (stream.match(/"[^"\n]*"/, false)) {
      stream.match(/"[^"\n]*"/);
      return 'string';
    }

    /* number like 1.1, 0.5 */
    if (stream.match(/[0-9]+(\.[0-9]+)?/, false)) {
      stream.next();
      return 'number';
    }

    /* fallthrough */
    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: '#' },
  },
});
