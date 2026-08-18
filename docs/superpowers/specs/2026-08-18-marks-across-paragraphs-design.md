# Marks across paragraphs, and marks inside marks

**Date:** 2026-08-18

## What is wrong today

Two sentences in the README describe the same wall:

> Marks do not nest, and none may span a blank line — no multi-paragraph anchors.

A reviewer cannot say *cut these three paragraphs*. The parser refuses any
construct whose body contains a blank line (`critic.ts`, `BLANK_LINE`), and the
comment above that refusal gives the honest reason: the Reading-view renderer
reads one rendered block at a time and cannot see across a paragraph boundary,
so honouring a spanning mark in the editor would make the two display modes
disagree about what the note says.

The reviewer also cannot cut a passage that already carries a suggestion.
`scanCritic` runs one alternating regular expression and advances past each
match, so a construct inside another construct's body is never looked for, and
its braces sit visible inside the struck-through text.

These two are one piece of work rather than two, because the first produces the
second. Select three paragraphs of a draft an assistant has already marked up,
press the key for a suggested cut, and `wrapSelection` writes `{--` before the
selection and `--}` after it — around marks that were already there. Nesting
stops being exotic the moment a mark may span paragraphs; it becomes the
ordinary result of a second review pass.

## The rule this design follows

**Extend the host format, never the mark format.**

CriticMarkup carries a change to a span of text and nothing else. Anything that
is not a change to a span goes into Markdown that Obsidian already renders.

The plugin has followed this rule once already. `> [!editorial]` exists because
a remark about a passage is not a mark on a span, and the design of 2026-08-13
chose an Obsidian callout over inventing a sixth CriticMarkup construct. A
callout is a blockquote, so the file still reads as prose in any Markdown
reader.

The test any addition has to pass is MultiMarkdown's: a MultiMarkdown table
comes out of a plain Markdown reader as a row of pipe characters, but every
word is still there and still readable. So — what does another CriticMarkup
tool make of a chapter marked up this way, and what does an assistant produce
when asked for CriticMarkup without being handed a house dialect first? Those
two questions are the whole budget.

**Nothing in this design adds syntax.** Both new capabilities are already
expressible in standard CriticMarkup; the plugin has simply been refusing to
read them. Four things the format genuinely lacks — a block form, mark
identity, attribution, an escape sequence — are addressed by convention or left
alone, and the section *What stays impossible* says which is which.

## Two forms of the same mark

A mark may span paragraphs in two shapes, and the shapes mean different things.

**The block form** puts each marker alone on its own line:

```markdown
Sie stand am Fenster.

{--
Der Regen hatte aufgehört. Auf dem Hof glänzten die Pfützen.

Irgendwo schlug eine Tür. Dann war es wieder still.
--}

Der Zug fuhr um sieben.
```

**The inline form** puts them inside sentences:

```markdown
Sie stand am Fenster{-- und sah in den Hof hinaus. Der Regen--} hatte aufgehört.
```

Accepting the first removes three whole paragraphs. Accepting the second joins
two paragraphs into one, because the text between the markers included the
paragraph break. That second operation is a **paragraph merge**, and it is a
real editorial move rather than a whitespace accident. The clearest way to
write one is a substitution whose quoted half is the break and whose
replacement is a space:

```markdown
Sie stand am Fenster und sah in den Hof hinaus.{~~

~> ~~}Der Regen hatte aufgehört.
```

Supporting both forms is therefore not redundancy. It is two operations that
happen to share a syntax, and the shape of the markers is what distinguishes
them.

Neither form is new syntax. A CriticMarkup processor that accepts newlines
inside a mark — which the reference tools discourage but permit, their caveat
being *"newlines should be avoided as much as possible"* — reads the block form
as one deletion whose body happens to contain paragraph breaks. The block form
asks nothing of another reader that the inline form does not already ask.

### The one parser rule that makes the block form work everywhere

**When an opening marker is followed immediately by a newline, that newline
belongs to the marker rather than to the body. Same for the newline immediately
preceding a closing marker.**

