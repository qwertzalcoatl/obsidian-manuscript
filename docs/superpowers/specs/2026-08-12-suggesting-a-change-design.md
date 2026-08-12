# Suggesting a Change — Design Spec

**Date:** 2026-08-12
**Plugin:** Sheet Navigator (Obsidian)
**Status:** Approved
**Follows:** `docs/superpowers/specs/2026-08-11-writable-review-drawer-design.md`

---

## The problem

There is no way to propose new wording without a dialog box, and the reason is
that edit-through made the place you would type it invisible.

```
"Sie {++++}ging."        markers [4,7) and [7,10), body [7,7)
"Das {~~kalte~>~~} L."   markers [4,7) [12,14) [14,17), replacement [14,14)
```

Both markers are hidden, and the body between them has no width. An empty
insertion therefore renders as **nothing at all** — a zero-width point in the
prose with no way to see it and no way to find it. Nor can it be decorated:
CodeMirror throws `"Mark decorations may not be empty"` on a zero-width mark
(`@codemirror/view/dist/index.js:1382`), which is why `criticDecorations` guards
every mark with `nonEmpty` and skips it.

The caret can reach that offset — an empty body sits exactly *between* two
hidden ranges, and `skipAtomicRanges` only moves a position strictly inside one
— and typing there lands inside the construct correctly. Nothing on screen says
so. So the two authoring commands kept their modals, and `MarkupPromptModal` is
now the last dialog in a plugin whose first rule is that you never see syntax.

## What replaces them

One command, **Suggest a change**, with two modes:

| Selection | Writes | Caret |
|---|---|---|
| something | `{~~kalte~>~~}` | after the arrow, at the empty replacement |
| nothing | `{++++}` | between the two markers |

and a **placeholder** drawn where the caret lands, so the empty body is a place
you can see.

```
Das kalte Licht.          →   Das k̶a̶l̶t̶e̶ → ‹insert…› Licht.
        ‸────‼                              ‸

Sie ging.                 →   Sie ‹insert…› ging.
    ‸                                ‸
```

The caret offsets are safe for the reason the ⌘⇧M offset was not: `{>><<}` put
the caret in the middle of a single six-character hidden range, where the
construct was both invisible and atomic. An empty body is a boundary between two
ranges, not a position inside one.

## The placeholder

A `WidgetType` at the empty body's offset. A widget rather than a mark because a
zero-width mark throws, and it carries no state: *this body is empty* is a pure
function of the parse, read the same way `hiddenRanges` reads it. The first
keystroke makes the body non-empty, the widget's range disappears from the next
decoration set, and the ordinary insertion mark takes over.

It renders as **green italic text on a faint green wash**, which took two
revisions to reach and both are worth keeping.

The first version drew a dashed border. Edges made it an object sitting in the
sentence, so the first keystroke read as destroying something rather than
writing — the module docstring's rule against badges applies here after all.
Removing the border fixed that but left the hint saying nothing about what to do
with it. The wash says it: **marked text is something you type over.** It is the
same 14% and 2px radius `.sn-critic-highlight` uses, in the insertion's green
rather than the accent, so a highlight and a placeholder never read as the same
kind of thing — and no stronger than a highlight, for the reason
`.sn-critic-revealed` already gives.

```
Sie insert… ging.
    ░░░░░░░  14% green wash, italic, full size
```

**The caret cannot be inside it, however it is styled.** A widget is one atomic
element, so the caret always renders beside it; and a frame drawn on the body
collapses to nothing while the body has no width. So "the placeholder lives in a
box and you write in the box" is only reachable after the first keystroke, which
is what settles the question against a box at all. Established by rendering the
real decorations in a bare `EditorView`, not by reading the library.

Reading view gets none of it. A reader has nothing to type into, and an empty
construct there should stay what it is: nothing.

## Abandoning one

**Escape removes the construct** when the caret is in an empty body. That rides
the `Prec.high` keymap beside Backspace and Delete, and returns false everywhere
else — Obsidian's own Escape is untouched except in this one position.

