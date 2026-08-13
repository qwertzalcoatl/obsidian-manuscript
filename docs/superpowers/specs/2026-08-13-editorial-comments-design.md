# Editorial Comments — Design Spec

**Date:** 2026-08-13
**Plugin:** Manuscript (Obsidian)
**Status:** Proposed — awaiting review

---

## The problem

Every mark this plugin writes is attached to characters. A comment, a
suggested cut, a replacement: each one says *change this span, accept it or
reject it*. That is what CriticMarkup models, and it is all CriticMarkup
models — the format has five constructs, all inline, all anchored at an
offset, and nothing that speaks about a passage as a whole.

So there is nowhere to put the sentence a real editor writes most often:

> Dieser Absatz funktioniert noch nicht. Nells Nervosität kommt nicht raus.

It is not an edit. There is nothing in it to accept. It is prose *about* the
manuscript, and today the only way to write it is to disguise it as a note on
some arbitrary word nearby, which puts a remark about four paragraphs onto one
of them and makes the drawer show it as a query about a single phrase.

Two things are missing, and they turn out to be one thing in two positions: a
standing assessment at the top of a sheet — editorial frontmatter — and an
observation dropped between two scenes. Both are a visibly distinct block of
editorial prose. Only the placement differs.

## What it does

You invoke **Insert editorial comment**. The plugin writes a callout at the
caret and leaves the caret inside it:

```markdown
> [!editorial] Editorial comment
> Dieser Absatz funktioniert noch nicht. Nells Nervosität kommt nicht raus.
```

It renders as a distinctly styled box in Live Preview and in Reading view, it
folds, and it holds as many paragraphs and lists as the thought needs. It
appears in the Review drawer as a card, in document order among the marks it
sits between. Clicking that card scrolls the editor to it and flashes it, the
way clicking any card already does.

Nothing accepts it, nothing rejects it. You delete it when it has been dealt
with.

## Why a callout, and not CriticMarkup

The obvious move is a sixth construct — a doubled brace, a new delimiter, an
optional flag on `{>>…<<}`. Each was considered and each is worse.

**A new delimiter stops being CriticMarkup.** The format's whole value is that
it is a shared convention: any tool that reads it agrees what the braces mean.
Invent a construct and every other CriticMarkup-aware tool shows raw braces,
while this plugin pays for the syntax three times over — in the CodeMirror
extension, in the Reading-view post-processor, and in the drawer.

**The nearby delimiters are already taken, one of them destructively.**
`{~~ XXX ~~}` is a substitution, and `parseCritic` has a defined rule for a
body without `~>`: it is treated as a deletion of exactly what it holds
(`critic.ts:301`). An editorial comment written that way would render struck
through, and its **Accept** button would delete the text of the assessment.

**Overloading `{>>…<<}` by position costs something real.** A standalone
comment occupying its own line could be declared visible, since `{>>…<<}` is
hidden by this plugin's own choice (`critic-render.ts:763`) rather than by
Obsidian. But then every block-level comment becomes visible, and the private
note between two scenes — *TODO: Zeitlinie prüfen* — has nowhere left to live.

**And an editorial comment is not an editorial mark.** It has no span, no
accept, no reject. Modelling it as one of the five constructs would put a
thing with no edit in it into the type that exists to describe edits.

A callout, by contrast, is already: visible in both view modes with no
rendering code at all, natively styled and themeable, foldable, able to hold
paragraphs — and, outside Obsidian, a readable blockquote rather than a
mangled brace. Its one real cost is that it is invisible to CriticMarkup
tooling, which for commentary is correct rather than regrettable.

## The syntax

The callout identifier is **`editorial`** — one word, no spaces, which keeps
both Obsidian's parser and the CSS attribute selector straightforward. The
visible title is set explicitly rather than left to Obsidian's capitalisation
of the identifier:

```markdown
> [!editorial] Editorial comment
```

The writer never types this. The command inserts it.

**A block begins** at a line matching `^>\s*\[!editorial\]` — optionally
followed by a fold marker (`+` or `-`) and a title — and **continues** through
every consecutive line that begins with `>`. The first line that does not ends
it.

Case is ignored on the identifier, because Obsidian ignores it.

## Where the module boundary falls

A new pure module, `src/editorial.ts`, with no Obsidian imports — the shape
`critic.ts`, `naming.ts`, `text.ts` and `archive.ts` already have, and the
reason all four are testable.

```ts
export interface EditorialBlock {
  /** Offset of the `>` opening the callout. */
  from: number;
  /** Offset past the last character of the last quoted line. */
  to: number;
  /** The title after the identifier, trimmed. Empty when none was written. */
  title: string;
  /** The body with one leading `> ` stripped from each line, trimmed. */
  body: string;
}

export function parseEditorial(content: string): EditorialBlock[];

/** What Insert editorial comment writes, and where the caret goes in it. */
export function editorialSkeleton(): { text: string; caret: number };
```

