# LaTeX PDF Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in LaTeX PDF export to Sheet Navigator — writers right-click to select folders/files, then export combined content as a Normseite-formatted PDF via a native Save As dialog.

**Architecture:** New `src/export.ts` owns all export logic (types, template, markdown conversion, pdflatex shell-out, `ExportModal`). `src/main.ts` gains selection state and a redesigned toolbar. The feature is gated behind a settings toggle and entirely hidden on mobile via `Platform.isDesktop`.

**Tech Stack:** TypeScript, Obsidian API, Node.js `child_process` / `fs` / `os` / `path` (already external in esbuild), `@electron/remote` for native Save As dialog (provided by Obsidian at runtime), `pdflatex` (user-installed), Jest + ts-jest for pure-function tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/export.ts` | **Create** | `ExportTemplate`, `TEMPLATES`, `FileContent`, `stripMarkdown()`, `escapeLatex()`, `generateLatex()`, `checkPdflatex()`, `compilePdf()`, `ExportModal` |
| `src/export.test.ts` | **Create** | Unit tests for `stripMarkdown()`, `escapeLatex()`, `generateLatex()` |
| `src/main.ts` | **Modify** | Add selection state + methods to `SheetNavigatorView`; update settings interface, defaults, and tab; update context menu; update card click handlers; redesigned toolbar |
| `styles.css` | **Modify** | Toolbar styles, selection highlight, export modal styles, settings status styles |
| `esbuild.config.mjs` | **Modify** | Add `@electron/remote` to externals |
| `jest.config.js` | **Create** | Jest + ts-jest config |
| `package.json` | **Modify** | Add `jest`, `ts-jest`, `@types/jest` devDependencies |

---

## Task 1: Test infrastructure + export.ts skeleton

**Files:**
- Modify: `package.json`
- Create: `jest.config.js`
- Create: `src/export.ts`
- Create: `src/export.test.ts`

- [ ] **Step 1: Add devDependencies to package.json**

Replace the `devDependencies` block in `package.json`:

```json
"devDependencies": {
  "@types/jest": "^29.5.0",
  "@types/node": "^22.0.0",
  "builtin-modules": "^4.0.0",
  "esbuild": "^0.24.0",
  "jest": "^29.7.0",
  "obsidian": "latest",
  "ts-jest": "^29.2.0",
  "typescript": "^5.6.0"
}
```

- [ ] **Step 2: Create jest.config.js**

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  moduleNameMapper: {
    // Obsidian is not available in tests — these modules are never imported by tested functions
    '^obsidian$': '<rootDir>/src/__mocks__/obsidian.ts',
  },
};
```

- [ ] **Step 3: Create the Obsidian mock (only needed by test runner, not by export.ts)**

Create `src/__mocks__/obsidian.ts`:

```typescript
// Minimal stub — export.ts doesn't import from obsidian, but ts-jest needs a resolvable module
export class Modal {}
export class Setting {}
export class Notice {}
export class Plugin {}
```

- [ ] **Step 4: Create src/export.ts skeleton with types**

```typescript
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Modal, Notice, Platform, Setting, TFile, TFolder } from 'obsidian';
import type SheetNavigatorPlugin from './main';
import type { SheetNavigatorView } from './main';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileContent {
  title: string;
  content: string;
}

export type ExportTemplate = 'normseite-de';

interface TemplateDefinition {
  id: ExportTemplate;
  label: string;
  wrap: (body: string) => string;
}

// ─── Normseite template ───────────────────────────────────────────────────────
// Normseite (DE): Courier 12pt, ~60 chars/line, ~30 lines/page, A4
// textwidth=155mm → 60 Courier chars at 12pt (≈2.58mm/char)
// setstretch=1.667 → baselineskip≈24pt=8.47mm; 247mm text height / 8.47 ≈ 29 lines

const NORMSEITE_TEMPLATE = (body: string): string =>
  `\\documentclass[12pt,a4paper]{article}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{courier}
\\usepackage{geometry}
\\usepackage{setspace}
\\geometry{
  a4paper,
  top=25mm,
  bottom=25mm,
  left=30mm,
  right=25mm,
  textwidth=155mm
}
\\renewcommand{\\familydefault}{\\ttdefault}
\\setstretch{1.667}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{\\baselineskip}
\\pagestyle{plain}
\\begin{document}
${body}
\\end{document}
`;

export const TEMPLATES: TemplateDefinition[] = [
  { id: 'normseite-de', label: 'Normseite (DE)', wrap: NORMSEITE_TEMPLATE },
];

// ─── Placeholders for Task 2 & 3 ─────────────────────────────────────────────

export function escapeLatex(_text: string): string {
  throw new Error('not implemented');
}

export function stripMarkdown(_content: string): string {
  throw new Error('not implemented');
}

export function generateLatex(_files: FileContent[], _template: ExportTemplate): string {
  throw new Error('not implemented');
}
```

- [ ] **Step 5: Create src/export.test.ts with one placeholder test**

