# Manuscript

A single-column, drill-down sidebar for [Obsidian](https://obsidian.md), plus an
editorial review pass built on [CriticMarkup](http://criticmarkup.com).

## What is this for?

Writers who keep a long project in folders and numbered files — novels,
screenplays, reports — and whose vault sidebar shows them everything at once
when they only want the chapter they are in.

Manuscript replaces that with one column that goes a level at a time: folders
appear as chapter cards with note counts, notes as cards with a preview of their
first lines. On top of it sits a review workflow: mark a draft up with
suggestions and comments, then walk through them one by one in a side drawer.

## How to use this

### 1. Browse

Open the navigator from the **ribbon icon** (layers) or the command palette
("Open Manuscript"). Click a chapter to drill in, a note to open it, the
chevron to go back up. `Cmd+N` creates the next numbered note in the current
folder; right-click renames or deletes.

Numbered items sort first in numeric order, everything else alphabetically:

```
1 – Opening.md
2 – The Arrival.md
3.md
99 – Notes.md
```

Turn on **Enable ordering** in settings to get drag handles. Dropping renumbers
the folder sequentially (1, 2, 3…), keeping each item's title and separator.
Items without a number keep their filename and stay at the end — dragging one
into the numbered run is what gives it a number. Folders and notes are numbered
as separate sequences.

### 2. Mark up a draft

Ask an assistant to *"review chapter 3 and mark it up in CriticMarkup"*, or
write the marks yourself from the command palette (`⌘P`) or the right-click
menu. Three marks propose an edit:

| Written | Means | Accept | Reject |
|---|---|---|---|
| `{++new text++}` | insertion | keeps the text | drops it |
| `{--old text--}` | deletion | removes the text | keeps it |
| `{~~old~>new~~}` | substitution | writes `new` | keeps `old` |

Two are annotations, so they only offer **Resolve**:

| Written | Means | Resolve |
|---|---|---|
| `{==text==}` | highlight | unwraps it, leaving the text |
| `{>>comment<<}` | comment | deletes it |

A `{>>comment<<}` written directly after another mark belongs to it and shares
its card. Obsidian's own `%%comment%%` and `==text==%%comment%%` are read too; a
plain `==text==` is ordinary markdown and is left alone.

The commands you will reach for:

| Command | Needs a selection |
|---|---|
| Comment on selection — `⌃⌘M` | yes |
| Highlight selection | yes |
| Suggest deletion — `⌃⌘-` | yes |
| Suggest a change — `⌃⌘+` | no — with a selection it replaces, without one it inserts |
| Insert editorial comment | no |

A mark may cover several paragraphs, and where you put its markers says what it
means. Inside two sentences it proposes joining them into one paragraph; on lines
of their own it takes the paragraphs whole:

```markdown
{--
Der Regen hatte aufgehört.

Irgendwo schlug eine Tür.
--}
```

Selecting whole paragraphs writes that form for you, selecting from mid-sentence
to mid-sentence the inline one. A paragraph break inside a mark shows as `¶`,
because a struck-through blank line would otherwise be invisible.

Marks may also sit inside one another, which is what happens when you cut a
passage that already carries a suggestion. The drawer indents the inner card
under the outer one, and accepting the outer mark settles both.

Marked-up prose stays editable in place: the syntax is hidden, you type around
it, and nothing is settled just to reach the words nearby. **Show markup source
at cursor** unfolds one mark for hand repair and folds it back when you leave.

### 3. Work through the pass

Open the drawer from the **Review button** in the toolbar or the command
palette. Each mark is a card showing the change itself — struck through for a
deletion, underlined for an insertion. Click a card to jump to it; click its
note to write or edit one (`⌘↵` commits, `Escape` cancels).

- **Accept / Reject** decide a suggestion
- **Resolve** clears a highlight or comment, leaving the text
- **⋯ → Accept all / Reject all** settles the whole note at once
- A **broken marker** — one with no partner, or a `{~~…~~}` with no `~>` — gets a
  card with nothing to settle, saying what is wrong. In the prose the marker
  itself is coloured, because braces that do not parse otherwise look exactly like
  text you typed on purpose.

Every action goes through the editor, so **⌘Z undoes it** like any other edit.

## Editorial comments

An observation belongs to a passage, not to a word, so it is not a mark.
**Insert editorial comment** writes a callout that stands in the text:

```markdown
> [!editorial] Editorial comment
> This paragraph is not working yet.
```

At the top of a note it reads as editorial frontmatter; between two scenes it
comments on the scene it follows. It appears in the drawer in document order
with no Accept, Reject or Resolve — there is nothing to settle. **Accept all**
and **Reject all** leave these standing; you delete them once the passage is
fixed.

## Archiving cut text

A paragraph that is wrong *here* is often not wrong at all. **Archive
selection** moves it out of the note and into an archive file beside it, so
cutting is not a choice between deleting and living with it.

Set an archive folder in **Settings > Manuscript** first. Each note then gets
one archive file mirroring its path, and every cut is appended under a
timestamp:

```
Book/Chapter 3/3 – The Arrival.md  →  Archive/Book/Chapter 3/3 – The Arrival.md
```

The archive links back to its source with an `origin` link rather than a
filename, because reordering renumbers files and Obsidian rewrites links when it
does. **The archive is append-only** — nothing here ever deletes from it, so
`⌘Z` puts the text back in your chapter but leaves the archived copy in place.

## Known limitations

- The same kind of mark cannot nest inside itself: in `{--a {--b--} c--}` the
  first closing marker has no way to say which opener it belongs to. The drawer
  reports both loose ends.
- CriticMarkup has no escape syntax, so a selection containing `~>` or `~~}`
  cannot become a substitution, and a note cannot contain a blank line or `<<}`.
- A mistyped opening marker claims the closing marker of the next mark of its
  kind, so it can strike through several paragraphs at once. `⌘Z` undoes it, and
  the drawer names it.
- **Accept all** / **Reject all** rewrite everything between the first and last
  mark in one edit, so the cursor can move. Deciding marks one at a time does not.
- `⌃⌘M`, `⌃⌘-` and `⌃⌘+` are macOS bindings for a German or US layout. Obsidian tells a
  plugin which character a key typed and which US-labelled key it sits under, and
  neither identifies "the minus key" on every board — so on Windows, on Linux, or
  on a layout that reaches these keys some third way, record your own in
  **Settings > Hotkeys**, which overrides the defaults. They avoid `⌘⇧`, where
  Obsidian's own Zoom in wins.
- In Reading view only CriticMarkup renders — Obsidian strips `%%comments%%`
  before any plugin sees them. A mark spanning paragraphs needs the note's source,
  which Obsidian withholds inside an embedded note and in a PDF export; there the
  markers still vanish, but the passage is left unstyled.

## Settings

**Settings > Community plugins > Manuscript**

| Setting | Default | Effect |
|---|---|---|
| Enable ordering | off | Shows drag handles and renumbers folders on drop |
| Enable review | on | Renders CriticMarkup inline and enables the Review drawer. Off leaves marks as plain text. Needs a reload to take full effect. |
| Archive folder | empty | Where **Archive selection** puts cut text. Empty disables archiving. |

## Installation

**From Community Plugins:** Settings > Community plugins > Browse, search for
"Manuscript", Install, Enable.

**Manually:** download `main.js`, `styles.css` and `manifest.json` from the
[latest release](../../releases/latest) into `.obsidian/plugins/manuscript/`,
then enable the plugin.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
npm test       # run tests
```

## License

MIT — see [LICENSE](LICENSE).
