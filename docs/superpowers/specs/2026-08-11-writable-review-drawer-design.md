# The Writable Review Drawer — Design Spec

**Date:** 2026-08-11
**Plugin:** Sheet Navigator (Obsidian)
**Status:** Approved
**Follows:** `docs/superpowers/specs/2026-08-11-criticmarkup-edit-through-design.md`

---

## The problem

Edit-through adopted a rule and stopped halfway through it. **The comment lives in
the drawer** — but only to be read. It is still written in the manuscript, by a
hotkey that parks the caret between `{>>` and `<<}` and expects you to type there.

That place no longer exists. `wrapSelection` writes `{==Text==}{>><<}` and moves
the caret just past the `{>>` (`src/main.ts:1473-1477`), into a range that
edit-through made both invisible and atomic:

```
doc:     "Sie {==ging==}{>><<} fort."
caret:   17
hidden:  [4,7)='{=='   [11,14)='==}'   [14,20)='{>><<}'
caret strictly inside a hidden range?  true
```

You would be typing into text that never renders, and the first arrow keypress
would eject the caret out of it. ⌘⇧M, the plugin's only default binding, is
broken.

The bug is a symptom. A comment can be read in the drawer and decided in the
drawer, but it is born in the manuscript and can only be corrected there, through
a repair command meant for malformed syntax. The lifecycle has no home. Making
the drawer the whole of it is what the rule already said; this spec is that rule
carried out.

## What the drawer becomes

A comment is **read, written, edited and decided** on its card.

- ⌘⇧M wraps the selection in `{==…==}{>><<}`, opens the drawer, and puts the
  caret in the new card's note field.
- A card's note is a click target; clicking it opens the same field.
- A card with no note offers one from its actions row.
- No brace appears anywhere, and no modal opens.

The one thing this costs: **commenting now requires the drawer.** Today you can
leave a note with the sidebar closed. Afterwards ⌘⇧M always opens it and takes
the caret out of the manuscript. That follows from the rule — the note is not
manuscript text and has nowhere else to go — but it is a change to the most-used
hotkey in the plugin, and it is stated here rather than discovered.

## The card's note row

Three states, and two of the rows below draw the same one:

| `entry.comment` | Card shows |
|---|---|
| a string | the note, in the reading font, clickable |
| `''` | nothing; a **Note** button in the actions row |
| `null` | nothing; a **Note** button in the actions row |
| — while editing | a textarea in the note's place |

`review-view.ts:261` tests `if (entry.comment)`, so `{>><<}` — which parses to
`comment: ''` — currently draws no note element at all. That is the card ⌘⇧M has
to type into. Collapsing `''` and `null` into one visible state fixes it and
costs nothing: the two differ only at write time, where one replaces a body and
the other inserts a construct. Nothing in the card has to know which it is.

The **Note** button goes in the actions row rather than as a placeholder line of
its own. That row is already the card's "things you can do here" surface, already
hidden until hover or focus (`styles.css:647-659`), and already occupies the
space — so the affordance costs no vertical rhythm in a list of forty cards, and
`:focus-within` makes it keyboard-reachable through the tab order that already
exists.

Adding a note to a suggestion that has none is slightly beyond the reported bug.
It is included because the machinery is identical and the alternative is a drawer
where a note can be written on a highlight but not on the deletion next to it.

## Writing back

Reuse the write path rather than reinvent it. `act()` (`src/review-view.ts:346`)
already guards every write with two independent checks — the source at the card's
offsets must still be byte-identical to what the card was built from, and a fresh
parse of the live text must still agree that an entry of that kind sits exactly
there — and `write()` (`:437`) narrows the result to a `minimalEdit` so the caret
and scroll do not jump. The note commit takes the same road: guard, compute the
whole document as it should read, hand it to `write()`.

The guard is extracted from `act()` into a `stillThere(content, card)` helper so
both callers state the same rule once.

### The body's boundary

The transform needs to know where a comment's body sits, and `Spans` does not say.
`spans.comment` covers the whole construct, markers included.

`parseCritic` **already computes it and throws it away**: the comment's `Raw`
carries `quoteAt`, which is exactly the body, and both branches that build an
entry discard it (`src/critic.ts:356`, `src/critic.ts:383`). So `Spans` gains:

```ts
/** Where the comment's text sits inside its markers. Zero-width when empty. */
commentBody: Range | null;
```

Two lines in `parseCritic`, no new logic, no behaviour change. This is what the
`Spans` docstring exists for — *"the parser reports this so Live Preview and
Reading view don't each re-derive marker lengths from the raw text. Two copies of
that arithmetic would eventually disagree"* — and the edit-through spec said as
much in the negative: *"No new `Spans` member is needed: with no inline comment
editing there is nothing that requires the comment body's boundary."* There is now.