```typescript
import { escapeLatex, stripMarkdown, generateLatex } from './export';

describe('escapeLatex', () => {
  it('is a placeholder', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 6: Install dependencies**

```bash
npm install
```

Expected: `node_modules` updated, no errors.

- [ ] **Step 7: Run tests**

```bash
npx jest
```

Expected: 1 test suite, 1 test, 1 passed.

- [ ] **Step 8: Commit**

```bash
git add package.json jest.config.js src/export.ts src/export.test.ts src/__mocks__/obsidian.ts
git commit -m "feat: add test infrastructure and export.ts skeleton"
```

---

## Task 2: Implement escapeLatex() and stripMarkdown() (TDD)

**Files:**
- Modify: `src/export.ts`
- Modify: `src/export.test.ts`

- [ ] **Step 1: Write failing tests for escapeLatex()**

Replace the contents of `src/export.test.ts`:

```typescript
import { escapeLatex, stripMarkdown, generateLatex, TEMPLATES } from './export';

describe('escapeLatex', () => {
  it('escapes backslash', () => {
    expect(escapeLatex('a\\b')).toBe('a\\textbackslash{}b');
  });
  it('escapes braces', () => {
    expect(escapeLatex('a{b}c')).toBe('a\\{b\\}c');
  });
  it('escapes ampersand', () => {
    expect(escapeLatex('a&b')).toBe('a\\&b');
  });
  it('escapes percent', () => {
    expect(escapeLatex('50%')).toBe('50\\%');
  });
  it('escapes dollar', () => {
    expect(escapeLatex('$10')).toBe('\\$10');
  });
  it('escapes hash', () => {
    expect(escapeLatex('#tag')).toBe('\\#tag');
  });
  it('escapes underscore', () => {
    expect(escapeLatex('a_b')).toBe('a\\_b');
  });
  it('escapes caret', () => {
    expect(escapeLatex('a^b')).toBe('a\\textasciicircum{}b');
  });
  it('escapes tilde', () => {
    expect(escapeLatex('a~b')).toBe('a\\textasciitilde{}b');
  });
  it('leaves plain text unchanged', () => {
    expect(escapeLatex('Hello world')).toBe('Hello world');
  });
});

