// Inline rendering of editorial markup, in both of Obsidian's display modes.
//
// This is load-bearing rather than decorative: with {~~alt~>neu~~} sitting in
// the prose, an unrendered note looks broken. Both renderers read their
// geometry from parseCritic's `spans`, so neither can drift from the other or
// from what the drawer rewrites.
//
// The change is shown as the change — struck through for a deletion,
// underlined for an insertion — rather than as a labelled badge. Text keeps
// its normal colour throughout; coloured prose is hard to read, and the
// decoration already carries the meaning.

import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { setIcon } from 'obsidian';
import { parseCritic, type Entry, type Range } from './critic';

/** Cheap reject for the overwhelming majority of notes, which carry no markup. */
function mightHaveMarkup(text: string): boolean {
  return text.includes('{') || text.includes('%%') || text.includes('==');
}

const QUOTE_CLASS: Record<Entry['kind'], string> = {
  insertion: 'sn-critic-insertion',
  deletion: 'sn-critic-deletion',
  substitution: 'sn-critic-deletion',
  highlight: 'sn-critic-highlight',
  comment: '',
};

/**
 * Screen-reader label. The visual treatment carries this for sighted users —
 * which is exactly why the cards and decorations carry no type labels of their
 * own, and why this text has to say what the styling shows.
 */
function labelFor(entry: Entry): string {
  if (entry.kind === 'comment') {
    return entry.comment ? `Comment: ${entry.comment}` : 'Comment';
  }

  const what =
    entry.kind === 'substitution'
      ? `Suggested replacement: ${entry.quote} becomes ${entry.replacement}`
      : entry.kind === 'insertion'
        ? `Suggested insertion: ${entry.quote}`
        : entry.kind === 'deletion'
          ? `Suggested deletion: ${entry.quote}`
          : `Highlighted: ${entry.quote}`;

  return entry.comment ? `${what}. Comment: ${entry.comment}` : what;
}

const nonEmpty = (r: Range | null): r is Range => r !== null && r.to > r.from;

// ─── Live Preview ───

class CommentGlyph extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  eq(other: CommentGlyph): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    // Only clickable in Live Preview, where a click maps to a document offset
    // and can focus the matching card. Reading view's glyph is an indicator.
    el.className = 'sn-critic-glyph is-interactive';
    el.setAttribute('aria-label', this.label);
    setIcon(el, 'message-square');
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const HIDDEN = Decoration.replace({});

/**
 * Every decoration the editor paints for a document, derived from nothing but
 * the state passed in.
 *
 * Pure rather than a method on the field so the reveal rule is checkable
 * without an EditorView, and so the field below can cache the parse without
 * also owning the question of what gets painted.
 */
export function criticDecorations(state: EditorState): DecorationSet {
  const ranges: { from: number; to: number; value: Decoration }[] = [];

  for (const entry of state.field(criticField)) {
    // Standard Live Preview behaviour: put the cursor in a construct and its
    // raw markers come back, so the markup stays editable by hand.
    const revealed = state.selection.ranges.some(
      (r) => r.from <= entry.to && r.to >= entry.from
    );

    const mark = (r: Range | null, cls: string) => {
      if (!nonEmpty(r) || !cls) return;
      ranges.push({
        from: r.from,
        to: r.to,
        value: Decoration.mark({ class: cls, attributes: { 'aria-label': labelFor(entry) } }),
      });
    };

    // {~~alt~>neu~~} contains a ~~ pair, which Obsidian's own Markdown parser
    // reads as ordinary strikethrough — a second line across arrow and
    // replacement too. This mark is the hook styles.css uses to cancel that
    // line; the deletion span then re-applies its own. No aria-label: the
    // quote and replacement marks inside already carry the full sentence.
    if (entry.kind === 'substitution') {
      ranges.push({
        from: entry.from,
        to: entry.to,
        value: Decoration.mark({ class: 'sn-critic-substitution' }),
      });
    }

    // With its markers revealed, the construct is markup in prose colour on a
    // prose line. A wash over the whole span — braces, comment body and all —
    // says where the markup ends and the sentence resumes.
    if (revealed) {
      ranges.push({
        from: entry.from,
        to: entry.to,
        value: Decoration.mark({ class: 'sn-critic-revealed' }),
      });
    }

    mark(entry.spans.quote, QUOTE_CLASS[entry.kind]);
    mark(entry.spans.replacement, 'sn-critic-insertion');

    if (revealed) continue;

    for (const marker of entry.spans.markers) {
      if (nonEmpty(marker)) ranges.push({ from: marker.from, to: marker.to, value: HIDDEN });
    }
    if (nonEmpty(entry.spans.comment)) {
      ranges.push({
        from: entry.spans.comment.from,
        to: entry.spans.comment.to,
        value: Decoration.replace({ widget: new CommentGlyph(labelFor(entry)) }),
      });
    }
  }

  return Decoration.set(
    ranges.map((r) => r.value.range(r.from, r.to)),
    true
  );
}

