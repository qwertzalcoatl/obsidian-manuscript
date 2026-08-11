# CriticMarkup Edit-Through Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make marked-up prose editable in place — the caret enters a construct and types, and CriticMarkup syntax never appears unless the writer deliberately asks for it.

**Architecture:** `critic-render.ts` splits into three independent pieces: a state field holding only the parse, a state field holding the one construct showing raw source, and a pure function that builds decorations from both. Hidden ranges are contributed to `EditorView.atomicRanges` so the caret hops them, and an explicit `Prec.high` keymap stops Backspace and Delete from silently corrupting a construct. The comment glyph is removed from both display modes; comments live only in the Review drawer.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), Obsidian plugin API, Jest + ts-jest with a jsdom environment.

**Spec:** `docs/superpowers/specs/2026-08-11-criticmarkup-edit-through-design.md`

## Global Constraints

- **No new dependencies.** `@codemirror/state` and `@codemirror/view` are already present; everything here uses APIs they already export.
- **`src/critic.ts` is not modified.** The parser already reports every span this work needs. Any task that seems to need a parser change is a signal to re-read `Spans`.
- **Tests run view-free.** Every new behaviour is exposed as a pure function over `EditorState` so Jest can drive it without constructing an `EditorView`, matching how `flashRangesFor` is already tested.
- **`Range` is ambiguous in this file.** `src/critic.ts` exports `Range` as `{ from: number; to: number }`; `@codemirror/state` exports a generic `Range<T>`. `critic-render.ts` imports the former. Never import the latter — build CodeMirror ranges with `value.range(from, to)`.
- **New commands get no default hotkey.** `⌘⇧M` (`comment-on-selection`) stays the plugin's only default binding, matching `highlight-selection` and `suggest-deletion`.
- **Run tests with:** `npm test`. A single file: `npx jest src/critic-live.test.ts`.
- **Commit style:** lowercase conventional prefix, imperative subject, body explaining *why* — see `git log`. End commit messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 0: Clear the working tree

The branch `criticmarkup-edit-through` carries uncommitted work from before this design existed. Most of it survives untouched — the flash field and its tests, the `~~` strikethrough cancellation, the drawer's `focusedOffset` persistence, the `active-leaf-change` narrowing. What does not survive is the cursor-driven reveal work, which Task 2 replaces.

Landing that as its own commit first means Task 2's diff shows what changed rather than mixing a rewrite into unrelated polish.

- [ ] **Step 1: See what is uncommitted**

Run: `git status --short && git diff --stat`
Expected: modifications to `src/critic-live.test.ts`, `src/critic-render.ts`, `src/review-view.ts`, `styles.css`.

- [ ] **Step 2: Confirm it is green before committing it**

Run: `npm test && npm run build`
Expected: both exit 0. If anything fails, fix it before proceeding — this plan assumes a passing baseline, and a failure inherited from here will look like a failure Task 1 caused.

- [ ] **Step 3: Commit it**

```bash
git add src/critic-live.test.ts src/critic-render.ts src/review-view.ts styles.css
git commit -m "$(cat <<'EOF'
feat: flash a card's entry in the editor and hold the drawer's focus

Clicking a card scrolled the editor but left the eye to find the entry.
Also stops a repaint from destroying the focus a click just applied, and
cancels the native strikethrough Obsidian draws through a substitution.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Split the parse from the decorations

A pure refactor. `criticField` currently owns both the parse and the decorations, which makes the reveal decision a cached side-effect of `docChanged`. Task 2 needs to layer explicit reveal state on top, and cannot while the two are fused. **Behaviour must not change** — every existing test passes untouched except the one helper that reaches into the field.

**Files:**
- Modify: `src/critic-render.ts:83-174` (`decorate`, `CriticValue`, `build`, `criticField`), `src/critic-render.ts:254-278` (`criticEditorExtension`)
- Test: `src/critic-live.test.ts:26-45` (the `paint` helper)

**Interfaces:**
- Consumes: `parseCritic`, `Entry`, `Range` from `./critic` (already imported)
- Produces:
  - `criticField: StateField<Entry[]>` — the parse, cached on `docChanged`
  - `criticDecorations(state: EditorState): DecorationSet` — pure decoration builder

- [ ] **Step 1: Update the test helper to drive the new shape**

In `src/critic-live.test.ts`, change the import on line 14 and replace the `paint` helper at lines 26-45:

```ts
import { criticDecorations, criticField, flashEffect, flashField, flashRangesFor } from './critic-render';
```

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts`
Expected: FAIL — `criticDecorations` is not exported from `./critic-render`.

