# CriticMarkup Edit-Through — Design Spec

**Date:** 2026-08-11
**Plugin:** Sheet Navigator (Obsidian)
**Status:** Approved

---

## The problem

Marked-up prose is not editable prose. Put the caret inside `{==passage==}{>>warum?<<}` and the whole construct unfolds: braces appear, the comment glyph expands into full inline text, the line reflows under the cursor. The writer wanted to fix a word and is now looking at syntax.

The practical consequence, in the author's words: *to edit, you have to essentially resolve the comment, then work on it.* Resolving is a decision. Being forced to make it just to gain typing access is the defect.

The cause is one line, `src/critic-render.ts:89`:

```ts
const revealed = state.selection.ranges.some(
  (r) => r.from <= entry.to && r.to >= entry.from
);
```

`entry.to` includes the attached comment, so a caret anywhere in `passage` unfolds the note as well. This is the standard Live Preview contract, and it is right for `**bold**`, where the markers *are* what you might want to edit. It is wrong here, because the prose inside an editorial construct is just prose.

## The principle

Two rules decide everything below.

**The caret goes wherever text is visible, and is blocked only where text is hidden.** No per-kind exceptions — you can put a caret in struck-through `kalte` precisely because you can see `kalte`. Markers and comment bodies are the only unreachable places, and they are unreachable because they are not on screen.

**The comment lives in the drawer.** The editor pane shows the manuscript; the Review drawer is the entire editorial layer. Nothing about a comment renders in the prose beyond the fact that its anchor is marked.

Together these mean: **in ordinary writing you never see a brace.** Reveal stops being a function of the caret and becomes an explicit repair mode you enter deliberately.

## Why complete hiding is achievable

The concern worth answering first: `styles.css` already cancels `.cm-strikethrough` because Obsidian's own parser reads the `~~` in `{~~alt~>neu~~}` as strikethrough. Obsidian also reveals its own markers on caret entry, and that decoration is not ours to suppress.

It does not matter. Hiding in CodeMirror is **additive** — `Decoration.replace` removes text from the rendered output, and there is no anti-decoration. Obsidian does not reveal its `~~` by adding something; it reveals by *omitting* its own hide-decoration when the caret is in the node, and an omission cannot defeat a replace. Our marker span strictly contains theirs: for `{~~kalte~>fahle~~}` the opening marker is `[from, from+3)` = `{~~`, which swallows Obsidian's `~~` at `[from+1, from+3)`. Same at the close.

So once `revealed` stops firing from caret proximity, Obsidian's reveal has nothing left to reveal. **Verify in the real app before merging** (see Verification below); the reasoning is sound but the claim is load-bearing.

## Architecture

`criticField` currently owns both the parse and the decorations, with the reveal decision buried in a cache keyed on `docChanged`. Layering explicit reveal state on top creates a cycle: decorations need the reveal state, and the reveal state needs entry ranges to know when to expire. Splitting them breaks it.

```
unfoldField    StateField<Range | null>       the construct showing raw source,
                                              mapped through edits, cleared when
                                              the selection stops touching it

criticField    StateField<Entry[]>            parse only — still cached on docChanged

decorations    EditorView.decorations
                 .compute([criticField, unfoldField, "selection"], …)

atomicRanges   EditorView.atomicRanges.of(view => hiddenRanges(view.state))

keymap         Prec.high(keymap.of([Backspace, Delete]))
```

Storing a **range** rather than an entry index is what keeps `unfoldField` independent of `criticField`: it captures the construct's extent at unfold time and maps it forward through `tr.changes`, so it never consults the parse. That breaks the cycle.

The facet dependency form is legal — `@codemirror/state/dist/index.d.ts:593` declares `Slot<T> = FacetReader<T> | StateField<T> | "doc" | "selection"`.

`decorate()` itself barely changes. `revealed` goes from selection-overlap to `unfold !== null && unfold covers entry`.

## Decorations

For each entry, unless it is the one showing raw source:

| Span | Treatment |
|---|---|
| `spans.markers` | `Decoration.replace({})` — hidden |
| `spans.comment` | `Decoration.replace({})` — hidden, **no widget** |
| `spans.quote` | `Decoration.mark` with `QUOTE_CLASS[kind]` |
| `spans.replacement` | `Decoration.mark` with `sn-critic-insertion` |
| whole construct, substitutions only | `sn-critic-substitution` (existing strikethrough cancel) |
| whole construct, when `entry.comment !== null` | `sn-critic-has-comment` |
| whole construct, when raw-revealed | `sn-critic-revealed` wash |

`has-comment` goes on a construct-wide mark, not on `spans.quote`. A substitution's quote is its struck-through half, and a dotted underline drawn across struck text is mud; spanning the whole construct also means one rule works identically for all four anchored kinds. Only substitutions carry a construct-wide mark today, so this generalises that span rather than adding a new kind of decoration.

The `has-comment` modifier is the only survivor of the glyph's job. With no bubble and a possibly-closed drawer, it is the sole thing telling the writer a note exists — `{--ging--}` and `{--ging--}{>>zu spät?<<}` must not look identical. It has to be legible at a glance, not a subtlety.

