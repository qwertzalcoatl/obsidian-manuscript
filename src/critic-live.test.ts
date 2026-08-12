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
  constructToSelectOnDelete,
  criticDecorations,
  criticField,
  emptyBodyOf,
  emptyConstructAt,
  flashEffect,
  flashField,
  flashRangesFor,
  hiddenRanges,
  lineCollapseRange,
  unfoldEffect,
  unfoldField,
} from './critic-render';
import { parseCritic, suggestChange } from './critic';

interface Painted {
  from: number;
  to: number;
  /** The class a mark or a widget applies, or '' for a hidden range. */
  cls: string;
  text: string;
  /** What the reader sees in its place, or null where the source text stays. */
  renders: string | null;
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

/**
 * A decoration's class, whether it marks text or replaces it with a widget.
 *
 * A widget carries no spec.class, so without this it would read as an empty
 * class — indistinguishable from a hidden marker, which is exactly what the
 * arrow stopped being.
 */
function classOf(value: { spec: unknown }): string {
  const spec = value.spec as { class?: string; widget?: { cls?: string } };
  return spec.class ?? spec.widget?.cls ?? '';
}

/**
 * What a decoration puts on screen in place of the source it covers, or null
 * where the source survives.
 *
 * A mark leaves the text alone. Everything else replaces it — with nothing, or
 * with whatever its widget renders. Reading the widget's own `text` rather than
 * keeping a table here means the arrow can change without this knowing.
 */
function rendersAs(value: { spec: unknown }): string | null {
  const spec = value.spec as { class?: string; widget?: { text?: string } };
  if (spec.class !== undefined) return null;
  return spec.widget?.text ?? '';
}

/** Reads a state's decorations out as plain data. */
function painted(state: EditorState, doc: string): Painted[] {
  const out: Painted[] = [];
  criticDecorations(state).between(0, doc.length, (from, to, value) => {
    out.push({
      from,
      to,
      cls: classOf(value),
      text: doc.slice(from, to),
      renders: rendersAs(value),
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

/** Text as the reader sees it, with every replaced range standing in for itself. */
function visible(doc: string, cursor?: number): string {
  const replaced = paint(doc, cursor).filter((d) => d.renders !== null);
  let out = '';
  let at = 0;
  for (const r of replaced.sort((a, b) => a.from - b.from)) {
    out += doc.slice(at, r.from);
    out += r.renders;
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

  it('shows both halves of a substitution and draws the arrow between them', () => {
    const doc = 'Das {~~kalte~>fahle~~} Licht.';
    expect(visible(doc)).toBe('Das kalte→fahle Licht.');
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
    expect(visible('Das {~~kalte~>fahle~~} Licht.', 15)).toBe('Das kalte→fahle Licht.');
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
      .filter((d) => d.renders !== null)
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
      .filter((d) => d.renders !== null)
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
        cls: classOf(value),
        text: state.doc.sliceString(from, to),
        renders: rendersAs(value),
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

describe('constructToSelectOnDelete — a keystroke that would break markup', () => {
  // {--ging--}: markers [4,7) and [11,14), body [7,11).
  const doc = 'Sie {--ging--} fort.';
  const state = () => EditorState.create({ doc, extensions: [unfoldField, criticField] });
  const at = (pos: number, forward: boolean) =>
    constructToSelectOnDelete(state(), pos, forward);

  it('selects the construct when backspace would eat the opening marker', () => {
    expect(at(7, false)).toEqual({ from: 4, to: 14 });
  });

  it('selects the construct when delete would eat the closing marker', () => {
    expect(at(11, true)).toEqual({ from: 4, to: 14 });
  });

  it('selects the construct when backspace lands just past the closing brace', () => {
    expect(at(14, false)).toEqual({ from: 4, to: 14 });
  });

  it('leaves backspace alone just before the opening brace', () => {
    expect(at(4, false)).toBeNull();
  });

  it('leaves backspace alone inside the quoted text', () => {
    expect(at(9, false)).toBeNull();
  });

  it('leaves delete alone inside the quoted text', () => {
    expect(at(9, true)).toBeNull();
  });

  it('leaves ordinary prose alone', () => {
    expect(at(2, false)).toBeNull();
    expect(at(18, true)).toBeNull();
  });

  it('leaves a construct showing its raw source alone', () => {
    const revealed = state().update({
      selection: { anchor: 7 },
      effects: unfoldEffect.of({ from: 4, to: 14 }),
    }).state;
    expect(constructToSelectOnDelete(revealed, 7, false)).toBeNull();
  });

  it('selects the whole entry, attached comment included', () => {
    const commented = 'Sie {--ging--}{>>zu spät?<<} fort.';
    const built = EditorState.create({
      doc: commented,
      extensions: [unfoldField, criticField],
    });
    expect(constructToSelectOnDelete(built, 7, false)).toEqual({ from: 4, to: 28 });
  });
});

describe('lineCollapseRange — a comment that owned its line takes it along', () => {
  const collapse = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [unfoldField, criticField] });
    const entry = state.field(criticField)[0];
    const range = lineCollapseRange(state, entry);
    return range === null ? null : doc.slice(range.from, range.to);
  };

  it('takes the preceding newline with a comment alone on its line', () => {
    expect(collapse('Sie ging.\n{>>Mehr Luft<<}\nDann Stille.')).toBe('\n{>>Mehr Luft<<}');
  });

  it('tolerates leading and trailing whitespace on that line', () => {
    expect(collapse('Sie ging.\n  {>>Mehr Luft<<}  \nDann Stille.')).toBe(
      '\n  {>>Mehr Luft<<}  '
    );
  });

  it('leaves a comment sharing its line with prose', () => {
    expect(collapse('Sie ging.{>>Mehr Luft<<}')).toBeNull();
  });

  it('leaves an attached comment, whose anchor is on the line', () => {
    expect(collapse('Sie {==ging==}{>>Mehr Luft<<}')).toBeNull();
  });

  it('takes the following newline when the comment opens the note', () => {
    expect(collapse('{>>Mehr Luft<<}\nSie ging.')).toBe('{>>Mehr Luft<<}\n');
  });

  it('leaves a comment that is the only line in the note', () => {
    expect(collapse('{>>Mehr Luft<<}')).toBeNull();
  });

  it('takes both lines when the comment runs across two', () => {
    expect(collapse('Sie ging.\n{>>Mehr Luft\nim Absatz<<}\nDann Stille.')).toBe(
      '\n{>>Mehr Luft\nim Absatz<<}'
    );
  });

  it('leaves a two-line comment with prose after it on the last line', () => {
    expect(collapse('Sie ging.\n{>>Mehr Luft\nim Absatz<<} Dann Stille.')).toBeNull();
  });

  it('leaves a two-line comment with prose before it on the first line', () => {
    expect(collapse('Sie ging. {>>Mehr Luft\nim Absatz<<}\nDann Stille.')).toBeNull();
  });
});

describe('Live Preview decorations — an unanchored comment on its own line', () => {
  const doc = 'Sie ging.\n{>>Mehr Luft<<}\nDann Stille.';

  it('replaces the line rather than just the construct', () => {
    expect(paint(doc)).toContainEqual(
      expect.objectContaining({ cls: '', text: '\n{>>Mehr Luft<<}' })
    );
  });

  it('leaves the prose above and below untouched', () => {
    expect(visible(doc)).toBe('Sie ging.\nDann Stille.');
  });

  it('replaces only the construct when prose shares the line', () => {
    expect(visible('Sie ging.{>>Mehr Luft<<}')).toBe('Sie ging.');
  });
});

describe('Live Preview decorations — a construct carrying a note', () => {
  it('marks a commented deletion', () => {
    expect(paint('Sie {--ging--}{>>zu spät?<<} fort.')).toContainEqual(
      expect.objectContaining({
        cls: 'sn-critic-has-comment',
        text: '{--ging--}{>>zu spät?<<}',
      })
    );
  });

  it('marks a commented annotation', () => {
    expect(paint('Sie {==ging==}{>>warum?<<} fort.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-has-comment' })
    );
  });

  it('leaves an uncommented construct of the same kind unmarked', () => {
    expect(paint('Sie {--ging--} fort.').map((d) => d.cls)).not.toContain(
      'sn-critic-has-comment'
    );
  });

  it('does not mark a standalone comment, which has no anchor to mark', () => {
    expect(paint('Sie ging.{>>warum?<<}').map((d) => d.cls)).not.toContain(
      'sn-critic-has-comment'
    );
  });
});

describe('constructToSelectOnDelete — the line a collapsed comment took with it', () => {
  // "Sie ging.\n" is [0,10); the comment is [10,25); the collapse swallowed
  // the newline at 9, so what the reader sees as one object is [9,25).
  const doc = 'Sie ging.\n{>>Mehr Luft<<}\nDann Stille.';
  const state = () => EditorState.create({ doc, extensions: [unfoldField, criticField] });

  it('selects the collapsed line when delete would eat its newline', () => {
    expect(constructToSelectOnDelete(state(), 9, true)).toEqual({ from: 9, to: 25 });
  });

  it('selects it from the far side too', () => {
    expect(constructToSelectOnDelete(state(), 25, false)).toEqual({ from: 9, to: 25 });
  });

  it('leaves the prose above it alone', () => {
    expect(constructToSelectOnDelete(state(), 5, false)).toBeNull();
  });
});

describe('suggestChange — the caret lands somewhere it can rest', () => {
  // The bug this exists for: ⌘⇧M put the caret three characters into a
  // six-character hidden range, so you were typing into text that never
  // rendered and the first arrow key threw the caret out of it.
  const reachable = (doc: string, caret: number) => {
    const state = EditorState.create({
      doc,
      extensions: [unfoldField, criticField],
      selection: { anchor: caret },
    });
    return !hiddenRanges(state).some((r) => caret > r.from && caret < r.to);
  };

  it('is not inside a hidden range, in either mode', () => {
    for (const selection of ['', 'kalte', 'ein längerer Satzteil', 'a~b']) {
      const change = suggestChange(selection);
      if (change === null) throw new Error('expected a change');
      const doc = `Sie ${change.text} fort.`;
      expect(reachable(doc, 4 + change.caret)).toBe(true);
    }
  });

  it('sits between the two markers it was written between', () => {
    const doc = 'Sie {++++} fort.';
    const state = EditorState.create({ doc, extensions: [unfoldField, criticField] });
    expect(hiddenRanges(state)).toEqual([
      { from: 4, to: 7 },
      { from: 7, to: 10 },
    ]);
  });
});

describe('Live Preview decorations — the substitution arrow', () => {
  it('replaces the ~> marker rather than hiding it', () => {
    expect(paint('Das {~~kalte~>fahle~~} Licht.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-arrow', text: '~>' })
    );
  });

  it('draws even when the replacement is still empty', () => {
    // The case the whole change is for: a zero-width mark is dropped, so
    // generated content hung off the replacement would vanish exactly while
    // the replacement is being written.
    expect(paint('Das {~~kalte~>~~} Licht.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-arrow', text: '~>' })
    );
  });

  it('leaves an insertion alone, which has no arrow', () => {
    expect(paint('Sie {++leise ++}ging.').map((d) => d.cls)).not.toContain('sn-critic-arrow');
  });
});

describe('emptyBodyOf — where the words are going to go', () => {
  const bodyOf = (doc: string) => {
    const state = EditorState.create({ doc, extensions: [unfoldField, criticField] });
    return emptyBodyOf(state.field(criticField)[0]);
  };

  it('finds an insertion with nothing in it yet', () => {
    expect(bodyOf('Sie {++++}ging.')).toEqual({ from: 7, to: 7 });
  });

  it('finds a substitution whose replacement is still empty', () => {
    expect(bodyOf('Das {~~kalte~>~~} Licht.')).toEqual({ from: 14, to: 14 });
  });

  it('finds nothing once there is text in it', () => {
    expect(bodyOf('Sie {++leise ++}ging.')).toBeNull();
    expect(bodyOf('Das {~~kalte~>fahle~~} Licht.')).toBeNull();
  });

  it('leaves the kinds with no way to reach an empty body', () => {
    // {----} and {====} are malformed rather than half-written: no command
    // produces one, so there is no wording a placeholder could honestly use.
    expect(bodyOf('Sie {----} fort.')).toBeNull();
    expect(bodyOf('Sie {====} fort.')).toBeNull();
    expect(bodyOf('Sie ging.{>><<}')).toBeNull();
  });

  it('looks only at the replacement half of a substitution', () => {
    // {~~~>fahle~~} has an empty *quoted* half, which is a malformed construct
    // rather than one being written — repair mode's business, not this.
    expect(bodyOf('Das {~~~>fahle~~} Licht.')).toBeNull();
  });
});

describe('Live Preview decorations — the placeholder', () => {
  it('stands where an empty insertion would be typed', () => {
    expect(paint('Sie {++++}ging.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-placeholder', from: 7, to: 7 })
    );
  });

  it('stands after the arrow of an empty replacement', () => {
    expect(paint('Das {~~kalte~>~~} Licht.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-placeholder', from: 14, to: 14 })
    );
  });

  it('is gone as soon as there is text', () => {
    expect(paint('Sie {++leise ++}ging.').map((d) => d.cls)).not.toContain(
      'sn-critic-placeholder'
    );
  });

  it('is gone in repair mode, where the braces are on screen instead', () => {
    expect(paintUnfolded('Sie {++++}ging.', 7).map((d) => d.cls)).not.toContain(
      'sn-critic-placeholder'
    );
  });
});

describe('emptyConstructAt — what Escape throws away', () => {
  const at = (doc: string, pos: number) =>
    emptyConstructAt(
      EditorState.create({ doc, extensions: [unfoldField, criticField] }),
      pos
    );

  it('finds an empty insertion from its body', () => {
    expect(at('Sie {++++}ging.', 7)).toEqual({ from: 4, to: 10 });
  });

  it('finds an empty substitution from its replacement', () => {
    expect(at('Das {~~kalte~>~~} Licht.', 14)).toEqual({ from: 4, to: 17 });
  });

  it('finds nothing anywhere else in the same construct', () => {
    // Every other offset in it is inside a hidden marker, and those are
    // atomic — the caret cannot be there to press Escape in the first place.
    expect(at('Sie {++++}ging.', 4)).toBeNull();
    expect(at('Sie {++++}ging.', 10)).toBeNull();
  });

  it('finds nothing once the construct has text in it', () => {
    expect(at('Sie {++leise ++}ging.', 7)).toBeNull();
  });

  it('finds nothing in open prose', () => {
    expect(at('Sie ging fort.', 4)).toBeNull();
  });

  it('leaves a construct showing its raw source alone', () => {
    const revealed = EditorState.create({
      doc: 'Sie {++++}ging.',
      extensions: [unfoldField, criticField],
      selection: { anchor: 7 },
    }).update({ effects: unfoldEffect.of({ from: 4, to: 10 }) }).state;
    expect(emptyConstructAt(revealed, 7)).toBeNull();
  });
});
