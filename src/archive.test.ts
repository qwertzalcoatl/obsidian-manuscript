import {
  appendEntry,
  archivePathFor,
  expandToMarks,
  newArchive,
  originLink,
  timestamp,
} from './archive';

describe('archivePathFor', () => {
  it('mirrors the origin path under the archive root', () => {
    expect(archivePathFor('Manuskript/Kapitel 3/3 – Die Nachricht.md', 'Archiv')).toBe(
      'Archiv/Manuskript/Kapitel 3/3 – Die Nachricht.md'
    );
  });

  it('mirrors a note sitting at the vault root', () => {
    expect(archivePathFor('3 – Die Nachricht.md', 'Archiv')).toBe(
      'Archiv/3 – Die Nachricht.md'
    );
  });

  it('tolerates a trailing slash on the configured root', () => {
    // The setting is free text, so both spellings arrive.
    expect(archivePathFor('Kapitel 3/3.md', 'Archiv/')).toBe('Archiv/Kapitel 3/3.md');
  });

  it('accepts an archive root that is itself nested', () => {
    expect(archivePathFor('Kapitel 3/3.md', 'Material/Archiv')).toBe(
      'Material/Archiv/Kapitel 3/3.md'
    );
  });

  it('keeps two notes of the same name apart', () => {
    // The reason the mirror exists: the README documents bare `3.md`, and a
    // flat archive would put these two in the same place.
    expect(archivePathFor('Kapitel 7/3.md', 'Archiv')).not.toBe(
      archivePathFor('Kapitel 9/3.md', 'Archiv')
    );
  });
});

describe('originLink', () => {
  it('writes the full vault path as a wikilink', () => {
    // The full path, not the basename: `[[3]]` is ambiguous in a vault holding
    // several `3.md` and would resolve to whichever one sits nearest.
    expect(originLink('Manuskript/Kapitel 3/3 – Die Nachricht.md')).toBe(
      '[[Manuskript/Kapitel 3/3 – Die Nachricht]]'
    );
  });

  it('links a note at the vault root', () => {
    expect(originLink('3 – Die Nachricht.md')).toBe('[[3 – Die Nachricht]]');
  });

  it('strips only the trailing extension', () => {
    expect(originLink('Kapitel/1.2 – Szene.md')).toBe('[[Kapitel/1.2 – Szene]]');
  });
});

describe('timestamp', () => {
  it('renders ISO date and 24-hour time', () => {
    expect(timestamp(new Date(2026, 7, 12, 14, 32))).toBe('2026-08-12 14:32');
  });

  it('pads single-digit months, days, hours and minutes', () => {
    expect(timestamp(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05 09:07');
  });
});

describe('newArchive', () => {
  it('opens the file with frontmatter and the first entry', () => {
    expect(newArchive('[[Kapitel 3/3 – Die Nachricht]]', '2026-08-12 14:32', 'Der Absatz.')).toBe(
      '---\norigin: "[[Kapitel 3/3 – Die Nachricht]]"\n---\n\n## 2026-08-12 14:32\n\nDer Absatz.\n'
    );
  });

  it('trims the archived text', () => {
    // A selection usually carries the newline that ended the paragraph.
    const file = newArchive('[[K]]', '2026-08-12 14:32', '\n  Der Absatz.  \n\n');
    expect(file).toBe('---\norigin: "[[K]]"\n---\n\n## 2026-08-12 14:32\n\nDer Absatz.\n');
  });

  it('escapes a quote in the link so the YAML stays valid', () => {
    expect(newArchive('[[Kapitel/Er sagte "nein"]]', '2026-08-12 14:32', 'x')).toContain(
      'origin: "[[Kapitel/Er sagte \\"nein\\"]]"'
    );
  });
});

describe('appendEntry', () => {
  const existing = '---\norigin: "[[K]]"\n---\n\n## 2026-08-12 14:32\n\nDer erste.\n';

  it('adds an entry under one blank line', () => {
    expect(appendEntry(existing, '2026-08-12 16:05', 'Der zweite.')).toBe(
      existing + '\n## 2026-08-12 16:05\n\nDer zweite.\n'
    );
  });

  it('separates entries when the body does not end in a newline', () => {
    // Hand-edited files do this, and without the fix the heading would land on
    // the same line as the last word of the previous entry.
    const result = appendEntry(existing.trimEnd(), '2026-08-12 16:05', 'Der zweite.');
    expect(result).toBe(existing + '\n## 2026-08-12 16:05\n\nDer zweite.\n');
  });

  it('collapses a run of trailing blank lines to one separator', () => {
    const result = appendEntry(existing + '\n\n\n', '2026-08-12 16:05', 'Der zweite.');
    expect(result).toBe(existing + '\n## 2026-08-12 16:05\n\nDer zweite.\n');
  });

  it('leaves everything already in the file untouched', () => {
    // The whole promise of the feature, asserted directly.
    expect(appendEntry(existing, '2026-08-12 16:05', 'Der zweite.')).toContain(existing);
  });
});

describe('expandToMarks', () => {
  it('leaves a selection in unmarked prose alone', () => {
    const content = 'Er ging nach Hause und schwieg.';
    expect(expandToMarks(content, 3, 12)).toEqual({ from: 3, to: 12 });
  });

  it('leaves a selection that already contains a whole mark alone', () => {
    const content = 'Er ging {++schnell++} nach Hause.';
    expect(expandToMarks(content, 0, content.length)).toEqual({
      from: 0,
      to: content.length,
    });
  });

  it('reaches back when the selection opens inside a mark', () => {
    const content = 'Er ging {++schnell nach Hause++} und schwieg.';
    const result = expandToMarks(content, content.indexOf('nach'), content.length);
    expect(result).toEqual({ from: content.indexOf('{++'), to: content.length });
  });

  it('reaches forward when the selection closes inside a mark', () => {
    const content = 'Er ging {++schnell nach Hause++} und schwieg.';
    const result = expandToMarks(content, 0, content.indexOf('nach'));
    expect(result).toEqual({ from: 0, to: content.indexOf('++}') + 3 });
  });

  it('reaches both ways when the selection cuts two marks', () => {
    const content = 'Er {--ging schnell--} nach Hause und {++schwieg lange++} danach.';
    const result = expandToMarks(
      content,
      content.indexOf('schnell'),
      content.indexOf('lange')
    );
    expect(result).toEqual({
      from: content.indexOf('{--'),
      to: content.indexOf('++}') + 3,
    });
  });

  it('takes an attached comment with the mark it belongs to', () => {
    // parseCritic reports `to` past the comment, so the note travels with the
    // decision it annotates rather than being left behind anchored to nothing.
    const content = 'Er ging {--zu spät--}{>>wirklich?<<} weiter.';
    const result = expandToMarks(content, 0, content.indexOf('spät'));
    expect(result).toEqual({ from: 0, to: content.indexOf('<<}') + 3 });
  });

  it('does not expand for a mark the selection merely touches', () => {
    // Ending exactly where a construct begins is adjacency, not a split.
    const content = 'Er ging {++schnell++} nach Hause.';
    const start = content.indexOf('{++');
    expect(expandToMarks(content, 0, start)).toEqual({ from: 0, to: start });
  });
});