### Atomic ranges

The rule is exactly the model sentence: **atomic = hidden.** Every range the table above replaces is contributed to `EditorView.atomicRanges`.

This works because `skipAtomicRanges` (`@codemirror/view/dist/index.js:3792`) only moves a position that is *strictly* inside a range:

```js
if (pos > from && pos < to) { … }
```

So the caret can rest at offset 3 in `{--ging--}` — the start of `ging`, which is the closing edge of the marker `[0,3)` — but arrow-left from there computes offset 2, finds it strictly inside, and skips to 0. The markers become one step in either direction, and no keypress is ever swallowed.

## Deletion

`atomicRanges` does **not** give the wanted behaviour, and this is worth stating plainly because the name suggests otherwise. With the caret at offset 3 in `{--ging--}`:

- if Obsidian's bundled delete command ignores `atomicRanges`: backspace eats one `-` → `{-ging--}` → silently plain text (today's bug);
- if it honours them: backspace extends over the whole marker → `ging--}` → still broken, just faster.

Both outcomes corrupt the construct. So Backspace and Delete are handled explicitly at `Prec.high`, in front of Obsidian's own bindings.

The decision is a pure function:

```ts
constructToSelectOnDelete(
  entries: Entry[],
  hidden: Range[],
  pos: number,
  forward: boolean
): Range | null
```

It asks whether the single character the keystroke would remove — `[pos-1, pos)` backward, `[pos, pos+1)` forward — intersects any hidden range. If so it returns the owning entry's `{from, to}`; otherwise `null`.

The handler selects that range and consumes the key. The **second** press deletes a non-empty selection through the ordinary path, as one undo step.

All four boundaries of `{--ging--}` (markers `[0,3)` and `[7,10)`, body `[3,7)`) behave correctly under this rule:

| Caret | Key | Probe | Result |
|---|---|---|---|
| 0 (before `{`) | ⌫ | `[-1,0)` | no intersection → deletes the character before the construct |
| 3 (before `g`) | ⌫ | `[2,3)` | hits `[0,3)` → selects `[0,10)` |
| 7 (after `g`) | ⌦ | `[7,8)` | hits `[7,10)` → selects `[0,10)` |
| 10 (after `}`) | ⌫ | `[9,10)` | hits `[7,10)` → selects `[0,10)` |

When an entry is showing raw source its markers are not hidden, contribute no atomic ranges, and deletion behaves normally on visible syntax — which is the point of repair mode.

**The second press is a raw delete, not an accept or reject.** `Das {~~kalte~>fahle~~} Licht.` becomes `Das  Licht.`, both halves gone, two spaces left. That is what selecting the text and pressing delete has always done, and it is undoable.

## Click

Unchanged in effect from today, and simpler in code.

`criticEditorExtension` finds the entry under the pointer and calls `onReveal(entry.from)`, which routes to `focusReviewCard` and highlights the matching drawer card **if the drawer is open**. It does not open it. The reasoning at `src/main.ts:1461` — *"having a sidebar spring out each time would be the plugin interrupting rather than answering"* — gets stronger under edit-through, not weaker: clicking into marked-up prose stops being a review gesture and becomes the ordinary act of writing a sentence. In a scene carrying twenty suggestions the drawer would fling itself open all afternoon.

The drawer already opens at the right moments — `wrapSelection` calls `activateReviewView(false)` whenever markup is created, and there is a command and the ribbon. By the time editorial work is happening, it is open, and click→focus does the right thing.

**Revert `mousedown` to `click`.** The handler currently uses `mousedown` to work around a problem this change deletes:

> *Revealing the construct rebuilds the line's DOM under the pressed button, and the browser swallows the click entirely when the pressed element does not survive to mouseup.*

Nothing rebuilds on press any more, so the element survives to mouseup and `click` fires normally. The workaround and its comment both go.

## Repair mode

One command, `Show markup source at cursor`, in the palette with **no default hotkey** — matching `highlight-selection` and `suggest-deletion`. `⌘⇧M` remains the plugin's only default binding.

It toggles `unfoldField` between `null` and the range of the entry under the caret. The construct also folds itself back when the selection stops touching it, so a forgotten unfold cannot linger.

This is the **only** path to a visible brace.

## Standalone comments

`{>>note<<}` with no anchored text has `quote: ''` and `spans.comment` covering the whole construct. Under drawer-only comments it renders as nothing at all, and there is no anchor to carry `has-comment`.

