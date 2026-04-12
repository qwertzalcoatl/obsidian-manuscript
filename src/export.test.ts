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
  it('converts headings to LaTeX formatting', () => {
    expect(stripMarkdown('# Chapter One')).toContain('\\textbf{Chapter One}');
    expect(stripMarkdown('## Scene')).toContain('\\textbf{Scene}');
    expect(stripMarkdown('### Note')).toContain('\\textit{Note}');
    expect(stripMarkdown('# Chapter One')).not.toContain('#');
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

describe('generateLatex', () => {
  const files: import('./export').FileContent[] = [
    { title: 'Scene 1', content: 'It was a dark night.' },
    { title: 'Scene 2', content: 'The door opened.' },
  ];

  it('returns a string containing \\begin{document}', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\begin{document}');
  });

  it('returns a string containing \\end{document}', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\end{document}');
  });

  it('includes content from all files', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('It was a dark night.');
    expect(result).toContain('The door opened.');
  });

  it('wraps in Normseite preamble when template is normseite-de', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\usepackage{stdpage}');
    expect(result).toContain('\\usepackage{babel}');
  });

  it('throws for unknown template', () => {
    expect(() => generateLatex(files, 'unknown' as any)).toThrow('Unknown template');
  });

  it('strips markdown in file content', () => {
    const withMarkdown: import('./export').FileContent[] = [
      { title: 'Test', content: '**bold text**' },
    ];
    const result = generateLatex(withMarkdown, 'normseite-de');
    expect(result).toContain('bold text');
    expect(result).not.toContain('**');
  });
});
