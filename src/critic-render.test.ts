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
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('leise ');
  });

  it('renders a deletion', () => {
    const root = render('<p>Sie ging{-- fort--}.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.ms-critic-deletion')?.textContent).toBe(' fort');
  });

  it('renders a substitution as struck old followed by new', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    expect(root.textContent).toBe('Das kalte→fahle Licht.');
    expect(root.querySelector('.ms-critic-deletion')?.textContent).toBe('kalte');
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('fahle');
  });

  it('renders a highlight', () => {
    const root = render('<p>Sie {==ging==} fort.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.ms-critic-highlight')?.textContent).toBe('ging');
  });

  it('removes a standalone comment entirely', () => {
    const root = render('<p>Er zögerte. {>>Mehr Spannung<<}</p>');
    expect(root.textContent).toBe('Er zögerte. ');
    expect(root.querySelector('.ms-critic-glyph')).toBeNull();
  });

  it('keeps the anchor and removes an attached comment', () => {
    const root = render('<p>Sie {==ging==}{>>zu abrupt?<<} fort.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.ms-critic-highlight')?.textContent).toBe('ging');
    expect(root.querySelector('.ms-critic-glyph')).toBeNull();
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
    expect(root.querySelectorAll('.ms-critic-deletion').length).toBeGreaterThan(0);
  });

  it('styles every slice of a multi-node quote', () => {
    const root = render('<p>{==a<em>b</em>c==}</p>');
    expect(root.textContent).toBe('abc');
    const styled = [...root.querySelectorAll('.ms-critic-highlight')]
      .map((el) => el.textContent)
      .join('');
    expect(styled).toBe('abc');
  });
});

describe('renderCriticMarkup — several entries at once', () => {
  it('renders three constructs on one line without disturbing each other', () => {
    const root = render('<p>{--a--} und {++b++} und {~~c~>d~~}</p>');
    expect(root.textContent).toBe('a und b und c→d');
  });

  it('renders constructs in separate paragraphs', () => {
    const root = render('<p>Erste {--weg--}.</p><p>Zweite {++neu++}.</p>');
    expect(root.textContent).toBe('Erste weg.Zweite neu.');
  });

  // The parser is given one block at a time and cannot pair the two markers, so
  // it styles neither — but it hides both, because a brace shown to a reader is
  // worse than a passage left unstyled. Supplying the note's source is what lets
  // the passage be styled as well; see the SectionSource cases below.
  it('hides both markers of a mark it cannot pair across two paragraphs', () => {
    const root = render('<p>Erste {--offen</p><p>Zweite --} zu.</p>');
    expect(root.textContent).toBe('Erste offenZweite  zu.');
  });
});

describe('renderCriticMarkup — what it leaves alone', () => {
  it('leaves ordinary prose byte-for-byte untouched', () => {
    const html = '<p>Ganz normale <em>Prosa</em>.</p>';
    expect(render(html).innerHTML).toBe(html);
  });

  // It used to stay literal, which was the silent failure: braces that do not
  // parse look exactly like braces the writer meant. The prose is untouched;
  // only the marker goes. The drawer is where the writer is told why.
  it('hides an unterminated marker and keeps the prose', () => {
    expect(textOf('<p>Sie {++ ging fort.</p>')).toBe('Sie  ging fort.');
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
    expect(root.querySelector('.ms-critic-highlight')).toBeNull();
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

describe('renderCriticMarkup — a construct carrying a note', () => {
  it('marks the anchor of a commented deletion', () => {
    const root = render('<p>Sie {--ging--}{>>zu spät?<<} fort.</p>');
    expect(root.querySelector('.ms-critic-has-comment')?.textContent).toBe('ging');
  });

  it('leaves an uncommented deletion unmarked', () => {
    const root = render('<p>Sie {--ging--} fort.</p>');
    expect(root.querySelector('.ms-critic-has-comment')).toBeNull();
  });
});

describe('renderCriticMarkup — the substitution separator', () => {
  it('marks the replacement half of a substitution', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    const halves = root.querySelectorAll('.ms-critic-insertion');
    expect(halves).toHaveLength(1);
    expect(halves[0].textContent).toBe('fahle');
  });

  it('renders the arrow as its own element between the halves', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    expect(root.querySelector('.ms-critic-arrow')?.textContent).toBe('→');
    expect(root.textContent).toBe('Das kalte→fahle Licht.');
  });

  it('renders the arrow when the replacement is empty', () => {
    const root = render('<p>Das {~~kalte~>~~} Licht.</p>');
    expect(root.querySelector('.ms-critic-arrow')?.textContent).toBe('→');
  });

  it('draws no placeholder — a reader has nothing to type into', () => {
    const root = render('<p>Sie {++++}ging.</p>');
    expect(root.querySelector('.ms-critic-placeholder')).toBeNull();
    expect(root.textContent).toBe('Sie ging.');
  });

  it('leaves a plain insertion without an arrow', () => {
    const root = render('<p>Sie {++leise ++}ging.</p>');
    expect(root.querySelector('.ms-critic-arrow')).toBeNull();
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('leise ');
  });
});

describe('renderCriticMarkup — a mark that spans two blocks', () => {
  it('hides an unmatched marker rather than showing braces', () => {
    const root = render('<p>Sie ging{-- fort.</p><p>Der Regen--} blieb.</p>');
    expect(root.textContent).toBe('Sie ging fort.Der Regen blieb.');
  });

  it('leaves an unmatched marker inside code alone', () => {
    const root = render('<p>So schreibt man <code>{--</code> hin.</p>');
    expect(root.textContent).toBe('So schreibt man {-- hin.');
  });
});

describe('renderCriticMarkup — a mark inside a mark', () => {
  // The whole cut has to be struck through, not just the part before the mark
  // inside it. Anything less and a reader cannot see where the cut ends.
  it('strikes the whole cut, the mark inside it included', () => {
    const root = render('<p>{--Sie zählte {~~Dann~>Schließlich~~} Ende.--}</p>');
    expect(root.textContent).toBe('Sie zählte Dann→Schließlich Ende.');

    const outer = root.querySelector('.ms-critic-deletion');
    expect(outer?.textContent).toBe('Sie zählte Dann→Schließlich Ende.');
    expect(root.querySelectorAll('.ms-critic-insertion')).toHaveLength(1);
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('Schließlich');
    // And the replacement sits inside the cut, so it wears both treatments:
    // proposed wording that the cut would take away with it.
    expect(outer?.querySelector('.ms-critic-insertion')).not.toBeNull();
  });

  it('keeps every character of a nested highlight, and underlines all of it', () => {
    const root = render('<p>{++neu {==wichtig==} da++}</p>');
    expect(root.textContent).toBe('neu wichtig da');
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('neu wichtig da');
    expect(root.querySelector('.ms-critic-highlight')?.textContent).toBe('wichtig');
  });

  it('nests a mark that itself wraps inline markdown', () => {
    const root = render('<p>{--weg <strong>fett</strong> {++neu++} da--}</p>');
    expect(root.textContent).toBe('weg fett neu da');
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('neu');
  });
});
