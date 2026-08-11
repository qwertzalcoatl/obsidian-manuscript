/**
 * @jest-environment jsdom
 *
 * Drives the Live Preview StateField through a real CodeMirror state — no
 * editor view, but the decorations it produces are plain data, so what the
 * reader would see is checkable here rather than only by eye in Obsidian.
 *
 * The rule worth pinning is that the caret reveals nothing: get it wrong and
 * marked-up prose stops being editable in place, which is a trap you only
 * notice after clicking into a sentence and finding braces under the cursor.
 */

import { EditorState } from '@codemirror/state';
import {
  criticDecorations,
  criticField,
  flashEffect,
  flashField,
  flashRangesFor,
  hiddenRanges,
  unfoldEffect,
  unfoldField,
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
    extensions: [unfoldField, criticField],
    ...(cursor === undefined ? {} : { selection: { anchor: cursor } }),
  });

  return painted(state, doc);
}

/** Reads a state's decorations out as plain data. */
function painted(state: EditorState, doc: string): Painted[] {
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

/** Paints `doc` with the construct at `at` unfolded to its raw source. */
function paintUnfolded(doc: string, at: number): Painted[] {
  const base = EditorState.create({
    doc,
    extensions: [unfoldField, criticField],
    selection: { anchor: at },
  });
  const entry = base.field(criticField).find((e) => at >= e.from && at <= e.to);
  if (!entry) throw new Error(`no construct at offset ${at} in ${JSON.stringify(doc)}`);

  const state = base.update({
    effects: unfoldEffect.of({ from: entry.from, to: entry.to }),
  }).state;

  return painted(state, doc);
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

  it('keeps the construct mark with the cursor inside', () => {
    expect(paint(doc, 6)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-substitution', text: '{~~kalte~>fahle~~}' })
    );
  });

  it('does not mark other kinds, whose bodies Markdown leaves alone', () => {
    expect(paint('Sie {--ging--}.').map((d) => d.cls)).not.toContain('sn-critic-substitution');
  });
});

describe('Live Preview decorations — the caret never reveals markup', () => {
  it('keeps an insertion folded with the cursor inside its text', () => {
    expect(visible('Sie {++leise ++}ging.', 8)).toBe('Sie leise ging.');
  });

  it('keeps a substitution folded with the cursor in the replacement', () => {
    expect(visible('Das {~~kalte~>fahle~~} Licht.', 15)).toBe('Das kaltefahle Licht.');
  });

  it('keeps an annotation folded with the cursor in the anchored text', () => {
    expect(visible('Sie {==ging==}{>>warum?<<} fort.', 9)).toBe('Sie ging fort.');
  });

  it('keeps markers folded with the cursor on either boundary', () => {
    const doc = 'Sie {++leise ++}ging.';
    expect(visible(doc, doc.indexOf('{++'))).toBe('Sie leise ging.');
    expect(visible(doc, doc.indexOf('++}') + 3)).toBe('Sie leise ging.');
  });

  it('paints no wash from the cursor alone', () => {
    expect(paint('Sie {++leise ++}ging.', 8).map((d) => d.cls)).not.toContain(
      'sn-critic-revealed'
    );
  });

  it('keeps styling the text, so the edit stays legible while typing in it', () => {
    expect(paint('Sie {++leise ++}ging.', 8)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-insertion', text: 'leise ' })
    );
  });
});

describe('Live Preview decorations — the unfold effect reveals markup', () => {
  const doc = 'Sie {++leise ++}ging.';

  it('shows the raw source of the unfolded construct', () => {
    const hidden = paintUnfolded(doc, 8)
      .filter((d) => d.cls === '')
      .map((d) => d.text);
    expect(hidden).toEqual([]);
  });

  it('washes the whole construct, braces and all', () => {
    expect(paintUnfolded(doc, 8)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-revealed', text: '{++leise ++}' })
    );
  });

  it('washes a revealed comment, braces and body alike', () => {
    expect(paintUnfolded('Sie ging.{>>warum?<<}', 12)).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-revealed', text: '{>>warum?<<}' })
    );
  });

  it('leaves every other construct folded', () => {
    const two = 'Sie {++leise ++}ging {--fort--}.';
    const hidden = paintUnfolded(two, 8)
      .filter((d) => d.cls === '')
      .map((d) => d.text);
    expect(hidden).toEqual(['{--', '--}']);
  });
});