Clicking away leaves the placeholder where it is. That is a deliberate choice
over the note field's *an empty note is not a note*, and the difference is worth
stating: a note lives in the drawer, where an empty one is a blank card that says
nothing. A placeholder lives in the manuscript, where it is visible, and removing
it on caret-leave would need the plugin's first `transactionFilter` — one that
has to re-check emptiness against `tr.newDoc`, or the very keystroke that fills
the placeholder also deletes it. The styling above is what makes leaving it safe.

**Backspace already removes it and needs no new code.** With the caret at the
placeholder, `constructToSelectOnDelete` probes `[pos-1, pos)`, hits the opening
marker, and selects the whole construct; the second press deletes it. Escape is
the convenience, not the mechanism.

## The arrow has to move

This is forced, not opportunistic. For `{~~kalte~>~~}` the replacement span is
zero-width, so its mark is skipped — and the arrow currently lives on
`.sn-critic-replacement::before`. Mode 1 would render `k̶a̶l̶t̶e̶ ‹insert…›` with
nothing between the halves, which is the exact ambiguity the arrow exists to
prevent.

So the `~>` marker stops being hidden and becomes a widget: its own element
between the two halves, drawn whether the replacement has text in it or not.
This is the shape `paintQuote` already builds on the drawer card, where the arrow
is a sibling span rather than generated content inside the replacement.

**It also fixes a defect that has been there all along.** The current CSS tries
to keep the arrow out of the insertion's underline:

```css
.sn-critic-replacement::before {
  content: '→';
  text-decoration: none;   /* inert */
  border-bottom: none;     /* inert */
}
```

Neither reset works. A `border-bottom` on an inline box spans its generated
content, and per CSS Text Decoration a descendant cannot remove a decoration its
ancestor draws. So the green line runs straight through the arrow today, joining
the two halves into the single underlined run the arrow was added to break up.
Once the arrow is its own element outside the insertion span, it carries nothing.

With `::before` gone, `sn-critic-replacement` has no rule left and no other
reader, so the class goes from both renderers. The card's `sheet-review-arrow`
becomes `sn-critic-arrow` too: one class, one rule, three surfaces, which is what
`paintQuote` exists for.

## Reading view

`Op` gains a third variant. The `~>` marker is currently a `hide`; it becomes a
replacement with text, so the same arrow appears there:

```ts
type Op =
  | { from: number; to: number; op: 'hide' }
  | { from: number; to: number; op: 'wrap'; cls: string; label: string }
  | { from: number; to: number; op: 'text'; text: string; cls: string };
```

## The drawer

An empty insertion is an entry like any other, so it gets a card, and
`paintQuote` renders `entry.quote.trim()` into a span that is empty — a card with
a blank line where the quote should be. Since a placeholder can be left behind,
these cards persist, so the empty case has to be drawn rather than left blank.

It draws the same `‹insert…›` the manuscript does, in the same class. That is
`paintQuote`'s standing job: a card and its text look alike.

## What the command writes

The arithmetic that broke ⌘⇧M is the arithmetic here, so it moves out of `main.ts`
and into a pure function next to the other transforms:

```ts
suggestChange(selection: string): { text: string; caret: number }
```

`caret` is an offset into `text`. `main.ts` writes `text` and places the caret at
`start + caret`, and nothing about marker lengths lives in the command any more.

This is testable in the way the ⌘⇧M bug was not: build an `EditorState` around
the result, ask `hiddenRanges` for the ranges, and assert the caret is not
strictly inside any of them. That is precisely the check that would have caught
the last one.

## The command surface

`suggest-insertion` and `suggest-replacement` are replaced by `suggest-change`,
named **Suggest a change**. No default hotkey — ⌘⇧M remains the plugin's only
binding. Typing *suggest* in the palette still turns up the suggestion types
together, which is now two commands rather than three; the comment above them
needs its count corrected.

Removing the two ids orphans any custom hotkey bound to them. This is a
single-author plugin and the trade is worth it, but it is a real change and not a
silent one.

**`{++selection++}` moves to the right-click menu.** Marking text already in the
manuscript as a proposed addition is the one case where a selection means
something other than *here is where I will write*, and it is the rarest of the
four. It keeps a home on the menu — which is the selection surface — without a
third palette command claiming the word *suggest*.

