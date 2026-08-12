# Archive Text — Design Spec

**Date:** 2026-08-12
**Plugin:** Manuscript (Obsidian)
**Status:** Approved

---

## The problem

Cut prose has nowhere to go. A paragraph that is wrong *here* is often not wrong
*at all*, and the two ways of handling that today are both bad: delete it and
hope you don't want it back, or leave it in the chapter behind a comment and
read past it for the rest of the draft.

What is missing is a place beside the manuscript — one file per chapter,
holding everything ever cut from that chapter, in the order it was cut.

## What it does

You select text and invoke **Archive selection**. The plugin finds the archive
file belonging to the note you are in, or creates it, appends the selection
under a timestamp, and removes it from the chapter.

The archive is **append-only**. Nothing in this feature ever deletes from an
archive file, moves an entry out of one, or rewrites an entry already in one.
That is the promise, and several decisions below are its price.

## Where the archive lives

One setting, `archiveFolder`, names the archive root. It is empty by default,
which means unconfigured, and the command refuses until it is set. Settings live
in the vault's own `data.json`, so the archive is configured per vault without
any extra machinery.

Inside that root, the archive **mirrors the origin's full vault-relative path**:

```
Manuskript/Kapitel 3/3 – Die Nachricht.md
  →  Archiv/Manuskript/Kapitel 3/3 – Die Nachricht.md
```

One rule, no second setting, and it cannot collide. Collisions are a real
concern rather than a hypothetical one: the README documents bare `3.md` as a
supported filename, so a flat archive would put `Kapitel 7/3.md` and
`Kapitel 9/3.md` in the same place.

The cost is one redundant `Manuskript/` level inside the archive. The
alternative — a second setting naming the manuscript root so it can be stripped
— buys cosmetics with configuration. Declined.

Missing folder levels are created on first use.

## How an archive file knows its origin

The archive file's frontmatter carries a **wikilink** to the origin:

```yaml
---
origin: "[[Manuskript/Kapitel 3/3 – Die Nachricht]]"
---
```

The full vault path is written rather than the basename, because `[[3]]` is
ambiguous in a vault that contains several `3.md` and would resolve to whichever
one is nearest the archive file.

A link rather than a path string, because **this plugin renames manuscript files
as a matter of course**. Dropping a scene renumbers its whole folder through
`computeRenamePlan` and the `fileManager.renameFile` calls at `src/main.ts:817`,
`861` and `941`. A stored path would go stale on the first reorder, and the next
cut from that chapter would silently start a second archive file.

`fileManager.renameFile` is the API that rewrites inbound links, frontmatter
links included. So Obsidian maintains the association for us, and the plugin
writes nothing into the manuscript files themselves.

### Lookup

Frontmatter is the truth; the filename is a convenience. To find a chapter's
archive, the plugin walks the `.md` files under the archive root, reads each
one's `origin` out of `frontmatterLinks`, resolves it with
`getFirstLinkpathDest`, and compares the result against the origin `TFile`.

Deriving the path and trusting it was rejected: after a renumber the archive
file still sits under its old name, so a derived path finds nothing and creates
a duplicate — exactly the failure the wikilink was chosen to prevent. The
derived path is used for **creation only**.

Self-healing — renaming a drifted archive file back into place — was considered
and declined. It adds a file move to a feature whose promise is that it only
appends, and the stale name costs nothing: the archive is reached through the
link, and Obsidian's backlinks pane shows it from the chapter.

## The entry format

```markdown
---
origin: "[[Manuskript/Kapitel 3/3 – Die Nachricht]]"
---

## 2026-08-12 14:32

Der gestrichene Absatz …

## 2026-08-12 16:05

Noch einer …
```

A heading per entry, stamped with local time in ISO order — sortable,
locale-neutral, and enough to find *the version I cut last Tuesday*. Headings
also give the archive an outline in Obsidian's own outline view, which a bare
separator would not.

Append-only makes this format permanent for every archive already written, which
is why it is decided here rather than discovered later.

## Selections that cut a mark in half

A selection can start or end inside a CriticMarkup construct. Taken literally,
`{++neuer Text++}` becomes `{++neuer Te` in the archive and `xt++}` in the
chapter — two malformed marks, and the plugin's only repair tool unfolds a mark
rather than rejoining a torn one.

So the range is **expanded outward until no construct is split**, and the
expanded text is what moves. This follows the guard already in
`critic-render.ts`, where a Backspace that would break a mark selects the whole
thing first rather than letting it degrade into plain text.

Refusing instead was rejected on a specific ground: the markup is folded, so the
writer cannot see where a construct begins. "Adjust your selection" would ask
them to aim at something invisible.

`parseCritic` reports an entry's `to` past its attached `{>>comment<<}`, so
expanding over a mark takes its note with it without extra work.

## The module boundary

A new `src/archive.ts`, free of any `obsidian` import — the pattern `text.ts`,
`naming.ts` and `critic.ts` already follow, and the only way this logic reaches
jest. `main.ts` is at 1541 lines and absorbs none of it.

| Function | Answers |
|---|---|
| `archivePathFor(originPath, archiveRoot)` | where this chapter's archive file lives |
| `expandToMarks(content, from, to)` | how far the range must grow to stop splitting marks |
| `originLink(originPath)` | the wikilink written into `origin:`, extension stripped |
| `timestamp(date)` | a `Date` → `2026-08-12 14:32`, so the format is testable |
| `newArchive(link, stamp, text)` | the body of a first-time archive file |
| `appendEntry(existing, stamp, text)` | existing body + one cut → new body |

`main.ts` keeps the vault I/O alone: the folder walk, `createFolder`,
`vault.create`, `vault.process`.

## The command surface

