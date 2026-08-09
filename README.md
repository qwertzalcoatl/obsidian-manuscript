# Sheet Navigator

A single-column, drill-down sidebar for [Obsidian](https://obsidian.md) — built for writers who organize novels, screenplays, and long-form projects in folders and numbered files.

Browse your vault one level at a time: chapters show as cards with note counts, scenes show content previews. Click a scene to open it.

![Sheet Navigator screenshot](screenshot.png)

## Features

- **Drill-down navigation** — single-column view, one level at a time
- **Content previews** — each note card shows the first few lines of text
- **Smart name parsing** — extracts chapter numbers and titles from filenames like `1 – Die Preisverleihung` or `3 - Chapter Three`
- **Drag-and-drop reordering** — reorder scenes and chapters by dragging; items are renumbered sequentially (opt-in via settings)
- **New note button** — creates the next numbered note in the current folder (`Cmd+N`)
- **Right-click context menu** — rename or delete files and folders
- **Active note highlight** — the currently open note is highlighted in the sidebar
- **Live updates** — the list refreshes when files are created, renamed, or modified

## How it works

Open the navigator from the **ribbon icon** (layers) or the command palette ("Open Sheet Navigator").

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

Enable **Settings > Sheet Navigator > Enable ordering** to show drag handles. Dragging and dropping renumbers the folder sequentially (1, 2, 3…), preserving each item's title and its choice of separator.

Items **without** a number are left alone — they keep their exact filename and sort to the end of the list. Dragging an unnumbered item into the numbered run is the one action that gives it a number.

Folders and notes are numbered as separate sequences, so dragging a note onto a chapter folder is refused rather than producing two items that share a number.

## Installation

### From Obsidian Community Plugins

1. Open **Settings > Community plugins > Browse**
2. Search for "Sheet Navigator"
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Create a folder `sheet-navigator` in your vault's `.obsidian/plugins/` directory
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

Apache 2.0