It also settles a case nothing else can express. On an attached comment, `entry.native`
reports the **anchor's** form, not the note's, so `{--ging--}%%zu spät?%%` gives no
way to tell that its note is delimited by `%%` and not by `{>>`. With both ranges
in hand the marker length falls out as `commentBody.from - comment.from` — 2 or 3
— and no caller sniffs the source text for delimiters.

While there: the `comment` member's docstring still says *"replaced by a glyph."*
The glyph was deleted two commits ago.

### The transform

Pure, in `critic.ts`, beside `applyEntry` — same shape, same file, same job of
rewriting a document from an entry and one decision:

```ts
setComment(content: string, entry: Entry, text: string): string
```

Five cases, in the order they are decided:

1. **Empty text, standalone comment** — `applyEntry(content, entry, 'resolve')`.
   Removing the construct is exactly what resolving one does, line-emptying rule
   and all, and `applyEdits` already gets that right for a note spanning two lines.
2. **Empty text, attached note** — cut `spans.comment`. The anchor stays.
3. **Empty text, no note yet** — nothing to do; return `content`.
4. **Text, existing note** — replace `spans.commentBody`.
5. **Text, no note yet** — insert `{>>text<<}` at `entry.to`. The attachment rule
   is *whitespace but no newline between the two* (`src/critic.ts:365`), and
   inserting flush against `entry.to` leaves no gap at all.

`content` and `entry` must come from the same parse; that is already the contract
`applyEntry` documents and the caller's guard enforces.

### An empty note is not a note

Closing an empty field removes the construct — whether the field was committed or
cancelled with Escape. One rule instead of two, and it means abandoning ⌘⇧M leaves
a clean `{==Text==}` highlight rather than a dotted underline promising a note that
was never written.

The oddity is real and accepted: Escape writes to the document. It writes only
when the stored value was already empty, so nothing a writer typed is ever
discarded by it, and ⌘Z undoes it like any other edit.

Emptying an existing note removes it too. On a standalone comment that is the same
outcome as pressing **Resolve**, which is the honest answer — a comment with no
text is not a comment.

### What a note may contain

CriticMarkup has no escape syntax, so the container has to be defended at the
point of writing. `sanitizeComment(text, close)` in `critic.ts`, applied on every
commit:

- **Blank lines.** `BLANK_LINE` (`src/critic.ts:220`) makes the construct stop
  parsing entirely — a note that swallows the rest of the paragraph, or nothing at
  all. Any run of newlines separated only by spaces or tabs collapses to a single
  newline. Single newlines survive: notes are multi-line.
- **The closing marker.** `<<}` ends the construct early, truncating the note and
  spilling the rest into the manuscript. It becomes `<< }`. For a `%%…%%` note the
  terminator is `%%`, which becomes `% %`. The opening `{>>` needs no treatment:
  the regex is non-greedy, so a nested `{>>` is ordinary text inside the body.
- **CRLF** normalises to `\n`, and the result is trimmed — the parser trims what
  it reports, so an untrimmed write would show back differently from what was
  stored.

Only the closing marker changes what the writer typed, and the realistic collision
is a German writer typing guillemets as `>>Wort<<` with a `}` immediately after.
The card redraws from the document after every commit, so the sanitised text is
what you see — nothing is silently different from what is stored.

The field itself: **Enter inserts a newline**, ⌘↵ and blur commit, Escape cancels.

## The repaint — the real work

`requestRefresh` (`src/review-view.ts:137`) fires on `editor-change` and rebuilds
every card from scratch 200ms later. An open, half-typed textarea does not survive
that, and the keystrokes in it are gone. This bug has already bitten once:
`focusedOffset` (`:78`) exists because a repaint destroyed the focus a click had
just applied.

The answer is **suppression plus reconstruction**, and both halves are needed.

**Suppression.** While a field is open, the drawer does not reload. The guard goes
in the load path, not in the debounce: `act()` calls `this.refresh()` directly on
guard failure, and `refreshViews()` (`src/main.ts:1509`) calls it from outside the
view entirely, so guarding `requestRefresh` alone leaks two ways in.

`refresh()` splits into a fire-and-forget wrapper over an awaitable `load()`,
which the ⌘⇧M path needs anyway (below). The guard sits at the top of `load()`.

Closing the field always reloads, so a change suppressed during editing is shown
the moment editing ends and no dirty flag is needed. What is stale meanwhile is
the *other* cards, which is harmless — and if a click lands on another card's
button, the textarea blurs and commits first, and that card's own guard catches
any offsets our write just moved. It refuses with the notice that already exists
rather than writing to the wrong place.

**Reconstruction.** `paint()` rebuilds the field from view state rather than
receiving it:

```ts
private editing: { offset: number; draft: string } | null = null;
```