So in the block form above, the body is exactly
`Der Regen … Pfützen.\n\nIrgendwo … still.` — with no leading or trailing
newline of its own.

This single rule is what keeps the block form from needing special handling
anywhere else in the plugin:

| Consumer | Why the rule is enough |
|---|---|
| Live Preview | the marker ranges already include their newlines, so both marker lines vanish and the paragraphs close up |
| Reading view | the marker lines render as their own blocks and are hidden whole |
| The drawer card | the quote is the prose, with no stray blank line at either end |
| Accept | the whole construct is replaced by nothing; `applyEdits` takes the emptied line with it, as it already does |
| **Reject** | the quote is written back **without** the marker lines' newlines, so rejecting a block-form cut does not leave two blank lines behind |

Reject is the case that proves it. Without the rule, rejecting the block form
writes back `\nDer Regen … still.\n` where two marker lines used to be, and the
note gains a blank line above and below the restored passage every time.

## Marks inside marks

`{--Sie zählte bis zehn. {~~Dann~>Schließlich~~} drehte sie sich um.--}` is
unambiguous: the deletion closes at the first `--}`, and the substitution's
markers are a different pair. Nesting of two **different** kinds is expressible
in standard CriticMarkup, and refusing it is an implementation choice.

Nesting of the **same** kind is not expressible — `{--a {--b--} c--}` gives the
first `--}` no way to say which opener it belongs to. A stack-based scan closes
the outer mark early and leaves `c--}` behind, which the checker reports as a
closing marker with no opening marker. That is the right diagnosis and needs no
rule of its own.

Entries stay a **flat list**, sorted by start offset. Only containment is new:
an inner entry's range lies inside an outer entry's range. No tree, no children
field, no second axis in the drawer.

### Settling a nested pair

| The reviewer does this | The note becomes |
|---|---|
| accepts the outer cut | both paragraphs gone, the substitution gone with them |
| rejects the outer cut | both paragraphs stay, the substitution still open |
| accepts the inner substitution first | `Schließlich` is written, the cut still open around it |

All three already work under the existing single-entry transforms, because each
one replaces a single contiguous range and the plugin re-parses afterwards.

`Accept all` and `Reject all` do not. `applyEdits` requires its edits not to
overlap, and nested entries overlap by definition. **They have to resolve from
the inside out**: settle the innermost mark, then settle the one containing it
against the text that came back.

Rejecting is what proves this too. Rejecting a deletion keeps its quoted text
verbatim, and that text still contains `{~~Dann~>Schließlich~~}`. Settle the
outer mark first and `Reject all` leaves markup in a note it has just declared
settled.

## What changes in `critic.ts`

**The blank-line refusal goes.** `BLANK_LINE` and the `continue` that uses it
are deleted. No cap replaces it: a mistyped `{--` that reaches forward and
claims the closing marker of a later mark produces three struck-through
paragraphs, which is loud rather than silent, and the checker names it.

**`scanCritic` becomes recursive.** After matching a construct it scans that
construct's body too, rather than advancing past it, and appends what it finds.
The result is still a flat array; `parseCritic` still sorts it by `from`.

**The attachment test gains a bound.** `parseCritic` attaches a comment to the
construct before it when the text between them is whitespace with no newline:

```ts
/^[ \t]*$/.test(content.slice(raw.to, next.from))
```

With nesting, `next` can be a comment *inside* `raw` — `{--foo{>>bar<<}--}`.
Then `next.from < raw.to`, `slice` returns the empty string, the test passes,
and the entry's `to` is set to a point **before** its own end. Every offset
downstream is then wrong. The test must require `next.from >= raw.to` first.
This is a latent correctness bug that only the recursion can reach, so it needs
a test of its own.

**Marker ranges absorb an adjacent newline**, per the rule above. `simple()`
and the substitution branch both compute `quoteAt` from a fixed marker length;
they gain a check for a newline on the inside edge of each marker and move the
boundary by one.