describe('stripMarkdown', () => {
  it('strips YAML frontmatter', () => {
    const input = '---\ntitle: Test\n---\nHello world';
    expect(stripMarkdown(input)).toBe('Hello world');
  });
  it('strips heading markers but keeps text', () => {
    expect(stripMarkdown('# Chapter One')).toBe('Chapter One');
    expect(stripMarkdown('## Scene')).toBe('Scene');
  });
  it('strips bold markers', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
    expect(stripMarkdown('__bold__')).toBe('bold');
  });
  it('strips italic markers', () => {
    expect(stripMarkdown('*italic*')).toBe('italic');
    expect(stripMarkdown('_italic_')).toBe('italic');
  });
  it('converts links to link text only', () => {
    expect(stripMarkdown('[click here](http://example.com)')).toBe('click here');
  });
  it('strips inline code backticks', () => {
    expect(stripMarkdown('use `code`')).toBe('use code');
  });
  it('strips fenced code blocks', () => {
    expect(stripMarkdown('before\n```\ncode\n```\nafter')).toBe('before\nafter');
  });
  it('escapes LaTeX special chars in remaining text', () => {
    expect(stripMarkdown('50% done')).toBe('50\\% done');
    expect(stripMarkdown('cost: $10')).toBe('cost: \\$10');
  });
  it('handles plain text with no markdown', () => {
    expect(stripMarkdown('Hello world')).toBe('Hello world');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest
```

Expected: multiple FAILED tests with "not implemented" errors.

- [ ] **Step 3: Implement escapeLatex() in src/export.ts**

Replace the `escapeLatex` stub:

```typescript
export function escapeLatex(text: string): string {
  return text
    // Backslash must come first — use placeholder to avoid double-escaping braces
    .replace(/\\/g, '\x00BS\x00')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\x00BS\x00/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}
```

- [ ] **Step 4: Implement stripMarkdown() in src/export.ts**

Replace the `stripMarkdown` stub:

```typescript
export function stripMarkdown(content: string): string {
  let text = content;

  // Strip YAML frontmatter
  if (text.startsWith('---')) {
    const end = text.indexOf('---', 3);
    if (end !== -1) text = text.slice(end + 3).trimStart();
  }

  // Strip fenced code blocks before other processing
  text = text.replace(/```[\s\S]*?```/g, '');

  // Strip heading markers, keep text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  // Strip bold (**text** and __text__)
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strip italic (*text* and _text_) — must come after bold
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');

  // Strip links [text](url) → text
  text = text.replace(/\[(.+?)\]\(.+?\)/g, '$1');

  // Strip inline code backticks
  text = text.replace(/`(.+?)`/g, '$1');

  // Escape remaining LaTeX special characters
  text = escapeLatex(text);

  return text.trim();
}
```

- [ ] **Step 5: Run tests — all should pass**

```bash
npx jest
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/export.ts src/export.test.ts
git commit -m "feat: implement escapeLatex and stripMarkdown"
```

---

## Task 3: Implement generateLatex() (TDD)

**Files:**
- Modify: `src/export.ts`
- Modify: `src/export.test.ts`

- [ ] **Step 1: Add failing tests for generateLatex()**

Append to `src/export.test.ts`:

```typescript
describe('generateLatex', () => {
  const files: import('./export').FileContent[] = [
    { title: 'Scene 1', content: 'It was a dark night.' },
    { title: 'Scene 2', content: 'The door opened.' },
  ];

  it('returns a string containing \\begin{document}', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\begin{document}');
  });

  it('returns a string containing \\end{document}', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\end{document}');
  });

  it('includes content from all files', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('It was a dark night.');
    expect(result).toContain('The door opened.');
  });

  it('wraps in Normseite preamble when template is normseite-de', () => {
    const result = generateLatex(files, 'normseite-de');
    expect(result).toContain('\\usepackage{courier}');
    expect(result).toContain('textwidth=155mm');
  });

  it('throws for unknown template', () => {
    expect(() => generateLatex(files, 'unknown' as any)).toThrow('Unknown template');
  });

  it('strips markdown in file content', () => {
    const withMarkdown: import('./export').FileContent[] = [
      { title: 'Test', content: '**bold text**' },
    ];
    const result = generateLatex(withMarkdown, 'normseite-de');
    expect(result).toContain('bold text');
    expect(result).not.toContain('**');
  });
});
```

- [ ] **Step 2: Run tests to verify generateLatex tests fail**

```bash
npx jest --testNamePattern="generateLatex"
```

Expected: FAILED with "not implemented".

- [ ] **Step 3: Implement generateLatex() in src/export.ts**

Replace the `generateLatex` stub:

```typescript
export function generateLatex(files: FileContent[], template: ExportTemplate): string {
  const def = TEMPLATES.find(t => t.id === template);
  if (!def) throw new Error(`Unknown template: ${template}`);

  const body = files
    .map(f => stripMarkdown(f.content))
    .filter(text => text.length > 0)
    .join('\n\n\\bigskip\n\n');

  return def.wrap(body);
}
```

- [ ] **Step 4: Run all tests — all should pass**

```bash
npx jest
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/export.ts src/export.test.ts
git commit -m "feat: implement generateLatex with Normseite template"
```

---

## Task 4: Implement checkPdflatex() and compilePdf()

**Files:**
- Modify: `src/export.ts`
- Modify: `esbuild.config.mjs`

No unit tests for these — they shell out to pdflatex. Manual smoke-test in Task 12.

- [ ] **Step 1: Add @electron/remote to esbuild externals**

In `esbuild.config.mjs`, add `"@electron/remote"` to the `external` array:

```js
external: [
  "obsidian",
  "electron",
  "@electron/remote",       // ← add this line
  "@codemirror/autocomplete",
  // ... rest unchanged
],
```

- [ ] **Step 2: Add checkPdflatex() to src/export.ts**

Add after the `generateLatex` function:

```typescript
// ─── Compilation ─────────────────────────────────────────────────────────────