keyed on `entry.from`, the same key `focusedOffset` uses. This is not belt and
braces — it is what makes ⌘⇧M work at all. That flow is *write markup → reload →
paint → open field*, so the field has to be a product of painting, not something
layered on afterwards. `draft` is mirrored from the textarea's `input` event, so a
repaint that does get through — one we asked for — restores the text. The caret
inside the field goes to the end; the only repaints that can reach an open field
are ones this code triggers deliberately, never a keystroke.

`focus()` on a detached element does nothing, so the focus call happens after the
fragment is appended, alongside the `is-focused` restoration that already lives
there.

### Two collisions in the existing card

Both are in `buildCard`, and both would be found the hard way.

**Space.** The card's keydown handler (`review-view.ts:278`) calls
`preventDefault()` on `' '` and reveals. Events from the textarea bubble to it, so
the space bar would scroll the editor instead of typing a word break. The handler
gains a guard that ignores anything not targeted at the card itself.

**Focus.** `reveal()` dispatches into the CodeMirror view. If that takes DOM focus
the textarea blurs, commits, and closes itself — a click that undoes itself. The
note element stops propagation, so clicking a note edits it and clicking anywhere
else on the card reveals it. The cost is that opening a note no longer scrolls the
editor to its anchor, which is acceptable: you clicked the note because you were
already reading the card.

## Focus, and ⌘⇧M

`wrapSelection` loses its comment branch entirely. `WRAPPERS` gains the missing
member:

```ts
const WRAPPERS: Record<MarkupKind, [string, string]> = {
  highlight: ["{==", "==}"],
  deletion: ["{--", "--}"],
  insertion: ["{++", "++}"],
  // A comment is an anchor plus an empty note. The note is typed in the drawer,
  // so what gets written here is the container for it.
  comment: ["{==", "==}{>><<}"],
};
```

and the function collapses to one `replaceSelection` for all four kinds. The
caret arithmetic goes with it.

What remains kind-dependent is only where focus lands, which is honest — that is
the actual difference between the four commands now:

```ts
if (kind === "comment") await this.startNote(start);
else await this.activateReviewView(false);
```

`activateReviewView(focus)` keeps its parameter and its meaning; `false` is still
"the caret stays in the manuscript", still correct for the other three and for
both modal commands. Its docstring gains the inversion: a comment is the one
construct whose content is not manuscript text, so for it the drawer is where the
caret belongs. `startNote` reveals the drawer *with* focus and then hands an
offset to the view.

The handoff is the riskiest runtime piece in this design. `textarea.focus()` has
to land after `revealLeaf` resolves **and** after the drawer's asynchronous read
has repainted, which is why `load()` is awaitable:

```ts
async openNote(offset: number): Promise<void> {
  await this.load();               // cards now reflect the text just written
  const card = this.cards.find((c) => offset >= c.entry.from && offset < c.entry.to);
  if (!card) return;
  this.editing = { offset: card.entry.from, draft: card.entry.comment ?? '' };
  this.paint();                    // paint opens and focuses the field
}
```

If the right sidebar cannot be opened — `getRightLeaf(false)` returning null —
`activateReviewView` already returns silently and the markup is simply written
with no field. Rare, and not worth a second code path.

## Multi-line notes, and what they touch

Notes span lines, which the parser has always allowed (`CRITIC_RE` matches with
`[\s\S]*?`) but nothing has exercised. Two things follow.

**`lineCollapseRange` is wrong for them.** It reads only the line at `entry.from`
(`src/critic-render.ts:289`), and for a two-line standalone comment the suffix
test slices past the end of that line, returns `''`, and passes — so the first
line collapses and the second stays on screen as raw text. It has to span the line
at `entry.from` through the line at `entry.to`, which is what `applyEdits` already
does for the same rule it was written to mirror (`src/critic.ts:452-458`).

**Replacing a line break is legal here.** CodeMirror throws *"Decorations that
replace line breaks may not be specified via plugins"*, but only for sources
flagged in `disallowBlockEffectsFor`, which is `dynamicDecorationMap` — set by
`typeof d == "function"` (`@codemirror/view/dist/index.js:3269`). Our decorations
come from `EditorView.decorations.compute`, whose facet value is a `DecorationSet`
and not a function, so the flag is false and both block decorations and line-break
replacement are permitted. Same mechanism the edit-through spec relied on for the
line collapse. Confirmed by reading, unconfirmed in the app — it joins the
verification list.

Nothing else changes. `has-comment` stays keyed on `entry.comment !== null`, so an
anchor shows its dotted underline the instant ⌘⇧M runs and loses it again if the
note is abandoned — which is the right feedback, not an oversight.

## Styling

Small, and mostly reuse.

1. **`.sheet-review-comment` becomes a click target** — `cursor: text`, and a hover
   state faint enough not to compete with the card's own. It is prose you edit, and
   the editor pane made exactly this change one commit ago for the same reason.