describe('unfoldField — what folds it back', () => {
  const doc = 'Sie {++leise ++}ging.';
  const unfolded = () =>
    EditorState.create({ doc, extensions: [unfoldField], selection: { anchor: 8 } }).update({
      effects: unfoldEffect.of({ from: 4, to: 16 }),
    }).state;

  it('starts folded', () => {
    expect(EditorState.create({ doc, extensions: [unfoldField] }).field(unfoldField)).toBeNull();
  });

  it('holds the range the effect set', () => {
    expect(unfolded().field(unfoldField)).toEqual({ from: 4, to: 16 });
  });

  it('folds back when the selection leaves', () => {
    const moved = unfolded().update({ selection: { anchor: 0 } }).state;
    expect(moved.field(unfoldField)).toBeNull();
  });

  it('stays open while the selection is still inside', () => {
    const moved = unfolded().update({ selection: { anchor: 10 } }).state;
    expect(moved.field(unfoldField)).toEqual({ from: 4, to: 16 });
  });

  it('follows text inserted above it', () => {
    const edited = unfolded().update({ changes: { from: 0, insert: 'Neu. ' } }).state;
    expect(edited.field(unfoldField)).toEqual({ from: 9, to: 21 });
  });

  it('folds back when the construct is deleted out from under it', () => {
    const edited = unfolded().update({ changes: { from: 0, to: 21, insert: '' } }).state;
    expect(edited.field(unfoldField)).toBeNull();
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
      extensions: [unfoldField, criticField],
    });
    const after = start.update({ changes: { from: 0, insert: 'Neue Zeile\n' } }).state;

    const marks = painted(after, after.doc.toString());

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

describe('hiddenRanges — what the caret may not enter', () => {
  const rangesFor = (doc: string, cursor = 0) => {
    const state = EditorState.create({
      doc,
      extensions: [unfoldField, criticField],
      selection: { anchor: cursor },
    });
    return hiddenRanges(state).map((r) => doc.slice(r.from, r.to));
  };

  it('covers an insertion\'s markers and nothing else', () => {
    expect(rangesFor('Sie {++leise ++}ging.')).toEqual(['{++', '++}']);
  });

  it('covers a substitution\'s arrow as well as its braces', () => {
    expect(rangesFor('Das {~~kalte~>fahle~~} Licht.')).toEqual(['{~~', '~>', '~~}']);
  });

  it('covers an attached comment whole, anchor markers included', () => {
    expect(rangesFor('Sie {==ging==}{>>warum?<<} fort.')).toEqual([
      '{==',
      '==}',
      '{>>warum?<<}',
    ]);
  });

  it('never covers the quote or the replacement', () => {
    const doc = 'Das {~~kalte~>fahle~~} Licht.';
    const covered = hiddenRanges(
      EditorState.create({ doc, extensions: [unfoldField, criticField] })
    );
    expect(covered.some((r) => r.from <= 7 && r.to > 7)).toBe(false); // 'k' of kalte
    expect(covered.some((r) => r.from <= 14 && r.to > 14)).toBe(false); // 'f' of fahle
  });

  it('hides nothing in a construct showing its raw source', () => {
    const doc = 'Sie {++leise ++}ging.';
    const state = EditorState.create({
      doc,
      extensions: [unfoldField, criticField],
      selection: { anchor: 8 },
    }).update({ effects: unfoldEffect.of({ from: 4, to: 16 }) }).state;
    expect(hiddenRanges(state)).toEqual([]);
  });

  it('finds nothing in a note without markup', () => {
    expect(rangesFor('Sie ging fort.')).toEqual([]);
  });
});
