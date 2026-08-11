/**
 * @jest-environment jsdom
 *
 * Drives the Live Preview StateField through a real CodeMirror state — no
 * editor view, but the decorations it produces are plain data, so what the
 * reader would see is checkable here rather than only by eye in Obsidian.
 *
 * The cursor-reveal rule is the one worth pinning: get it wrong and the
 * markup becomes uneditable by hand, which is a trap you only notice after
 * typing into a note and finding the braces gone.
 */

import { EditorState } from '@codemirror/state';
import {
  criticDecorations,
  criticField,
  flashEffect,
  flashField,
  flashRangesFor,
} from './critic-render';
import { parseCritic } from './critic';

interface Painted {
  from: number;
  to: number;
  /** The class a mark applies, or '' for a hidden/replaced range. */
  cls: string;
  text: string;
}

/** Every decoration the renderer produces for `doc`, with an optional cursor. */
function paint(doc: string, cursor?: number): Painted[] {
  const state = EditorState.create({
    doc,
    extensions: [criticField],
    ...(cursor === undefined ? {} : { selection: { anchor: cursor } }),
  });

  const out: Painted[] = [];
  criticDecorations(state).between(0, doc.length, (from, to, value) => {
    out.push({
      from,
      to,
      cls: (value.spec.class as string) ?? '',
      text: doc.slice(from, to),
    });
  });
  return out;
}

/** Text as the reader sees it: hidden and replaced ranges taken out. */
function visible(doc: string, cursor?: number): string {
  const removed = paint(doc, cursor).filter((d) => d.cls === '');
  let out = '';
  let at = 0;
  for (const r of removed.sort((a, b) => a.from - b.from)) {
    out += doc.slice(at, r.from);
    at = Math.max(at, r.to);
  }
  return out + doc.slice(at);
}

describe('Live Preview decorations — markers hidden, text styled', () => {
  it('hides an insertion\'s markers and underlines its text', () => {
    expect(visible('Sie {++leise ++}ging.')).toBe('Sie leise ging.');
    expect(paint('Sie {++leise ++}ging.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-insertion', text: 'leise ' })
    );
  });

  it('strikes a deletion', () => {
    expect(visible('Sie ging{-- fort--}.')).toBe('Sie ging fort.');
    expect(paint('Sie ging{-- fort--}.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-deletion', text: ' fort' })
    );
  });

  it('shows both halves of a substitution and hides the arrow', () => {
    const doc = 'Das {~~kalte~>fahle~~} Licht.';
    expect(visible(doc)).toBe('Das kaltefahle Licht.');
    const marks = paint(doc);
    expect(marks).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-deletion', text: 'kalte' })
    );
    expect(marks).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-insertion', text: 'fahle' })
    );
  });

  it('tints a highlight', () => {
    expect(paint('Sie {==ging==} fort.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-highlight', text: 'ging' })
    );
  });

  it('replaces a comment entirely, anchor and all', () => {
    expect(visible('Sie {==ging==}{>>warum?<<} fort.')).toBe('Sie ging fort.');
  });

  it('renders Obsidian\'s native commented highlight', () => {
    expect(visible('Sie ==ging==%%warum?%% fort.')).toBe('Sie ging fort.');
  });
});

describe('Live Preview decorations — native ~~ strikethrough is cancelled', () => {
  // {~~alt~>neu~~} contains a ~~ pair, which Obsidian's own Markdown parser
  // reads as ordinary strikethrough — striking arrow and replacement too.
  // The construct-wide mark is the hook styles.css uses to cancel that line.
  const doc = 'Das {~~kalte~>fahle~~} Licht.';

  it('marks the whole substitution, markers included', () => {
    expect(paint(doc)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-substitution', text: '{~~kalte~>fahle~~}' })
    );
  });

  it('keeps the construct mark while the cursor reveals the markup', () => {
    expect(paint(doc, 6)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-substitution', text: '{~~kalte~>fahle~~}' })
    );
  });

  it('does not mark other kinds, whose bodies Markdown leaves alone', () => {
    expect(paint('Sie {--ging--}.').map((d) => d.cls)).not.toContain('sn-critic-substitution');
  });
});

describe('Live Preview decorations — revealed markup stands apart from prose', () => {
  const doc = 'Sie {++leise ++}ging.';

  it('washes the whole construct while the cursor is inside', () => {
    expect(paint(doc, 8)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-revealed', text: '{++leise ++}' })
    );
  });

  it('adds no wash while the markup is folded away', () => {
    expect(paint(doc, 0).map((d) => d.cls)).not.toContain('sn-critic-revealed');
  });

  it('washes a revealed comment, braces and body alike', () => {
    const commented = 'Sie ging.{>>warum?<<}';
    expect(paint(commented, 12)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-revealed', text: '{>>warum?<<}' })
    );
  });
});

describe('Live Preview decorations — cursor reveals the raw markup', () => {
  const doc = 'Sie {++leise ++}ging.';

  it('hides markers when the cursor is elsewhere', () => {
    expect(visible(doc, 0)).toBe('Sie leise ging.');
  });

  it('shows markers when the cursor is inside the construct', () => {
    expect(visible(doc, 8)).toBe(doc);
  });

  it('shows markers when the cursor sits on either boundary', () => {
    expect(visible(doc, doc.indexOf('{++'))).toBe(doc);
    expect(visible(doc, doc.indexOf('++}') + 3)).toBe(doc);
  });

  it('keeps styling the text while revealed, so the edit stays legible', () => {
    expect(paint(doc, 8)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-insertion', text: 'leise ' })
    );
  });

  it('reveals only the construct the cursor is in', () => {
    const two = '{--a--} und {--b--}';
    expect(visible(two, 3)).toBe('{--a--} und b');
  });
});