On the menu that leaves four items: *Comment on selection*, *Highlight
selection*, *Suggest deletion*, and *Suggest as addition* — the last renamed from
*Suggest insertion* to say what it does now that a selection means something else
everywhere. The menu keeps calling `wrapSelection`, which is unchanged.

`MarkupPromptModal` has exactly two users, both of them these commands. The class
and its roughly eighty lines go, and with them the last dialog in the plugin.

## Testing

Pure functions over state, driven through `EditorState` without an `EditorView`.

**`suggestChange`** — both modes' text; the caret lands after the arrow for a
replacement and between the markers for an insertion; a selection containing
`~>` or a brace still produces a construct that parses back to one entry.

**The caret is reachable.** For both modes, and for a handful of selections, the
caret offset is not strictly inside any range `hiddenRanges` reports. This is the
regression test for the class of bug that broke ⌘⇧M.

**`emptyBodyOf(entry)`** — the zero-width range wanting a placeholder: an
insertion with an empty body, a substitution with an empty replacement; null for
either with text, null for a deletion, a highlight or a comment, and null for a
substitution whose *quote* is empty, which is a malformed construct and repair
mode's business rather than this feature's.

**`emptyConstructAt(state, pos)`** — the construct Escape removes, found when
`pos` is exactly the empty body's offset. That is the only position in an empty
construct the caret can occupy: everything else in it is inside a hidden marker.
Null in open prose, null inside a body with text, and null when the construct is
showing its raw source, where the syntax is visible and editing it is the point.

**Decorations** — a placeholder widget for `{++++}` and for `{~~kalte~>~~}`; an
arrow widget on every substitution, including one whose replacement is empty;
neither on a filled insertion. The `paint` helper in `critic-live.test.ts` reads
`value.spec.class` and will need to report `spec.widget` as well.

**Reading view** — a substitution renders an arrow element outside both halves;
an empty replacement still renders the arrow; no placeholder is rendered at all.

## Verification before merge

1. **Mode 2.** Caret mid-sentence, run the command. The placeholder appears at
   the caret, the caret is visible against it, typing lands inside the construct
   and the placeholder disappears on the first keystroke.
2. **Mode 1.** Select a word, run the command. It goes red and struck through, an
   arrow follows it, the placeholder follows that, and the caret is in it.
3. **Escape** removes the construct from both modes and leaves the surrounding
   prose exactly as it was. Confirm Obsidian's own Escape still works everywhere
   else, including with a selection active and in a modal.
4. **Backspace twice** from the placeholder removes the construct.
5. **The arrow.** Confirm it carries neither the strikethrough nor the green
   underline, in Live Preview and in Reading view, and that a filled substitution
   and an empty one place it identically.
6. **Copy.** Select a paragraph containing a placeholder and copy it. The widget
   text must not come along — CodeMirror reads the clipboard from the document
   rather than the DOM, so it should not, but a placeholder pasted into a
   manuscript would be a bad way to find out.
7. **The drawer** shows a card for the empty construct with `‹insert…›` as its
   quote, and that card fills in as you type.

### Carried forward — still unverified

Neither of the two previous cycles has been run in Obsidian. This work touches
items 2 and 5 directly.

1. The Obsidian `~~` collision inside a substitution's replacement half.
2. A commented substitution stacking a dotted underline, a strikethrough, an
   underline and now an arrow *widget* rather than generated content — the
   stacking question is unchanged, but the arrow is no longer part of it.
3. The standalone-comment line collapse as a block decoration, including a note
   spanning two lines.
4. All four backspace boundaries, plus list-outdent elsewhere in a note.
5. Arrow traversal across a substitution — now across a widget.
6. The repair command, and the whole of the writable drawer.

## Out of scope

- **`has-comment` stacking.** Whether a commented insertion's dotted accent rule
  and its green underline read as two lines or as mud is a real question and it
  is not this one. It needs to be looked at, not reasoned about.
- **Degenerate constructs.** `{----}` and `{====}` still render as nothing. They
  can only come from hand-editing or a bad generation, and giving every empty
  construct a placeholder would mean inventing wording for cases that have no
  authoring path.
- **Suggestion mode** — typing automatically producing CriticMarkup.
- **Clean view** — a display mode rendering the note as accepted.
