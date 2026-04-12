# Sheet Navigator

A single-column, drill-down navigator for [Obsidian](https://obsidian.md) — inspired by [Ulysses](https://ulysses.app).

Browse your vault like a Miller column with depth = 1: folders show as chapter cards with note counts, notes show content previews. Click to drill in, click back to go up.

## Features

- **Drill-down navigation** — single-column view, one level at a time
- **Content previews** — each note card shows the first few lines of text
- **Smart name parsing** — extracts chapter numbers and titles from filenames like `1 – Die Preisverleihung` or `3 - Chapter Three`
- **Drag-and-drop reordering** — reorder by dragging; items are renumbered by renaming their numeric prefix (opt-in via settings)
- **Right-click context menu** — rename or delete files and folders
- **Active note highlight** — the currently open note is highlighted
- **Live updates** — the list refreshes when files are created, renamed, or modified

## How it works

Open the navigator from the **ribbon icon** (layers) or the command palette ("Open Sheet Navigator").

The navigator shows the contents of the current folder. Folders appear as cards with note counts and a drill-in chevron. Notes appear as cards with a title and content preview.

### Filename-based ordering

Files and folders are sorted naturally by name. Use numeric prefixes to control order:

```
1 – Die Preisverleihung.md
2 – Die Nachricht.md
3.md
99 – Notes.md
```

### Drag-and-drop reordering

Enable **Settings → Sheet Navigator → Enable ordering** to show drag handles. Dragging and dropping renumbers all items in the current folder sequentially (1, 2, 3…), preserving titles and separators.

## Installation

### From Obsidian Community Plugins

1. Open **Settings → Community plugins → Browse**
2. Search for "Sheet Navigator"
3. Click **Install**, then **Enable**

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Create a folder `sheet-navigator` in your vault's `.obsidian/plugins/` directory
3. Copy the three files into it
4. Enable the plugin in **Settings → Community plugins**

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```

Copy `main.js`, `styles.css`, and `manifest.json` to your vault's `.obsidian/plugins/sheet-navigator/` for testing.

## License

MIT