This is an accepted loss. An unanchored note is findable in the drawer, which shows it with `entry.line` as context (`paintQuote`'s `is-context` branch), and the navigator's toolbar badge counts it via `parseCritic(...).length` (`src/main.ts:481`) — so a note nobody noticed still shows up in the count.

**One artifact needs handling.** A standalone comment alone on its own line leaves an empty line in the middle of the prose once its text is hidden — visibly worse than the glyph it replaced. Where the construct is the only non-whitespace content on its line, the decoration extends to a `Decoration.replace({block: true})` over the line and its newline, collapsing it entirely. This mirrors what `applyEdits` in `src/critic.ts` already does when resolving such a comment: *"An edit that empties the line it sits on takes the line with it."*

Block decorations must sit on line boundaries and can interact awkwardly with caret placement. If this proves troublesome inside Obsidian's editor, the fallback is to leave the line in place and hide only the construct, accepting the blank line. The inline case — a standalone comment sitting mid-paragraph — needs none of this and simply disappears.

## Reading view

Same rules. `renderCriticMarkup` drops its `glyph` op; comments are hidden, anchors keep their decoration and gain `has-comment`. A reader wants the manuscript, and an unanchored editorial note has no business interrupting it — which is also what the function's existing docstring already says about native `%%…%%`.

The `CommentGlyph` widget class, the `glyph` branch of `applyOps`, and every `.sn-critic-glyph` rule in `styles.css` are deleted.

## Styling

1. **`cursor: pointer` → `cursor: text`** on `.cm-content .sn-critic-insertion`, `.sn-critic-deletion`, `.sn-critic-highlight`. They are editable prose now, not click targets. The companion rule overriding cursor inside `.sn-critic-revealed` becomes redundant and goes.
2. **`has-comment`** — a **dotted** underline layered on whatever the construct kind already draws. Dotted rather than doubled because the two existing decorations are both solid — a strikethrough on deletions, a bottom border on insertions — so a dotted rule reads as a different kind of statement rather than a heavier version of the same one.
3. **Substitution separator.** With `~>` hidden, `{~~kalte~>fahle~~}` renders as `k̶a̶l̶t̶e̶f̲a̲h̲l̲e̲` — joined, no gap. `styles.css:388-400` gives the deletion a strikethrough and the insertion a bottom border and nothing between them; the drawer card has an explicit `→` (`sheet-review-arrow`) but the editor has nothing. Add a faint `→` via `::before` on the insertion half inside `.sn-critic-substitution` — the same glyph the card uses, because `paintQuote` exists to make a card and its text look alike and a bare margin in one place against an arrow in the other would break that. Pre-existing, but complete hiding is what makes it matter, since substitutions are now on screen far more of the time.
4. **`.sn-critic-revealed`** stays, now painted only in repair mode. Its comment needs rewriting — it currently describes cursor-driven reveal.

## What this does not touch

`src/critic.ts` is unchanged. No new `Spans` member is needed: with no inline comment editing there is nothing that requires the comment body's boundary, and the line-collapse case reads line boundaries from `state.doc`.

The flash mechanism (`flashField`, `flashEntry`, `flashRangesFor`) and the drawer's focus persistence are unaffected.

## Testing

Pure functions, tested without a live `EditorView`, the way `flashRangesFor` already is:

- `hiddenRanges(state)` — markers and comment bodies for folded entries; empty for the one in repair mode.
- `constructToSelectOnDelete(...)` — the four-boundary table above, plus: no match in open prose, no match inside a construct's body, no match when the entry is revealed.

Field and decoration behaviour through `EditorState`, extending the existing `paint(doc, cursor)` helper:

- caret in `quote` → nothing revealed;
- caret in `replacement` → nothing revealed;
- caret anywhere in an annotation → the comment stays hidden;
- unfold effect → `sn-critic-revealed` and visible markers;
- selection moves off the unfolded range → folds back;
- unfolded range follows text inserted above it;
- `has-comment` present on a commented construct, absent on an uncommented one of the same kind;
- a standalone comment alone on its line collapses the line; one mid-paragraph does not.

**Deleted:** the cursor-driven reveal assertions added in the current working tree (`Live Preview decorations — cursor reveals the raw markup`, and the `.sn-critic-revealed` cases in `revealed markup stands apart from prose`). They assert the behaviour this spec removes. Their effect-driven equivalents replace them.

**Kept unchanged:** the flash tests and the `~~`-cancellation tests.

## Verification before merge

1. **The Obsidian `~~` collision.** Caret inside the replacement half of a substitution: confirm Obsidian's own `~~` markers stay hidden behind our replace decorations. The reasoning above says they must; confirm it.
2. **Block decorations in Obsidian's editor.** Confirm the standalone-comment line collapse behaves, and that the caret cannot strand itself on a hidden line. Fall back as described if not.
3. **`Prec.high` keymap ordering.** Confirm the Backspace handler runs ahead of Obsidian's own bindings, and that returning `false` still lets list-outdent and the rest work normally.

## Working tree

The uncommitted changes should be committed or stashed before implementation so this lands against a known baseline. Most of it survives: the flash field and its tests, the `~~` strikethrough cancellation, the drawer's `focusedOffset` persistence, and the `active-leaf-change` narrowing. What does not survive is the cursor-driven reveal work — the `.sn-critic-revealed` tests and the `cursor: pointer` rules — which this spec replaces.

## Out of scope

- **Decide-in-place** — inline Accept/Reject on the construct under the caret. Considered and set aside; the drawer already does this.
- **Editable comments** — editing a note's text in the drawer card. Not required by this change: with comments drawer-only and repair mode available, a typo in a note is fixable. Worth revisiting on its own merits.
- **Suggestion mode** — typing automatically producing CriticMarkup.
- **Clean view** — a display mode rendering the note as accepted.
