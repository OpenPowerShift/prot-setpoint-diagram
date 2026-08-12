/**
 * Lexer + recursive-descent parser for PSDL.
 *
 * PSDL is line-oriented and intentionally small: ~30 productions.
 *
 *   diagram        = "diagram", string, "{", { statement }, "}" ;
 *   statement      = orientation | voltage | ct | show | view | scale | range
 *                  | word | style | constraint | selection ;
 *   expression     = factor, { ( "*" | "/" ), factor } ;
 *   factor         = number | "(", expression, ")" ;
 *   unit           = "A" | "kA" | "kVA" | "MVA" ;
 *
 * Whitespace separates tokens. Newlines terminate statements, except inside
 * parentheses. Lines beginning with `#` (after optional leading whitespace)
 * are comments through end of line. Keywords and units are case-sensitive.
 */

import type {
  Diagram,
  DisplayQuantity,
  Document,
  Margin,
  ParseError,
  Quantity,
  RangeKind,
  Requirement,
  ScaleKind,
  SelectionForm,
  SourceLocation,
  Statement,
  StyleStatement,
  Unit,
  ViewKind,
  WordName,
} from './ast.js';

export interface ParseResult {
  document?: Document;
  errors: ParseError[];
}

/* ---------------------------------------------------------------- tokens */

export type TokenKind =
  | 'identifier'
  | 'string'
  | 'number'
  | 'unit'
  | 'percent'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'asterisk'
  | 'slash'
  | 'hash'
  | 'newline'
  | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  loc: SourceLocation;
}

const UNITS_SET = new Set(['A', 'kA', 'kVA', 'MVA', 'kV', '%']);

