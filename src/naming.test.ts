import {
  parseItemName,
  buildName,
  displayTitle,
  compareItems,
  computeRenamePlan,
  fullNameOf,
  makeTempName,
  isTempName,
  recoverTempName,
  UNTITLED,
  type PlanItem,
} from './naming';

// The arbiter for the two discrimination rules in parseItemName: the dash guard
// and the segment cap. Tune the rules against this table, not the other way round.
describe('parseItemName', () => {
  const cases: Array<[string, string | null, string]> = [
    // name                      number        title
    ['1 – Die Preisverleihung',  '1',          'Die Preisverleihung'],
    ['1 Kapitel',                '1',          'Kapitel'],
    ['1-Kapitel',                '1',          'Kapitel'],
    ['10 - Zehn',                '10',         'Zehn'],
    ['100 – Lang',               '100',        'Lang'],
    ['1.2 – Szene',              '1.2',        'Szene'],
    ['1.2.3 – Szene',            '1.2.3',      'Szene'],
    ['1 -Titel',                 '1',          'Titel'],
    ['3',                        '3',          ''],
    ['1.2',                      '1.2',        ''],
    ['1 – ',                     '1',          ''],
    ['Anhang',                   null,         'Anhang'],
    ['– Intro',                  null,         '– Intro'],
    ['Kapitel 1 - Der Anfang',   null,         'Kapitel 1 - Der Anfang'],
    ['2025-01-01 Journal',       null,         '2025-01-01 Journal'],
    ['2026.04.12',               null,         '2026.04.12'],
    ['1.md',                     null,         '1.md'],
  ];

  it.each(cases)('parses %j', (name, number, title) => {
    const parsed = parseItemName(name);
    expect(parsed.number).toBe(number);
    expect(parsed.title).toBe(title);
  });

  it('keeps a bare dash as a separator only when the title is not a digit', () => {
    // "1-Kapitel" is chapter 1; "2025-01-01 Journal" is a date, not chapter 2025.
    expect(parseItemName('1-Kapitel').number).toBe('1');
    expect(parseItemName('2025-01-01 Journal').number).toBeNull();
  });

  it('caps number-only names at two segments so dot-dates keep their name', () => {
    // Without the cap, unifying the parsers would swallow "2026.04.12" whole and
    // render a badge with no title at all.
    expect(parseItemName('1.2').number).toBe('1.2');
    expect(parseItemName('2026.04.12').number).toBeNull();
    expect(parseItemName('2026.04.12').title).toBe('2026.04.12');
  });

  it('applies the cap only when no separator and title follow', () => {
    expect(parseItemName('1.2.3 – Szene').number).toBe('1.2.3');
  });
});

describe('buildName', () => {
  it('preserves the dash the user chose and normalises spacing', () => {
    expect(buildName(2, parseItemName('1 – Titel'))).toBe('2 – Titel');
    expect(buildName(2, parseItemName('1 - Titel'))).toBe('2 - Titel');
    expect(buildName(2, parseItemName('1 -Titel'))).toBe('2 - Titel');
    expect(buildName(2, parseItemName('1-Titel'))).toBe('2 - Titel');
  });

  it('preserves a space-only separator', () => {
    expect(buildName(2, parseItemName('1 Kapitel'))).toBe('2 Kapitel');
  });

  it('gives a newly numbered item the default separator', () => {
    expect(buildName(3, parseItemName('Anhang'))).toBe('3 – Anhang');
  });

  it('emits a bare number for number-only names', () => {
    expect(buildName(4, parseItemName('3'))).toBe('4');
    expect(buildName(4, parseItemName('1 – '))).toBe('4');
  });
});

describe('displayTitle', () => {
  it('never repeats the number the badge already shows', () => {
    expect(displayTitle(parseItemName('3'))).toEqual({ text: UNTITLED, isUntitled: true });
  });

  it('returns the title for numbered names', () => {
    expect(displayTitle(parseItemName('1 – Prolog'))).toEqual({
      text: 'Prolog',
      isUntitled: false,
    });
  });

  it('returns the whole name for unnumbered names', () => {
    expect(displayTitle(parseItemName('Anhang'))).toEqual({
      text: 'Anhang',
      isUntitled: false,
    });
  });
});

describe('compareItems', () => {
  const sortNames = (names: string[], isFolder = false) =>
    names.map(n => ({ name: n, isFolder })).sort(compareItems).map(i => i.name);

  it('sorts numerically, not lexically', () => {
    expect(sortNames(['10 – X', '9 – Y', '1 – Z'])).toEqual(['1 – Z', '9 – Y', '10 – X']);
  });

  it('sorts dotted numbers segment-wise', () => {
    expect(sortNames(['1.10 – B', '1.9 – A', '1 – Z'])).toEqual([
      '1 – Z',
      '1.9 – A',
      '1.10 – B',
    ]);
  });

  it('puts unnumbered items last', () => {
    expect(sortNames(['Anhang', '2 – B', '– Intro', '1 – A'])).toEqual([
      '1 – A',
      '2 – B',
      '– Intro',
      'Anhang',
    ]);
  });

  it('puts folders before files', () => {
    const items = [
      { name: '1 – Note', isFolder: false },
      { name: '9 – Chapter', isFolder: true },
    ];
    expect(items.sort(compareItems).map(i => i.name)).toEqual(['9 – Chapter', '1 – Note']);
  });
});

// ─── computeRenamePlan ────────────────────────────────────────────────────────

const file = (name: string): PlanItem => ({ name, extension: 'md', isFolder: false });
const dir = (name: string): PlanItem => ({ name, extension: '', isFolder: true });