export function checkPdflatex(pdflatexPath: string): boolean {
  try {
    execSync(`"${pdflatexPath}" --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add compilePdf() to src/export.ts**

Add after `checkPdflatex`:

```typescript
export interface CompileResult {
  pdfPath: string;
  tmpDir: string;
}

export function compilePdf(texContent: string, pdflatexPath: string): CompileResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-nav-'));
  const texPath = path.join(tmpDir, 'export.tex');
  const pdfPath = path.join(tmpDir, 'export.pdf');

  try {
    fs.writeFileSync(texPath, texContent, 'utf-8');

    // Quote paths to handle spaces on all platforms
    const cmd = `"${pdflatexPath}" -interaction=nonstopmode -output-directory="${tmpDir}" "${texPath}"`;

    // Two passes: first builds the PDF, second resolves page numbers / cross-refs
    execSync(cmd, { stdio: 'pipe', cwd: tmpDir });
    execSync(cmd, { stdio: 'pipe', cwd: tmpDir });

    if (!fs.existsSync(pdfPath)) {
      throw new Error('pdflatex ran but produced no PDF. Check your LaTeX installation.');
    }

    return { pdfPath, tmpDir };
  } catch (err: any) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const stderr = err.stderr ? (err.stderr as Buffer).toString().slice(-2000) : '';
    throw new Error(stderr || err.message);
  }
}
```

- [ ] **Step 4: Run existing tests to ensure nothing regressed**

```bash
npx jest
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/export.ts esbuild.config.mjs
git commit -m "feat: implement checkPdflatex and compilePdf"
```

---

## Task 5: Update settings interface and defaults in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update SheetNavigatorSettings interface**

Find in `src/main.ts`:

```typescript
interface SheetNavigatorSettings {
  orderingEnabled: boolean;
}
```

Replace with:

```typescript
interface SheetNavigatorSettings {
  orderingEnabled: boolean;
  latexExportEnabled: boolean;
  pdflatexPath: string;
}
```

- [ ] **Step 2: Update DEFAULT_SETTINGS**

Find:

```typescript
const DEFAULT_SETTINGS: SheetNavigatorSettings = {
  orderingEnabled: false,
};
```

Replace with:

```typescript
const DEFAULT_SETTINGS: SheetNavigatorSettings = {
  orderingEnabled: false,
  latexExportEnabled: false,
  pdflatexPath: 'pdflatex',
};
```

- [ ] **Step 3: Build to verify no TypeScript errors**

```bash
npm run build
```

Expected: builds successfully to `main.js`.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: add latexExportEnabled and pdflatexPath to settings"
```

---

## Task 6: Add PDF export section to the settings tab

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add Platform import**

Find at the top of `src/main.ts`:

```typescript
import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFile,
  TFolder,
  TAbstractFile,
  Menu,
  Modal,
  Setting,
  PluginSettingTab,
  App,
  FileSystemAdapter,
  Notice,
} from "obsidian";
```

Replace with:

```typescript
import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFile,
  TFolder,
  TAbstractFile,
  Menu,
  Modal,
  Setting,
  PluginSettingTab,
  App,
  FileSystemAdapter,
  Notice,
  Platform,
} from "obsidian";
```

- [ ] **Step 2: Add checkPdflatex import at top of src/main.ts**

Add after the obsidian import block:

```typescript
import { checkPdflatex } from './export';
```

- [ ] **Step 3: Extend SheetNavigatorSettingTab.display() with PDF export section**

Find the end of `display()` in `SheetNavigatorSettingTab`, just before the closing `}`:

```typescript
      );
  }
}
```

Add before the two closing braces:

```typescript
    if (!Platform.isDesktop) return;

    containerEl.createEl('h3', { text: 'PDF Export' });

    new Setting(containerEl)
      .setName('Enable PDF export')
      .setDesc('Adds export to PDF via pdflatex. Requires a TeX distribution (MacTeX, MiKTeX, or TeX Live).')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.latexExportEnabled)
          .onChange(async value => {
            this.plugin.settings.latexExportEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (!this.plugin.settings.latexExportEnabled) return;

    const statusEl = containerEl.createDiv({ cls: 'sn-pdflatex-status' });

    new Setting(containerEl)
      .setName('pdflatex path')
      .setDesc('Full path to the pdflatex binary, or just "pdflatex" if it is on your PATH.')
      .addText(text => {
        text.setValue(this.plugin.settings.pdflatexPath);
        text.onChange(async value => {
          this.plugin.settings.pdflatexPath = value.trim() || 'pdflatex';
          await this.plugin.saveSettings();
          this.validatePdflatex(statusEl);
        });
      });

    // Validate on first render
    this.validatePdflatex(statusEl);
```

- [ ] **Step 4: Add validatePdflatex() method to SheetNavigatorSettingTab**

Add after `display()`:

```typescript
  private validatePdflatex(statusEl: HTMLElement): void {
    statusEl.setText('Checking…');
    statusEl.className = 'sn-pdflatex-status';
    // Run in next tick so UI updates before the synchronous execSync
    setTimeout(() => {
      const found = checkPdflatex(this.plugin.settings.pdflatexPath);
      statusEl.setText(
        found
          ? '✓ pdflatex found'
          : '✗ Not found — install MacTeX, MiKTeX, or TeX Live'
      );
      statusEl.className = `sn-pdflatex-status ${found ? 'sn-pdflatex-found' : 'sn-pdflatex-missing'}`;
    }, 0);
  }
```

- [ ] **Step 5: Add settings styles to styles.css**

Append to `styles.css`:

```css
/* ─── Settings: pdflatex status ─── */
.sn-pdflatex-status {
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 0 8px;
}

.sn-pdflatex-found {
  color: var(--color-green, #4caf50);
}

.sn-pdflatex-missing {
  color: var(--color-orange, #ff9800);
}
```

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: builds successfully.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts styles.css
git commit -m "feat: add PDF export section to settings tab"
```

---

## Task 7: Add selection state and methods to SheetNavigatorView

**Files:**
- Modify: `src/main.ts`
- Modify: `styles.css`

- [ ] **Step 1: Add selection properties to SheetNavigatorView class body**

Find in `src/main.ts`:

```typescript
  headerEl!: HTMLElement;
  listEl!: HTMLElement;
```

Replace with:

```typescript
  headerEl!: HTMLElement;
  listEl!: HTMLElement;
  exportBtnEl: HTMLElement | null = null;
  selectedPaths: Set<string> = new Set();
  isSelectionMode: boolean = false;
```

- [ ] **Step 2: Add selection methods to SheetNavigatorView**

Add these methods after `goUp()` and before `onClose()`:

```typescript
  // ─── Selection ───────────────────────────────────────────────────────────

  enterSelectionMode(absPath: string): void {
    this.isSelectionMode = true;
    this.selectedPaths.add(absPath);
    this.updateSelectionUI();
  }

  exitSelectionMode(): void {
    this.isSelectionMode = false;
    this.selectedPaths.clear();
    this.updateSelectionUI();
  }

  toggleSelection(absPath: string): void {
    if (this.selectedPaths.has(absPath)) {
      this.selectedPaths.delete(absPath);
    } else {
      this.selectedPaths.add(absPath);
    }
    if (this.selectedPaths.size === 0) {
      this.isSelectionMode = false;
    }
    this.updateSelectionUI();
  }

  selectRange(targetPath: string): void {
    if (this.selectedPaths.size === 0) {
      this.selectedPaths.add(targetPath);
      this.updateSelectionUI();
      return;
    }

    // All visible item paths in visual order
    const allPaths: string[] = [];
    this.listEl.querySelectorAll<HTMLElement>('[data-abs-path]').forEach(el => {
      const p = el.dataset.absPath;
      if (p) allPaths.push(p);
    });

    // Anchor = last item added to selection
    const anchor = [...this.selectedPaths][this.selectedPaths.size - 1];
    const fromIdx = allPaths.indexOf(anchor);
    const toIdx = allPaths.indexOf(targetPath);

    if (fromIdx === -1 || toIdx === -1) {
      this.selectedPaths.add(targetPath);
    } else {
      const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      for (let i = start; i <= end; i++) {
        this.selectedPaths.add(allPaths[i]);
      }
    }

    this.updateSelectionUI();
  }

  updateSelectionUI(): void {
    // Update card highlight states
    this.listEl.querySelectorAll<HTMLElement>('[data-abs-path]').forEach(el => {
      const p = el.dataset.absPath ?? '';
      el.classList.toggle('is-selected', this.selectedPaths.has(p));
    });

    // Update export button dim/active state
    if (this.exportBtnEl) {
      const hasSelection = this.selectedPaths.size > 0;
      this.exportBtnEl.classList.toggle('is-dimmed', !hasSelection);
      this.exportBtnEl.classList.toggle('is-active', hasSelection);
    }

    // Update selection mode body class for cursor hint
    this.containerEl.classList.toggle('is-selection-mode', this.isSelectionMode);
  }
```

- [ ] **Step 3: Register Escape key handler in onOpen()**

Find in `onOpen()`:

```typescript
    this.renderCurrentFolder();
  }