export function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isAlpha = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isAlnum = (c: string) => isAlpha(c) || isDigit(c);

  while (i < src.length) {
    const c = src[i];

    /* newline */
    if (c === '\n') {
      tokens.push({ kind: 'newline', text: '\n', loc: { line, column: col, offset: i } });
      i++;
      line++;
      col = 1;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }

    /* comment – hash to end of line */
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    /* whitespace */
    if (c === ' ' || c === '\t') {
      i++;
      col++;
      continue;
    }

    /* structural */
    if (c === '{') {
      tokens.push({ kind: 'lbrace', text: '{', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === '}') {
      tokens.push({ kind: 'rbrace', text: '}', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen', text: '(', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen', text: ')', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === ',') {
      tokens.push({ kind: 'comma', text: ',', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === '*') {
      tokens.push({ kind: 'asterisk', text: '*', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === '/') {
      tokens.push({ kind: 'slash', text: '/', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }
    if (c === '%') {
      tokens.push({ kind: 'percent', text: '%', loc: { line, column: col, offset: i } });
      i++;
      col++;
      continue;
    }

    /* string */
    if (c === '"') {
      const start = { line, column: col, offset: i };
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') {
        value += src[j];
        j++;
      }
      if (j >= src.length || src[j] !== '"') {
        /* unterminated string – emit a placeholder so the parser can
         * produce a structured PSDL003 diagnostic; we record the error
         * in the parser, not the lexer, so the location is a string */
        tokens.push({ kind: 'string', text: value, loc: start });
        i = j;
        col += value.length + 1;
      } else {
        tokens.push({ kind: 'string', text: value, loc: start });
        i = j + 1;
        col += value.length + 2;
      }
      continue;
    }

    /* number */
    if (isDigit(c)) {
      const start = { line, column: col, offset: i };
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (j < src.length && src[j] === '.') {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      const text = src.slice(i, j);
      tokens.push({ kind: 'number', text, loc: start });
      col += j - i;
      i = j;
      continue;
    }

    /* identifier or unit */
    if (isAlpha(c)) {
      const start = { line, column: col, offset: i };
      let j = i;
      while (j < src.length && (isAlnum(src[j]) || src[j] === '-')) j++;
      const text = src.slice(i, j);
      if (UNITS_SET.has(text)) {
        tokens.push({ kind: 'unit', text, loc: start });
      } else {
        tokens.push({ kind: 'identifier', text, loc: start });
      }
      col += j - i;
      i = j;
      continue;
    }

    /* unknown character: emit as identifier-sized token so the parser
     * error covers it (PSD001_UNKNOWN_STATEMENT). */
    tokens.push({
      kind: 'identifier',
      text: c,
      loc: { line, column: col, offset: i },
    });
    i++;
    col++;
  }

  tokens.push({
    kind: 'eof',
    text: '',
    loc: { line, column: col, offset: i },
  });
  return tokens;
}

/* -------------------------------------------------------------- parser */

const TYPE_KEYWORDS = new Set([
  'diagram',
  'orientation',
  'voltage',
  'ct',
  'show',
  'view',
  'scale',
  'range',
  'word',
  'style',
  'below',
  'above',
  'must',
  'should',
  'margin',
  'selected',
  'midpoint',
  'low',
  'high',
  'step',
  'none',
  'to',
]);

const DISPLAY_QUANTITIES: DisplayQuantity[] = ['entered', 'current', 'mva', 'secondary'];
const SCALE_KINDS: ScaleKind[] = ['linear', 'log', 'indicative', 'auto'];
const VIEW_KINDS: ViewKind[] = ['report', 'compact', 'rail'];
const STYLE_PROPERTIES = new Set(['theme', 'palette', 'zones', 'connections']);
const STYLE_VALUES = new Set<string>([
  // theme
  'light',
  'dark',
  'print',
  'monochrome',
  // palette
  'accessible',
  'default',
  'high-contrast',
  'monochrome',
  // zones
  'off',
  'subtle',
  'full',
  // connections
  'off',
  'pale',
  'rows',
]);
const WORD_NAMES: WordName[] = [
  'do-not-set',
  'caution',
  'recommended',
  'selected',
  'no-recommended',
  'no-compliant',
];

export function parse(src: string): ParseResult {
  const tokens = lex(src);
  const errors: ParseError[] = [];

  let pos = 0;

  function peek(): Token {
    return tokens[pos]!;
  }
  function next(): Token {
    const t = tokens[pos]!;
    pos++;
    return t;
  }
  function at(kind: TokenKind): boolean {
    return peek().kind === kind;
  }
  function skipNewlines(): void {
    while (peek().kind === 'newline') pos++;
  }

  function expect(kind: TokenKind, message: string): Token | null {
    if (peek().kind !== kind) {
      const got = peek();
      pushError('PSDL001_UNKNOWN_STATEMENT', `Expected ${message}, got ${describe(got)}.`, got.loc, Math.max(1, got.text.length));
      return null;
    }
    return next();
  }

  function pushError(code: string, message: string, loc: SourceLocation, length = 1): void {
    errors.push({ code, severity: 'error', message, line: loc.line, column: loc.column, offset: loc.offset, length });
  }

  /* document. Skip leading newlines. Single diagram. */
  skipNewlines();
  let document: Document | undefined;

  const docStart = peek().loc;
  const kw = expect('identifier', `'diagram' keyword`);
  if (kw && kw.text === 'diagram') {
    const diagram = parseDiagram(kw.loc);
    if (diagram) {
      document = {
        type: 'document',
        title: diagram.title,
        diagram,
        loc: { line: docStart.line, column: docStart.column, offset: docStart.offset },
      };
    }
    skipNewlines();
    if (peek().kind !== 'eof') {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Expected end of file after '}', got ${describe(peek())}.`,
        peek().loc,
      );
    }
  } else {
    pushError(
      'PSDL001_UNKNOWN_STATEMENT',
      `Expected 'diagram' keyword, got ${describe(peek())}.`,
      peek().loc,
    );
  }

  return { document, errors };

  /* ----------------------------------------------------------- internals */

  function parseDiagram(start: SourceLocation): Diagram | undefined {
    const titleTok = expect('string', `diagram title`);
    if (!titleTok) return undefined;
    if (titleTok.text.length === 0) {
      pushError('PSDL003_STRING_REQUIRED', `Diagram title must not be empty.`, titleTok.loc, titleTok.text.length + 2);
    }
    const lbrace = expect('lbrace', `'{'`);
    if (!lbrace) return undefined;
    skipNewlines();

    const body: Statement[] = [];
    const seen = new Set<string>();
    while (!at('rbrace') && !at('eof')) {
      const stmt = parseStatement(seen);
      if (stmt) body.push(stmt);
      skipNewlines();
    }
    expect('rbrace', `'}'`);
    return {
      type: 'diagram',
      title: titleTok.text,
      body,
      loc: { line: start.line, column: start.column, offset: start.offset },
    };
  }

  function parseStatement(seen: Set<string>): Statement | undefined {
    const tok = peek();
    if (tok.kind !== 'identifier') {
      /* statement-starting token must be a keyword. Recover by skipping
       * the line. */
      pushError('PSDL001_UNKNOWN_STATEMENT', `Expected a statement keyword, got ${describe(tok)}.`, tok.loc);
      recoverLine();
      return undefined;
    }

    const word = tok.text;
    if (!TYPE_KEYWORDS.has(word)) {
      pushError('PSDL001_UNKNOWN_STATEMENT', `Unknown statement '${word}'.`, tok.loc, word.length);
      recoverLine();
      return undefined;
    }

    if (word === 'orientation' || word === 'voltage' || word === 'ct' || word === 'show' ||
        word === 'view'    || word === 'scale'   || word === 'range') {
      if (seen.has(word)) {
        pushError('PSDL002_DUPLICATE_SINGLETON', `Duplicate '${word}' statement.`, tok.loc, word.length);
        recoverLine();
        return undefined;
      }
      seen.add(word);
    }

    switch (word) {
      case 'orientation':
        return parseOrientation(tok);
      case 'voltage':
        return parseVoltage(tok);
      case 'ct':
        return parseCt(tok);
      case 'show':
        return parseShow(tok);
      case 'view':
        return parseView(tok);
      case 'scale':
        return parseScale(tok);
      case 'range':
        return parseRange(tok);
      case 'word':
        return parseWord(tok, seen);
      case 'style':
        return parseStyle(tok, seen);
      case 'below':
      case 'above':
        return parseConstraint(tok);
      case 'selected':
        return parseSelection(tok);
    }
    return undefined;
  }

  function parseOrientation(start: Token): Statement {
    next();
    const valueTok = next();
    if (valueTok.kind !== 'identifier' || (valueTok.text !== 'horizontal' && valueTok.text !== 'vertical')) {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Orientation must be 'horizontal' or 'vertical', got ${describe(valueTok)}.`,
        valueTok.loc,
      );
      return { type: 'orientation', value: 'horizontal', loc: start.loc };
    }
    return { type: 'orientation', value: valueTok.text, loc: start.loc };
  }

  function parseVoltage(start: Token): Statement {
    next();
    const q = parseQuantity();
    if (!q) {
      return { type: 'voltage', value: { value: 0, unit: 'kV', expression: '0', loc: start.loc }, loc: start.loc };
    }
    if (q.unit !== 'kV') {
      pushError('PSDL005_UNIT_UNKNOWN', `Voltage must use kV, got '${q.unit}'.`, q.loc, q.unit.length);
    }
    return { type: 'voltage', value: q, loc: start.loc };
  }

  function parseCt(start: Token): Statement | undefined {
    next();
    const a = next();
    if (a.kind !== 'number') {
      pushError('PSDL004_EXPRESSION_INVALID', `CT primary must be a number, got ${describe(a)}.`, a.loc);
      recoverLine();
      return undefined;
    }
    if (!at('slash')) {
      pushError('PSDL004_EXPRESSION_INVALID', `CT ratio missing '/'.`, peek().loc);
      recoverLine();
      return undefined;
    }
    next();
    const b = next();
    if (b.kind !== 'number') {
      pushError('PSDL004_EXPRESSION_INVALID', `CT secondary must be a number, got ${describe(b)}.`, b.loc);
      recoverLine();
      return undefined;
    }
    if (!at('unit') || peek().text !== 'A') {
      const t = peek();
      pushError('PSDL005_UNIT_UNKNOWN', `CT ratio must end with A, got ${describe(t)}.`, t.loc);
    } else {
      next();
    }
    return {
      type: 'ct',
      primary: Number(a.text),
      secondary: Number(b.text),
      loc: start.loc,
    };
  }

  function parseShow(start: Token): Statement {
    next();
    const quantities: DisplayQuantity[] = [];
    while (true) {
      const tok = next();
      if (tok.kind !== 'identifier' || !DISPLAY_QUANTITIES.includes(tok.text as DisplayQuantity)) {
        pushError(
          'PSDL001_UNKNOWN_STATEMENT',
          `Display quantity must be one of ${DISPLAY_QUANTITIES.join(', ')}, got ${describe(tok)}.`,
          tok.loc,
        );
        break;
      }
      quantities.push(tok.text as DisplayQuantity);
      if (at('comma')) {
        next();
        continue;
      }
      break;
    }
    return { type: 'show', quantities, loc: start.loc };
  }

  function parseView(start: Token): Statement {
    next();
    const tok = next();
    const value = (tok.kind === 'identifier' && (VIEW_KINDS as string[]).includes(tok.text))
      ? (tok.text as ViewKind)
      : 'compact';
    if (value === 'compact' && tok.kind !== 'identifier') {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `View must be one of ${VIEW_KINDS.join(', ')}, got ${describe(tok)}.`,
        tok.loc,
      );
    }
    return { type: 'view', value, loc: start.loc };
  }

  function parseScale(start: Token): Statement {
    next();
    const tok = next();
    const value = (tok.kind === 'identifier' && (SCALE_KINDS as string[]).includes(tok.text))
      ? (tok.text as ScaleKind)
      : 'auto';
    if (value === 'auto' && tok.kind !== 'identifier') {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Scale must be one of ${SCALE_KINDS.join(', ')}, got ${describe(tok)}.`,
        tok.loc,
      );
    }
    return { type: 'scale', value, loc: start.loc };
  }

  function parseRange(start: Token): Statement {
    next();
    const tok = peek();
    let value: RangeKind;
    if (tok.kind === 'identifier' && tok.text === 'auto') {
      next();
      value = { kind: 'auto' };
    } else if (tok.kind === 'identifier' && tok.text === 'all') {
      next();
      value = { kind: 'all' };
    } else if (tok.kind === 'identifier' && tok.text === 'focus') {
      next();
      value = { kind: 'focus' };
    } else {
      const lo = parseQuantity();
      if (!lo) {
        value = { kind: 'auto' };
      } else {
        if (!at('identifier') || peek().text !== 'to') {
          const t = peek();
          pushError('PSDL001_UNKNOWN_STATEMENT', `Range must use 'auto', 'all', 'focus', or 'quantity to quantity', got ${describe(t)}.`, t.loc);
          value = { kind: 'auto' };
        } else {
          next();
          const hi = parseQuantity();
          if (!hi) {
            value = { kind: 'auto' };
          } else {
            value = { kind: 'explicit', minimum: lo, maximum: hi };
          }
        }
      }
    }
    return { type: 'range', value, loc: start.loc };
  }

  function parseWord(start: Token, seen: Set<string>): Statement | undefined {
    next();
    const nameTok = next();
    if (nameTok.kind !== 'identifier' || !(WORD_NAMES as string[]).includes(nameTok.text)) {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Word name must be one of ${WORD_NAMES.join(', ')}, got ${describe(nameTok)}.`,
        nameTok.loc,
      );
      recoverLine();
      return undefined;
    }
    if (seen.has('word:' + nameTok.text)) {
      pushError('PSDL002_DUPLICATE_SINGLETON', `Duplicate word '${nameTok.text}'.`, nameTok.loc, nameTok.text.length);
    }
    seen.add('word:' + nameTok.text);
    const textTok = expect('string', `word value`);
    if (!textTok) return undefined;
    if (textTok.text.length === 0) {
      pushError('PSDL003_STRING_REQUIRED', `Word value must not be empty.`, textTok.loc);
    }
    return { type: 'word', name: nameTok.text as WordName, text: textTok.text, loc: start.loc };
  }

  function parseStyle(start: Token, seen: Set<string>): StyleStatement {
    next();
    const propTok = next();
    let property: StyleStatement['property'] = 'theme';
    if (propTok.kind !== 'identifier' || !STYLE_PROPERTIES.has(propTok.text)) {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Style property must be one of theme, palette, zones, connections, got ${describe(propTok)}.`,
        propTok.loc,
      );
    } else {
      property = propTok.text as StyleStatement['property'];
      /* Each style property (theme, palette, zones, connections) is its
       * own singleton — the spec's canonical example sets all four in
       * separate `style` statements, so only a repeated PROPERTY is a
       * duplicate, not a repeated `style` keyword. */
      if (seen.has('style:' + property)) {
        pushError('PSDL002_DUPLICATE_SINGLETON', `Duplicate 'style ${property}' statement.`, propTok.loc, property.length);
      }
      seen.add('style:' + property);
    }
    const valTok = next();
    let value = '';
    if (valTok.kind === 'identifier') {
      if (!STYLE_VALUES.has(propTok.text + ':' + valTok.text) && !STYLE_VALUES.has(valTok.text)) {
        pushError(
          'PSDL001_UNKNOWN_STATEMENT',
          `Style value '${valTok.text}' is not recognised for '${property}'.`,
          valTok.loc,
        );
      }
      value = valTok.text;
    } else {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Style value must be an identifier, got ${describe(valTok)}.`,
        valTok.loc,
      );
    }
    return { type: 'style', property, value, loc: start.loc };
  }

  function parseConstraint(start: Token): Statement {
    const direction = next().text as 'below' | 'above';
    const labelTok = expect('string', `criterion label`);
    if (!labelTok) {
      return constraintFallback(start.loc, direction);
    }
    if (labelTok.text.length === 0) {
      pushError('PSDL003_STRING_REQUIRED', `Criterion label must not be empty.`, labelTok.loc);
    }
    const reqTok = next();
    let requirement: Requirement = 'must';
    if (reqTok.kind !== 'identifier' || (reqTok.text !== 'must' && reqTok.text !== 'should')) {
      pushError(
        'PSDL001_UNKNOWN_STATEMENT',
        `Requirement must be 'must' or 'should', got ${describe(reqTok)}.`,
        reqTok.loc,
      );
    } else {
      requirement = reqTok.text as Requirement;
    }
    const value = parseQuantity();
    if (!value) {
      return constraintFallback(start.loc, direction);
    }
    let margin: Margin | undefined;
    if (at('identifier') && peek().text === 'margin') {
      next();
      const m = parseMargin();
      if (m) margin = m;
    }
    return {
      type: 'constraint',
      direction,
      label: labelTok.text,
      requirement,
      value,
      margin,
      loc: start.loc,
    };
  }

  function constraintFallback(
    loc: SourceLocation,
    direction: 'below' | 'above',
  ): Statement {
    return {
      type: 'constraint',
      direction,
      label: '',
      requirement: 'must',
      value: { value: 0, unit: 'kA', expression: '0', loc },
      loc,
    };
  }

  function parseMargin(): Margin | undefined {
    /* Grammar: margin = "margin", ( percentage | quantity ) — so an
     * absolute margin carries its own unit and that unit MUST be
     * consumed here. Previously the unit token was left unread and the
     * unit hardcoded to 'A', so `margin 0.4 kA` both emitted a spurious
     * PSDL001 (the stray 'kA' parsed as a new statement) and silently
     * resolved to 0.4 A — a 1000x error in a protection margin. */
    const tok = peek();
    if (tok.kind === 'percent') {
      next();
      const loc = tok.loc;
      return { kind: 'percentage', value: { value: 0, unit: '%', expression: '', loc }, percent: 0, loc };
    }
    const expr = parseExpression();
    if (!expr) return undefined;
    if (peek().kind === 'percent') {
      const loc = next().loc;
      const percent = expr.value;
      return { kind: 'percentage', value: { value: percent, unit: '%', expression: expr.text, loc }, percent, loc };
    }
    if (peek().kind === 'unit') {
      const unitTok = next();
      return {
        kind: 'absolute',
        value: { value: expr.value, unit: unitTok.text as Unit, expression: expr.text, loc: expr.loc },
        loc: expr.loc,
      };
    }
    pushError(
      'PSDL005_UNIT_UNKNOWN',
      `Margin must be a percentage or a quantity with a unit (A, kA, kVA, MVA), got ${describe(peek())}.`,
      peek().loc,
    );
    return {
      kind: 'absolute',
      value: { value: expr.value, unit: 'A', expression: expr.text, loc: expr.loc },
      loc: expr.loc,
    };
  }


  function parseSelection(start: Token): Statement | undefined {
    next();
    const labelTok = expect('string', `selection label`);
    if (!labelTok) return undefined;
    if (labelTok.text.length === 0) {
      pushError('PSDL003_STRING_REQUIRED', `Selection label must not be empty.`, labelTok.loc);
    }
    const tok = peek();
    let form: SelectionForm;
    /* Selection forms come in two shapes: a keyword (midpoint, low, high,
     * none) optionally followed by `step N kA`, or a literal quantity. */
    const consumeStep = (): Quantity | undefined => {
      if (at('identifier') && peek().text === 'step') {
        next();
        return parseQuantity();
      }
      return undefined;
    };
    if (tok.kind === 'identifier' && (tok.text === 'midpoint' || tok.text === 'low' || tok.text === 'high')) {
      const keyword = tok.text as 'midpoint' | 'low' | 'high';
      next();
      const step = consumeStep();
      form = { kind: keyword, step };
    } else if (tok.kind === 'identifier' && tok.text === 'none') {
      next();
      form = { kind: 'none' };
    } else if (tok.kind === 'identifier') {
      /* not a known form, attempt to read a quantity */
      const q = parseQuantity();
      form = q ? { kind: 'explicit', value: q } : { kind: 'none' };
    } else if (tok.kind === 'number' || tok.kind === 'lparen') {
      const q = parseQuantity();
      form = q ? { kind: 'explicit', value: q } : { kind: 'none' };
    } else {
      pushError('PSDL001_UNKNOWN_STATEMENT', `Selection form must be a quantity, 'midpoint', 'low', 'high', or 'none', got ${describe(tok)}.`, tok.loc);
      form = { kind: 'none' };
    }
    return { type: 'selection', label: labelTok.text, form, loc: start.loc };
  }

  /* expressions */

  function parseQuantity(): Quantity | undefined {
    /* expression then unit */
    const expr = parseExpression();
    if (!expr) return undefined;
    const next_tok = peek();
    if (next_tok.kind === 'unit') {
      const u = next().text as Unit;
      return { value: expr.value, unit: u, expression: expr.text, loc: expr.loc };
    }
    if (next_tok.kind === 'percent') {
      next();
      return {
        value: expr.value,
        unit: '%',
        expression: expr.text,
        loc: { line: expr.loc.line, column: expr.loc.column, offset: expr.loc.offset },
      };
    }
    pushError('PSDL005_UNIT_UNKNOWN', `Expected a unit (A, kA, kVA, MVA, %) after number, got ${describe(next_tok)}.`, next_tok.loc);
    return { value: expr.value, unit: 'A', expression: expr.text, loc: expr.loc };
  }

  function parseExpression(): { value: number; text: string; loc: SourceLocation } | undefined {
    const start = peek().loc;
    const first = parseFactor();
    if (!first) return undefined;
    let value = first.value;
    let text = first.text;
    while (at('asterisk') || at('slash')) {
      const op = next().text;
      const next_ = parseFactor();
      if (!next_) return undefined;
      if (op === '*') value = value * next_.value;
      else {
        if (next_.value === 0) {
          pushError('PSDL104_DIVIDE_BY_ZERO', `Division by zero.`, next_.loc);
          value = NaN;
        } else {
          value = value / next_.value;
        }
      }
      text += ' ' + op + ' ' + next_.text;
    }
    if (Number.isNaN(value)) value = NaN;
    return { value, text, loc: start };
  }

  function parseFactor(): { value: number; text: string; loc: SourceLocation } | undefined {
    const tok = peek();
    if (tok.kind === 'lparen') {
      next();
      const inner = parseExpression();
      if (!inner) return undefined;
      const cl = expect('rparen', `')'`);
      if (!cl) return undefined;
      return { value: inner.value, text: '(' + inner.text + ')', loc: tok.loc };
    }
    if (tok.kind === 'number') {
      next();
      const value = Number(tok.text);
      if (!Number.isFinite(value)) {
        pushError('PSDL004_EXPRESSION_INVALID', `Number '${tok.text}' is not finite.`, tok.loc, tok.text.length);
      }
      return { value, text: tok.text, loc: tok.loc };
    }
    pushError('PSDL004_EXPRESSION_INVALID', `Expected number or '(', got ${describe(tok)}.`, tok.loc);
    return undefined;
  }

  /* error recovery: skip to next newline or `}` */
  function recoverLine(): void {
    while (peek().kind !== 'newline' && peek().kind !== 'rbrace' && peek().kind !== 'eof') {
      pos++;
    }
  }
}

function describe(t: Token): string {
  if (t.kind === 'eof') return 'end of file';
  if (t.kind === 'identifier') return `'${t.text}'`;
  if (t.kind === 'string') return `string`;
  if (t.kind === 'number') return `number '${t.text}'`;
  if (t.kind === 'unit') return `unit '${t.text}'`;
  if (t.kind === 'percent') return `'%'`;
  if (t.kind === 'lbrace') return `'{'`;
  if (t.kind === 'rbrace') return `'}'`;
  if (t.kind === 'lparen') return `'('`;
  if (t.kind === 'rparen') return `')'`;
  if (t.kind === 'comma') return `','`;
  if (t.kind === 'asterisk') return `'*'`;
  if (t.kind === 'slash') return `'/'`;
  if (t.kind === 'hash') return `'#'`;
  if (t.kind === 'newline') return `end of line`;
  return t.kind;
}