`editorialSkeleton` lives here rather than in the command for the same reason
`suggestChange` does: it is marker arithmetic, and marker arithmetic in
`main.ts` is what broke the comment hotkey once already.

**`parseCritic` does not learn about callouts, and `Kind` gains no sixth
member.** The five constructs stay exactly what CriticMarkup says they are.
An editorial comment is a different kind of object that happens to appear in
the same list on screen, and keeping the two parsers apart is what makes the
next paragraph true without any special-casing.

**The toolbar count needs no change.** `recountActiveMarkup` counts
`parseCritic(...).length` (`main.ts:505`), so editorial comments are excluded
from the badge as a consequence of the module boundary rather than as a rule
anyone has to remember.

## The drawer

`load()` parses both lists and merges them into one array of rows ordered by
`from`:

```ts
type Row =
  | { type: 'mark'; card: Card }
  | { type: 'editorial'; block: EditorialBlock };
```

`type` rather than `kind`, deliberately: `kind` already means a CriticMarkup
construct throughout this codebase, and a row is a different axis.

An editorial row builds a card carrying `data-kind="editorial"` — the existing
`el.dataset.kind` pattern — showing its title and the opening of its body,
clamped in CSS rather than truncated in JS, so the full text stays selectable.
That attribute is a styling hook and now carries a sixth value; the `Kind`
type it usually mirrors still has five members and gains none.

**It has no actions.** No Accept, no Reject, no Resolve, and no note field.
Clicking it reveals and flashes it in the editor, which is the only thing a
card does for it.

That is a decision rather than an omission. Every destructive action the
drawer offers today operates on a construct whose complete text is on the
card in front of you; an editorial comment may run to several paragraphs of
which the card shows two lines, and a one-click delete of prose you cannot
fully see is a different proposition. You delete it in the manuscript, where
you can read it.

One consequence worth stating: `stillThere` — the guard that compares a card's
source against the live text before any write — is not needed on an editorial
row, because an editorial row never writes. The `editing` record is likewise
untouched. The arithmetic that re-focuses its field is not, and that is the
next section.