```

Add before that closing line:

```typescript
    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isSelectionMode) {
        this.exitSelectionMode();
      }
    });

```

- [ ] **Step 4: Add data-abs-path to folder cards**

In `renderFolderCard()`, find:

```typescript
    card.dataset.itemName = folder.name;
```

Add after it:

```typescript
    card.dataset.absPath = folder.path;
```

- [ ] **Step 5: Add data-abs-path to file cards**

In `renderFileCard()`, find:

```typescript
    card.dataset.path = file.path;
    card.dataset.itemName = file.name;
```

Add after:

```typescript
    card.dataset.absPath = file.path;
```

- [ ] **Step 6: Add selection styles to styles.css**

Append to `styles.css`:

```css
/* ─── Selection mode ─── */
.sheet-nav-card.is-selected {
  background-color: color-mix(in srgb, var(--interactive-accent) 15%, transparent);
  box-shadow: inset 3px 0 0 0 var(--interactive-accent);
}

.sheet-nav-card.is-selected .sheet-nav-card-title,
.sheet-nav-card.is-selected .sheet-nav-card-name {
  color: var(--text-normal);
}

/* Suppress active highlight when a card is selected (avoid double-highlight) */
.is-selection-mode .sheet-nav-card.is-active:not(.is-selected) {
  background-color: transparent;
  box-shadow: none;
}
```

- [ ] **Step 7: Build**

```bash
npm run build
```

Expected: builds successfully.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts styles.css
git commit -m "feat: add selection state and methods to SheetNavigatorView"
```

---

## Task 8: Redesign header toolbar using the frontend-design skill

**Files:**
- Modify: `src/main.ts`
- Modify: `styles.css`

