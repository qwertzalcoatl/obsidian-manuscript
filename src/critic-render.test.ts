/**
 * @jest-environment jsdom
 *
 * Covers the Reading-view renderer, whose job is to map offsets in a block's
 * concatenated text back onto the several DOM text nodes that produced it.
 * That mapping plus the right-to-left splitting is the most error-prone code
 * in the feature, and its failure mode is silently mangling how a manuscript
 * displays — so it is checked here rather than by eye.
 *
 * The Live Preview half needs a real CodeMirror instance and is verified by
 * hand in Obsidian; both halves read their geometry from the same parseCritic
 * spans, which critic.test.ts pins.
 */

import { renderCriticMarkup } from './critic-render';

/** Renders an HTML fragment through the post-processor and returns the result. */
function render(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  renderCriticMarkup(root);
  return root;
}

const textOf = (html: string) => render(html).textContent;

describe('renderCriticMarkup — markers disappear, text survives', () => {
  it('renders an insertion', () => {
    const root = render('<p>Sie {++leise ++}ging.</p>');
    expect(root.textContent).toBe('Sie leise ging.');
    expect(root.querySelector('.sn-critic-insertion')?.textContent).toBe('leise ');
  });

  it('renders a deletion', () => {
    const root = render('<p>Sie ging{-- fort--}.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.sn-critic-deletion')?.textContent).toBe(' fort');
  });

  it('renders a substitution as struck old followed by new', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    expect(root.textContent).toBe('Das kaltefahle Licht.');
    expect(root.querySelector('.sn-critic-deletion')?.textContent).toBe('kalte');
    expect(root.querySelector('.sn-critic-insertion')?.textContent).toBe('fahle');
  });

  it('renders a highlight', () => {
    const root = render('<p>Sie {==ging==} fort.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.sn-critic-highlight')?.textContent).toBe('ging');
  });

  it('replaces a standalone comment with a glyph', () => {
    const root = render('<p>Er zögerte. {>>Mehr Spannung<<}</p>');
    expect(root.textContent).toBe('Er zögerte. ');
    const glyph = root.querySelector('.sn-critic-glyph');
    expect(glyph).not.toBeNull();
    expect(glyph?.getAttribute('aria-label')).toBe('Comment: Mehr Spannung');
  });

  it('keeps the anchor and shows a glyph for an attached comment', () => {
    const root = render('<p>Sie {==ging==}{>>zu abrupt?<<} fort.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.sn-critic-highlight')?.textContent).toBe('ging');
    expect(root.querySelector('.sn-critic-glyph')?.getAttribute('aria-label')).toBe(
      'Highlighted: ging. Comment: zu abrupt?'
    );
  });
});

describe('renderCriticMarkup — constructs spanning several DOM nodes', () => {
  it('renders a construct that wraps other markdown', () => {
    const root = render('<p>Sie {++<strong>leise</strong> und ruhig++} ging.</p>');
    expect(root.textContent).toBe('Sie leise und ruhig ging.');
    // The <strong> survives; the braces around it are gone.
    expect(root.querySelector('strong')?.textContent).toBe('leise');
    expect(root.textContent).not.toContain('{');
  });

  it('renders a construct whose markers sit in different nodes', () => {
    const root = render('<p>{--weg <em>und</em> fort--}</p>');
    expect(root.textContent).toBe('weg und fort');
    expect(root.querySelectorAll('.sn-critic-deletion').length).toBeGreaterThan(0);
  });

  it('styles every slice of a multi-node quote', () => {
    const root = render('<p>{==a<em>b</em>c==}</p>');
    expect(root.textContent).toBe('abc');
    const styled = [...root.querySelectorAll('.sn-critic-highlight')]
      .map((el) => el.textContent)
      .join('');
    expect(styled).toBe('abc');
  });
});

describe('renderCriticMarkup — several entries at once', () => {
  it('renders three constructs on one line without disturbing each other', () => {
    const root = render('<p>{--a--} und {++b++} und {~~c~>d~~}</p>');
    expect(root.textContent).toBe('a und b und cd');
  });

  it('renders constructs in separate paragraphs', () => {
    const root = render('<p>Erste {--weg--}.</p><p>Zweite {++neu++}.</p>');
    expect(root.textContent).toBe('Erste weg.Zweite neu.');
  });

  it('does not join a construct across two paragraphs', () => {
    // The opening marker never finds its close, so both stay literal.
    const root = render('<p>Erste {--offen</p><p>Zweite --} zu.</p>');
    expect(root.textContent).toBe('Erste {--offenZweite --} zu.');
  });
});

describe('renderCriticMarkup — what it leaves alone', () => {
  it('leaves ordinary prose byte-for-byte untouched', () => {
    const html = '<p>Ganz normale <em>Prosa</em>.</p>';
    expect(render(html).innerHTML).toBe(html);
  });

  it('leaves an unterminated marker literal', () => {
    expect(textOf('<p>Sie {++ ging fort.</p>')).toBe('Sie {++ ging fort.');
  });

  it('leaves markup inside a code element alone', () => {
    expect(textOf('<p>Schreib <code>{--text--}</code> so.</p>')).toBe(
      'Schreib {--text--} so.'
    );
  });

  it('leaves markup inside a pre block alone', () => {
    expect(textOf('<pre><code>{++x++}</code></pre>')).toBe('{++x++}');
  });

  it('leaves a rendered mark element alone — a lone highlight is not an entry', () => {
    const root = render('<p>Sie <mark>ging</mark> fort.</p>');
    expect(root.querySelector('mark')?.textContent).toBe('ging');
    expect(root.querySelector('.sn-critic-highlight')).toBeNull();
  });

  it('renders markup inside a list item and a heading', () => {
    expect(textOf('<ul><li>Punkt {--weg--}</li></ul>')).toBe('Punkt weg');
    expect(textOf('<h2>Titel {++neu++}</h2>')).toBe('Titel neu');
  });

  it('renders markup inside a blockquote', () => {
    expect(textOf('<blockquote><p>Zitat {==wichtig==}</p></blockquote>')).toBe(
      'Zitat wichtig'
    );
  });
});