const siblingsOf = (items: PlanItem[]) => items.map(fullNameOf);

const plan = (
  items: PlanItem[],
  draggedName: string,
  targetName: string,
  insertBefore: boolean,
  siblingNames = siblingsOf(items)
) => computeRenamePlan({ items, siblingNames, draggedName, targetName, insertBefore });

const renames = (result: ReturnType<typeof plan>) => {
  if (!result.ok) throw new Error(`expected a plan, got: ${result.reason}`);
  return result.ops.map(op => `${fullNameOf(op.item)} -> ${op.newFullName}`);
};

describe('computeRenamePlan', () => {
  it('renumbers only the numbered items and leaves unnumbered ones untouched', () => {
    const items = [file('1 – A'), file('2 – B'), file('3 – C'), file('Anhang'), file('Notizen')];
    // Move C to the top.
    expect(renames(plan(items, '3 – C', '1 – A', true))).toEqual([
      '3 – C.md -> 1 – C.md',
      '1 – A.md -> 2 – A.md',
      '2 – B.md -> 3 – B.md',
    ]);
  });

  it('does not touch unnumbered items when they are only bystanders', () => {
    const items = [file('1 – A'), file('2 – B'), file('Anhang'), file('2025-01-01 Journal')];
    const ops = renames(plan(items, '2 – B', '1 – A', true));
    expect(ops.join(' ')).not.toContain('Anhang');
    expect(ops.join(' ')).not.toContain('Journal');
  });

  it('numbers an unnumbered item dragged into the numbered run', () => {
    const items = [file('1 – A'), file('2 – B'), file('Anhang')];
    expect(renames(plan(items, 'Anhang', '2 – B', true))).toEqual([
      'Anhang.md -> 2 – Anhang.md',
      '2 – B.md -> 3 – B.md',
    ]);
  });

  it('numbers an unnumbered item dropped directly below the numbered run', () => {
    const items = [file('1 – A'), file('2 – B'), file('Anhang')];
    expect(renames(plan(items, 'Anhang', '2 – B', false))).toEqual([
      'Anhang.md -> 3 – Anhang.md',
    ]);
  });

  it('is a no-op when an unnumbered item is dragged deeper into the tail', () => {
    const items = [file('1 – A'), file('Anhang'), file('Notizen'), file('Skizzen')];
    // Skizzen below Notizen — both already in the unnumbered tail, nothing to renumber.
    expect(renames(plan(items, 'Skizzen', 'Notizen', false))).toEqual([]);
  });

  it('keeps a numbered item numbered when dropped past the numbered run', () => {
    const items = [file('1 – A'), file('2 – B'), file('3 – C'), file('Anhang')];
    expect(renames(plan(items, '1 – A', 'Anhang', false))).toEqual([
      '2 – B.md -> 1 – B.md',
      '3 – C.md -> 2 – C.md',
      '1 – A.md -> 3 – A.md',
    ]);
  });

  it('rejects a cross-group drop instead of mixing sequences', () => {
    const items = [dir('1 – Teil'), file('1 – Szene')];
    const result = plan(items, '1 – Szene', '1 – Teil', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/separately/i);
  });

  it('numbers folders and files as independent sequences', () => {
    const items = [dir('1 – Teil'), dir('2 – Zwei'), file('1 – Szene'), file('2 – Zwo')];
    // Reordering the folders must not renumber the files.
    const ops = renames(plan(items, '2 – Zwei', '1 – Teil', true));
    expect(ops).toEqual(['2 – Zwei -> 1 – Zwei', '1 – Teil -> 2 – Teil']);
  });

  it('rejects a plan that would collide with a hidden or non-markdown sibling', () => {
    const items = [file('1 – A'), file('2 – B')];
    const result = plan(items, '2 – B', '1 – A', true, [
      '1 – A.md',
      '2 – B.md',
      '1 – B.md', // an invisible sibling already owns the target name
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('1 – B.md');
  });

  it('allows a plan whose targets are only held by items it renames away', () => {
    const items = [file('1 – A'), file('2 – B')];
    expect(plan(items, '2 – B', '1 – A', true).ok).toBe(true);
  });

  it('emits nothing when the order does not change', () => {
    const items = [file('1 – A'), file('2 – B'), file('3 – C')];
    expect(renames(plan(items, '2 – B', '1 – A', false))).toEqual([]);
  });

  it('rejects a drag whose item has vanished', () => {
    const items = [file('1 – A')];
    expect(plan(items, 'Ghost', '1 – A', true).ok).toBe(false);
  });

  it('renumbers folders without an extension suffix', () => {
    const items = [dir('1 – Eins'), dir('2 – Zwei')];
    expect(renames(plan(items, '2 – Zwei', '1 – Eins', true))).toEqual([
      '2 – Zwei -> 1 – Zwei',
      '1 – Eins -> 2 – Eins',
    ]);
  });
});

describe('temp names', () => {
  it('round-trips a name through the temp prefix', () => {
    const temp = makeTempName('ab12cd34', '2 – Titel.md');
    expect(isTempName(temp)).toBe(true);
    expect(recoverTempName(temp)).toBe('2 – Titel.md');
  });

  it('does not eat underscores in the recovered name', () => {
    // A greedy /^__sn_.*_/ would strip through the last underscore and leave "File.md".
    expect(recoverTempName('__sn_ab12cd34_2 – My_File.md')).toBe('2 – My_File.md');
  });

  it('ignores names that only look similar', () => {
    expect(isTempName('__sn__leading.md')).toBe(false);
    expect(recoverTempName('2 – Titel.md')).toBeNull();
    expect(recoverTempName('__sn_ab12_')).toBeNull();
  });
});