/**
 * The whole document is re-parsed on every edit rather than just the viewport:
 * deciding whether an offset sits inside a code fence needs the lines above it,
 * and a scene file is small enough that the honest answer is also the fast one.
 */
export const criticField = StateField.define<Entry[]>({
  create: (state) => parse(state),
  update: (value, tr) => (tr.docChanged ? parse(tr.state) : value),
});

function parse(state: EditorState): Entry[] {
  const text = state.doc.toString();
  return mightHaveMarkup(text) ? parseCritic(text) : [];
}

// ─── Card-click flash ───

/**
 * Exported for tests; dispatch through flashEntry. The key tells consecutive
 * flashes of the same ranges apart, so CodeMirror rebuilds the spans — and
 * with them restarts the CSS animation — instead of diffing the change away.
 */
export const flashEffect = StateEffect.define<{ ranges: Range[]; key: number }>({
  map: (value, mapping) => ({
    ...value,
    ranges: value.ranges.map((r) => ({
      from: mapping.mapPos(r.from),
      to: mapping.mapPos(r.to),
    })),
  }),
});

export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        const mark = Decoration.mark({
          class: 'sn-critic-flash',
          attributes: { 'data-sn-flash': String(e.value.key) },
        });
        return Decoration.set(e.value.ranges.map((r) => mark.range(r.from, r.to)));
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * What a card click washes: the entry's text — quote and replacement, the
 * same boxes the resting decorations paint — rather than the whole
 * construct, whose comment glyph is shorter than a text fragment and gives
 * the wash a stepped outline. Only a bare comment, having no text of its
 * own, flashes its full range.
 *
 * Clamped rather than trusted: the caller's offsets can be a refresh older
 * than the text, and a stale range past the end would throw.
 */
export function flashRangesFor(entry: Entry, len: number): Range[] {
  const texts = [entry.spans.quote, entry.spans.replacement].filter(nonEmpty);
  // A substitution flashes as one band from quote to replacement: the arrow
  // between them is hidden, and two adjacent rounded boxes would meet in a
  // visible notch.
  const spans =
    texts.length > 0
      ? [{ from: texts[0].from, to: texts[texts.length - 1].to }]
      : [{ from: entry.from, to: entry.to }];
  return spans
    .map((r) => ({ from: Math.min(r.from, len), to: Math.min(r.to, len) }))
    .filter((r) => r.from < r.to);
}

let flashKey = 0;

/**
 * Briefly washes an entry's text so the eye lands where the drawer just
 * scrolled the editor. The animation ends transparent and the decorations
 * then sit inert until the next flash replaces them — cheaper than a removal
 * timer, and immune to the races one invites when clicks come quickly.
 */
export function flashEntry(view: EditorView, entry: Entry): void {
  const ranges = flashRangesFor(entry, view.state.doc.length);
  if (ranges.length === 0) return;
  view.dispatch({ effects: flashEffect.of({ ranges, key: flashKey++ }) });
}

/**
 * @param onReveal Called with an entry's start offset when the reader presses
 *   anywhere inside it — decorated text or comment glyph alike. Handling this
 *   at the view level rather than on the widget covers both with one listener
 *   and keeps the press from being swallowed: the caret still moves.
 */
export function criticEditorExtension(onReveal: (offset: number) => void): Extension {
  return [
    criticField,
    EditorView.decorations.compute([criticField, 'selection'], criticDecorations),
    flashField,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        // Deliberately mousedown, not click. Revealing the construct rebuilds
        // the line's DOM under the pressed button, and the browser swallows
        // the click entirely when the pressed element does not survive to
        // mouseup — so a click handler misses exactly the first press on a
        // folded construct. This runs before CodeMirror's own handler moves
        // the caret, so the layout — and these coordinates — are still the
        // folded ones the reader aimed at.
        if (event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const hit = view.state.field(criticField).find((e) => pos >= e.from && pos <= e.to);
        if (hit) onReveal(hit.from);
        return false;
      },
    }),
  ];
}

// ─── Reading view ───

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'TD', 'TH', 'DT', 'DD', 'DIV',
]);

