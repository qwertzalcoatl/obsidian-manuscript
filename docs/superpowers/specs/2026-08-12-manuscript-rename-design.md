# Renaming to Manuscript — Design Spec

**Date:** 2026-08-12
**Plugin:** Sheet Navigator (Obsidian) → **Manuscript**
**Status:** Approved

---

## The problem

The plugin is called *Sheet Navigator*, which describes a file browser. What it
has become is a place to work on a novel: chapters drilled into one level at a
time, scenes as cards, and an editorial pass in CriticMarkup with a review
drawer. The name names the smallest of those three things.

## What it is called instead

**Manuscript.** It is the plainest word for the thing the plugin operates on,
and the one a novelist scanning the community store reads without translating.

The store already carries *Manuscript Compiler*, *Manuscript Export*,
*Manuscript Outliner*, *Manuscriptum* and *Japanese Manuscript Counter*, so the
word is not distinctive. But the bare, unqualified `manuscript` id is free and
is the cleanest position in that field. Accepted knowingly.

`community-plugins.json` has no `sheet-navigator` entry — the plugin was never
submitted, so the id is not load-bearing for anyone but its author, and the
rename is free in the only sense that matters.

## What changes

### Identity

| Where | From | To |
|---|---|---|
| `manifest.json` `id` | `sheet-navigator` | `manuscript` |
| `manifest.json` `name` | Sheet Navigator | Manuscript |
| `package.json` `name` | `obsidian-sheet-navigator` | `obsidian-manuscript` |
| Ribbon tooltip | Sheet Navigator | Manuscript |
| Settings heading | Sheet Navigator | Manuscript |
| Command title | Open Sheet Navigator | Open Manuscript |
| `console.error` prefix (6×) | `Sheet Navigator:` | `Manuscript:` |
| GitHub repo | `obsidian-sheet-navigator` | `obsidian-manuscript` |

### Identifiers

Each one costs something specific, and the cost is the reason it is listed
rather than swept up by a single find-and-replace.

| Identifier | To | What it costs |
|---|---|---|
| `VIEW_TYPE` = `sheet-navigator-view` | `manuscript-view` | The vault stores an open leaf's type in `workspace.json`. An open navigator deserializes to nothing once; reopening from the ribbon fixes it permanently. |
| `VIEW_TYPE_REVIEW` = `sheet-navigator-review` | `manuscript-review` | The same, for the drawer. |
| Command id `open-sheet-navigator` | `open-manuscript` | Obsidian keys hotkeys as `<pluginId>:<commandId>`, so a hand-set binding detaches. The plugin id changes anyway, so every hand-set binding detaches regardless. |
| `SheetNavigator*` (15 occurrences) | `Manuscript*` | Compile-time only. Covers the view, the plugin, the settings interface and the settings tab. |
| `.sheet-navigator` | `.manuscript` | — |
| `.sheet-nav-*` | `.ms-nav-*` | — |
| `.sheet-review-*` | `.ms-review-*` | — |
| `.sn-critic-*` | `.ms-critic-*` | — |
| `--sn-folder-num-chars`, `--sn-file-num-chars` | `--ms-*` | — |

The plugin registers ten commands. The other nine carry no product name and stay
exactly as they are: `new-note-in-current-folder`, `open-review-panel`,
`toggle-markup-source`, `suggest-change`, `accept-all-markup`,
`reject-all-markup`, and the three registered through `addSelectionCommand` —
`comment-on-selection`, `highlight-selection`, `suggest-deletion`.

The CSS names are written in **two** places — `styles.css` and the `cls:`
strings in `src/main.ts` and `src/review-view.ts`. Roughly 280 replacements
across both. This is the part that fails silently; see *Verification*.

## What deliberately stays

**The word "sheet."** It survives as a domain term — "the active sheet," "read
the sheet for review," `getActiveSheetView`. A manuscript is made of sheets, so
the vocabulary holds together better after the rename than before it. Only the
branded pair *Sheet Navigator* goes.

**Settings keys.** `orderingEnabled`, `reviewEnabled` and the LaTeX-export keys
carry no product name, so `data.json` stays readable across the rename.

**`docs/superpowers/`.** The seven dated specs and plans record what was decided
when, under the name the plugin had at the time. Rewriting them would falsify
the record. They keep saying *Sheet Navigator*, and that is correct.

## What this costs the author's own vault

Obsidian derives the plugin's data directory from its id. After the rename:

```
<vault>/.obsidian/plugins/sheet-navigator/   →  .../plugins/manuscript/
```

Rename that folder and `data.json` travels with it, settings intact. Skip it and
Obsidian shows two plugins and the new one starts on defaults. Hand-set hotkeys
detach either way, because they are keyed on the plugin id.

## Verification

`npm test` covers `critic.ts`, `naming.ts` and `text.ts`. It has no view of CSS
wiring, so a replacement that updates `styles.css` but misses a `cls:` string in
`review-view.ts` produces **zero test failures and silently unstyled UI**. The
test suite is therefore not the gate. This is:

1. `grep -rniE "sheet[- _]?navigator|sheet-nav|sheet-review|sn-critic|--sn-" src styles.css`
   returns nothing — note `sheet-review` is listed separately, because
   `sheet-nav` does not match it and leaving it out would pass a grep over 38
   unrenamed drawer classes
2. `grep -rn "Sheet Navigator" manifest.json package.json README.md` returns
   nothing
3. `npm run build` succeeds
4. `npm test` passes
5. Load in the vault: the navigator renders with its cards, previews and
   chevrons; the Review drawer opens and its cards are styled

Step 5 is the only one that proves the CSS rename landed.

## Out of scope

Renaming the local working directory (`~/Developer/sheet-navigator`) and the
vault's plugin folder. Both are the author's to run; the commands are handed
over on completion.