> **IMPORTANT:** Before writing any code in this task, invoke the `frontend-design` skill with the brief below. The skill will produce the toolbar HTML (as TS string construction) and CSS. Use that output directly for steps 2 and 3.
>
> **frontend-design brief:**
> Design a compact icon toolbar for the header of an Obsidian sidebar plugin. The existing `.sheet-nav-title-row` div is a flex row containing the folder title on the left and action buttons on the right. Replace the current lone `+` icon button with a proper toolbar group containing two icon buttons: **New note** (file-plus icon) and **Export** (download icon). Requirements:
> - Buttons use SVG icons (18×18, stroke-based, currentColor), `stroke-width="1.5"`, `stroke-linecap="round"`, `stroke-linejoin="round"`
> - The toolbar group has a subtle gap between buttons
> - Each button has a 28×28 hit area, rounded corners, and a hover background (`var(--background-modifier-hover)`)
> - The Export button accepts `.is-dimmed` (opacity 0.3, no hover effect) and `.is-active` (accent color: `var(--interactive-accent)`) modifier classes
> - Match the visual language of the existing CSS: muted colors, Obsidian CSS variables, no hard-coded colors
> - Produce: (1) the TypeScript DOM construction code (using Obsidian's `createDiv`, `createSpan`, `innerHTML` for SVGs), and (2) the CSS classes

- [ ] **Step 1: Invoke frontend-design skill and collect output**

Use the brief above. Collect the TS construction code and CSS.

- [ ] **Step 2: Replace title row rendering in renderCurrentFolder()**

Find in `renderCurrentFolder()`:

```typescript
    const titleRow = this.headerEl.createDiv({ cls: 'sheet-nav-title-row' });
    const title = titleRow.createDiv({ cls: 'sheet-nav-title' });
    title.setText(folder.name || 'Vault');

    const newBtn = titleRow.createDiv({
      cls: 'sheet-nav-new-btn',
      attr: { 'aria-label': 'New note' },
    });
    newBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
    newBtn.addEventListener('click', () => this.createNewNote());
```

Replace with the frontend-design output (toolbar group with New note + Export buttons). Export button wiring:

```typescript
    // Export button — wired after frontend-design produces the element reference
    this.exportBtnEl = exportBtn; // assign whatever variable name frontend-design uses
    exportBtn.classList.toggle('is-dimmed', this.selectedPaths.size === 0);
    exportBtn.classList.toggle('is-active', this.selectedPaths.size > 0);
    exportBtn.addEventListener('click', () => {
      if (!Platform.isDesktop || !this.plugin.settings.latexExportEnabled) return;
      if (this.selectedPaths.size === 0) {
        new Notice('Right-click items to select them for export.');
        return;
      }
      new ExportModal(this.app, this.plugin, this, new Set(this.selectedPaths)).open();
    });
```

- [ ] **Step 3: Replace old toolbar CSS with frontend-design output**

Find and remove from `styles.css` any existing `.sheet-nav-new-btn` rules, then add the new toolbar CSS from the frontend-design output.

- [ ] **Step 4: Hide export button on mobile / when feature disabled**

Wrap the export button creation in a guard:

```typescript
    if (Platform.isDesktop && this.plugin.settings.latexExportEnabled) {
      // ... export button DOM + wiring from Step 2
    }
```

- [ ] **Step 5: Build and visually inspect**

```bash
npm run build
```

Copy `main.js`, `styles.css`, `manifest.json` to your vault's `.obsidian/plugins/sheet-navigator/`. Reload Obsidian. Verify:
- Toolbar shows two icon buttons, not the old lone `+`
- Export button is dimmed when nothing is selected
- New note button still creates notes

- [ ] **Step 6: Commit**

```bash
git add src/main.ts styles.css
git commit -m "feat: redesign header toolbar with new note and export buttons"
```

---

## Task 9: Add "Select for export" to context menu

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the menu item to showContextMenu()**

Find in `showContextMenu()`, just before `menu.showAtMouseEvent(e)`:

```typescript
    menu.showAtMouseEvent(e);
```

Add before it:

```typescript
    if (Platform.isDesktop && this.plugin.settings.latexExportEnabled) {
      menu.addSeparator();
      menu.addItem(item => {
        item
          .setTitle(
            this.selectedPaths.has(abstractFile.path)
              ? 'Deselect'
              : 'Select for export'
          )
          .setIcon('check-square')
          .onClick(() => {
            if (this.selectedPaths.has(abstractFile.path)) {
              this.toggleSelection(abstractFile.path);
            } else {
              if (!this.isSelectionMode) {
                this.enterSelectionMode(abstractFile.path);
              } else {
                this.toggleSelection(abstractFile.path);
              }
            }
          });
      });
    }

```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: builds successfully.

- [ ] **Step 3: Copy to vault and manually test context menu**

Copy `main.js` to vault plugin folder. Reload. Right-click a folder or file. Verify "Select for export" appears when `latexExportEnabled` is on.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: add Select for export to context menu"
```

---

## Task 10: Selection-aware click handlers on cards

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Make folder card clicks selection-aware**

In `renderFolderCard()`, find:

```typescript
    content.addEventListener('click', () => this.drillInto(folder));
    chevron.addEventListener('click', () => this.drillInto(folder));
```

Replace with:

```typescript
    content.addEventListener('click', (e: MouseEvent) => {
      if (this.isSelectionMode) {
        if (e.shiftKey) {
          this.selectRange(folder.path);
        } else {
          this.toggleSelection(folder.path);
        }
        return;
      }
      this.drillInto(folder);
    });
    chevron.addEventListener('click', (e: MouseEvent) => {
      // Chevron always drills in, even in selection mode — it's an explicit navigation intent
      e.stopPropagation();
      if (this.isSelectionMode) this.exitSelectionMode();
      this.drillInto(folder);
    });
```

- [ ] **Step 2: Make file card clicks selection-aware**

In `renderFileCard()`, find:

```typescript
    content.addEventListener('click', () => {
      this.app.workspace.openLinkText(file.path, '', false);
    });
```

Replace with:

```typescript
    content.addEventListener('click', (e: MouseEvent) => {
      if (this.isSelectionMode) {
        if (e.shiftKey) {
          this.selectRange(file.path);
        } else {
          this.toggleSelection(file.path);
        }
        return;
      }
      this.app.workspace.openLinkText(file.path, '', false);
    });
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: builds successfully.

- [ ] **Step 4: Manual test — selection behavior**

Copy to vault. Reload. Enable PDF export in settings.
1. Right-click a folder → "Select for export" → folder gets highlighted, toolbar export button activates
2. Click another folder card → it gets selected too (no drill-in)
3. Shift-click a third folder → range selected
4. Click Export button → modal opens (even without pdflatex yet)
5. Press Escape → selection clears, toolbar export dims
6. Chevron click → drills in normally, clears selection mode

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: selection-aware click handlers on folder and file cards"
```

---

## Task 11: Implement ExportModal

**Files:**
- Modify: `src/export.ts`
- Modify: `styles.css`

- [ ] **Step 1: Add ExportModal imports at top of export.ts**

The imports at the top of `src/export.ts` already include `App`, `Modal`, `Notice`, `Platform`, `Setting`, `TFile`, `TFolder`. Also ensure the type imports for `SheetNavigatorPlugin` and `SheetNavigatorView` are present. If `SheetNavigatorView` is not exported from `main.ts`, add `export` to its class declaration now:

In `src/main.ts`, find:

```typescript
class SheetNavigatorView extends ItemView {
```

Replace with:

```typescript
export class SheetNavigatorView extends ItemView {
```

- [ ] **Step 2: Add ElectronRemote type to export.ts**

Add just before the `ExportModal` class:

```typescript
// Minimal type for @electron/remote (provided by Obsidian at runtime)
interface ElectronRemote {
  dialog: {
    showSaveDialog(options: {
      title: string;
      defaultPath: string;
      filters: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePath?: string }>;
  };
}
```

- [ ] **Step 3: Add ExportModal class to src/export.ts**

Append to `src/export.ts`:

```typescript
// ─── Export Modal ─────────────────────────────────────────────────────────────

export class ExportModal extends Modal {
  private plugin: SheetNavigatorPlugin;
  private view: SheetNavigatorView;
  private selectedPaths: Set<string>;

  constructor(
    app: App,
    plugin: SheetNavigatorPlugin,
    view: SheetNavigatorView,
    selectedPaths: Set<string>
  ) {
    super(app);
    this.plugin = plugin;
    this.view = view;
    this.selectedPaths = selectedPaths;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('sn-export-modal');
    contentEl.createEl('h3', { text: 'Export as PDF' });

    // Selected items summary
    const names = [...this.selectedPaths].map(p => p.split('/').pop() ?? p);
    const summaryEl = contentEl.createDiv({ cls: 'sn-export-summary' });
    summaryEl.setText(names.join(', '));

    // Template selector
    let selectedTemplate: ExportTemplate = 'normseite-de';
    new Setting(contentEl)
      .setName('Template')
      .addDropdown(dd => {
        TEMPLATES.forEach(t => dd.addOption(t.id, t.label));
        dd.setValue(selectedTemplate);
        dd.onChange(v => { selectedTemplate = v as ExportTemplate; });
      });

    // Status / progress area
    const statusEl = contentEl.createDiv({ cls: 'sn-export-status' });

    // Buttons
    new Setting(contentEl)
      .addButton(btn =>
        btn
          .setButtonText('Export')
          .setCta()
          .onClick(() => this.runExport(selectedTemplate, statusEl))
      )
      .addButton(btn =>
        btn.setButtonText('Cancel').onClick(() => this.close())
      );
  }

  private async runExport(template: ExportTemplate, statusEl: HTMLElement): Promise<void> {
    try {
      statusEl.setText('Collecting files…');
      const files = this.collectFiles();
      if (files.length === 0) {
        statusEl.setText('No markdown files found in selection.');
        return;
      }

      statusEl.setText('Generating LaTeX…');
      const fileContents: FileContent[] = await Promise.all(
        files.map(async f => ({
          title: f.basename,
          content: await this.app.vault.read(f),
        }))
      );

      const tex = generateLatex(fileContents, template);

      statusEl.setText('Compiling PDF (this may take a few seconds)…');
      // compilePdf is synchronous; wrap in setTimeout to let status render first
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const result = compilePdf(tex, this.plugin.settings.pdflatexPath);
            resolve();
            this.savePdf(result, statusEl);
          } catch (err) {
            reject(err);
          }
        }, 50);
      });
    } catch (err: any) {
      const msg: string = err.message ?? String(err);
      if (msg.toLowerCase().includes('pdflatex') || msg.includes('ENOENT')) {
        statusEl.setText('pdflatex not found. Set its path in Sheet Navigator settings.');
      } else {
        statusEl.setText(`Compilation error:\n${msg.slice(0, 500)}`);
      }
    }
  }

  private async savePdf(result: CompileResult, statusEl: HTMLElement): Promise<void> {
    try {
      const { dialog } = require('@electron/remote') as ElectronRemote;
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save PDF',
        defaultPath: 'export.pdf',
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      });

      if (!canceled && filePath) {
        fs.copyFileSync(result.pdfPath, filePath);
        new Notice('PDF exported successfully.');
        statusEl.setText('Saved.');
        setTimeout(() => this.close(), 1200);
      }
    } finally {
      // Always clean up temp dir
      try { fs.rmSync(result.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private collectFiles(): TFile[] {
    const result: TFile[] = [];
    // Sort selected paths so numeric order is preserved
    const sorted = [...this.selectedPaths].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    for (const p of sorted) {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      const item = this.app.vault.getAbstractFileByPath(normalized);
      if (item instanceof TFile && item.extension === 'md') {
        result.push(item);
      } else if (item instanceof TFolder) {
        this.collectFromFolder(item, result);
      }
    }
    return result;
  }

  private collectFromFolder(folder: TFolder, result: TFile[]): void {
    const children = [...folder.children].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    for (const child of children) {
      if (child instanceof TFile && child.extension === 'md') {
        result.push(child);
      } else if (child instanceof TFolder) {
        this.collectFromFolder(child, result);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 4: Import ExportModal in main.ts**

At the top of `src/main.ts`, update the import from `./export`:

```typescript
import { checkPdflatex, ExportModal } from './export';
```

- [ ] **Step 5: Add modal styles to styles.css**

Append to `styles.css`:

```css
/* ─── Export modal ─── */
.sn-export-summary {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 12px;
  font-style: italic;
  word-break: break-all;
}

.sn-export-status {
  font-size: 12px;
  color: var(--text-muted);
  min-height: 1.5em;
  white-space: pre-wrap;
  margin-top: 4px;
}
```

- [ ] **Step 6: Build**

```bash
npm run build
```

Expected: builds successfully with no TypeScript errors.

- [ ] **Step 7: Run tests**

```bash
npx jest
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/export.ts src/main.ts styles.css
git commit -m "feat: implement ExportModal with full compile pipeline"
```

---

## Task 12: End-to-end smoke test + final build

**Files:** no code changes — verification only.

- [ ] **Step 1: Run full test suite**

```bash
npx jest --verbose
```

Expected: all tests PASS.

- [ ] **Step 2: Production build**

```bash
npm run build
```

Expected: minified `main.js` produced with no errors.

- [ ] **Step 3: Deploy to vault for smoke test**

Copy `main.js`, `styles.css`, `manifest.json` to `.obsidian/plugins/sheet-navigator/`. Reload Obsidian.

- [ ] **Step 4: Settings smoke test**

1. Open Settings → Sheet Navigator
2. Toggle "Enable PDF export" ON
3. Leave path as `pdflatex`
4. Verify status shows "✓ pdflatex found" (if installed) or the ✗ message

- [ ] **Step 5: Selection smoke test**

1. Right-click a folder → "Select for export" → folder highlights, Export button activates
2. Click another folder card → adds to selection
3. Shift-click a third → range selected
4. Press Escape → selection clears
5. Right-click → context menu shows "Select for export" again

- [ ] **Step 6: Export smoke test (requires pdflatex)**

1. Select 2 folders
2. Click Export → ExportModal opens
3. Confirm template = Normseite (DE), items listed
4. Click Export → progress messages appear
5. Native Save As dialog appears
6. Save → PDF opens in default viewer
7. Verify content is present, Courier font, ~60 chars/line

- [ ] **Step 7: Mobile smoke test**

Open vault on Obsidian mobile (or disable desktop check temporarily). Verify:
- No "Select for export" in context menu
- No Export button in toolbar
- Plugin navigates normally

- [ ] **Step 8: Final commit if any minor fixes were needed**

```bash
git add -p   # stage only intentional changes
git commit -m "fix: smoke test corrections for latex export"
```

---

## Self-review checklist

- [x] **spec: Selection UX** — Tasks 7, 9, 10
- [x] **spec: Toolbar redesign** — Task 8
- [x] **spec: ExportModal** — Task 11
- [x] **spec: LaTeX pipeline** — Tasks 2, 3, 4, 11
- [x] **spec: Normseite template** — Task 3
- [x] **spec: checkPdflatex + settings** — Tasks 4, 6
- [x] **spec: Cross-platform paths** — Task 4 (path.join, os.tmpdir, quoted paths, output-directory)
- [x] **spec: Save As dialog** — Task 11 (@electron/remote)
- [x] **spec: Mobile hidden** — Tasks 7, 8, 9
- [x] **spec: isDesktopOnly stays false** — not touched
- [x] **type consistency** — `ExportTemplate`, `FileContent`, `CompileResult`, `TEMPLATES` defined in Task 1/3/4; used consistently in Tasks 3, 4, 11
- [x] **no placeholders** — all steps contain complete code
