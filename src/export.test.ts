import { escapeLatex, stripMarkdown, generateLatex, TEMPLATES } from './export';

describe('escapeLatex', () => {
  it('escapes backslash', () => {
    expect(escapeLatex('a\\b')).toBe('a\\textbackslash{}b');
  });
  it('escapes braces', () => {
    expect(escapeLatex('a{b}c')).toBe('a\\{b\\}c');
  });
  it('escapes ampersand', () => {
    expect(escapeLatex('a&b')).toBe('a\\&b');
  });
  it('escapes percent', () => {
    expect(escapeLatex('50%')).toBe('50\\%');
  });
  it('escapes dollar', () => {
    expect(escapeLatex('$10')).toBe('\\$10');
  });
  it('escapes hash', () => {
    expect(escapeLatex('#tag')).toBe('\\#tag');
  });
  it('escapes underscore', () => {
    expect(escapeLatex('a_b')).toBe('a\\_b');
  });
  it('escapes caret', () => {
    expect(escapeLatex('a^b')).toBe('a\\textasciicircum{}b');
  });
  it('escapes tilde', () => {
    expect(escapeLatex('a~b')).toBe('a\\textasciitilde{}b');
  });
  it('leaves plain text unchanged', () => {
    expect(escapeLatex('Hello world')).toBe('Hello world');
  });
});

describe('stripMarkdown', () => {
  it('strips YAML frontmatter', () => {
    const input = '---\ntitle: Test\n---\nHello world';
    expect(stripMarkdown(input)).toBe('Hello world');
  });
  it('strips frontmatter even when YAML values contain ---', () => {
    const input = '---\ndescription: a---b\n---\nContent';
    expect(stripMarkdown(input)).toBe('Content');
  });
  it('strips heading markers but keeps text', () => {
    expect(stripMarkdown('# Chapter One')).toBe('Chapter One');
    expect(stripMarkdown('## Scene')).toBe('Scene');
  });
  it('strips bold markers', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
    expect(stripMarkdown('__bold__')).toBe('bold');
  });
  it('strips italic markers', () => {
    expect(stripMarkdown('*italic*')).toBe('italic');
    expect(stripMarkdown('_italic_')).toBe('italic');
  });
  it('converts links to link text only', () => {
    expect(stripMarkdown('[click here](http://example.com)')).toBe('click here');
  });
  it('strips inline code backticks', () => {
    expect(stripMarkdown('use `code`')).toBe('use code');
  });
  it('strips fenced code blocks', () => {
    expect(stripMarkdown('before\n```\ncode\n```\nafter')).toBe('before\nafter');
  });
  it('escapes LaTeX special chars in remaining text', () => {
    expect(stripMarkdown('50% done')).toBe('50\\% done');
    expect(stripMarkdown('cost: $10')).toBe('cost: \\$10');
  });
  it('handles plain text with no markdown', () => {
    expect(stripMarkdown('Hello world')).toBe('Hello world');
  });
});