**`renderAll` resolves inside out.** For each top-level entry, resolve the
entries contained in it first, then compute the outer replacement against the
resolved body. `applyEdits` itself is unchanged and keeps its non-overlap
contract; it is only ever handed top-level edits.

**A new export, `checkMarkup`.** See *The checker* below.

**`suggestChange` and the wrappers gain a block variant.** A new predicate
decides which form a selection wants:

```ts
/**
 * Whether a selection should be wrapped with its markers on their own lines.
 *
 * 'block' when the selection crosses a paragraph boundary *and* both its edges
 * sit on one — anything else is 'inline', which is what makes a paragraph
 * merge expressible rather than a special case.
 */
export function wrapForm(content: string, from: number, to: number): 'inline' | 'block';
```

A selection covering exactly one whole paragraph gets `'inline'`: the block form
would add two lines of syntax and change nothing about how the mark renders or
resolves.

## What changes in `critic-render.ts` — Live Preview

Almost nothing, which is the point. That renderer parses the whole document and
CodeMirror draws a decoration across a paragraph boundary without complaint.

Three details need attention:

1. **Innermost wins.** The click handler finds the entry under the caret with
   `.find((e) => pos >= e.from && pos <= e.to)`, which returns the outer mark
   for a click inside an inner one. It must prefer the narrowest match. The
   same applies to `toggle-markup-source` in `main.ts`: repairing the innermost
   construct at the caret is what the writer means.
2. **Overlapping decorations.** Nested `Decoration.mark`s are fine — CodeMirror
   splits them. Two overlapping `Decoration.replace`s are not, and one case can
   produce them: an unanchored comment whose line is collapsed with
   `Decoration.replace({ block: true })`, sitting inside an outer mark. The plan
   must render that case and confirm it, and fall back to hiding the comment
   alone if CodeMirror refuses.
3. **Ordering.** `hiddenRanges` returns per-entry runs, which nesting puts out
   of document order. Both consumers already pass `sort: true` to
   `RangeSet.of` and `Decoration.set`, so this is safe — worth an assertion in
   the tests rather than a change.

## What changes in `critic-render.ts` — Reading view

This is where the work is.

Obsidian hands a post-processor one rendered section at a time, and
`renderCriticMarkup` parses **the rendered text of that block**, not the note's
source. A mark opening in paragraph 1 and closing in paragraph 3 arrives as
three unrelated pieces: paragraph 1 ends with an unmatched `{--`, paragraph 3
begins with an unmatched `--}`, and the parser recognises neither. The reader
sees literal braces.

Guessing is not available. A paragraph ending in an unmatched `{--` is either a
mark continuing into the next paragraph or a typo, and the block alone cannot
tell which. Guessing *continuing* would strike through a tail that Live Preview
leaves as plain braces, and the premise of this file is that the two display
modes cannot disagree.

So the renderer asks. `MarkdownPostProcessorContext.getSectionInfo(el)` returns
`{ text, lineStart, lineEnd }` — the note's full source and the first and last
line of the section being rendered. That answers the one question a block
cannot answer for itself, and **no more than that is needed**: the markers
themselves are still found in the block's own rendered text, so source offsets
never have to be mapped onto the DOM. Mapping them was the expensive part, and
this design does not do it.

```ts
interface SectionSource { text: string; lineStart: number; lineEnd: number }

/** A mark that reaches into, over, or out of the block at these lines. */
interface Straddle {
  kind: Kind;
  /** Where the opening marker sits in this block's rendered text, or null when it opened earlier. */
  opensAt: number | null;
  /** Where the closing marker sits, or null when it closes later. */
  closesAt: number | null;
  /** Substitution only — where the arrow sits, when it is in this block. */
  arrowAt: number | null;
}

export function renderCriticMarkup(root: HTMLElement, source?: SectionSource): void;
```

`main.ts` becomes
`registerMarkdownPostProcessor((el, ctx) => renderCriticMarkup(el, ctx.getSectionInfo(el) ?? undefined))`.

