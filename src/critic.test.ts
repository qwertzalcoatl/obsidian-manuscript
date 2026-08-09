import {
  parseCritic,
  applyEntry,
  renderAccepted,
  renderRejected,
  type Entry,
} from './critic';

/** Parses and asserts a single entry came back, returning it. */
function one(content: string): Entry {
  const entries = parseCritic(content);
  expect(entries).toHaveLength(1);
  return entries[0];
}

describe('parseCritic — the five constructs', () => {
  it('reads an insertion', () => {
    const e = one('Sie {++leise ++}öffnete die Tür.');
    expect(e.kind).toBe('insertion');
    expect(e.quote).toBe('leise ');
    expect(e.comment).toBeNull();
  });

  it('reads a deletion', () => {
    const e = one('Sie öffnete die Tür {--und trat ein--}.');
    expect(e.kind).toBe('deletion');
    expect(e.quote).toBe('und trat ein');
  });

  it('reads a substitution, splitting on the first arrow', () => {
    const e = one('Das {~~kalte~>fahle~~} Licht.');
    expect(e.kind).toBe('substitution');
    expect(e.quote).toBe('kalte');
    expect(e.replacement).toBe('fahle');
  });

  it('splits a substitution on the FIRST arrow only', () => {
    const e = one('{~~a~>b~>c~~}');
    expect(e.quote).toBe('a');
    expect(e.replacement).toBe('b~>c');
  });

  it('treats a substitution with no arrow as a deletion', () => {
    const e = one('{~~verschwindet~~}');
    expect(e.kind).toBe('deletion');
    expect(e.quote).toBe('verschwindet');
  });

  it('reads a highlight', () => {
    const e = one('Sie {==öffnete die Tür==} und trat ein.');
    expect(e.kind).toBe('highlight');
    expect(e.quote).toBe('öffnete die Tür');
    expect(e.comment).toBeNull();
  });

  it('reads a standalone comment with its line as context', () => {
    const e = one('Er zögerte am Fenster. {>>Mehr Spannung<<}');
    expect(e.kind).toBe('comment');
    expect(e.quote).toBe('');
    expect(e.comment).toBe('Mehr Spannung');
    expect(e.line).toBe('Er zögerte am Fenster. {>>Mehr Spannung<<}');
  });

  it('returns entries in document order', () => {
    const kinds = parseCritic('{>>a<<} {++b++} {--c--}').map((e) => e.kind);
    expect(kinds).toEqual(['comment', 'insertion', 'deletion']);
  });
});

describe('parseCritic — comment attachment', () => {
  it('attaches a comment that immediately follows a construct', () => {
    const e = one('Sie {==öffnete die Tür==}{>>zu abrupt?<<} und trat ein.');
    expect(e.kind).toBe('highlight');
    expect(e.quote).toBe('öffnete die Tür');
    expect(e.comment).toBe('zu abrupt?');
  });

  it('attaches across spaces and tabs', () => {
    expect(one('{--weg--} \t {>>warum<<}').comment).toBe('warum');
  });

  it('does NOT attach across a newline', () => {
    const entries = parseCritic('{--weg--}\n{>>warum<<}');
    expect(entries).toHaveLength(2);
    expect(entries[0].comment).toBeNull();
    expect(entries[1].kind).toBe('comment');
  });

  it('spans the attached comment in the entry range', () => {
    const src = '{==x==}{>>c<<}';
    const e = one(src);
    expect(src.slice(e.from, e.to)).toBe(src);
  });

  it('attaches a comment to a deletion and to a substitution', () => {
    expect(one('{--a--}{>>c<<}').comment).toBe('c');
    expect(one('{~~a~>b~~}{>>c<<}').comment).toBe('c');
  });
});

describe('parseCritic — Obsidian native syntax', () => {
  it('reads a bare %%comment%%', () => {
    const e = one('Er zögerte. %%Mehr Spannung nötig%%');
    expect(e.kind).toBe('comment');
    expect(e.comment).toBe('Mehr Spannung nötig');
    expect(e.native).toBe(true);
  });

  it('reads ==text==%%comment%% as a commented highlight', () => {
    const e = one('Sie ==öffnete die Tür==%%zu abrupt?%% und trat ein.');
    expect(e.kind).toBe('highlight');
    expect(e.quote).toBe('öffnete die Tür');
    expect(e.comment).toBe('zu abrupt?');
    expect(e.native).toBe(true);
  });

  it('ignores a lone ==highlight== with no comment', () => {
    expect(parseCritic('Sie ==öffnete die Tür== und trat ein.')).toEqual([]);
  });

  it('ignores every lone highlight even alongside a real entry', () => {
    const entries = parseCritic('==eins== und ==zwei== und {>>echt<<}');
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('comment');
  });

  it('does not double-count the == inside a CriticMarkup highlight', () => {
    const entries = parseCritic('{==text==}');
    expect(entries).toHaveLength(1);
    expect(entries[0].native).toBe(false);
  });

  it('does not mistake == inside another construct for a highlight', () => {
    const e = one('{~~Türe~>Tür==Rest==~~}%%c%%');
    expect(e.kind).toBe('substitution');
    expect(e.replacement).toBe('Tür==Rest==');
  });

  it('lets a native comment attach to a CriticMarkup construct', () => {
    const e = one('{--weg--}%%warum%%');
    expect(e.kind).toBe('deletion');
    expect(e.comment).toBe('warum');
    expect(e.native).toBe(false);
  });
});