interface NodeSpan {
  node: Text;
  /** Offset of this node's text within the block's concatenated string. */
  start: number;
}

/** The nearest block-level ancestor, so a construct cannot span two paragraphs. */
function blockOf(node: Node, root: HTMLElement): HTMLElement {
  let el = node.parentElement;
  while (el && el !== root && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el ?? root;
}

/** Text nodes in document order, grouped by block, skipping code. */
function textNodesByBlock(root: HTMLElement): Map<HTMLElement, Text[]> {
  const groups = new Map<HTMLElement, Text[]>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Code is not prose; markup inside it is a literal example.
      if (parent.closest('code, pre, .sn-critic-glyph')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = n as Text;
    const block = blockOf(text, root);
    const list = groups.get(block);
    if (list) list.push(text);
    else groups.set(block, [text]);
  }

  return groups;
}

/**
 * Splits a text node so that [start, end) of its content becomes a node of its
 * own, and returns it. Both splits are conditional so a range covering the
 * whole node does not create empty siblings.
 */
function isolate(node: Text, start: number, end: number): Text {
  if (end < node.data.length) node.splitText(end);
  return start > 0 ? node.splitText(start) : node;
}

/**
 * The per-node slices a [from, to) range of the block's concatenated text
 * covers. A construct wrapping other markdown — {++**fett** und kursiv++} —
 * arrives split across several nodes, which is why this exists at all.
 */
function slices(spans: NodeSpan[], from: number, to: number) {
  const out: { node: Text; start: number; end: number }[] = [];
  for (const span of spans) {
    const nodeEnd = span.start + span.node.data.length;
    if (nodeEnd <= from || span.start >= to) continue;
    out.push({
      node: span.node,
      start: Math.max(0, from - span.start),
      end: Math.min(span.node.data.length, to - span.start),
    });
  }
  return out;
}

type Op =
  | { from: number; to: number; op: 'hide' }
  | { from: number; to: number; op: 'wrap'; cls: string; label: string }
  | { from: number; to: number; op: 'glyph'; label: string };

function applyOps(spans: NodeSpan[], ops: Op[]): void {
  // Right to left, so splitting a node never moves the ranges still to come.
  for (const op of [...ops].sort((a, b) => b.from - a.from)) {
    for (const slice of slices(spans, op.from, op.to).reverse()) {
      if (slice.end <= slice.start) continue;
      const piece = isolate(slice.node, slice.start, slice.end);

      if (op.op === 'hide') {
        piece.remove();
        continue;
      }

      if (op.op === 'glyph') {
        const glyph = document.createElement('span');
        glyph.className = 'sn-critic-glyph';
        glyph.setAttribute('aria-label', op.label);
        setIcon(glyph, 'message-square');
        piece.replaceWith(glyph);
        continue;
      }

      const wrapper = document.createElement('span');
      wrapper.className = op.cls;
      wrapper.setAttribute('aria-label', op.label);
      piece.replaceWith(wrapper);
      wrapper.appendChild(piece);
    }
  }
}

/**
 * Reading-view renderer. CriticMarkup only, by construction rather than by
 * choice: Obsidian has already deleted %%comments%% from the DOM and turned
 * ==text== into a <mark> element by the time a post-processor runs, so the
 * native forms leave nothing here to find. A native comment staying invisible
 * in Reading view is exactly how Obsidian behaves without this plugin.
 */
export function renderCriticMarkup(root: HTMLElement): void {
  for (const [, nodes] of textNodesByBlock(root)) {
    const spans: NodeSpan[] = [];
    let text = '';
    for (const node of nodes) {
      spans.push({ node, start: text.length });
      text += node.data;
    }

    if (!mightHaveMarkup(text)) continue;

    const ops: Op[] = [];
    for (const entry of parseCritic(text)) {
      const label = labelFor(entry);
      for (const marker of entry.spans.markers) {
        if (nonEmpty(marker)) ops.push({ ...marker, op: 'hide' });
      }
      if (nonEmpty(entry.spans.quote) && QUOTE_CLASS[entry.kind]) {
        ops.push({ ...entry.spans.quote, op: 'wrap', cls: QUOTE_CLASS[entry.kind], label });
      }
      if (nonEmpty(entry.spans.replacement)) {
        ops.push({ ...entry.spans.replacement, op: 'wrap', cls: 'sn-critic-insertion', label });
      }
      if (nonEmpty(entry.spans.comment)) {
        ops.push({ ...entry.spans.comment, op: 'glyph', label });
      }
    }

    if (ops.length > 0) applyOps(spans, ops);
  }
}