Per straddle the renderer emits the operations it already has: hide each marker
token it can find, and wrap from just after the opener — or from the start of
the block — to just before the closer, or to the end of the block.

**Two limits, both stated rather than discovered:**

- `getSectionInfo` returns null in several contexts, an embedded note and a PDF
  export among them. The API documentation says so outright: *"this function
  may also return null in many circumstances; if you use it, you must be
  prepared to deal with nulls."* Without it, the renderer hides any unmatched
  marker token and styles nothing. No braces leak into the reader's view; the
  passage simply reads as prose.
- A section containing several blocks — a callout, a list — gets one line range
  for the whole of it, so per-block ranges inside it are unknown. Straddle
  handling applies only when every text node in the section belongs to one
  block; otherwise the per-block parse runs as it does today. Marks inside a
  callout are single-paragraph in practice.

**`applyOps` has to be rebuilt.** It splits text nodes and replaces them with
wrapper elements, working right to left so that offsets it has not reached stay
valid. A wrapper inside a wrapper breaks that: the inner operation replaces a
text node that the outer operation still holds a reference to, and the outer
then writes into a node no longer in the document. The applier needs to nest
wrappers rather than assume each text node is claimed once. This is the highest
risk in the whole design, the failure mode is a paragraph that renders with
pieces missing, and the plan writes its test first.

## A paragraph break inside a mark draws as a pilcrow

A struck-through blank line is invisible. Without a glyph, the merge of section
*Two forms* has nothing on screen to say it exists, and its card reads as an
arrow with empty text on either side.

So a newline inside a mark's body renders as `¶`, in the prose and on the card,
carrying the same class the surrounding body carries — struck through in a
deletion's quote, underlined in an insertion's.

This is a convention, not a label. The cards and decorations deliberately carry
no type names; they show a cut as struck-through text and let the treatment
carry the meaning. Showing whitespace as a glyph is the same kind of move, and
text editors have done it for forty years.

It applies to the **inline** form only. In the block form the newlines next to
the markers belong to the markers, and the newlines inside the body separate
whole paragraphs, which the card shows as paragraphs — see the next section.

## What changes in `review-view.ts`

**A third row type.** `Row` is a union of `'mark'` and `'editorial'`; it gains
`'problem'`. `rowFrom` extends by one line. `rows()` already sorts by offset,
and `paint()` already builds one element per row.

**Innermost wins, again.** `rowStartCovering` uses `.find()` and would focus
the outer card when the editor's caret sits in an inner mark. It must return
the narrowest row covering the offset.

**A nested card is indented one step.** The outer mark has the smaller offset,
so `rows()` already orders them correctly; the card only needs to know its
depth. Indentation says that settling the outer mark erases the inner one
without a sentence having to say it.

**A long quote is clamped, and keeps its paragraph breaks.** `.ms-review-quote`
has no line limit, so a three-paragraph cut sets several hundred characters of
monospace into the sidebar. It gains the `-webkit-line-clamp` treatment
`.ms-review-quote.is-context` already uses — six lines rather than two, and in
CSS rather than by truncating in JavaScript, so the full text stays selectable.

It also gains `white-space: pre-wrap`, because `setText` writes the body into
one element and HTML would otherwise collapse the paragraph breaks of a
block-form cut into single spaces, running three paragraphs together as one. On
a single-line quote the declaration changes nothing, which is why it can sit on
the shared rule rather than on a variant of it. This is what makes the pilcrow a
question for the inline form only: in the block form the card shows the breaks
as breaks.

**A problem row has no actions.** No Accept, no Reject, no Resolve, no note
field — the same shape an editorial row has, and for the same reason: there is
nothing to settle, only something to fix. Clicking it reveals and flashes the
marker in the editor. `data-kind="problem"` colours the card's rail, extending
the `.ms-review-card[data-kind=…]::before` pattern.

Because a problem row never writes, `stillThere` and the `editing` record need
no changes, exactly as the editorial design already established.

## The checker

The whole point is that stray markup is **silent**. A marker that never finds
its partner does not match, so the braces sit in the prose as ordinary text and
nothing tells the writer. That is true today, before any of this work.

