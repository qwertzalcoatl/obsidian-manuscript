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
import { criticField } from './critic-render';

interface Painted {
  from: number;
  to: number;
  /** The class a mark applies, or '' for a hidden/replaced range. */
  cls: string;
  text: string;
}

/** Every decoration the field produces for `doc`, with an optional cursor. */
function paint(doc: string, cursor?: number): Painted[] {
  const state = EditorState.create({
    doc,
    extensions: [criticField],
    ...(cursor === undefined ? {} : { selection: { anchor: cursor } }),
  });

  const out: Painted[] = [];
  state
    .field(criticField)
    .decorations.between(0, doc.length, (from, to, value) => {
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

describe('Live Preview decorations — after an edit', () => {
  it('re-parses so offsets follow text inserted above', () => {
    const start = EditorState.create({
      doc: 'Sie {--ging--} fort.',
      extensions: [criticField],
    });
    const after = start.update({ changes: { from: 0, insert: 'Neue Zeile\n' } }).state;

    const doc = after.doc.toString();
    const marks: Painted[] = [];
    after.field(criticField).decorations.between(0, doc.length, (from, to, value) => {
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
    expect(after.field(criticField).entries).toEqual([]);
  });
});
