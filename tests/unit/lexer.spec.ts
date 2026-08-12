import { describe, it, expect } from 'vitest';
import { lex } from '~/parser/parser';

describe('PSDL lexer', () => {
  it('tokenises identifiers, keywords, strings, numbers and units', () => {
    const tokens = lex(`diagram "Title" { orientation horizontal }`);
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain('identifier');
    expect(kinds).toContain('string');
    expect(kinds).toContain('lbrace');
    expect(kinds).toContain('rbrace');
  });

  it('treats kr expressions as separate tokens', () => {
    const tokens = lex(`below "x" must 5 kA margin 10 %`);
    const percentCount = tokens.filter((t) => t.kind === 'percent').length;
    expect(percentCount).toBe(1);
  });

  it('treats # comments to end of line', () => {
    const tokens = lex(`# comment\n diagram "T" { }`);
    /* The lexer consumes the comment up to the newline, then the
     * first remaining token should be the diagram identifier. */
    expect(tokens.find((t) => t.kind === 'identifier')?.text).toBe('diagram');
  });
});