2. **`.sheet-review-comment-input`** — the textarea, styled to be invisible as a
   control: same font, size, line height and colour as the note it replaces, no
   border or background of its own beyond a focus ring, `resize: none`, and height
   driven from `scrollHeight` on input so it grows with the note. The point is that
   committing changes nothing on screen except the caret leaving.
3. **The Note button** reuses `.sheet-review-action` unchanged. Not `is-primary`:
   Accept and Resolve are the primary act on a card, and a second accent button
   would flatten that.
4. **The empty-state text.** *"Nothing to review. Select text and press ⌘⇧M to
   leave a note."* still describes the old model, where the note was left in the
   manuscript. It becomes: *"Nothing to review. Select a passage and press ⌘⇧M; the
   note is typed here."*

## Testing

Pure functions over state, driven through `EditorState` without an `EditorView`,
per `src/critic-live.test.ts`.

`review-view.ts` itself cannot be imported under test — `src/__mocks__/obsidian.ts`
has no `ItemView`, so the class definition throws, and `Platform.isMacOS` is read
at module scope. That is why every decision the drawer makes lives in `critic.ts`
and the view holds only wiring. It is also why the verification list below is not
optional.

**`sanitizeComment`** — blank lines collapse to one newline; single newlines
survive; CRLF normalises; `<<}` becomes `<< }`; `%%` becomes `% %` for a native
note and is left alone for a CriticMarkup one; leading and trailing whitespace go;
an empty and a whitespace-only input both give `''`.

**`setComment`** — inserts a note on an anchor that has none; replaces an existing
body; keeps a `%%…%%` note in its own form rather than converting it; empty text
removes an attached note and leaves the anchor; empty text on a standalone comment
removes the construct and takes its line; empty text on an entry with no note
changes nothing.

**The property that matters:** for every kind of anchor and a set of hostile
inputs — `<<}`, `{>>`, `%%`, a blank line, a lone newline, `}`, an empty string —
`parseCritic(setComment(content, entry, hostile))` finds the same number of
entries as before, and the note reads back as `sanitizeComment` produced it. A
note must never be able to break its own container.

**`Spans.commentBody`** — present and zero-width for `{>><<}`; correct for a
CriticMarkup note, a native `%%…%%` note, and a native note attached to a
CriticMarkup anchor; `null` where `comment` is null.

**`lineCollapseRange`** — the existing cases still pass, plus a standalone comment
spanning two lines collapses both, and one spanning two lines with prose after it
on the last line collapses neither.

The `nonEmpty()` guard is the trap here. `{>><<}` has a zero-width body, so any
guard reflexively reused from `critic-render.ts` would skip exactly the case this
feature exists for. Body ranges are tested for `null`, never for emptiness.

## Verification before merge

Nothing below can be reached from Jest.

1. **The ⌘⇧M round trip.** Select a passage, press ⌘⇧M. The drawer opens, the new
   card's field has the caret, typing lands in it. ⌘↵ commits; the note appears on
   the card and no brace appears in the manuscript. Repeat with the drawer already
   open, and with it closed.
2. **Escape after ⌘⇧M** leaves a plain highlight — no dotted underline, no empty
   card slot.
3. **A repaint mid-typing.** Open a field, type, then let 200ms pass without
   touching anything; type again. Nothing is lost. Then trigger an external change
   (edit the file from outside Obsidian) while a field is open and confirm the
   drawer catches up when the field closes.
4. **Editing an existing note** — click it, change it, blur. Confirm the caret and
   scroll position in the editor pane did not move.
5. **A multi-line note.** Type one with Enter, commit, and confirm it renders as
   nothing in the manuscript, that the prose around it closes up, and that the
   caret cannot land inside it.
6. **Space and Enter in the field** type and break lines rather than scrolling the
   editor.

### Carried forward, still unverified

The previous cycle shipped without any of these being run in Obsidian. They are
not done, and this work touches the last two directly.

1. The Obsidian `~~` collision inside a substitution's replacement half.
2. The standalone-comment line collapse as a block decoration — now also for a
   note spanning two lines.
3. All four backspace boundaries, plus list-outdent elsewhere in a note.
4. Arrow traversal across a substitution.
5. A commented substitution stacking four treatments; the plan carries two
   fallbacks.
6. The repair command — toggle on, toggle off, auto-fold on clicking away.

## Out of scope

- **A comment on a comment.** Threads are a different feature.
- **Decide-in-place** — inline Accept/Reject on the construct under the caret.
- **Suggestion mode** — typing automatically producing CriticMarkup.
- **Clean view** — a display mode rendering the note as accepted.
- **A testable `review-view.ts`.** Filling out the obsidian mock far enough to
  construct an `ItemView` is a larger investment than this change earns, and the
  design deliberately leaves the view with nothing worth asserting.