describe('Live Preview decorations — what stays untouched', () => {
  it('leaves ordinary prose alone', () => {
    expect(paint('Ganz normale Prosa.')).toEqual([]);
  });

  it('leaves a lone highlight to Obsidian', () => {
    expect(paint('Sie ==ging== fort.')).toEqual([]);
  });

  it('leaves a fenced code block alone', () => {
    const doc = '```\n{--text--}\n```';
    expect(paint(doc)).toEqual([]);
    expect(visible(doc)).toBe(doc);
  });

  it('leaves an unterminated marker alone', () => {
    expect(paint('Sie {++ ging fort.')).toEqual([]);
  });
});

describe('Live Preview decorations — flash after a card click', () => {
  const doc = 'Sie {--ging--} fort.';

  const flashed = (state: EditorState) => {
    const out: Painted[] = [];
    state.field(flashField).between(0, state.doc.length, (from, to, value) => {
      out.push({
        from,
        to,
        cls: (value.spec.class as string) ?? '',
        text: state.doc.sliceString(from, to),
      });
    });
    return out;
  };

  const base = () => EditorState.create({ doc, extensions: [flashField] });

  it('starts with nothing flashed', () => {
    expect(flashed(base())).toEqual([]);
  });

  it('paints the flashed ranges', () => {
    const state = base().update({
      effects: flashEffect.of({ ranges: [{ from: 4, to: 14 }], key: 1 }),
    }).state;
    expect(flashed(state)).toEqual([
      expect.objectContaining({ cls: 'sn-critic-flash', text: '{--ging--}' }),
    ]);
  });

  it('replaces one flash with the next instead of stacking them', () => {
    const state = base()
      .update({ effects: flashEffect.of({ ranges: [{ from: 4, to: 14 }], key: 1 }) })
      .state.update({ effects: flashEffect.of({ ranges: [{ from: 15, to: 20 }], key: 2 }) }).state;
    expect(flashed(state)).toEqual([
      expect.objectContaining({ cls: 'sn-critic-flash', text: 'fort.' }),
    ]);
  });

  it('follows text inserted above it', () => {
    const state = base()
      .update({ effects: flashEffect.of({ ranges: [{ from: 4, to: 14 }], key: 1 }) })
      .state.update({ changes: { from: 0, insert: 'Neu. ' } }).state;
    expect(flashed(state)).toEqual([
      expect.objectContaining({ cls: 'sn-critic-flash', text: '{--ging--}' }),
    ]);
  });
});

describe('flashRangesFor — the flash matches the visible text, not the box', () => {
  const entryOf = (doc: string) => parseCritic(doc)[0]!;

  it('flashes a substitution as one band from quote to replacement', () => {
    // One range, not two: the arrow between them is hidden (zero-width), and
    // two adjacent rounded boxes would meet in a visible notch.
    const doc = 'Das {~~kalte~>fahle~~} Licht.';
    const slices = flashRangesFor(entryOf(doc), doc.length).map((r) => doc.slice(r.from, r.to));
    expect(slices).toEqual(['kalte~>fahle']);
  });

  it('flashes the quote of a commented construct, not its comment glyph', () => {
    const doc = 'Sie {--ging--}{>>zu spät?<<} fort.';
    const slices = flashRangesFor(entryOf(doc), doc.length).map((r) => doc.slice(r.from, r.to));
    expect(slices).toEqual(['ging']);
  });

  it('falls back to the whole construct for a bare comment', () => {
    const doc = 'Sie ging.{>>warum?<<}';
    const slices = flashRangesFor(entryOf(doc), doc.length).map((r) => doc.slice(r.from, r.to));
    expect(slices).toEqual(['{>>warum?<<}']);
  });

  it('clamps ranges that have gone stale past the end of the doc', () => {
    const doc = 'Sie {--ging--}.';
    expect(flashRangesFor(entryOf(doc), 9)).toEqual([{ from: 7, to: 9 }]);
    expect(flashRangesFor(entryOf(doc), 6)).toEqual([]);
  });
});

describe('Live Preview decorations — after an edit', () => {
  it('re-parses so offsets follow text inserted above', () => {
    const start = EditorState.create({
      doc: 'Sie {--ging--} fort.',
      extensions: [criticField],
    });
    const after = start.update({ changes: { from: 0, insert: 'Neue Zeile\n' } }).state;

    const doc = after.doc.toString();
    const marks: Painted[] = [];
    criticDecorations(after).between(0, doc.length, (from, to, value) => {
      marks.push({ from, to, cls: (value.spec.class as string) ?? '', text: doc.slice(from, to) });
    });

    expect(marks).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-deletion', text: 'ging' })
    );
  });

  it('drops the decoration once the markup is deleted', () => {
    const start = EditorState.create({
      doc: '{--ging--}',
      extensions: [criticField],
    });
    const after = start.update({ changes: { from: 0, to: 10, insert: 'ging' } }).state;
    expect(after.field(criticField)).toEqual([]);
  });
});
