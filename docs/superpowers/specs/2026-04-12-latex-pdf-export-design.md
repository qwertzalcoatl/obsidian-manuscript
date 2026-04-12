# LaTeX PDF Export — Design Spec

**Date:** 2026-04-12  
**Plugin:** Sheet Navigator (Obsidian)  
**Status:** Approved

---

## Overview

Add an opt-in LaTeX PDF export feature to Sheet Navigator. Writers can right-click folders/files in the navigator to select them, then export the combined content as a formatted PDF (starting with the German Normseite standard) via a one-click pipeline that calls `pdflatex` and presents a native Save As dialog.

---

## Architecture

Everything lives in `src/main.ts`. Four new pieces bolt onto the existing code:

1. **Selection state** on `SheetNavigatorView` — a `Set<string>` of selected paths plus an `isSelectionMode: boolean` flag.
2. **`ExportModal`** — a new `Modal` subclass with a template dropdown and Export button. Owns the full pipeline: gather files → generate `.tex` → run `pdflatex` → Save As dialog → clean up.
3. **LaTeX helpers** — two pure functions:
   - `generateLatex(files: TFile[], template: ExportTemplate): string` — converts markdown content to a `.tex` string
   - `compilePdf(texContent: string, pdflatexPath: string): Promise<string>` — shells out to `pdflatex`, returns the output `.pdf` path
4. **Settings additions** — `latexExportEnabled: boolean` and `pdflatexPath: string`.

The feature is entirely inert when the toggle is off. All export UI is also hidden on mobile via `Platform.isDesktop`.

---

## Selection UX

- **Entry point:** Right-click any folder or file → context menu → "Select for export"
  - The item is highlighted (distinct colored left border, different from active-note highlight)
  - The view enters selection mode
- **In selection mode:**
  - Clicking any card toggles its selection (does not drill in)
  - Shift+click selects a contiguous range based on current visual order
  - Clicking an already-selected item deselects it
  - Drilling via the chevron exits selection mode (keeps the UI simple; the user can start a new selection after drilling in)
  - Pressing **Escape** or clicking **× clear** in the toolbar exits selection mode and clears all selections
- **Toolbar export button** activates (full opacity, accent color) when ≥1 item is selected. When nothing is selected it is dimmed; clicking it shows a brief inline hint: "Right-click items to select them."

---

## Header Toolbar

The existing lone `+` button is replaced with a proper icon toolbar, designed using the `frontend-design` skill during implementation. The toolbar contains at minimum:

| Button | Icon | Behavior |
|--------|------|----------|
| New note | `file-plus` | Creates next numbered note in current folder (existing behavior) |
| Export | `download` or PDF icon | Dimmed when nothing selected; active when ≥1 item selected; hidden on mobile |

Hover states, spacing, active/inactive styling, and overall toolbar aesthetics are handled as a unified design pass — not bolted on piecemeal.

---

## Export Modal

Triggered by clicking the active Export button.

**Contents:**
- Title: "Export as PDF"
- Read-only summary of selected items (e.g. "Prolog, Die Preisverleihung") for confirmation
- Template dropdown — initial options: `Normseite (DE)`; designed to accept additional formats later
- "Export" button (CTA)
- Progress/status area: shows "Generating…", "Compiling…", error messages

**On Export:**
1. Walk selected folders/files in navigator order (numeric sort, recursive for folders) to collect `.md` files in the correct sequence
2. Strip/convert markdown: frontmatter removed, headings become section breaks, bold/italic converted to LaTeX equivalents
3. Wrap content in the selected LaTeX template
4. Write `.tex` to `os.tmpdir()`
5. Run `pdflatex` (two passes) via `child_process.execSync`
6. Present native Save As dialog via Electron's `dialog.showSaveDialog()` for the resulting `.pdf`
7. Clean up all temp files

**Error handling:**
- `pdflatex` not found → "pdflatex not found. Set its path in Sheet Navigator settings."
- Compilation failure → show pdflatex stderr in the modal so the user can diagnose

---

## LaTeX Templates

### Normseite (DE)

German publishing standard: Courier 12pt, 60 characters per line, 30 lines per page (~1,800 characters/page).

Uses the appropriate LaTeX package for Normseite formatting (to be confirmed during implementation — candidates: `normalpage`, `geometry` + custom settings). Template is a string constant in the source, parameterised by content.

### Future formats

The `ExportTemplate` type is designed as a union/enum so additional formats (Standard Manuscript Format, screenplay, etc.) can be added without restructuring. The dropdown in `ExportModal` renders from a `TEMPLATES` array.

---

## Cross-Platform Compatibility

| Concern | Solution |
|---------|----------|
| Path separators | `path.join()` everywhere — never string-concat with `/` |
| Temp directory | `os.tmpdir()` (works on macOS, Windows, Linux) |
| pdflatex invocation | All paths quoted in shell command; `-output-directory` flag used |
| Windows PATH | Settings path field lets users paste full binary path (e.g. `C:\Program Files\MiKTeX\...`); validated live |
| Save As dialog | Electron `dialog.showSaveDialog()` — identical on all three platforms |
| Mobile | All export UI hidden behind `Platform.isDesktop`; rest of plugin unaffected |
| `isDesktopOnly` | Stays `false` in `manifest.json` — the plugin works on mobile, only export is desktop-only |

---

## Settings

New section in the settings tab, rendered only when `Platform.isDesktop`:

- **"Enable PDF export"** toggle (`latexExportEnabled`, default `false`)
  - When off: no other fields shown, all export UI hidden throughout plugin
- **"pdflatex path"** text field (`pdflatexPath`, default `"pdflatex"`)
  - Shown only when toggle is on
- **Status line** below path field: validates binary on load and after each keystroke
  - "✓ pdflatex found" (muted success style)
  - "✗ Not found — install MacTeX, MiKTeX, or TeX Live" (muted warning style)

### Updated settings interface

```typescript
interface SheetNavigatorSettings {
  orderingEnabled: boolean;
  latexExportEnabled: boolean;   // default: false
  pdflatexPath: string;          // default: "pdflatex"
}
```

---

## What is NOT in scope

- Markdown → LaTeX conversion for complex syntax (tables, code blocks, images) — plain text and basic formatting only for v1
- Bundling pdflatex — users must install a TeX distribution themselves
- Mobile export — entirely excluded
- Custom LaTeX template editing by the user — templates are built-in only