| Piece | Decision |
|---|---|
| Command | `archive-selection`, "Archive selection" |
| Availability | `editorCheckCallback`, unavailable without a selection — the idiom `addSelectionCommand` already uses |
| Context menu | An **Archive selection** item, icon `archive` |
| Hotkey | None. `⌘⇧M` stays the only binding this plugin claims |
| Setting | `archiveFolder: ""` in `ManuscriptSettings`, a plain `addText` below the two existing toggles |

**Registered outside `loadReview()`.** Archiving is not editorial review and must
keep working with *Enable review* switched off. The editor-menu block today
lives inside `loadReview()`, so the archive item needs its own `registerEvent`
rather than joining that list.

## The flow of one action

The archive write happens **first**; the chapter loses the text only once it has
landed. Reversed, the worst case is prose destroyed with no copy anywhere. In
this order the worst case is that nothing happened.

1. Guards — the editor has a backing file, the archive folder is configured, the
   note is not itself in the archive, the selection is not pure whitespace.
2. `expandToMarks` widens the range over any construct the selection cut.
3. Find the archive file by frontmatter, as above.
4. Found → append (see below). Not found → create the missing folder levels,
   then `vault.create` with frontmatter and the first entry. The returned
   `TFile` is held rather than looked up again: `metadataCache` updates
   asynchronously and does not yet know the file exists.
5. Re-read the editor and confirm the range still holds the text that was
   archived. If it does, remove it.
6. `Notice` naming the archive file.

### When the archive is open in a tab

You will have the archive open — that is where you go to read what you cut. If
it is open **and** holds unsaved changes, a `vault.process` append writes to
disk while the editor holds a different version of the same file, and whichever
flushes last wins. The losing side can be the entry just appended: silent loss,
in the one feature that promises nothing is ever lost.

So the append follows the rule this plugin already holds. `readLiveContent`
(`src/review-view.ts:45`) prefers an open `MarkdownView`'s editor value and only
falls back to `vault.cachedRead` — **the live buffer is authoritative.** The
archive write does the same: if a markdown view has this file open, the entry is
appended through that view's editor; otherwise through `vault.process`.

Writing through the editor also makes that append undoable in the archive's own
tab, which is a wrinkle in "append-only" but a harmless one — it is the writer
undoing in a document they have open, not the plugin removing anything.

## What can go wrong

| Situation | What happens |
|---|---|
| No archive folder set | Notice pointing at Settings → Manuscript. Nothing written |
| Selection is whitespace only | Refused. An empty entry is noise the file can never lose |
| The note is itself in the archive | Refused. Archiving the archive has no meaning |
| Archive folder does not exist | Created on first use, one level at a time |
| Two archive files claim one origin | First in path order wins, deterministically. Only reachable by hand-editing frontmatter |
| The archive is open with unsaved edits | Appended through that editor rather than to disk, so neither version is lost |
| Archive write fails | Notice carries the error; the chapter is untouched |
| The note changed mid-write | Archived but not removed, and the Notice says so. A visible duplicate beats an invisible deletion |

## Known limitations

- **Undo is asymmetric.** `⌘Z` puts the text back in the chapter; the archive
  keeps its copy. Append-only means the plugin never takes anything back out of
  an archive, including something it wrote a second ago.
- **A renamed or moved chapter leaves its archive where it was.** Renumbering
  leaves a stale filename; moving the chapter to another folder leaves the
  archive under the old one, so the mirror stops describing that pair. Both are
  cosmetic — the link still resolves and the append still lands in the right
  file. The link is what is true; the path is a convenience that was accurate
  when the file was made.
- **It rests on Obsidian's "Automatically update internal links."** With that
  setting off, a renumber detaches the archive and the next cut starts a second
  file. This is the one assumption the design leans on — see step 3 of the vault
  checks.
- The archive folder appears in the navigator like any other folder. Hiding it
  is not part of this.
- Markup inside an archived passage travels verbatim. The archive is a record of
  what was cut, not a resolved version of it.

## Verification

`npm test` covers `archive.ts` directly, it being pure:

- `archivePathFor` — nested origin, vault-root origin, archive root with and
  without a trailing slash
- `expandToMarks` — no marks; a mark wholly inside; a selection opening inside a
  mark; one closing inside a mark; one spanning several; a mark carrying an
  attached comment
- `appendEntry` — existing body ending in a newline and not ending in one, so
  two entries never run together
- `newArchive` — frontmatter plus first entry
- `originLink` — paths with spaces and en-dashes
- `timestamp` — a fixed `Date` renders to the documented shape

Jest sees none of the vault behaviour, so these six run in Obsidian:

1. Archive from a chapter → the file appears at the mirrored path, carrying the
   `origin` link
2. Archive again → a second heading in the **same** file
3. Rename that chapter from the navigator's right-click menu → the archive's
   `origin` link has been rewritten by Obsidian
4. Archive again after the rename → still one file, no duplicate
5. Archive with the archive file **open in a tab and holding unsaved edits** →
   the entry survives
6. Archive with **Enable review** switched off → still works
7. `⌘Z` after archiving → the text is back in the chapter

Check 3 uses the rename modal rather than drag-and-drop on purpose: reordering
needs *Enable ordering*, which is off by default, and `RenameModal` reaches the
same `fileManager.renameFile` at `main.ts:941` — the call that rewrites links.

**Checks 3 and 4 are load-bearing, and only as a pair.** Check 3 shows the link
changed; check 4 shows it still resolves to the right file, which is the thing
actually being relied on. If either fails in this vault, the wikilink decision
collapses and the fallback is stamping ids into both files. Better learned on
day one than after fifty cuts.

## Out of scope

Restoring text from an archive back into a chapter. Hiding the archive folder
from the navigator. Renaming archive files to follow a renumbered chapter.
Archiving whole notes rather than selections.
