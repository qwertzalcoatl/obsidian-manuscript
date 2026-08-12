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

import {
  EditorSelection,
  MapMode,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
  type DecorationSet,
} from '@codemirror/view';
import { parseCritic, type Entry, type Range } from './critic';

/** Cheap reject for the overwhelming majority of notes, which carry no markup. */
function mightHaveMarkup(text: string): boolean {
  return text.includes('{') || text.includes('%%') || text.includes('==');
}

const QUOTE_CLASS: Record<Entry['kind'], string> = {
  insertion: 'ms-critic-insertion',
  deletion: 'ms-critic-deletion',
  substitution: 'ms-critic-deletion',
  highlight: 'ms-critic-highlight',
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

const HIDDEN = Decoration.replace({});

/**
 * The `~>` between a substitution's halves, drawn as its own element.
 *
 * A widget rather than the CSS ::before it replaces, for two reasons. An empty
 * replacement has a zero-width mark, which CodeMirror drops — so generated
 * content hung off it disappears exactly when the arrow matters most, while the
 * replacement is still being typed. And generated content sits inside the
 * insertion's box, where it wears the green underline whatever it declares: a
 * border spans its generated content, and a descendant cannot cancel a
 * decoration its ancestor draws, so neither reset the old rule carried did
 * anything at all.
 *
 * The drawer card has always built it this way, as a sibling span.
 */
class ArrowWidget extends WidgetType {
  readonly cls = 'ms-critic-arrow';
  readonly text = '→';

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }

  // Every arrow is the same arrow, so CodeMirror never has to rebuild one.
  eq(): boolean {
    return true;
  }
}

const ARROW = Decoration.replace({ widget: new ArrowWidget() });

/**
 * Whether `marker` is the arrow of a substitution rather than one of its braces.
 *
 * Identified by position rather than by index into `spans.markers`: the arrow is
 * the one that begins where the quoted half ends, which stays true even when
 * that half is itself empty.
 */
function isArrowMarker(entry: Entry, marker: Range): boolean {
  return entry.kind === 'substitution' && marker.from === entry.spans.quote?.to;
}

/**
 * Where the words go, before there are any.
 *
 * A hint that gives way rather than a field you fill. It had a dashed box at
 * first, and the box was the mistake: edges made it read as an object sitting
 * in the sentence, so typing felt like destroying something. Green italic
 * against the manuscript's own face carries the whole message.
 *
 * The caret cannot be inside it however it is styled — a widget is one atomic
 * element, so the caret always renders beside it, and a frame drawn on the body
 * collapses to nothing while the body has no width. Rendered to find that out
 * rather than reasoned about.
 */
class PlaceholderWidget extends WidgetType {
  readonly cls = 'ms-critic-placeholder';
  readonly text = 'insert…';

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }

  eq(): boolean {
    return true;
  }
}

// side: 1 draws it after the position, so the caret sitting there renders
// before it — at the point the first character will actually land.
const PLACEHOLDER = Decoration.widget({ widget: new PlaceholderWidget(), side: 1 });

/**
 * The empty body a placeholder should stand in, or null.
 *
 * Only the two an authoring command can produce: an insertion's text, and a
 * substitution's replacement half. An empty deletion or highlight is malformed
 * rather than half-written — nothing makes one — so a placeholder there would
 * be inventing wording for a case with no way in. A substitution whose *quoted*
 * half is empty is the same: that is repair mode's business.
 *
 * Zero width is the whole point, so this compares from against to rather than
 * reaching for nonEmpty, which would reject exactly the case being looked for.
 */
export function emptyBodyOf(entry: Entry): Range | null {
  const body =
    entry.kind === 'insertion'
      ? entry.spans.quote
      : entry.kind === 'substitution'
        ? entry.spans.replacement
        : null;
  return body !== null && body.from === body.to ? body : null;
}

// ─── Repair mode ───

/**
 * Sets — or with null, clears — the one construct showing its raw source.
 *
 * Only one at a time: the point of showing braces is to fix a construct that
 * has gone wrong, and a note with several unfolded at once is just a note
 * full of braces again.
 */
export const unfoldEffect = StateEffect.define<Range | null>();

/**
 * Which construct, if any, is showing its raw source.
 *
 * Deliberately a range rather than an index into the parse: a range maps
 * itself forward through edits and never has to consult criticField, which is
 * what keeps the two fields independent. Reading the parse from here would
 * make the pair circular, since the decorations already read both.
 */
