# Suggesting a Change Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One **Suggest a change** command that writes an empty construct and puts the caret in it, with a visible placeholder standing where the words will go — replacing the plugin's last two modals.

**Architecture:** The marker arithmetic moves out of `main.ts` into a pure `suggestChange` beside the other transforms, and is regression-tested against `hiddenRanges` — the check that would have caught the ⌘⇧M bug. An empty body cannot be marked (CodeMirror throws on a zero-width mark), so it gets a widget; the substitution's arrow becomes a widget for the same reason, since an empty replacement's mark is dropped and generated content hung off it disappears with it.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), Obsidian plugin API, Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-08-12-suggesting-a-change-design.md`

## Global Constraints

- **No new dependencies.**
- **Branch:** `suggest-a-change`, off `writable-review-drawer`. Not `main`.
- **`src/critic.ts` gains one exported function** (`suggestChange`) and nothing else.
- **`src/review-view.ts` cannot be imported under test.** `src/__mocks__/obsidian.ts` has no `ItemView`, so the class definition throws at module evaluation. Its two changes here are one-liners verified by eye.
- **`nonEmpty()` is a trap.** Every body this feature cares about is zero-width. Ranges are tested with `from === to`, never with `nonEmpty`.
- **`Range` is ambiguous.** `src/critic.ts` exports `Range` as `{ from: number; to: number }`; `@codemirror/state` exports a generic `Range<T>`. Never import the latter into `critic-render.ts`.
- **Widgets name their own class.** Each `WidgetType` carries a `readonly cls`, used by `toDOM` and read by the test helper. Nothing else should have to know what a widget renders as.
- **Run tests with:** `npm test`. A single file: `npx jest src/critic.test.ts`. Build: `npm run build`. Typecheck: `npx tsc --noEmit`.
- **Commit style:** lowercase conventional prefix, imperative subject, body explaining *why* — see `git log`. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **House voice.** Comments explain why a thing is the way it is, in prose, and name the failure they prevent.

---

### Task 1: What the command writes

The arithmetic that broke ⌘⇧M, moved somewhere it can be tested. A selection becomes the half being replaced; nothing selected proposes an addition at the caret.

**Files:**
- Modify: `src/critic.ts` (new export, below `setComment`)
- Test: `src/critic.test.ts`, `src/critic-live.test.ts`

**Interfaces:**
- Produces: `suggestChange(selection: string): { text: string; caret: number } | null` — `caret` is an offset into `text`; null when the selection cannot be wrapped.

- [x] **Step 1: Write the failing tests**

Append to `src/critic.test.ts` (add `suggestChange` to the import from `./critic`):

```ts
describe('suggestChange — what the command writes', () => {
  it('proposes an addition when nothing is selected', () => {
    expect(suggestChange('')).toEqual({ text: '{++++}', caret: 3 });
  });

  it('proposes a replacement for a selection', () => {
    expect(suggestChange('kalte')).toEqual({ text: '{~~kalte~>~~}', caret: 10 });
  });

  it('puts the caret exactly at the empty body it wrote', () => {
    for (const selection of ['', 'kalte', 'ein längerer Satzteil']) {
      const change = suggestChange(selection);
      if (change === null) throw new Error('expected a change');
      const entry = parseCritic(change.text)[0];
      const body = entry.kind === 'insertion' ? entry.spans.quote : entry.spans.replacement;
      expect(body).toEqual({ from: change.caret, to: change.caret });
    }
  });

  it('parses back to exactly one entry', () => {
    expect(parseCritic('Sie {++++}ging.')).toHaveLength(1);
    const sub = parseCritic('Das {~~kalte~>~~} Licht.');
    expect(sub).toHaveLength(1);
    expect(sub[0].kind).toBe('substitution');
    expect(sub[0].quote).toBe('kalte');
    expect(sub[0].replacement).toBe('');
  });

  it("refuses a selection carrying the substitution's own markers", () => {
    // `~>` would split the construct in the wrong place and `~~}` would close
    // it early — both silently, both rewriting a manuscript.
    expect(suggestChange('a~>b')).toBeNull();
    expect(suggestChange('a~~}b')).toBeNull();
  });

  it('accepts a selection with a lone tilde, which breaks nothing', () => {
    expect(suggestChange('a~b')).toEqual({ text: '{~~a~b~>~~}', caret: 8 });
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic.test.ts -t suggestChange`
Expected: FAIL — `suggestChange` is not exported.

- [x] **Step 3: Implement**

In `src/critic.ts`, directly below `setComment`:

```ts
/**
 * What the Suggest a change command writes, and where the caret goes in it.
 *
 * Here rather than in the command because this is marker arithmetic, and marker
 * arithmetic in main.ts is what broke the comment hotkey: it put the caret three
 * characters into a six-character marker that edit-through had made both
 * invisible and atomic. These offsets are safe for the opposite reason — an
 * empty body is the boundary between two hidden ranges rather than a position
 * inside one — and critic-live.test.ts asserts exactly that against
 * hiddenRanges, which is the check the last one was missing.
 *
 * Both constructs are written empty on purpose. The words are typed into the
 * manuscript afterwards, which is where manuscript text belongs.
 */
export function suggestChange(selection: string): { text: string; caret: number } | null {
  if (selection === '') return { text: '{++++}', caret: 3 };

  // A selection carrying either of the substitution's own markers cannot be
  // wrapped in one: `~>` splits the construct in the wrong place and `~~}`
  // closes it early, and both do it quietly. Refusing beats guessing, for the
  // same reason resolvedText throws rather than picking an outcome.
  if (selection.includes('~>') || selection.includes('~~}')) return null;

  return { text: `{~~${selection}~>~~}`, caret: 3 + selection.length + 2 };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/critic.test.ts -t suggestChange`
Expected: PASS.

- [x] **Step 5: Write the regression test that matters**

The caret must be somewhere the caret can actually be. Append to `src/critic-live.test.ts` (add `suggestChange` to the `./critic` import, which currently brings in `parseCritic`):

```ts
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
```

- [x] **Step 6: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [x] **Step 7: Commit**

```bash
git add src/critic.ts src/critic.test.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
feat: work out what a suggested change writes

Marker arithmetic in main.ts is what broke the comment hotkey — the
caret went three characters into a six-character marker that had become
invisible and atomic. Moving it here makes it testable, and the test
that matters asserts the offset against hiddenRanges rather than against
a number someone counted by hand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The arrow becomes its own element

Forced by the empty replacement. Its mark is zero-width, CodeMirror drops it, and the `::before` hung off it goes with it — so `{~~kalte~>~~}` would render as two halves with nothing between them, which is the ambiguity the arrow exists to prevent.

**Files:**
- Modify: `src/critic-render.ts` (imports, new `ArrowWidget`, `criticDecorations`, `Op`, `applyOps`, `renderCriticMarkup`)
- Modify: `src/review-view.ts:416` (one line)
- Modify: `styles.css` (delete `.sn-critic-replacement::before` and `.sheet-review-arrow`, add `.sn-critic-arrow`)
- Test: `src/critic-live.test.ts:114`, `src/critic-render.test.ts:160-171`

**Interfaces:**
- Produces: the CSS class `sn-critic-arrow`, drawn in all three surfaces. `sn-critic-replacement` and `sheet-review-arrow` cease to exist.

- [x] **Step 1: Teach the test helper to see widgets**

A widget carries no `spec.class`, so `paint` currently reports it as an empty class — indistinguishable from a hidden marker. In `src/critic-live.test.ts`, add above `paint`:

```ts
/** A decoration's class, whether it marks text or replaces it with a widget. */
function classOf(value: { spec: unknown }): string {
  const spec = value.spec as { class?: string; widget?: { cls?: string } };
  return spec.class ?? spec.widget?.cls ?? '';
}
```

and use it in both collectors — `paint` and `paintUnfolded` — replacing `cls: (value.spec.class as string) ?? ''` with `cls: classOf(value)`.

- [x] **Step 2: Write the failing tests**

In `src/critic-live.test.ts`, line 114 expects the class the replacement no longer carries. Change:

```ts
      expect.objectContaining({ cls: 'sn-critic-insertion', text: 'fahle' })
```

Then append:

```ts
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
```

In `src/critic-render.test.ts`, replace the two blocks at lines 160-171 that query `.sn-critic-replacement`:

```ts
  it('marks the replacement half of a substitution', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    const halves = root.querySelectorAll('.sn-critic-insertion');
    expect(halves).toHaveLength(1);
    expect(halves[0].textContent).toBe('fahle');
  });

  it('renders the arrow as its own element between the halves', () => {
    const root = render('<p>Das {~~kalte~>fahle~~} Licht.</p>');
    expect(root.querySelector('.sn-critic-arrow')?.textContent).toBe('→');
    expect(root.textContent).toBe('Das kalte→fahle Licht.');
  });

  it('renders the arrow when the replacement is empty', () => {
    const root = render('<p>Das {~~kalte~>~~} Licht.</p>');
    expect(root.querySelector('.sn-critic-arrow')?.textContent).toBe('→');
  });

  it('draws no placeholder — a reader has nothing to type into', () => {
    const root = render('<p>Sie {++++}ging.</p>');
    expect(root.querySelector('.sn-critic-placeholder')).toBeNull();
    expect(root.textContent).toBe('Sie ging.');
  });
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts src/critic-render.test.ts`
Expected: FAIL — no `sn-critic-arrow` is produced anywhere.

- [x] **Step 4: Add the widget**

In `src/critic-render.ts`, add `WidgetType` to the `@codemirror/view` import:

```ts
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view';
```

and add below `const HIDDEN`:

```ts
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
  readonly cls = 'sn-critic-arrow';

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = '→';
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
 * Identified by position rather than by index into `spans.markers`: the arrow
 * is the one that begins where the quoted half ends, which stays true even when
 * that half is itself empty.
 */
function isArrowMarker(entry: Entry, marker: Range): boolean {
  return entry.kind === 'substitution' && marker.from === entry.spans.quote?.to;
}
```

- [x] **Step 5: Use it in Live Preview**

In `criticDecorations`, replace the marker loop:

```ts
    for (const marker of entry.spans.markers) {
      if (!nonEmpty(marker)) continue;
      ranges.push({
        from: marker.from,
        to: marker.to,
        value: isArrowMarker(entry, marker) ? ARROW : HIDDEN,
      });
    }
```

and drop the second class from the replacement mark, along with the comment explaining it — the separator is not carried there any more:

```ts
    mark(entry.spans.replacement, 'sn-critic-insertion');
```

- [x] **Step 6: Use it in Reading view**

In `src/critic-render.ts`, widen `Op`:

```ts
type Op =
  | { from: number; to: number; op: 'hide' }
  | { from: number; to: number; op: 'wrap'; cls: string; label: string }
  | { from: number; to: number; op: 'text'; text: string; cls: string };
```

In `applyOps`, the slice loop needs an index so a `text` op writes one element rather than one per node. Replace the inner loop:

```ts
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
        // A marker split across text nodes would otherwise get one arrow per
        // node. Only the first slice becomes the element; the rest just go.
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
```

In `renderCriticMarkup`, replace the marker loop:

```ts
      for (const marker of entry.spans.markers) {
        if (!nonEmpty(marker)) continue;
        if (isArrowMarker(entry, marker)) {
          ops.push({ ...marker, op: 'text', text: '→', cls: 'sn-critic-arrow' });
        } else {
          ops.push({ ...marker, op: 'hide' });
        }
      }
```

and drop the second class from the replacement op:

```ts
          cls: 'sn-critic-insertion',
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/critic-live.test.ts src/critic-render.test.ts`
Expected: PASS.

- [x] **Step 8: Move the drawer card onto the same class**

In `src/review-view.ts:416`:

```ts
      el.createSpan({ cls: 'sn-critic-arrow' }).setText('→');
```

- [x] **Step 9: Replace the styles**

In `styles.css`, **delete** the whole `.sn-critic-replacement::before` block including its comment, and **delete** the `.sheet-review-arrow` block. Add in the deleted `::before`'s place:

```css
/* Between a substitution's halves. Its own element rather than generated
   content inside the replacement: an empty replacement has a zero-width mark,
   which CodeMirror drops, and content generated inside the insertion's box
   wears the green underline no matter what it declares. The same class in the
   editor, in Reading view and on the drawer card — which is what paintQuote
   exists for, so a card and its text look alike. */
.sn-critic-arrow {
  color: var(--text-faint);
  padding: 0 0.3em;
  user-select: none;
}
```

- [x] **Step 10: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 11: Verify by hand in Obsidian**

In a note containing `Das {~~kalte~>fahle~~} Licht.`:

1. In Live Preview, confirm the arrow sits between the halves and carries **neither** the strikethrough nor the green underline. It carries the underline today, which is the defect this removes.
2. Same in Reading view.
3. Open the drawer and confirm the card's arrow is identical to the editor's.
4. Arrow-key across the construct from right to left. The arrow is a replaced range like any other marker, so it should be one press — confirm no press appears to do nothing.

- [x] **Step 12: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts src/critic-render.test.ts src/review-view.ts styles.css
git commit -m "$(cat <<'EOF'
feat: draw the substitution arrow as its own element

Forced by the empty replacement a suggested change starts from: its mark
is zero-width, CodeMirror drops it, and the ::before hung off it goes
too — leaving two halves with nothing between them exactly while one is
being written.

It also fixes a defect that was already there. The old rule declared
text-decoration: none and border-bottom: none on the pseudo-element and
neither did anything: a border spans its generated content, and a
descendant cannot cancel a decoration its ancestor draws. The green
underline has been running straight through the arrow all along.

One class now, in the editor, in Reading view and on the card.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: A placeholder where the body is empty

The heart of it. An empty body has no width, both its markers are hidden, and a zero-width mark throws — so the place you type is invisible until something is drawn there.

**Files:**
- Modify: `src/critic-render.ts` (new `PlaceholderWidget`, `emptyBodyOf`, `criticDecorations`)
- Modify: `src/review-view.ts` (`paintQuote`)
- Modify: `styles.css`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `criticField`, `unfoldField`, `isRevealed`
- Produces: `emptyBodyOf(entry: Entry): Range | null` — exported, used by Task 4; the CSS class `sn-critic-placeholder`

- [x] **Step 1: Write the failing tests**

Append to `src/critic-live.test.ts` (add `emptyBodyOf` to the `./critic-render` import):

```ts
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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts -t "emptyBodyOf|placeholder"`
Expected: FAIL — `emptyBodyOf` is not exported.

- [x] **Step 3: Implement the widget and the rule**

In `src/critic-render.ts`, below `ArrowWidget`:

```ts
/**
 * Where the words go, before there are any.
 *
 * The one badge in the plugin, and the exception is narrow: the rule against
 * them is about how an edit is shown, and this is not an edit being shown. It
 * is an instruction to the writer, and one that stays put if you click away
 * from it, so it has to be impossible to mistake for the manuscript.
 */
class PlaceholderWidget extends WidgetType {
  readonly cls = 'sn-critic-placeholder';

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = 'insert…';
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
```

In `criticDecorations`, add directly after `if (revealed) continue;` — a construct showing its raw source has its braces on screen, which says where to type without any help:

```ts
    const empty = emptyBodyOf(entry);
    if (empty !== null) {
      ranges.push({ from: empty.from, to: empty.to, value: PLACEHOLDER });
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/critic-live.test.ts -t "emptyBodyOf|placeholder"`
Expected: PASS.

- [x] **Step 5: Draw the same thing on the card**

An empty insertion is an entry like any other, so the drawer gives it a card — with a blank line where the quote should be. In `src/review-view.ts`, replace `paintQuote`'s body below the comment branch:

```ts
    const span = (text: string, cls: string) => el.createSpan({ cls }).setText(text);
    // The manuscript's own placeholder, on the card. Exact emptiness rather
    // than trimmed, so the two agree: {++  ++} has a body and gets no
    // placeholder in either place.
    const placeholder = () =>
      el.createSpan({ cls: 'sn-critic-placeholder' }).setText('insert…');

    if (entry.kind === 'substitution') {
      span(entry.quote.trim(), 'sn-critic-deletion');
      el.createSpan({ cls: 'sn-critic-arrow' }).setText('→');
      const replacement = entry.replacement ?? '';
      if (replacement === '') placeholder();
      else span(replacement.trim(), 'sn-critic-insertion');
      return;
    }

    if (entry.kind === 'insertion' && entry.quote === '') {
      placeholder();
      return;
    }

    const cls =
      entry.kind === 'insertion'
        ? 'sn-critic-insertion'
        : entry.kind === 'deletion'
          ? 'sn-critic-deletion'
          : 'sn-critic-highlight';
    span(entry.quote.trim(), cls);
```

- [x] **Step 6: Add the style**

In `styles.css`, after the `.sn-critic-arrow` rule:

```css
/* Where the words go, before there are any.

   A wash rather than a border, and the difference is the whole point: edges
   make it an object sitting in the sentence, so typing reads as destroying
   something, while a wash reads as marked text — and marked text is something
   you type over. The same 14% and 2px radius .sn-critic-highlight uses, in the
   insertion's own green, so the two never read as the same kind of thing. Not
   stronger than a highlight, for the reason .sn-critic-revealed gives.

   Full size, not shrunk: marked text is the size of the words around it. The
   smaller face was compensating for having nothing else to say "this is not
   manuscript", and the wash says it now.

   inline-block so no decoration on a surrounding construct paints through it,
   and the margin is breathing room against the next word — both gone on the
   first keystroke anyway. */
.sn-critic-placeholder {
  display: inline-block;
  padding: 0 0.15em;
  margin: 0 0.1em;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--color-green, #4caf50) 14%, transparent);
  color: color-mix(in srgb, var(--color-green, #4caf50) 85%, var(--text-normal));
  font-style: italic;
  user-select: none;
}
```

**Revised twice after seeing it**, and the CSS above is where it landed.

Round one: the dashed border read as an object being destroyed on the first
keystroke. Four variants were rendered side by side — no border, a frame
arriving as you write, a box persisting from hint to words — and no border won.
The finding that decided it: a widget is atomic, so the caret can never be
inside its box, and a frame on the body collapses while the body has no width,
so "you write inside the placeholder" is unreachable before the first keystroke.

Round two: with no border the hint said nothing about what to do with it. A wash
does — marked text is something you type over. Three strengths were rendered
against a real `{==highlight==}` sitting beside it; 24% out-shouted the
highlight, and dropping the 0.85em shrink mattered as much as the wash, since
marked text is the size of the words around it.

- [x] **Step 7: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [x] **Step 8: Verify by hand in Obsidian**

**Done, and it found something.** The caret rendered to the *left* of the
placeholder box, which reads as the caret being outside it. A harness rendering
the real decorations in a real CodeMirror settled where the blame lay:

| caret at | placeholder draws |
|---|---|
| the empty body | to its **right** — correct |
| the end of the construct | to its **left** — what Obsidian showed |

Adding an Obsidian-style `~~` strikethrough mark changed nothing, so it was not
decoration ordering. The caret was simply never landing where `suggestChange`
put it, which also means typing went *outside* the construct. Fixed in Task 5 by
dispatching the change and the selection as one CodeMirror transaction.

The harness is worth rebuilding if this comes up again — an entry that imports
`criticEditorExtension` into a bare `EditorView`, bundled with
`npx esbuild <entry> --bundle --format=iife`, served over http (Chrome will not
navigate to `file://`), probed with `view.coordsAtPos(pos)` rather than by
reading the drawn cursor, which lags a frame behind the state.

Type `Sie {++++}ging.` and `Das {~~kalte~>~~} Licht.` into a note by hand — the command does not exist until Task 5.

1. Both show the placeholder, and the second shows the arrow before it.
2. Click just before the placeholder and type. The characters land inside the construct and the placeholder disappears on the first one.
3. Confirm the caret is visible next to the placeholder rather than hidden behind it. If it renders on the wrong side, `side: 1` is the knob — try `side: -1`.
4. Select the whole paragraph and copy it into a scratch note. The word `insert…` must not come along: CodeMirror reads the clipboard from the document rather than the DOM, so it should not, but a placeholder pasted into a manuscript is a bad way to find out.
5. Open the drawer and confirm the card for each shows the same placeholder.

- [x] **Step 9: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts src/review-view.ts styles.css
git commit -m "$(cat <<'EOF'
feat: show where the words go before there are any

An empty body has no width and both its markers are hidden, so an empty
insertion rendered as nothing at all — a point in the prose with no way
to see it and no way to find it. That is why the two authoring commands
still had modals.

A widget rather than a mark because CodeMirror throws on a zero-width
one, and no new state: whether a body is empty is a fact about the parse.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Escape removes an empty construct

The way out when you change your mind. Backspace twice already does it — `constructToSelectOnDelete` hits the opening marker from the placeholder and selects the whole thing — so this is the convenience, not the mechanism.

**Files:**
- Modify: `src/critic-render.ts` (new `emptyConstructAt`, the `Prec.high` keymap)
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: `emptyBodyOf` (Task 3), `criticField`, `unfoldField`, `isRevealed`
- Produces: `emptyConstructAt(state: EditorState, pos: number): Range | null`

- [x] **Step 1: Write the failing test**

Append to `src/critic-live.test.ts` (add `emptyConstructAt` to the import):

```ts
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx jest src/critic-live.test.ts -t emptyConstructAt`
Expected: FAIL — `emptyConstructAt` is not exported.

- [x] **Step 3: Implement**

In `src/critic-render.ts`, below `constructToSelectOnDelete`:

```ts
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
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx jest src/critic-live.test.ts -t emptyConstructAt`
Expected: PASS.

- [x] **Step 5: Bind the key**

In `src/critic-render.ts`, below `selectRatherThanBreak`:

```ts
/**
 * Throws away a construct you started and did not write into.
 *
 * Returns false everywhere else, which is nearly everywhere — Escape belongs to
 * Obsidian, and the one position this claims it in is a placeholder the caret
 * only reaches by having just asked for it.
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
```

and add the binding to the existing `Prec.high(keymap.of([…]))` array in `criticEditorExtension`:

```ts
        { key: 'Escape', run: discardEmptyConstruct },
```

- [x] **Step 6: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 7: Verify by hand in Obsidian**

With `Sie {++++}ging.` typed by hand:

1. Click at the placeholder, press Escape. The construct goes and the line reads `Sie ging.` with the caret where it was.
2. Press ⌘Z. It comes back whole.
3. Press Escape with the caret in ordinary prose, with a selection active, and with a modal open. Obsidian's own behaviour must be unchanged in all three — this binding is at `Prec.high` and runs ahead of everything.
4. From the placeholder, press ⌫ twice instead. The construct should be selected by the first press and gone after the second.

- [x] **Step 8: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
fix: let Escape throw away a construct you did not write into

Backspace twice already removed one — the probe hits the opening marker
from the placeholder and selects the whole thing — but changing your
mind should not take two presses of a key that means delete. Escape
claims exactly one position and returns false everywhere else.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The command, and the last modal

**Files:**
- Modify: `src/main.ts` (imports, `MarkupPromptModal` deletion, `loadReview`'s commands and menu)
- Modify: `README.md`

**Interfaces:**
- Consumes: `suggestChange` (Task 1)
- Produces: the `suggest-change` command. `suggest-insertion` and `suggest-replacement` cease to exist.

- [x] **Step 1: Replace the two commands**

In `src/main.ts`, add `suggestChange` to the `./critic` import. Then replace both the `suggest-insertion` and `suggest-replacement` `addCommand` blocks with one:

```ts
    // The only command that works without a selection, because that is the
    // difference between its two modes rather than a special case: with a
    // selection it proposes a replacement for what you picked, without one an
    // addition where the caret is. Both write the construct empty and put the
    // caret inside it — the words are manuscript text, and manuscript text is
    // typed in the manuscript.
    this.addCommand({
      id: "suggest-change",
      name: "Suggest a change",
      editorCallback: (editor) => {
        const change = suggestChange(editor.getSelection());
        if (change === null) {
          new Notice(
            "This selection contains ~> or ~~}, which a replacement cannot hold. Shorten it and try again."
          );
          return;
        }

        const start = editor.posToOffset(editor.getCursor("from"));
        editor.replaceSelection(change.text);
        editor.setCursor(editor.offsetToPos(start + change.caret));
        void this.activateReviewView(false);
      },
    });
```

- [x] **Step 2: Correct the comment above the suggestion commands**

The block comment above `addSelectionCommand("comment-on-selection", …)` says *"typing 'suggest' in the palette turns up all three suggestion types together"*. There are two now:

```ts
    // One command per construct the format supports, named so that typing
    // "suggest" in the palette turns up both suggestion commands together and
    // "markup" turns up the whole-note actions.
```

- [x] **Step 3: Rename the menu item**

In the `editor-menu` handler, the fourth item wraps a selection in `{++…++}`. That is now the only place that act lives, and its old name reads as the command that no longer exists:

```ts
        wrap("Suggest as addition", "diff", "insertion");
```

- [x] **Step 4: Delete the modal**

Delete the `MarkupPromptModal` class, `src/main.ts:1180-1227` — from `class MarkupPromptModal extends Modal {` through the closing brace before `class ConfirmModal`. Confirm nothing else references it:

Run: `grep -n "MarkupPromptModal" src/main.ts`
Expected: no output.

**Leave the `obsidian` import alone.** `Modal` still has two subclasses in this file, `RenameModal` at :1112 and `ConfirmModal` at :1230, and `Setting` is used by both of those and by the settings tab.

- [x] **Step 5: Build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 6: Verify by hand in Obsidian**

1. **Mode 2.** Put the caret mid-sentence and run **Suggest a change**. The placeholder appears at the caret, the caret is in it, and typing lands inside the construct. The drawer opens without stealing the caret.
2. **Mode 1.** Select a word and run it. The word goes red and struck through, the arrow follows, the placeholder follows that, and the caret is in it. Type; confirm the drawer's card shows `kalte → fahle`.
3. **Escape** from either leaves the prose exactly as it was — including Mode 1, where the selected word must come back unmarked.
4. Select text containing `~>` and run it. The notice appears and nothing is written.
5. Confirm **Suggest insertion…** and **Suggest replacement…** are gone from the palette and no dialog opens anywhere in the plugin.
6. Right-click a selection and confirm **Suggest as addition** still wraps it in `{++…++}`.

- [x] **Step 7: Bring the README in line**

Four edits. Keep the existing voice and length.

1. The command table: **delete** the `Suggest insertion…` and `Suggest replacement…` rows and add one in their place:

```
| Suggest a change | no | with a selection `{~~alt~>neu~~}`, without one `{++Text++}` — either way you type the new wording in the manuscript |
```

2. The sentence below the table, *"The four wrapping commands are also on the editor's right-click menu"* — the menu now carries **Suggest as addition**, which has no command of its own. Say so.

3. **Editing a marked-up draft** — add that a construct you have started but not written into shows a dashed placeholder where the words go, that Escape throws it away, and that this is the only badge the plugin draws.

4. **Known limitations** — add that a selection containing `~>` or `~~}` cannot become a replacement, since the format has no escape syntax and the construct would break.

- [x] **Step 8: Commit**

```bash
git add src/main.ts README.md
git commit -m "$(cat <<'EOF'
feat: one command for a suggested change, and no more dialogs

There was no way to propose new wording without a modal, because the
place you would type it was invisible: an empty body has no width and
both its markers are hidden. With a placeholder standing there, the
dialog has nothing left to do.

Two commands become one, because with and without a selection is the
difference between its modes rather than a special case. Marking text
already written as an addition keeps its home on the right-click menu.

MarkupPromptModal was the last dialog in the plugin.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

In a real vault. None of this can be reached from Jest.

- [ ] **A writing pass.** Open a scene and propose several changes — some replacing a word, some adding one, some abandoned with Escape. Confirm no brace ever appears, the placeholder never survives a keystroke, and every construct ends up in the drawer with the right two halves.
- [ ] **A placeholder left behind.** Start one, click away, carry on writing elsewhere, then come back to it. Confirm it is still legible as an instruction rather than as prose, and that Escape from it still works.
- [ ] **Undo.** Run the command, type a word, press ⌘Z until you are back to plain prose. Confirm nothing partial survives.
- [ ] **Reading view** shows the arrow between a substitution's halves, no placeholder anywhere, and an empty replacement rendering as a dangling arrow — which is the accepted cost of a construct being read mid-authoring.

### Carried forward — still unverified

Neither of the two previous cycles has been run in Obsidian. This is the third.

- [ ] **The Obsidian `~~` collision** inside a substitution's replacement half.
- [ ] **The whole writable drawer** — the ⌘⇧M handoff first, which is the likeliest failure and has its fallback written out in `docs/superpowers/plans/2026-08-11-writable-review-drawer.md`, Task 7 Step 6.
- [ ] **The standalone-comment line collapse** as a block decoration, including a note spanning two lines.
- [ ] **Backspace boundaries**, all four, plus list-outdent elsewhere in a note.
- [ ] **A commented substitution**, which stacks a dotted underline, a strikethrough and an underline. The arrow is no longer part of that pile.
- [ ] **The repair command** — toggle on, toggle off, auto-fold on clicking away.