- [ ] **Step 3: Rewrite the field and extract the builder**

In `src/critic-render.ts`, replace everything from `function decorate` (line 83) through the end of `criticField` (line 174) with:

```ts
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
```

- [ ] **Step 4: Wire the decorations facet in the extension**

In `criticEditorExtension`, replace the bare `criticField,` entry with both:

```ts
    criticField,
    EditorView.decorations.compute([criticField, 'selection'], criticDecorations),
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all existing tests, unchanged in meaning. If any test other than the `paint` helper needed editing, the refactor changed behaviour and is wrong.

- [ ] **Step 6: Build to confirm the plugin still compiles**

Run: `npm run build`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
refactor: split the critic parse from its decorations

criticField owned both, which made the reveal decision a cached
side-effect of docChanged. Explicit reveal state cannot layer on top of
that. Pure function plus a parse-only field, no behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Edit-through — reveal becomes explicit

The behaviour change. The caret stops revealing anything; a construct shows its raw source only because an effect said so, and folds back the moment the selection leaves.

**Files:**
- Modify: `src/critic-render.ts` (imports, new `unfoldField`, `criticDecorations`, `criticEditorExtension`)
- Modify: `styles.css:430-442`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `criticField`, `criticDecorations` (Task 1)
- Produces:
  - `unfoldEffect: StateEffectType<Range | null>` — sets or clears the unfolded construct
  - `unfoldField: StateField<Range | null>` — the construct showing raw source
  - `isRevealed(unfold: Range | null, entry: Entry): boolean` — internal, not exported

- [ ] **Step 1: Write the failing tests**

In `src/critic-live.test.ts`, **delete** these two `describe` blocks entirely — they assert the behaviour this task removes:
- `Live Preview decorations — revealed markup stands apart from prose`
- `Live Preview decorations — cursor reveals the raw markup`

Update the import to add the new exports:

```ts
import {
  criticDecorations,
  criticField,
  flashEffect,
  flashField,
  flashRangesFor,
  unfoldEffect,
  unfoldField,
} from './critic-render';
```

Add `unfoldField` to the `paint` helper's extension list so the field exists:

```ts
    extensions: [unfoldField, criticField],