`flashEntry` currently takes an `Entry` and derives its ranges from the
construct's spans. It grows a range-based sibling, `flashRange(view, from,
to)`, which `flashEntry` then uses; the editorial card calls the sibling
directly.

## The invariant the drawer never wrote down

`paint()` appends one element per entry of `this.cards`, in order, and four
places elsewhere rely on the correspondence that creates — that
`listEl.children[i]` is the card built from `cards[i]`:

| `review-view.ts` | What it does | What breaks |
|---|---|---|
| 354–357 | restores `is-focused` after a repaint | the wrong card is marked |
| 363–366 | finds the open note field's `<textarea>` to re-focus it | **finds nothing; the field silently loses focus on every repaint** |
| 683–684 | marks the card `reveal()` just scrolled to | the wrong card is marked |
| 693–695 | `focusAt` scrolls the drawer to a clicked mark | the wrong card is scrolled to |

Interleaving editorial rows into the same painted list puts every one of these
out by the number of editorial rows earlier in the sheet. The second is the
serious one: it is the exact failure the drawer plan already has a long note
about — the field blurs, `closeNote` commits an empty draft, and the note
being typed is removed by the very repaint meant to keep it.

**So the index goes away.** Each card is stamped with the offset it was built
from — `el.dataset.offset` — and all four lookups become a query by offset
rather than by position:

```ts
private cardEl(offset: number): HTMLElement | null {
  const el = this.listEl.querySelector(`[data-offset="${offset}"]`);
  return el instanceof HTMLElement ? el : null;
}
```

Offsets are unique within a sheet — no two rows begin at the same character —
so this is a key rather than a coincidence, and it survives any future
reordering or filtering of the list. `focusAt` keeps its range search to find
*which* row covers a clicked offset, then asks for that row's element by its
own `from`.

The alternative is to keep index arithmetic and point all four at the merged
`rows` array instead of `cards`. It is a smaller diff and it re-creates the
same unstated coupling one layer along. Declined.

Either way the invariant gets written down where `paint()` builds the list:
**the list is built only here, one element per row, and nothing appends to it
elsewhere.** It has been load-bearing since the drawer was written and has
never been stated.

## The command surface

One command: **Insert editorial comment**. No default hotkey — `⌘⇧M` remains
the only binding this plugin claims.

It writes the skeleton as its own block, with a blank line before and after it
if the surrounding text does not already provide one, and puts the caret at
the start of the body. With a selection active it still inserts rather than
wrapping: a callout wrapped around manuscript prose would turn the prose into
commentary, which is never what was meant.

## Accept-all and Reject-all leave it standing

`resolveAll` runs `renderAccepted` / `renderRejected`, which rewrite
CriticMarkup. A callout is not CriticMarkup, so both commands walk past it,
and a manuscript with every mark settled still carries its editorial comments.

This is intended. An assessment is not an edit and has no accepted form; it is
answered by revising the passage and then deleting the note. Adding a "clear
all editorial comments" command would be a way to throw away the only record
of what still needs work, in one keystroke, at exactly the moment the
manuscript looks finished.

## Styling

In `styles.css`, which the plugin already ships:

- `.callout[data-callout="editorial"]` — the manuscript side. A register
  visibly apart from the prose: its own border and background, and a smaller
  type size, so it reads as apparatus rather than text. Colours come from
  Obsidian's theme variables so it survives a theme change.
- `.ms-review-card[data-kind="editorial"]` — the drawer side, marked as
  clearly as the mark kinds already are.

## Testing

`editorial.test.ts`, against `parseEditorial` and `editorialSkeleton`, in the
style of the existing suites:

- a block at the top of a sheet, and one between two paragraphs
- with a title, and without one
- with a fold marker, `+` and `-`
- several paragraphs inside one block, including a bullet list
- a blank line, and a plain line, each ending the block
- a `> [!note]` callout, and a plain `>` blockquote: neither matches
- two blocks in one sheet, returned in document order
- a block that ends at end-of-file with no trailing newline
- CRLF line endings
- `editorialSkeleton`'s caret lands in the body, not in the marker

## Known limitations

- **Every line needs its `>`.** Markdown's lazy continuation is not honoured;
  a body line without the marker ends the block. This matches how Obsidian
  renders callouts and keeps the parser one rule long.
- **A nested callout inside an editorial comment is not understood.** The
  outer block runs to the last `>` line, nested content included.
- **Marks written inside an editorial comment are still marks.** `parseCritic`
  reads the raw text and knows nothing of callouts, so a `{--…--}` typed into
  editorial prose gets its own card and settles with Accept-all like any
  other. Filtering marks that fall inside an editorial range is a range check
  in two call sites if this ever bites; it is not worth the surface up front.
- **Archiving does not know about them.** `archive.ts` moves the raw
  selection, so a selection cutting through an editorial comment archives a
  fragment of one. The archive spec already has a section on selections that
  cut a mark in half; this is the same question and is left where that one
  left it.
- **Not CriticMarkup.** External tooling that processes CriticMarkup will not
  see an editorial comment as a review artefact. For commentary this is the
  correct outcome, but it is a real difference from every other mark here.

## Verification

By hand in Obsidian, after the suite and the build:

1. **Insert editorial comment** with the caret mid-chapter. The box renders in
   Live Preview, styled apart from the prose, with the caret in its body.
2. Switch to Reading view. It renders there too, and folds.
3. A card appears in the drawer, in document order between the marks around
   it. Clicking it scrolls the editor to it and flashes it.
4. The card offers no Accept, Reject or Resolve, and no note field opens.
5. Write several paragraphs and a bullet list into it. All of it renders;
   the card shows the opening and stays one card.
6. **Accept all markup in this note.** Every mark settles; the editorial
   comment is untouched. Same for **Reject all**.
7. Adding an editorial comment does not change the toolbar's mark count.
8. A `> [!note]` callout elsewhere in the sheet produces no card.
9. One at the very top of the sheet behaves identically — the frontmatter
   case is the same construct in a different place.
10. **The regression the index change exists to prevent:** with an editorial
    comment above a marked passage, press `⌘⇧M` on a word below it. The note
    field opens *and keeps focus* while typing, and `⌘↵` commits to the right
    card. Then click a mark below an editorial comment in the manuscript and
    confirm the drawer highlights that mark's card, not one two rows off.

## Out of scope

**Linking, and the optional id.** The next increment: an editorial comment
that references a specific mark, so that clicking the reference opens the
drawer on that mark's card. This needs an optional identity on a CriticMarkup
comment, which is a separate design with at least three problems of its own,
recorded here so that spec starts with them:

1. `setComment` rewrites the entire comment body. An id living in that body is
   destroyed the moment the note is edited in the drawer, unless `setComment`
   learns to carry it across.
2. The card must display the note without displaying the id.
3. Accepting, rejecting or resolving a marked span deletes its comment, and
   the reference in the editorial comment is then pointing at nothing. The
   behaviour has to be defined rather than discovered.

Also out of scope: editing an editorial comment from the drawer; a command to
clear them all; a Gutachten document beside the manuscript in the manner of
the archive; and any grouping of drawer cards by the editorial comment they
fall under.
