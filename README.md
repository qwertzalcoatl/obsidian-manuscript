# Manuscript

A single-column, drill-down sidebar for [Obsidian](https://obsidian.md) — built for writers who organize novels, screenplays, and long-form projects in folders and numbered files.

Browse your vault one level at a time: chapters show as cards with note counts, scenes show content previews. Click a scene to open it. Mark up a draft with suggestions and comments, then work through them in a side drawer.

## Features

- **Drill-down navigation** — single-column view, one level at a time
- **Content previews** — each note card shows the first few lines of text
- **Smart name parsing** — extracts chapter numbers and titles from filenames like `1 – Die Preisverleihung` or `3 - Chapter Three`
- **Drag-and-drop reordering** — reorder scenes and chapters by dragging; items are renumbered sequentially (opt-in via settings)
- **New note button** — creates the next numbered note in the current folder (`Cmd+N`)
- **Right-click context menu** — rename or delete files and folders
- **Active note highlight** — the currently open note is highlighted in the sidebar
- **Live updates** — the list refreshes when files are created, renamed, or modified
- **Editorial review** — suggest edits and leave comments in CriticMarkup, then accept or reject them one at a time from a side drawer
- **Archive** — move cut text out of a chapter into an append-only archive file that stays attached to it

## How it works

Open the navigator from the **ribbon icon** (layers) or the command palette ("Open Manuscript").

The navigator shows the contents of the current folder. Folders appear as chapter cards with note counts and a drill-in chevron. Notes appear as cards with a title and content preview.

### Filename-based ordering

Numbered items come first in numeric order, then everything else alphabetically. Use numeric prefixes to control order:

```
1 – Prolog.md
2 – Die Nachricht.md
3.md
99 – Notes.md
```

### Drag-and-drop reordering

Enable **Settings > Manuscript > Enable ordering** to show drag handles. Dragging and dropping renumbers the folder sequentially (1, 2, 3…), preserving each item's title and its choice of separator.

Items **without** a number are left alone — they keep their exact filename and sort to the end of the list. Dragging an unnumbered item into the numbered run is the one action that gives it a number.

Folders and notes are numbered as separate sequences, so dragging a note onto a chapter folder is refused rather than producing two items that share a number.

## Editorial review

An editorial pass on a chapter is a round trip: the text gets marked up, then you walk the marks and decide. Manuscript stores those marks as [CriticMarkup](http://criticmarkup.com) — plain text in the note itself, no sidecar database — and shows them in a **Review** drawer for the sheet you have open.

The workflow this is built for: ask Claude (or any assistant) to *"review chapter 3 and mark it up in CriticMarkup"*, then open the drawer and work through what comes back.

### The five marks

Three of them propose an edit, so they have two possible outcomes:

| Written | Means | Accept | Reject |
|---|---|---|---|
| `{++neuer Text++}` | insertion | keeps the text | drops it |
| `{--alter Text--}` | deletion | removes the text | keeps it |
| `{~~alt~>neu~~}` | substitution | writes `neu` | keeps `alt` |

The other two are annotations. They have one outcome, so they only offer **Resolve**:

| Written | Means | Resolve |
|---|---|---|
| `{==Text==}` | highlight | unwraps it, leaving the text |
| `{>>Kommentar<<}` | comment | deletes it |

A `{>>Kommentar<<}` written directly after another mark belongs to it and shares its card. Deciding that mark takes the comment with it — the decision is made, so the note about it is moot.

Obsidian's own syntax is read too: `%%Kommentar%%` is a standalone comment, and `==Text==%%Kommentar%%` is a commented highlight. A plain `==Text==` on its own is left alone — that's ordinary markdown, not an editorial mark.

### Editing a marked-up draft

Marked-up prose is prose you edit in place. Click into it and type — the syntax stays out of the way, and you never have to settle a suggestion just to gain typing access to the words around it. Arrow keys step over the hidden markers in one press rather than stalling on characters that aren't there, and a Backspace that would break a mark selects the whole thing first, so a construct cannot quietly degrade into plain text.

Comments live in the drawer, not in the prose — and they are written there too. A mark carrying one is drawn with a dotted underline; the note itself is on its card, where you click it to write or change it. A comment with no text anchored to it — one Claude left on a line of its own, say — shows in the drawer and the mark count but nowhere on the page.

A change you have started but not written into shows a faint green *insert…* where the words go, washed the way marked text is — because that is what it is, something you type over. Type and it gives way; press `Escape` and the whole construct does.

If a mark ever needs repairing by hand, **Show markup source at cursor** unfolds the one under the caret, braces and all. It folds itself back when you move away. That command is the only thing in the plugin that puts syntax on screen.

### Working through a pass

Open the drawer from the **Review button** in the navigator toolbar, or the command palette. Each mark becomes a card showing the affected text as the change itself: struck through for a deletion, underlined for an insertion. Click a card to jump to it in the editor.

- **Click a card's note** to write or change it; `⌘↵` or clicking away commits, `Escape` cancels. A note cleared to nothing is removed, and a card with no note yet offers one from its actions row.
- **Accept / Reject** decide a suggestion
- **Resolve** clears a highlight or comment, leaving the text
- **⋯ → Accept all / Reject all** settles the whole note in one step; either way the highlights and comments go too

Every action is written through the editor, so **⌘Z undoes it** like any other edit.

### Marking up by hand

Every construct has a command, so the whole format is reachable from the command palette (`⌘P`). Typing *suggest* brings up the three suggestion types together; typing *markup* brings up the whole-note actions.

| Command | Needs a selection | Writes |
|---|---|---|
| Comment on selection — `⌘⇧M` | yes | `{==Text==}`, then the drawer opens with the caret in its note field |
| Highlight selection | yes | `{==Text==}`, silently — the caret stays in the sentence |
| Suggest deletion | yes | `{--Text--}`, then the drawer opens with the caret in its note field |
| Suggest a change | no | with a selection `{~~alt~>neu~~}`, without one `{++Text++}` — either way you type the new wording in the manuscript |
| Accept all markup in this note | no | resolves everything, keeping the suggestions |
| Reject all markup in this note | no | resolves everything, turning them all down |
| Show markup source at cursor | no | unfolds the mark under the caret for repair |
| Open review panel | no | — |

The right-click menu carries **Comment on selection**, **Highlight selection**, **Suggest deletion** and **Suggest as addition** — the last of which marks text already written as a proposed addition and has no command of its own, since everywhere else a selection means *here is what I am changing*. Nothing in your note is ever modified unless you invoke one of these.
Proposing a cut asks a question of the writer, so *Suggest deletion* takes the caret into the note field the way a comment does. Leave the field empty and the mark simply stays as it is, unannotated.


### Known limitations

- A mark may wrap across a soft line break but not across a blank line, so there are no multi-paragraph anchors. This also stops a stray `{++` from swallowing the rest of the note when it eventually meets a `++}`.
- Marks do not nest. `{==a {==b==} c==}` closes at the first `==}`.
- A selection containing `~>` or `~~}` cannot become a replacement: the format has no escape syntax, so the construct would split in the wrong place or close early. The command says so and writes nothing.
- A note may run to several lines but cannot hold a blank line or its own `<<}` — CriticMarkup has no escape syntax, so a blank line would end the mark and `<<}` would close it early. Both are defused as the note is written, and what the card shows afterwards is what was stored.
- **Accept all** / **Reject all** rewrite everything between the first and last mark in one edit, so the cursor can move if it was sitting between them. Deciding marks one at a time leaves the cursor exactly where it was.
- `{--alt--}{++neu++}` is read as two separate marks, not as one substitution. Use `{~~alt~>neu~~}` for that.
- Whitespace left behind by a resolved mark is yours to tidy; the plugin does not guess.
- In Reading view, only CriticMarkup renders. Obsidian removes `%%comments%%` from the page before any plugin can see them, so those stay invisible there — exactly as they are without this plugin.

## Archiving cut text

A paragraph that is wrong *here* is often not wrong at all. **Archive selection**
moves it out of the chapter and into an archive beside the manuscript, so
cutting does not mean choosing between deleting and living with it.

Set an archive folder in **Settings > Manuscript** first — archiving refuses
until you do. Each note then gets one archive file, mirroring its path:

```
Manuskript/Kapitel 3/3 – Die Nachricht.md
  →  Archiv/Manuskript/Kapitel 3/3 – Die Nachricht.md
```

Every cut from that chapter is appended to that one file under a timestamp:

```markdown
---
origin: "[[Manuskript/Kapitel 3/3 – Die Nachricht]]"
---

## 2026-08-12 14:32

Der erste gestrichene Absatz …

## 2026-08-12 16:05

Und noch einer …
```

The `origin` link is how an archive knows its chapter, and it is a link rather
than a filename on purpose: reordering renumbers your files, and Obsidian
rewrites links when it does. Renumber a chapter and its archive stays attached
— under its old filename, which is now merely stale rather than wrong.

The command is in the palette and in the right-click menu, and it needs a
selection. A selection that cuts through a suggestion or comment is widened to
take the whole mark, so archiving can never tear a construct in half.

**The archive is append-only.** Nothing in this plugin ever deletes from an
archive file or moves an entry back out. One consequence is worth knowing:
`⌘Z` puts the text back in your chapter but leaves the archived copy in place.

## Settings

**Settings > Community plugins > Manuscript**

| Setting | Default | Effect |
|---|---|---|
| Enable ordering | off | Shows drag handles and renumbers folders on drop |
| Enable review | on | Renders CriticMarkup inline and enables the Review drawer and its commands. With it off, marks are left as plain text. Obsidian needs a reload for this to take full effect. |
| Archive folder | empty | Where **Archive selection** puts cut text. Empty disables archiving. |

## Installation

### From Obsidian Community Plugins

1. Open **Settings > Community plugins > Browse**
2. Search for "Manuscript"
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Create a folder `manuscript` in your vault's `.obsidian/plugins/` directory
3. Copy the three files into it
4. Enable the plugin in **Settings > Community plugins**

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
npm test       # run tests
```

## License

MIT — see [LICENSE](LICENSE).