describe('parseCritic — tolerance', () => {
  it('leaves an unterminated marker completely alone', () => {
    expect(parseCritic('Sie {++ öffnete die Tür und trat ein.')).toEqual([]);
    expect(parseCritic('Ein {>> Kommentar ohne Ende')).toEqual([]);
  });

  it('does not let an unterminated marker swallow a later valid one', () => {
    const entries = parseCritic('{++ offen\n\n{--echt--}');
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('deletion');
  });

  it('trims whitespace from comment bodies but never from quotes', () => {
    const e = one('{==  gesperrt  ==}{>>   viel Luft   <<}');
    expect(e.comment).toBe('viel Luft');
    expect(e.quote).toBe('  gesperrt  ');
  });

  it('reads a comment body spanning several lines', () => {
    const e = one('{>>erste Zeile\nzweite Zeile<<}');
    expect(e.comment).toBe('erste Zeile\nzweite Zeile');
  });

  it('reads two adjacent constructs as two entries, not a substitution', () => {
    const entries = parseCritic('{--alt--}{++neu++}');
    expect(entries.map((e) => e.kind)).toEqual(['deletion', 'insertion']);
  });

  it('handles an empty comment body', () => {
    expect(one('{==x==}{>><<}').comment).toBe('');
  });

  it('returns nothing for a note with no markup', () => {
    expect(parseCritic('Ganz normale Prosa ohne Auszeichnung.')).toEqual([]);
  });
});

describe('parseCritic — code and frontmatter are not markup', () => {
  it('ignores a construct inside a fenced block', () => {
    expect(parseCritic('```\n{--text--}\n```')).toEqual([]);
  });

  it('ignores a construct inside a fence with an info string', () => {
    expect(parseCritic('```js\n{++x++}\n```')).toEqual([]);
  });

  it('ignores a construct inside a tilde fence', () => {
    expect(parseCritic('~~~\n{>>c<<}\n~~~')).toEqual([]);
  });

  it('still reads markup outside a fenced block', () => {
    const entries = parseCritic('{--echt--}\n\n```\n{--fake--}\n```\n\n{>>auch echt<<}');
    expect(entries.map((e) => e.kind)).toEqual(['deletion', 'comment']);
  });

  it('ignores a construct inside inline code', () => {
    expect(parseCritic('Schreib `{--text--}` so.')).toEqual([]);
  });

  it('ignores a construct inside a double-backtick span', () => {
    expect(parseCritic('``ein {>>c<<} span``')).toEqual([]);
  });

  it('ignores markup inside frontmatter', () => {
    expect(parseCritic('---\ntitle: {>>nicht echt<<}\n---\n\nProsa.')).toEqual([]);
  });

  it('reads markup in the body of a note that has frontmatter', () => {
    const e = one('---\ntitle: Test\n---\n\nSie {--ging--}.');
    expect(e.kind).toBe('deletion');
    expect(e.quote).toBe('ging');
  });

  it('treats an unclosed fence as running to the end of the note', () => {
    expect(parseCritic('Prosa.\n\n```\n{--text--}')).toEqual([]);
  });
});

