import { stripFrontmatter, extractSnippet } from './text';

describe('stripFrontmatter', () => {
  it('removes a frontmatter block', () => {
    expect(stripFrontmatter('---\ntitle: Test\n---\nHello')).toBe('Hello');
  });

  it('removes a block whose values contain ---', () => {
    expect(stripFrontmatter('---\ndescription: a---b\n---\nContent')).toBe('Content');
  });

  it('handles CRLF line endings', () => {
    expect(stripFrontmatter('---\r\ntitle: T\r\n---\r\nContent')).toBe('Content');
  });

  it('leaves a note that opens with a horizontal rule alone', () => {
    // The old indexOf('---', 3) scan swallowed everything up to the next rule.
    // A blank line after the fence is what marks this as a rule, not frontmatter.
    const input = '---\n\nEs war ein kalter Abend.\n\n---\n\nUnd dann kam der Brief.';
    expect(stripFrontmatter(input)).toBe(input);
  });

  it('leaves an unterminated block alone rather than returning raw YAML', () => {
    expect(stripFrontmatter('---\ntitle: Test\nno closing fence')).toBe(
      '---\ntitle: Test\nno closing fence'
    );
  });

  it('handles a frontmatter block with no body after it', () => {
    expect(stripFrontmatter('---\ntitle: T\n---')).toBe('');
  });

  it('passes through content with no frontmatter', () => {
    expect(stripFrontmatter('Just text')).toBe('Just text');
  });
});

describe('extractSnippet', () => {
  it('joins the first three non-empty lines', () => {
    expect(extractSnippet('One\n\nTwo\nThree\nFour')).toBe('One Two Three');
  });

  it('skips frontmatter', () => {
    expect(extractSnippet('---\ntitle: T\n---\nDer Text')).toBe('Der Text');
  });

  it('keeps heading text instead of dropping the line', () => {
    // A note made only of headings previewed as blank before.
    expect(extractSnippet('# Kapitel Eins\n## Erste Szene')).toBe('Kapitel Eins Erste Szene');
  });

  it('strips inline markdown markers', () => {
    expect(extractSnippet('**fett** und *kursiv* und `code`')).toBe('fett und kursiv und code');
  });

  it('leaves snake_case words intact', () => {
    expect(extractSnippet('die datei some_long_name wurde geschrieben')).toBe(
      'die datei some_long_name wurde geschrieben'
    );
  });

  it('resolves wikilinks and their aliases', () => {
    expect(extractSnippet('Siehe [[Kapitel 2]] und [[3 – Ende|das Ende]]')).toBe(
      'Siehe Kapitel 2 und das Ende'
    );
  });

  it('resolves markdown links to their text', () => {
    expect(extractSnippet('[Notiz](notes/a.md) gelesen')).toBe('Notiz gelesen');
  });

  it('strips blockquote and list markers', () => {
    expect(extractSnippet('> Ein Zitat\n- Erster Punkt\n1. Zweiter Punkt')).toBe(
      'Ein Zitat Erster Punkt Zweiter Punkt'
    );
  });

  it('drops horizontal rules', () => {
    expect(extractSnippet('---\n\nText danach')).toBe('Text danach');
  });

  it('truncates with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const snippet = extractSnippet(long);
    expect(snippet).toHaveLength(121);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('returns an empty string for an empty note', () => {
    expect(extractSnippet('')).toBe('');
    expect(extractSnippet('\n\n   \n')).toBe('');
  });
});