A command would be the weaker answer, because a command is run when you already
suspect something. So the checker reports without being asked: as a row in the
drawer, and as a warning colour on the marker in the editor.

It is **derived from the parse** rather than forming a second opinion about
what counts as markup — the same reason `critic.ts` keeps every renderer
reading its geometry from one `parseCritic`:

1. Parse the note. That gives the consumed ranges and, inside each, which
   characters are that mark's own markers.
2. Scan for all ten marker tokens (`{++ ++} {-- --} {~~ ~~} {== ==} {>> <<}`),
   skipping the regions `skipRegions` already excludes — frontmatter, fenced
   code, inline code.
3. A token no mark consumed is stray: an opener with no closer, or a closer
   with no opener.

```ts
export type FaultKind = 'unmatched-opener' | 'unmatched-closer' | 'no-arrow' | 'empty-body';

export interface Fault {
  kind: FaultKind;
  /** What to reveal in the editor: the marker, or the whole malformed construct. */
  at: Range;
  /** The entry this fault belongs to, when it belongs to one. */
  entryFrom: number | null;
}

export function checkMarkup(content: string): Fault[];
```

Two faults belong to a construct the parser accepted, and those carry
`entryFrom`, so the drawer draws the warning **on the card that renders wrong**
rather than on a card of its own:

| Written | What the parser makes of it | What the card says |
|---|---|---|
| `{~~Dann drehte sie sich um~~}` | a deletion, because there is no `~>` | no `~>` in this mark, so it reads as a cut rather than a replacement |
| `{----}`, `{====}` | a mark with an empty body, which no command produces | an empty mark |

The wording lives in `review-view.ts`. `critic.ts` carries no user-facing copy
today and gains none.

A `{--` inside a deletion is **not** a fault. That is legal nesting, and it was
on an earlier draft of this list in error.

**The checker reads CriticMarkup tokens only.** A lone `%%` or `==` is ordinary
Obsidian markdown far more often than it is a broken mark, so reporting on it
would cry wolf in every note that uses a highlight. Obsidian's own forms are
otherwise untouched by this design: `NATIVE_COMMENT_RE` already matches across
newlines, because `BLANK_LINE` only ever guarded `scanCritic`, so a `%%…%%`
spanning paragraphs parses today and will parse the same way afterwards; and
`NATIVE_HIGHLIGHT_RE` stays bounded to one line, because a single-line
`==text==` is Obsidian's rule rather than this plugin's.

## The two hotkeys

Both commands exist and neither has a default binding: `Suggest deletion` and
`Suggest a change`. Obsidian binds `Cmd+-` to *Zoom out* and `Cmd+=` to *Zoom
in*, so the bare keys are not available.

| Command | Binding | Reading |
|---|---|---|
| Suggest deletion | `⌘⇧-` | minus means cut |
| Suggest a change | `⌘⇧+` | plus means add or replace |

They sit beside the `⌘⇧M` this plugin already claims. Both write the block form
when `wrapForm` says the selection covers whole paragraphs and the inline form
otherwise, so one key covers both operations and the shape of the selection
decides which one it means.

`Suggest a change` keeps the two modes it has — with a selection it proposes a
replacement, without one an addition — and its block variant puts the arrow on
its own line:

```markdown
{~~
old paragraphs
~>
new paragraphs
~~}
```

## What stays impossible

To be written into the README's limitations, replacing the two sentences this
design removes:

- **The same kind of mark cannot nest inside itself.** `{--a {--b--} c--}` gives
  the first closing marker no way to say which opener it belongs to. The checker
  reports the leftover as a closing marker with no opener.
- **There is still no escape syntax.** A comment cannot contain `<<}` and a
  substitution cannot contain `~>` or `~~}`. `sanitizeComment` defuses those
  sequences; `suggestChange` refuses a selection carrying them.