describe('applyEntry', () => {
  const run = (src: string, mode: 'accept' | 'reject' | 'resolve') =>
    applyEntry(src, one(src), mode);

  it('accepts an insertion by keeping the text', () => {
    expect(run('Sie {++leise ++}ging.', 'accept')).toBe('Sie leise ging.');
  });

  it('rejects an insertion by dropping it', () => {
    expect(run('Sie {++leise ++}ging.', 'reject')).toBe('Sie ging.');
  });

  it('accepts a deletion by removing the text', () => {
    expect(run('Sie ging{-- fort--}.', 'accept')).toBe('Sie ging.');
  });

  it('rejects a deletion by keeping the text', () => {
    expect(run('Sie ging{-- fort--}.', 'reject')).toBe('Sie ging fort.');
  });

  it('accepts a substitution by writing the replacement', () => {
    expect(run('Das {~~kalte~>fahle~~} Licht.', 'accept')).toBe('Das fahle Licht.');
  });

  it('rejects a substitution by keeping the original', () => {
    expect(run('Das {~~kalte~>fahle~~} Licht.', 'reject')).toBe('Das kalte Licht.');
  });

  it('resolves a highlight by unwrapping it', () => {
    expect(run('Sie {==ging==} fort.', 'resolve')).toBe('Sie ging fort.');
  });

  it('resolves a comment by deleting it', () => {
    expect(run('Sie ging fort. {>>zu schnell<<}', 'resolve')).toBe('Sie ging fort. ');
  });

  it('takes the attached comment with it in every mode', () => {
    expect(run('Sie {==ging==}{>>warum?<<} fort.', 'resolve')).toBe('Sie ging fort.');
    expect(run('Sie {--ging--}{>>warum?<<} fort.', 'reject')).toBe('Sie ging fort.');
    expect(run('Sie {--ging--}{>>warum?<<} fort.', 'accept')).toBe('Sie  fort.');
  });

  it('resolves a native commented highlight', () => {
    expect(run('Sie ==ging==%%warum?%% fort.', 'resolve')).toBe('Sie ging fort.');
  });

  // A suggestion has two possible outcomes, so "resolve" is ambiguous and
  // guessing would silently rewrite a manuscript. An annotation has exactly
  // one outcome, so the mode cannot change the answer.
  it('refuses to resolve a suggestion rather than guessing', () => {
    expect(() => run('{--weg--}', 'resolve')).toThrow(/Cannot resolve a deletion/);
    expect(() => run('{++neu++}', 'resolve')).toThrow(/Cannot resolve an? insertion/);
    expect(() => run('{~~a~>b~~}', 'resolve')).toThrow(/Cannot resolve a substitution/);
  });

  it('gives annotations the same outcome whatever the mode', () => {
    expect(run('Sie {==ging==} fort.', 'accept')).toBe('Sie ging fort.');
    expect(run('Sie {==ging==} fort.', 'reject')).toBe('Sie ging fort.');
    expect(run('Sie ging. {>>c<<}', 'accept')).toBe('Sie ging. ');
    expect(run('Sie ging. {>>c<<}', 'reject')).toBe('Sie ging. ');
  });

  it('removes the whole line when the entry was alone on it', () => {
    expect(applyEntry('Vorher.\n{>>Notiz<<}\nNachher.', one('Vorher.\n{>>Notiz<<}\nNachher.'), 'resolve'))
      .toBe('Vorher.\nNachher.');
  });

  it('removes a trailing own-line entry without leaving a blank line', () => {
    const src = 'Vorher.\n{>>Notiz<<}';
    expect(applyEntry(src, one(src), 'resolve')).toBe('Vorher.');
  });

  it('keeps the line when other text shares it', () => {
    const src = 'Vorher. {>>Notiz<<}\nNachher.';
    expect(applyEntry(src, one(src), 'resolve')).toBe('Vorher. \nNachher.');
  });
});

describe('renderAccepted / renderRejected', () => {
  const mixed =
    'Sie {++leise ++}öffnete die {~~Türe~>Tür~~} und ' +
    '{--trat ein--}. Das {==fahle Licht==}{>>Wiederholung<<} fiel herein. ' +
    '%%Szene kürzen%%';

  it('accepts everything', () => {
    expect(renderAccepted(mixed)).toBe(
      'Sie leise öffnete die Tür und . Das fahle Licht fiel herein. '
    );
  });

  it('rejects everything', () => {
    expect(renderRejected(mixed)).toBe(
      'Sie öffnete die Türe und trat ein. Das fahle Licht fiel herein. '
    );
  });

  // Whitespace left behind by a resolved construct is the author's to tidy.
  // Guessing at it would be its own way to corrupt a manuscript.
  it('does not tidy whitespace around what it removed', () => {
    expect(renderAccepted('Sie ging {--fort--} heute.')).toBe('Sie ging  heute.');
  });

  it('drops annotations in both directions', () => {
    const src = 'a {==b==} c {>>d<<} e';
    expect(renderAccepted(src)).toBe('a b c  e');
    expect(renderRejected(src)).toBe('a b c  e');
  });

  it('leaves a clean note untouched', () => {
    const clean = 'Ganz normale Prosa.\n\nZweiter Absatz.';
    expect(renderAccepted(clean)).toBe(clean);
    expect(renderRejected(clean)).toBe(clean);
  });

  it('leaves code and frontmatter untouched', () => {
    const src = '---\nt: {--x--}\n---\n\n```\n{++y++}\n```\n\n`{>>z<<}`';
    expect(renderAccepted(src)).toBe(src);
  });

  it('collapses lines that markup emptied', () => {
    expect(renderAccepted('Erste.\n{>>Notiz<<}\nZweite.')).toBe('Erste.\nZweite.');
  });

  it('handles several entries on one line', () => {
    expect(renderAccepted('{--a--} und {--b--} und {++c++}')).toBe(' und  und c');
  });

  it('is idempotent — rendering an already-clean result changes nothing', () => {
    const once = renderAccepted(mixed);
    expect(renderAccepted(once)).toBe(once);
  });
});