export const unfoldField = StateField.define<Range | null>({
  create: () => null,
  update(value, tr) {
    let next = value;

    if (next !== null && tr.docChanged) {
      const from = tr.changes.mapPos(next.from, 1, MapMode.TrackDel);
      const to = tr.changes.mapPos(next.to, -1, MapMode.TrackDel);
      next = from === null || to === null || to <= from ? null : { from, to };
    }

    for (const e of tr.effects) if (e.is(unfoldEffect)) next = e.value;

    // Folds itself back the moment the caret leaves. Without this a forgotten
    // unfold leaves braces sitting in the prose for the rest of the session,
    // which is exactly the state this whole feature exists to prevent.
    if (next !== null && !touches(tr.state.selection, next)) next = null;

    return next;
  },
});

function touches(selection: EditorSelection, range: Range): boolean {
  return selection.ranges.some((r) => r.from <= range.to && r.to >= range.from);
}

/** True when `entry` is the construct currently showing its raw source. */
function isRevealed(unfold: Range | null, entry: Entry): boolean {
  return unfold !== null && unfold.from <= entry.from && unfold.to >= entry.to;
}

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
  const unfold = state.field(unfoldField);

  for (const entry of state.field(criticField)) {
    // Never the caret's doing. Marked-up prose is prose you edit in place, so
    // clicking into it must not turn the line into syntax under the cursor —
    // that is the whole point of the feature. Only the repair command opens a
    // construct, and only until the caret leaves it.
    const revealed = isRevealed(unfold, entry);

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
        value: Decoration.mark({ class: 'ms-critic-substitution' }),
      });
    }

    // The only thing left saying a note exists here, now that the glyph has
    // gone: without it a commented deletion and a bare one are identical, and
    // with the drawer closed the note is invisible. On the whole construct
    // rather than the quote, so one rule serves all four anchored kinds — and
    // so a substitution's dotted rule does not land on its struck-through
    // half, where two lines would fight.
    if (entry.comment !== null && entry.kind !== 'comment') {
      ranges.push({
        from: entry.from,
        to: entry.to,
        value: Decoration.mark({ class: 'ms-critic-has-comment' }),
      });
    }

    // With its markers revealed, the construct is markup in prose colour on a
    // prose line. A wash over the whole span — braces, comment body and all —
    // says where the markup ends and the sentence resumes.
    if (revealed) {
      ranges.push({
        from: entry.from,
        to: entry.to,
        value: Decoration.mark({ class: 'ms-critic-revealed' }),
      });
    }

    mark(entry.spans.quote, QUOTE_CLASS[entry.kind]);
    mark(entry.spans.replacement, 'ms-critic-insertion');

    if (revealed) continue;

    // A construct showing its raw source needs no help saying where to type:
    // the braces are on screen, which is the whole point of repair mode.
    const empty = emptyBodyOf(entry);
    if (empty !== null) {
      ranges.push({ from: empty.from, to: empty.to, value: PLACEHOLDER });
    }

    for (const marker of entry.spans.markers) {
      if (!nonEmpty(marker)) continue;
      // Every marker comes off the screen; the substitution's arrow is the one
      // that leaves something behind. Without it the two halves run together
      // as "kaltefahle", and with the replacement still empty there would be
      // nothing at all between them.
      ranges.push({
        from: marker.from,
        to: marker.to,
        value: isArrowMarker(entry, marker) ? ARROW : HIDDEN,
      });
    }
    if (nonEmpty(entry.spans.comment)) {
      const line = lineCollapseRange(state, entry);
      if (line !== null) {
        ranges.push({ from: line.from, to: line.to, value: Decoration.replace({ block: true }) });
      } else {
        ranges.push({
          from: entry.spans.comment.from,
          to: entry.spans.comment.to,
          value: HIDDEN,
        });
      }
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

/**
 * Every range the decorations take off the screen, in document order.
 *
 * Fed to EditorView.atomicRanges, so the rule the whole feature rests on —
 * the caret goes wherever text is visible and is blocked only where text is
 * hidden — is stated once here rather than implied twice.
 */
export function hiddenRanges(state: EditorState): Range[] {
  const unfold = state.field(unfoldField);
  const out: Range[] = [];

  for (const entry of state.field(criticField)) {
    if (isRevealed(unfold, entry)) continue;
    out.push(...hiddenSpansOf(state, entry));
  }

  return out;
}

/** The ranges one entry's decorations take off the screen. */
function hiddenSpansOf(state: EditorState, entry: Entry): Range[] {
  const out: Range[] = [];
  for (const marker of entry.spans.markers) if (nonEmpty(marker)) out.push(marker);
  if (nonEmpty(entry.spans.comment)) {
    out.push(lineCollapseRange(state, entry) ?? entry.spans.comment);
  }
  return out;
}

/**
 * What the reader sees as one object: the entry's own bounds, or the whole
 * line when an unanchored comment took the line with it.
 *
 * The distinction matters for deletion. A collapsed line starts one character
 * to the left of the entry — at the newline it swallowed — so matching the
 * entry's bounds alone leaves that newline unguarded, and a Delete there falls
 * through to Obsidian's own command. atomicRanges then extends it across the
 * whole hidden range: the comment gone in one keystroke, with no selection
 * step and nothing on screen to say what happened.
 */
function visibleSpanOf(state: EditorState, entry: Entry): Range {
  return lineCollapseRange(state, entry) ?? { from: entry.from, to: entry.to };
}

/**
 * The line — or lines — an unanchored comment should take with it, or null.
 *
 * Hiding only the construct would leave a blank line mid-paragraph — more
 * conspicuous than the glyph this replaced. The same rule applyEdits already
 * applies in critic.ts when such a comment is resolved: an edit that empties
 * the line it sits on takes the line with it.
 *
 * Read from the first line to the last, because a note can run across several
 * of them. Reading only the line at `from` looks right and is not: the suffix
 * test then slices past the end of that line, gets an empty string, agrees the
 * line is clear, and collapses the first while the rest stays on screen as raw
 * markup.
 *
 * Takes the newline before the block where there is one, so the paragraphs
 * above and below close up rather than trading one gap for another. A comment
 * that is the whole note keeps its line: there is nothing to close.
 */
export function lineCollapseRange(state: EditorState, entry: Entry): Range | null {
  if (entry.kind !== 'comment') return null;

  const first = state.doc.lineAt(entry.from);
  const last = state.doc.lineAt(entry.to);
  if (first.text.slice(0, entry.from - first.from).trim() !== '') return null;
  if (last.text.slice(entry.to - last.from).trim() !== '') return null;

  if (first.from > 0) return { from: first.from - 1, to: last.to };
  if (last.to < state.doc.length) return { from: first.from, to: last.to + 1 };
  return null;
}

/**
 * The construct a Backspace or Delete would silently break, if any.
 *
 * The keystroke takes one character — [pos-1, pos) backwards, [pos, pos+1)
 * forwards. When that character is part of a hidden marker, removing it turns
 * the construct into plain text with nothing on screen to say so, because the
 * marker was never visible in the first place. The caller selects the whole
 * entry instead, and a second press removes it as one undoable unit.
 *
 * Returns null for a construct showing its raw source: there the syntax is
 * visible, and editing it by hand is the point.
 */
export function constructToSelectOnDelete(
  state: EditorState,
  pos: number,
  forward: boolean
): Range | null {
  const from = forward ? pos : pos - 1;
  const to = from + 1;
  const unfold = state.field(unfoldField);

  for (const entry of state.field(criticField)) {
    if (isRevealed(unfold, entry)) continue;
    if (hiddenSpansOf(state, entry).some((r) => from < r.to && to > r.from)) {
      return visibleSpanOf(state, entry);
    }
  }

  return null;
}

/**
 * The empty construct the caret is sitting in, if any.
 *
 * `pos` has to be the empty body itself, which is the only position in such a
 * construct the caret can occupy — everything else in it is inside a hidden
 * marker, and hidden markers are atomic.
 *
 * Null for a construct showing its raw source: there the braces are on screen
 * and editing them by hand is the point, Escape included.
 */
export function emptyConstructAt(state: EditorState, pos: number): Range | null {
  const unfold = state.field(unfoldField);

  for (const entry of state.field(criticField)) {
    if (isRevealed(unfold, entry)) continue;
    const empty = emptyBodyOf(entry);
    if (empty !== null && empty.from === pos) return { from: entry.from, to: entry.to };
  }

  return null;
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
          class: 'ms-critic-flash',
          attributes: { 'data-ms-flash': String(e.value.key) },
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
 * Turns a keystroke that would break a construct into a selection of it.
 *
 * Returns false — letting Obsidian's own Backspace run, list outdent and all
 * — whenever the keystroke is harmless, which is almost always.
 */
function selectRatherThanBreak(view: EditorView, forward: boolean): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;

  const hit = constructToSelectOnDelete(view.state, sel.head, forward);
  if (hit === null) return false;

  view.dispatch({ selection: EditorSelection.range(hit.from, hit.to) });
  return true;
}

/**
 * Throws away a construct you started and did not write into.
 *
 * Returns false everywhere else, which is nearly everywhere — Escape belongs to
 * Obsidian, and the one position this claims it in is a placeholder the caret
 * only reaches by having just asked for one.
 */
function discardEmptyConstruct(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;

  const hit = emptyConstructAt(view.state, sel.head);
  if (hit === null) return false;

  view.dispatch({
    changes: { from: hit.from, to: hit.to, insert: '' },
    selection: { anchor: hit.from },
  });
  return true;
}

/**
 * @param onReveal Called with an entry's start offset when the reader clicks
 *   anywhere inside it. Handling this at the view level rather than per span
 *   covers every construct with one listener, and returning false keeps the
 *   press from being swallowed: the caret still moves, which is now the
 *   primary thing a click into markup is for.
 *
 *   Deliberately does not open the Review drawer — see focusReviewCard in
 *   main.ts. Clicking into marked-up prose is how a sentence gets written
 *   now, not a request to review anything.
 */
export function criticEditorExtension(onReveal: (offset: number) => void): Extension {
  return [
    unfoldField,
    criticField,
    EditorView.decorations.compute([criticField, unfoldField, 'selection'], criticDecorations),
    // Cursor motion skips these, so the markers are one step in either
    // direction instead of several invisible ones. skipAtomicRanges only
    // moves a position strictly inside a range, so the caret can still rest
    // at a marker's edge — which is where typing inside a construct starts.
    EditorView.atomicRanges.of((view) =>
      RangeSet.of(
        hiddenRanges(view.state).map((r) => HIDDEN.range(r.from, r.to)),
        true
      )
    ),
    // Ahead of Obsidian's own bindings: by the time the default Backspace
    // runs, the marker is already gone. atomicRanges does not cover this —
    // it would extend the deletion over the whole marker run instead, which
    // breaks the construct just as thoroughly.
    Prec.high(
      keymap.of([
        { key: 'Backspace', run: (view) => selectRatherThanBreak(view, false) },
        { key: 'Delete', run: (view) => selectRatherThanBreak(view, true) },
        // Backspace twice already does this — the probe hits the opening
        // marker from the placeholder and selects the whole construct — but
        // changing your mind should not take two presses of a key that means
        // delete.
        { key: 'Escape', run: discardEmptyConstruct },
      ])
    ),
    flashField,
    EditorView.domEventHandlers({
      click(event, view) {
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
      if (parent.closest('code, pre')) return NodeFilter.FILTER_REJECT;
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
  | { from: number; to: number; op: 'text'; text: string; cls: string };

function applyOps(spans: NodeSpan[], ops: Op[]): void {
  for (const op of [...ops].sort((a, b) => b.from - a.from)) {
    const parts = slices(spans, op.from, op.to);
    // Right to left, so splitting a node never moves the ranges still to come.
    for (let i = parts.length - 1; i >= 0; i--) {
      const slice = parts[i];
      if (slice.end <= slice.start) continue;
      const piece = isolate(slice.node, slice.start, slice.end);

      if (op.op === 'hide') {
        piece.remove();
        continue;
      }

      if (op.op === 'text') {
        // A marker split across text nodes would otherwise get one element per
        // node. Only the first slice becomes it; the rest simply go.
        if (i > 0) {
          piece.remove();
          continue;
        }
        const el = document.createElement('span');
        el.className = op.cls;
        el.textContent = op.text;
        piece.replaceWith(el);
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
 *
 * Comments render as nothing at all, anchored or not: they live in the Review
 * drawer, and an editorial note has no business interrupting a reader.
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
        if (!nonEmpty(marker)) continue;
        if (isArrowMarker(entry, marker)) {
          ops.push({ ...marker, op: 'text', text: '→', cls: 'ms-critic-arrow' });
        } else {
          ops.push({ ...marker, op: 'hide' });
        }
      }
      // Here the class rides the quote rather than the whole construct: the
      // markers around it are removed from the DOM outright, so a wrapper
      // spanning them would have nothing left to wrap. The quote is the only
      // visible part, which is where the rule wants to be drawn anyway.
      if (nonEmpty(entry.spans.quote) && QUOTE_CLASS[entry.kind]) {
        const cls =
          entry.comment === null
            ? QUOTE_CLASS[entry.kind]
            : `${QUOTE_CLASS[entry.kind]} ms-critic-has-comment`;
        ops.push({ ...entry.spans.quote, op: 'wrap', cls, label });
      }
      if (nonEmpty(entry.spans.replacement)) {
        ops.push({
          ...entry.spans.replacement,
          op: 'wrap',
          cls: 'ms-critic-insertion',
          label,
        });
      }
      if (nonEmpty(entry.spans.comment)) {
        ops.push({ ...entry.spans.comment, op: 'hide' });
      }
    }

    if (ops.length > 0) applyOps(spans, ops);
  }
}