- **A mark has no identity**, so the format cannot express a *move* on its own.
  The convention that fills the gap needs nothing from the plugin and degrades
  perfectly in any other reader — a tag in the comment on each half:

  ```markdown
  {--Sie zählte bis zehn.--}{>>@claude: gehört vor die Hofszene · #move-4<<}
  {++Sie zählte bis zehn.++}{>>#move-4<<}
  ```

  Pairing the two halves in the drawer is out of scope here and noted as
  possible.
- **A mistyped opening marker can reach a long way.** It claims the closing
  marker of the next mark of its kind, so a stray `{--` can strike through
  several paragraphs at once. This is visible rather than silent, undone with
  `⌘Z`, and named by the checker.

## Build order

Four phases, in this order, because each one leaves the plugin in a state you
can write in.

1. **`critic.ts` alone** — the refusal removed, the recursive scan, the
   attachment bound, marker newlines, inside-out resolution, `checkMarkup`,
   `wrapForm`. All of it is pure and unit-testable under jest with no Obsidian
   present, which is the property the file's header comment exists to protect.
   Nothing on screen changes yet.
2. **Live Preview and the drawer** — innermost-wins, the pilcrow, the nested
   card, the clamp, problem rows, the warning colour on a stray marker. Plus the
   one piece of Reading view that cannot wait: **hiding an unmatched marker
   token**, which is the null-`getSectionInfo` fallback of the section above and
   about ten lines. Without it a spanning mark would put literal braces in front
   of a reader between this phase and the next, and that is the one intermediate
   state not worth living in. After this phase the feature is usable: you can
   write a spanning mark, see it, and settle it.
3. **Reading view** — `getSectionInfo`, straddles, and the rebuilt `applyOps`.
   Deliberately last and deliberately separate, because it carries the design's
   only real risk and because phase 2 already degrades acceptably: until this
   lands, a spanning mark shows a reader no braces and simply goes unstyled.
4. **The hotkeys and the README** — two bindings, the block-form wrappers wired
   to `wrapForm`, and the limitations section rewritten.

Phase 3 can be a session of its own without holding up phases 1, 2 and 4.

## Testing

`critic.test.ts` — parsing and transforms:

- the block form: markers absorb their adjacent newlines; the quote holds
  neither; accept closes the gap; **reject restores the passage with no blank
  line gained at either end**
- the inline form across a blank line, and the merge substitution
- a nested pair, each kind inside each other kind that can hold it
- the attachment bound: `{--foo{>>bar<<}--}` produces a deletion whose `to` is
  its own end, with the comment as an entry inside it
- `Accept all` and `Reject all` over a nested pair, the reject case asserting no
  markup is left behind
- `wrapForm` at every boundary: a whole paragraph, two whole paragraphs,
  mid-sentence to mid-sentence, a selection ending on a blank line

`critic.test.ts` — the checker:

- an unmatched opener, an unmatched closer, one of each in the same note
- a marker inside fenced code, inline code and frontmatter reports nothing
- `{~~…~~}` with no arrow, and `{----}`, each carrying `entryFrom`
- `{--a {--b--} c--}` reports exactly one unmatched closer
- a legally nested mark reports nothing

`critic-live.test.ts` — the editor:

- hidden ranges over a spanning mark, and over a nested pair, asserting the
  caret can reach every visible position and no hidden one
- innermost-wins for the entry under a position
- the block-replace-inside-a-mark case from *Live Preview*, item 2

`critic-render.test.ts` — Reading view:

- a mark opening in one block and closing in the next: braces hidden, both
  halves styled
- a block wholly inside a mark, with `SectionSource` supplied and withheld
- **nested wrappers**, written before `applyOps` is touched
- a section holding several blocks falls back to the per-block parse

## Out of scope

- Pairing `#move-…` halves in the drawer.
- A vault-wide or folder-wide markup check. It earns its place when there is an
  export to protect; the drawer covers the note in front of you.
- Structural suggestions — split this paragraph, reorder these scenes. Under the
  rule in this document they would be callouts rather than marks, and nothing
  needs them yet.
- An escape syntax for CriticMarkup.