```

Then add these blocks:

```ts
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

  const out: Painted[] = [];
  criticDecorations(state).between(0, doc.length, (from, to, value) => {
    out.push({ from, to, cls: (value.spec.class as string) ?? '', text: doc.slice(from, to) });
  });
  return out;
}

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

  it('paints no wash from the cursor alone', () => {
    expect(paint('Sie {++leise ++}ging.', 8).map((d) => d.cls)).not.toContain(
      'sn-critic-revealed'
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts`
Expected: FAIL — `unfoldEffect` and `unfoldField` are not exported.

- [ ] **Step 3: Add the unfold field**

In `src/critic-render.ts`, extend the `@codemirror/state` import:

```ts
import {
  EditorSelection,
  MapMode,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state';
```

Insert above `criticDecorations`:

```ts
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
 * itself forward through edits and never has to consult criticField, which
 * is what keeps the two fields independent. Reading the parse from here
 * would make the pair circular, since the decorations already read both.
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
```

- [ ] **Step 4: Drive the decorations from it**

In `criticDecorations`, replace the `revealed` computation. Read the field once before the loop:

```ts
export function criticDecorations(state: EditorState): DecorationSet {
  const ranges: { from: number; to: number; value: Decoration }[] = [];
  const unfold = state.field(unfoldField);

  for (const entry of state.field(criticField)) {
    // Never the caret's doing. Marked-up prose is prose you edit in place, so
    // clicking into it must not turn the line into syntax under the cursor —
    // that is the whole point of the feature. Only the repair command opens a
    // construct, and only until the caret leaves it.
    const revealed = isRevealed(unfold, entry);
```

The rest of the function body is unchanged.

- [ ] **Step 5: Add the field to the extension and revert mousedown to click**

In `criticEditorExtension`, add `unfoldField` and list it as a decoration dependency:

```ts
    unfoldField,
    criticField,
    EditorView.decorations.compute([criticField, unfoldField, 'selection'], criticDecorations),
    flashField,
```

Then replace the whole `EditorView.domEventHandlers({ mousedown ... })` block with:

```ts
    EditorView.domEventHandlers({
      click(event, view) {
        if (event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        // criticField holds Entry[] directly since Task 1 — no .entries.
        const hit = view.state.field(criticField).find((e) => pos >= e.from && pos <= e.to);
        if (hit) onReveal(hit.from);
        return false;
      },
    }),
```

Update the JSDoc above `criticEditorExtension` — the `mousedown` justification described a DOM rebuild that no longer happens:

```ts
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
```

- [ ] **Step 6: Run the tests**

Run: `npx jest src/critic-live.test.ts`
Expected: PASS.

- [ ] **Step 7: Invert the cursor rules**

In `styles.css`, replace lines 426-442 (the two cursor blocks) with:

```css
/* Marked-up text is editable prose now, not a click target: the caret goes
   into it and types, and the click that places the caret also focuses the
   drawer card as a side effect. An I-beam is what that deserves. Scoped to
   .cm-content because Reading view has no caret at all. */
.cm-content .sn-critic-insertion,
.cm-content .sn-critic-deletion,
.cm-content .sn-critic-highlight {
  cursor: text;
}
```

And rewrite the comment above `.sn-critic-revealed` (line 417-420), which still describes cursor-driven reveal:

```css
/* Repair mode. The raw markup is back on the line as prose-coloured text, so
   a faint wash over the whole construct — braces, comment body and all — says
   where markup ends and the sentence resumes. Weaker than
   .sn-critic-highlight, so a real highlight stays the stronger object. */
```

- [ ] **Step 8: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts styles.css
git commit -m "$(cat <<'EOF'
feat: let the caret edit marked-up prose without revealing syntax

Putting the cursor in a construct unfolded the whole thing, comment
included, so fixing a word meant looking at braces — and in practice
resolving the note first just to get typing access. Reveal is now an
explicit effect that folds back when the caret leaves.

Also reverts mousedown to click: it existed because revealing rebuilt the
line's DOM under the pressed button, which no longer happens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Make hidden ranges atomic

The caret can currently land *inside* a hidden marker, where it renders at the collapse point and an arrow keypress appears to do nothing. `EditorView.atomicRanges` makes the markers one step in either direction.

**Files:**
- Modify: `src/critic-render.ts`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `criticField`, `unfoldField`, `isRevealed` (Tasks 1-2)
- Produces: `hiddenRanges(state: EditorState): Range[]` — every range the decorations replace

- [ ] **Step 1: Write the failing test**

Append to `src/critic-live.test.ts` (add `hiddenRanges` to the import):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/critic-live.test.ts -t hiddenRanges`
Expected: FAIL — `hiddenRanges` is not exported.

- [ ] **Step 3: Implement**

Add to `src/critic-render.ts`, below `criticDecorations`:

```ts
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
    for (const marker of entry.spans.markers) if (nonEmpty(marker)) out.push(marker);
    if (nonEmpty(entry.spans.comment)) out.push(entry.spans.comment);
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/critic-live.test.ts -t hiddenRanges`
Expected: PASS.

- [ ] **Step 5: Contribute the facet**

In `criticEditorExtension`, add after the decorations line:

```ts
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
```

Add `RangeSet` to the `@codemirror/state` import.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Verify by hand in Obsidian**

Open a note containing `Das {~~kalte~>fahle~~} Licht.` in Live Preview. Place the caret before `L` in `Licht` and press ← repeatedly. Confirm: the caret steps through `fahle` one character at a time, crosses from `fahle` to `kalte` in a single press, and leaves the construct in a single press. No keypress appears to do nothing.

- [ ] **Step 8: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
feat: make hidden markup atomic for the caret

The caret could land inside a replaced marker, where it renders at the
collapse point and an arrow key appears to do nothing. Hidden ranges now
feed atomicRanges, so markers are one step in either direction.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Stop Backspace from corrupting a construct

`atomicRanges` does not solve this, and it is worth knowing why before starting: with the caret at offset 3 in `{--ging--}`, a delete command that ignores the facet eats one `-` and leaves `{-ging--}`; one that honours it eats the whole `{--` and leaves `ging--}`. Both are silently plain text. The keystroke has to be intercepted.

**Files:**
- Modify: `src/critic-render.ts`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `criticField`, `hiddenRanges` (Tasks 1, 3)
- Produces: `constructToSelectOnDelete(state: EditorState, pos: number, forward: boolean): Range | null`

- [ ] **Step 1: Write the failing test**

Append to `src/critic-live.test.ts` (add `constructToSelectOnDelete` to the import):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/critic-live.test.ts -t constructToSelectOnDelete`
Expected: FAIL — `constructToSelectOnDelete` is not exported.

- [ ] **Step 3: Implement**

Add to `src/critic-render.ts`, below `hiddenRanges`:

```ts
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

  const breaks = hiddenRanges(state).some((r) => from < r.to && to > r.from);
  if (!breaks) return null;

  const entry = state.field(criticField).find((e) => from < e.to && to > e.from);
  return entry ? { from: entry.from, to: entry.to } : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/critic-live.test.ts -t constructToSelectOnDelete`
Expected: PASS.

- [ ] **Step 5: Bind the keys**

Add to `src/critic-render.ts`, above `criticEditorExtension`:

```ts
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
```

And inside `criticEditorExtension`, after the atomicRanges entry:

```ts
    // Ahead of Obsidian's own bindings: by the time the default Backspace
    // runs, the marker is already gone. atomicRanges does not cover this —
    // it would extend the deletion over the whole marker run instead, which
    // breaks the construct just as thoroughly.
    Prec.high(
      keymap.of([
        { key: 'Backspace', run: (view) => selectRatherThanBreak(view, false) },
        { key: 'Delete', run: (view) => selectRatherThanBreak(view, true) },
      ])
    ),
```

Add `Prec` to the `@codemirror/state` import and `keymap` to the `@codemirror/view` import.

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Verify by hand in Obsidian**

In a note containing `Sie {--ging--} fort.`:
1. Place the caret directly before `g` and press ⌫ — the whole `ging` should become selected, and the source should be unchanged.
2. Press ⌫ again — the construct disappears in one step. Press ⌘Z once and confirm it comes back whole.
3. Place the caret in the middle of `ging` and press ⌫ — one character goes, as usual.
4. In an ordinary bulleted list elsewhere in the note, press ⌫ at the start of an item and confirm Obsidian's outdent still works.

- [ ] **Step 8: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
fix: stop backspace silently breaking a construct

With the markers hidden, a backspace at the edge of the quoted text ate a
brace and turned the construct into plain text with nothing on screen to
say so. atomicRanges does not help — it deletes the whole marker run
instead, which breaks it just as thoroughly. The keystroke now selects
the construct, and a second press removes it as one undoable unit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Remove the comment glyph

The bubble did three jobs. Two are already covered: clicks land on the construct through the view-level handler, and anchored text is already decorated. The third — standing in for an unanchored comment — is dropped deliberately; comments live in the drawer.

**Files:**
- Modify: `src/critic-render.ts` (`CommentGlyph`, `criticDecorations`, `Op`, `applyOps`, `renderCriticMarkup`, imports)
- Modify: `styles.css:464-488` and `src/__mocks__/obsidian.ts:1-4` (comment only)
- Test: `src/critic-render.test.ts:53-66`

**Interfaces:**
- Consumes: `criticDecorations` (Task 1)
- Produces: nothing new. `Op` loses its `glyph` variant.

- [ ] **Step 1: Rewrite the two glyph tests**

In `src/critic-render.test.ts`, replace lines 53-66 (the two `it` blocks naming a glyph) with:

```ts
  it('removes a standalone comment entirely', () => {
    const root = render('<p>Sie ging.{>>Mehr Spannung<<}</p>');
    expect(root.textContent).toBe('Sie ging.');
    expect(root.querySelector('.sn-critic-glyph')).toBeNull();
  });

  it('keeps the anchor and removes an attached comment', () => {
    const root = render('<p>Sie {==ging==}{>>Mehr Spannung<<} fort.</p>');
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.sn-critic-highlight')?.textContent).toBe('ging');
    expect(root.querySelector('.sn-critic-glyph')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-render.test.ts`
Expected: FAIL — a `.sn-critic-glyph` element is still found.

- [ ] **Step 3: Delete the Live Preview glyph**

In `src/critic-render.ts`:

Delete the entire `CommentGlyph` class (the `// ─── Live Preview ───` section's widget, lines 57-79 in the original file).

In `criticDecorations`, replace the comment branch:

```ts
    if (nonEmpty(entry.spans.comment)) {
      ranges.push({
        from: entry.spans.comment.from,
        to: entry.spans.comment.to,
        value: HIDDEN,
      });
    }
```

Remove `WidgetType` from the `@codemirror/view` import. Leave the `setIcon` import for now — `applyOps` still uses it until the next step.

- [ ] **Step 4: Delete the Reading-view glyph**

In `src/critic-render.ts`, narrow the `Op` union:

```ts
type Op =
  | { from: number; to: number; op: 'hide' }
  | { from: number; to: number; op: 'wrap'; cls: string; label: string };
```

In `applyOps`, delete the whole `if (op.op === 'glyph') { … }` branch.

In `renderCriticMarkup`, change the comment op from `glyph` to `hide`:

```ts
      if (nonEmpty(entry.spans.comment)) {
        ops.push({ from: entry.spans.comment.from, to: entry.spans.comment.to, op: 'hide' });
      }
```

In `textNodesByBlock`'s `acceptNode`, drop `.sn-critic-glyph` from the rejection selector — there is no glyph left to skip:

```ts
      if (parent.closest('code, pre')) return NodeFilter.FILTER_REJECT;
```

Now delete the `setIcon` import from `obsidian` — nothing in this module uses it any more, which leaves `critic-render.ts` obsidian-free like `critic.ts`.

Update the docstring above `renderCriticMarkup` to add a sentence:

```
 * Comments render as nothing at all, anchored or not: they live in the Review
 * drawer, and an editorial note has no business interrupting a reader.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/critic-render.test.ts`
Expected: PASS.

- [ ] **Step 6: Delete the glyph styles and correct the mock's comment**

In `styles.css`, delete the four `.sn-critic-glyph` rule blocks (the block starting `/* Stands in for a whole {>>…<<} construct.` through `.sn-critic-glyph svg { … }`).

In `src/__mocks__/obsidian.ts`, replace the header comment — `critic-render.ts` no longer imports `setIcon`, but `review-view.ts` and `main.ts` still do:

```ts
// Minimal stub so ts-jest can resolve `obsidian` in tests. The tested modules
// are obsidian-free; this exists for the ones that import it transitively.
// setIcon is Obsidian's Lucide <svg> injector — a marker element is enough.
```

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/critic-render.ts src/critic-render.test.ts src/__mocks__/obsidian.ts styles.css
git commit -m "$(cat <<'EOF'
feat: drop the comment glyph from both display modes

The bubble was doing three jobs and two were already covered: the
view-level click handler catches any press inside a construct, and
anchored text is already decorated. The third — standing in for an
unanchored note — goes deliberately. Comments live in the drawer.

Leaves critic-render.ts free of the obsidian import.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Collapse an emptied standalone-comment line

With the glyph gone, a standalone comment sitting alone on its line leaves a blank line in the middle of the prose — more conspicuous than the bubble it replaced. This mirrors what `applyEdits` in `src/critic.ts` already does when such a comment is resolved.

**Files:**
- Modify: `src/critic-render.ts`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `criticField`, `unfoldField` (Tasks 1-2)
- Produces: `lineCollapseRange(state: EditorState, entry: Entry): Range | null` — exported for tests

- [ ] **Step 1: Write the failing test**

Append to `src/critic-live.test.ts` (add `lineCollapseRange` to the import):

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/critic-live.test.ts -t lineCollapseRange`
Expected: FAIL — `lineCollapseRange` is not exported.

- [ ] **Step 3: Implement**

Add to `src/critic-render.ts`, below `hiddenRanges`:

```ts
/**
 * The line an unanchored comment should take with it, or null.
 *
 * Hiding only the construct would leave a blank line mid-paragraph — more
 * conspicuous than the glyph this replaced. The same rule applyEdits already
 * applies in critic.ts when such a comment is resolved: an edit that empties
 * the line it sits on takes the line with it.
 *
 * Takes the newline before the line where there is one, so the paragraphs
 * above and below close up rather than trading one gap for another. A comment
 * that is the only line in the note keeps its line: there is nothing to close.
 */
export function lineCollapseRange(state: EditorState, entry: Entry): Range | null {
  if (entry.kind !== 'comment') return null;

  const line = state.doc.lineAt(entry.from);
  if (line.text.slice(0, entry.from - line.from).trim() !== '') return null;
  if (line.text.slice(entry.to - line.from).trim() !== '') return null;

  if (line.from > 0) return { from: line.from - 1, to: line.to };
  if (line.to < state.doc.length) return { from: line.from, to: line.to + 1 };
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/critic-live.test.ts -t lineCollapseRange`
Expected: PASS.

- [ ] **Step 5: Use it in the decorations**

In `criticDecorations`, replace the comment branch added in Task 5 with:

```ts
    if (nonEmpty(entry.spans.comment)) {
      const line = lineCollapseRange(state, entry);
      if (line !== null) {
        ranges.push({
          from: line.from,
          to: line.to,
          value: Decoration.replace({ block: true }),
        });
      } else {
        ranges.push({
          from: entry.spans.comment.from,
          to: entry.spans.comment.to,
          value: HIDDEN,
        });
      }
    }
```

Extend `hiddenRanges` to match, so the caret cannot enter a collapsed line either:

```ts
    if (nonEmpty(entry.spans.comment)) {
      out.push(lineCollapseRange(state, entry) ?? entry.spans.comment);
    }
```

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0. If `hiddenRanges` tests now fail because a collapsed line changed the expected slices, correct the *expectations* — the behaviour is intended.

- [ ] **Step 7: Verify by hand in Obsidian — this is the risky step**

Create a note reading:

```
Sie ging.
{>>Mehr Luft in diesem Absatz<<}
Dann Stille.
```

Confirm in Live Preview: the two prose lines sit adjacent with no gap between them; the caret cannot be placed on the collapsed line by arrowing down from `Sie ging.`; and the drawer still lists the comment with `Sie ging.` as its context.

**If block decorations misbehave** — the caret strands itself on the hidden line, the editor throws, or the line fails to collapse — apply the fallback the spec allows: delete the `lineCollapseRange` branch from `criticDecorations` (keeping the function and its tests, which are correct and cheap), leave the blank line in place, and note it in the commit body. Do not spend more than one attempt at debugging block-decoration layout; the fallback is an acceptable outcome.

- [ ] **Step 8: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
feat: collapse the line an unanchored comment had to itself

With the glyph gone, a comment alone on its line left a blank line
mid-paragraph — more conspicuous than the bubble it replaced. Same rule
applyEdits already applies when such a comment is resolved.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Mark constructs that carry a note

The only survivor of the glyph's "a note exists here" job. Without it, `{--ging--}` and `{--ging--}{>>zu spät?<<}` are indistinguishable, and with the drawer closed a note is invisible.

**Files:**
- Modify: `src/critic-render.ts` (`criticDecorations`, `renderCriticMarkup`)
- Modify: `styles.css`
- Test: `src/critic-live.test.ts`, `src/critic-render.test.ts`

**Interfaces:**
- Consumes: `criticDecorations`, `renderCriticMarkup` (Tasks 1, 5)
- Produces: the CSS class `sn-critic-has-comment`, applied to the whole construct in both display modes

- [ ] **Step 1: Write the failing tests**

Append to `src/critic-live.test.ts`:

```ts
describe('Live Preview decorations — a construct carrying a note', () => {
  it('marks a commented deletion', () => {
    expect(paint('Sie {--ging--}{>>zu spät?<<} fort.')).toContainEqual(
      expect.objectContaining({ cls: 'sn-critic-has-comment', text: '{--ging--}{>>zu spät?<<}' })
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
```

And append to `src/critic-render.test.ts`:

```ts
describe('renderCriticMarkup — a construct carrying a note', () => {
  it('marks the anchor of a commented deletion', () => {
    const root = render('<p>Sie {--ging--}{>>zu spät?<<} fort.</p>');
    expect(root.querySelector('.sn-critic-has-comment')?.textContent).toBe('ging');
  });

  it('leaves an uncommented deletion unmarked', () => {
    const root = render('<p>Sie {--ging--} fort.</p>');
    expect(root.querySelector('.sn-critic-has-comment')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts src/critic-render.test.ts -t "carrying a note"`
Expected: FAIL — no `sn-critic-has-comment` is produced.

- [ ] **Step 3: Implement in Live Preview**

In `criticDecorations`, add below the `sn-critic-substitution` block:

```ts
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
        value: Decoration.mark({ class: 'sn-critic-has-comment' }),
      });
    }
```

- [ ] **Step 4: Implement in Reading view**

In `renderCriticMarkup`, the whole construct cannot be wrapped — the comment's own range is hidden, and a wrapper spanning both would have to survive that removal. Wrap the quote instead, which is the only visible part:

```ts
      if (nonEmpty(entry.spans.quote) && QUOTE_CLASS[entry.kind]) {
        const cls = entry.comment === null
          ? QUOTE_CLASS[entry.kind]
          : `${QUOTE_CLASS[entry.kind]} sn-critic-has-comment`;
        ops.push({ ...entry.spans.quote, op: 'wrap', cls, label });
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/critic-live.test.ts src/critic-render.test.ts -t "carrying a note"`
Expected: PASS.

- [ ] **Step 6: Add the style**

In `styles.css`, add after the `.sn-critic-highlight` rule:

```css
/* A note lives here. This is the only thing that says so — the drawer may be
   closed, and there is no glyph any more. Dotted rather than a heavier solid
   rule because both existing decorations are solid, a strikethrough on
   deletions and a bottom border on insertions, so a dotted line reads as a
   different kind of statement instead of a louder version of the same one. */
.sn-critic-has-comment {
  text-decoration: underline dotted;
  text-decoration-color: var(--text-accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
```

- [ ] **Step 7: Run the full suite and build**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 8: Verify by hand in Obsidian**

Create a note containing one of each, and confirm all four are distinguishable at a glance from their uncommented twins, in both Live Preview and Reading view, in a light theme and a dark one:

```
Sie {--ging--}{>>zu spät?<<} fort.
Sie {--ging--} fort.
Das {~~kalte~>fahle~~}{>>zu kühl?<<} Licht.
Das {~~kalte~>fahle~~} Licht.
Sie {++leise ++}{>>wirklich?<<}ging.
Sie {==ging==}{>>warum?<<} fort.
```

Pay particular attention to the substitution: the dotted rule must not collide with the deletion half's strikethrough or the insertion half's border. If it reads as mud, drop `text-underline-offset` to `2px` or reduce the dot contrast with `color-mix(in srgb, var(--text-accent) 60%, transparent)` — but do not move the mark back onto the quote.

- [ ] **Step 9: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts src/critic-render.test.ts styles.css
git commit -m "$(cat <<'EOF'
feat: mark constructs that carry a note

The last of the glyph's jobs. Without it a commented deletion and a bare
one look identical, and with the drawer closed the note is invisible.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Repair mode and the substitution separator

Two loose ends. The command is the only path to a visible brace in the whole plugin, and it needs to exist before this ships or a malformed construct is unfixable in Live Preview. The separator matters because substitutions are now on screen far more of the time.

**Files:**
- Modify: `src/main.ts` (`loadReview`)
- Modify: `styles.css`

**Interfaces:**
- Consumes: `unfoldEffect`, `criticField` (Tasks 1-2)
- Produces: the `toggle-markup-source` command

- [ ] **Step 1: Add the command**

In `src/main.ts`, extend the `critic-render` import:

```ts
import {
  criticEditorExtension,
  criticField,
  renderCriticMarkup,
  unfoldEffect,
  unfoldField,
} from "./critic-render";
```

Add to `loadReview()`, after the `open-review-panel` command:

```ts
    // The only way to see a brace in this plugin. Everything else keeps the
    // markup folded, which is right until a construct is malformed — then
    // there has to be a way in. No default hotkey: ⌘⇧M is the only binding
    // this plugin claims, and this is a repair tool, not a daily one.
    this.addCommand({
      id: "toggle-markup-source",
      name: "Show markup source at cursor",
      editorCheckCallback: (checking, editor) => {
        const cm = (editor as unknown as { cm?: CmEditorView }).cm;
        if (!cm) return false;

        const pos = cm.state.selection.main.head;
        const entry = cm.state
          .field(criticField)
          .find((e) => pos >= e.from && pos <= e.to);
        if (!entry) return false;

        if (!checking) {
          const open = cm.state.field(unfoldField);
          const showing = open !== null && open.from <= entry.from && open.to >= entry.to;
          cm.dispatch({
            effects: unfoldEffect.of(showing ? null : { from: entry.from, to: entry.to }),
          });
        }
        return true;
      },
    });
```

Add the CodeMirror view type at the top of `main.ts` — `review-view.ts:27` already does this the same way:

```ts
import type { EditorView as CmEditorView } from "@codemirror/view";
```

- [ ] **Step 2: Build to confirm it compiles**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 3: Verify the command by hand in Obsidian**

In a note containing `Das {~~kalte~>fahle~~} Licht.`:
1. Place the caret in `fahle`, run **Show markup source at cursor** from the palette. The braces and arrow appear, washed with `.sn-critic-revealed`.
2. Run it again — they fold away.
3. Reveal it again, then click elsewhere in the note. It folds back on its own.
4. With the caret in ordinary prose, confirm the command does not appear in the palette (the `editorCheckCallback` returns false).

- [ ] **Step 4: Add the substitution separator**

With `~>` hidden, `{~~kalte~>fahle~~}` renders as `kaltefahle` — the two halves run together. In `styles.css`, add after the `.sn-critic-substitution` strikethrough-cancel rule:

```css
/* The arrow is hidden, so without this the two halves run together as
   "kaltefahle". The same glyph the drawer card uses rather than a bare gap:
   paintQuote exists to make a card and its text look alike, and an arrow in
   one place against a space in the other would break that. */
.sn-critic-substitution .sn-critic-insertion::before {
  content: '→';
  padding: 0 0.25em;
  color: var(--text-faint);
  text-decoration: none;
  border-bottom: none;
}
```

- [ ] **Step 5: Verify the separator by hand**

Confirm in Live Preview and Reading view that `Das {~~kalte~>fahle~~} Licht.` reads as two distinct halves with an arrow between them, and that the arrow itself carries neither the strikethrough nor the insertion's underline.

If the `::before` inherits the insertion's `border-bottom` despite the reset, move the arrow to `.sn-critic-substitution .sn-critic-deletion::after` instead — it sits outside the insertion's box there.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Update the README**

`README.md` documents the plugin's commands and describes the editing model. Read it, and bring the CriticMarkup section in line: comments no longer render as a glyph, marked-up prose is directly editable, and the new **Show markup source at cursor** command exists for repairs. Keep the existing voice and length — this is an edit, not a rewrite.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts styles.css README.md
git commit -m "$(cat <<'EOF'
feat: add a repair command and separate the substitution halves

Everything else keeps the markup folded, which is right until a construct
is malformed — then there has to be a way in. Palette only; this is a
repair tool, not a daily one.

The arrow being hidden left "kaltefahle" running together, which matters
more now that substitutions are on screen far more of the time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After Task 8, run the spec's three pre-merge checks in a real vault. These cannot be done in Jest.

- [ ] **The Obsidian `~~` collision.** Put the caret inside the replacement half of `{~~kalte~>fahle~~}`. Confirm Obsidian's own `~~` markers stay hidden — the spec's reasoning says a `Decoration.replace` cannot be undone by another extension declining to add its own hide-decoration, but this is the one load-bearing claim in the design. If they do appear, the spec's promise of complete hiding needs rewording for substitutions specifically, and the finding belongs in the spec document.

- [ ] **A full editing pass.** Open a real scene with several suggestions. Write for a few minutes: click into marked-up prose, type, arrow through constructs, delete words near them. Confirm no brace ever appears, no keypress does nothing, and nothing corrupts.

- [ ] **The drawer still works.** Confirm clicking a card scrolls and flashes the entry; clicking a construct focuses its card when the drawer is open and does *not* open the drawer when it is closed; accept, reject and the bulk actions all still write correctly.

- [ ] **Reading view.** Confirm markup renders with no glyphs, `has-comment` shows, and no braces leak.

- [ ] **Undo.** Accept a suggestion, press ⌘Z, confirm the construct returns whole and folded.
