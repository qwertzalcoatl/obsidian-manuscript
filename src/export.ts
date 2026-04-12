import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Modal, Notice, Setting, TFile, TFolder } from 'obsidian';
import type SheetNavigatorPlugin from './main';
import type { SheetNavigatorView } from './main';

// Minimal type for @electron/remote (provided by Obsidian at runtime, not installed)
interface ElectronRemote {
  dialog: {
    showSaveDialog(options: {
      title: string;
      defaultPath: string;
      filters: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePath?: string }>;
  };
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FileContent {
  title: string;
  content: string;
  folderPath?: string; // used to group files into chapters (folders → \newpage)
}

export type ExportTemplate = 'normseite-de';

interface TemplateDefinition {
  id: ExportTemplate;
  label: string;
  wrap: (body: string) => string;
}

// ─── Normseite template ───────────────────────────────────────────────────────
// Uses the stdpage package (CTAN: https://ctan.org/pkg/stdpage), originally
// released as normseite.sty. Available in TeX Live and MiKTeX out of the box.
// stdpage enforces 30 lines × 60 chars, Courier 12pt, correct spacing on A4.

const NORMSEITE_TEMPLATE = (body: string): string =>
  `\\documentclass[12pt,a4paper,ngerman]{scrartcl}
\\usepackage[T1]{fontenc}
\\usepackage[utf8]{inputenc}
\\usepackage{babel}
\\usepackage{stdpage}
\\begin{document}
${body}
\\end{document}
`;

export const TEMPLATES: TemplateDefinition[] = [
  { id: 'normseite-de', label: 'Normseite (DE)', wrap: NORMSEITE_TEMPLATE },
];

const BACKSLASH_SENTINEL = '\uE000';

export function escapeLatex(text: string): string {
  return text
    // Backslash must come first — use placeholder to avoid double-escaping braces
    .replace(/\\/g, BACKSLASH_SENTINEL)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(new RegExp(BACKSLASH_SENTINEL, 'g'), '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

export function stripMarkdown(content: string): string {
  let text = content;

  // Strip YAML frontmatter (handles --- inside YAML values)
  if (text.startsWith('---')) {
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (match) text = text.slice(match[0].length).trimStart();
  }

  // Strip fenced code blocks before other processing (consume surrounding newlines too)
  text = text.replace(/\n?```[\s\S]*?```\n?/g, '\n');

  // Convert headings to LaTeX formatting.
  // Title text is escaped here separately; a PUA placeholder protects the
  // resulting LaTeX commands from being mangled by the escapeLatex pass below.
  const HEADING_SENTINEL = '\uE002';
  const headingLatex: string[] = [];
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_full, hashes: string, title: string) => {
    const level = hashes.length;
    const t = escapeLatex(title.trim());
    let latex: string;
    if (level === 1)      latex = `\n\\vspace{2\\baselineskip}\n{\\large\\textbf{${t}}}\n\\vspace{\\baselineskip}\n`;
    else if (level === 2) latex = `\n\\vspace{\\baselineskip}\n{\\textbf{${t}}}\n`;
    else if (level === 3) latex = `\n{\\textit{${t}}}\n`;
    else                  latex = `\n${t}\n`;
    const idx = headingLatex.length;
    headingLatex.push(latex);
    return `${HEADING_SENTINEL}${idx}${HEADING_SENTINEL}`;
  });

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

  // Escape remaining LaTeX special characters (heading placeholders pass through unharmed)
  text = escapeLatex(text);

  // Restore heading LaTeX commands
  if (headingLatex.length > 0) {
    text = text.replace(
      new RegExp(`${HEADING_SENTINEL}(\\d+)${HEADING_SENTINEL}`, 'g'),
      (_m, idx) => headingLatex[parseInt(idx)]
    );
  }

  return text.trim();
}

export function generateLatex(files: FileContent[], template: ExportTemplate): string {
  const def = TEMPLATES.find(t => t.id === template);
  if (!def) throw new Error(`Unknown template: ${template}`);

  // Group consecutive files by folder so we can insert chapter breaks between folders
  // and scene breaks between files within the same folder.
  const groups: string[][] = [];
  let currentFolder: string | undefined;

  for (const f of files) {
    const stripped = stripMarkdown(f.content);
    if (!stripped) continue;
    const folder = f.folderPath ?? '';
    if (folder !== currentFolder) {
      groups.push([]);
      currentFolder = folder;
    }
    groups[groups.length - 1].push(stripped);
  }

  // Scenes within a chapter: extra vertical space
  // Chapters: page break
  const body = groups
    .map(scenes => scenes.join('\n\n\\vspace{2\\baselineskip}\n\n'))
    .join('\n\n\\newpage\n\n');

  return def.wrap(body);
}

// ─── Compilation ─────────────────────────────────────────────────────────────

export function checkPdflatex(pdflatexPath: string): boolean {
  try {
    execFileSync(pdflatexPath, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

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

    const args = [
      '-interaction=nonstopmode',
      '-output-directory', tmpDir,
      texPath,
    ];

    // Run one pass, ignoring non-zero exit if the PDF was produced.
    // pdflatex commonly exits with code 1 for recoverable warnings (Underfull \hbox etc.)
    // while still producing a valid PDF.
    const runPass = () => {
      try {
        execFileSync(pdflatexPath, args, { stdio: 'pipe', cwd: tmpDir, timeout: 60000 });
      } catch (err: any) {
        if (!fs.existsSync(pdfPath)) throw err; // truly failed — no PDF produced
        // PDF exists despite non-zero exit — warnings only, proceed
      }
    };

    runPass(); // first pass
    runPass(); // second pass resolves cross-references

    if (!fs.existsSync(pdfPath)) {
      throw new Error('pdflatex ran but produced no PDF. Check your LaTeX installation.');
    }

    return { pdfPath, tmpDir };
  } catch (err: any) {
    // Clean up on failure, then rethrow — pdflatex logs to stdout, not stderr
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const stdout = err.stdout ? (err.stdout as Buffer).toString().slice(-2000) : '';
    const stderr = err.stderr ? (err.stderr as Buffer).toString().slice(-2000) : '';
    throw new Error(stdout || stderr || err.message);
  }
}

// ─── Export Modal ─────────────────────────────────────────────────────────────

export class ExportModal extends Modal {
  private plugin: SheetNavigatorPlugin;
  private view: SheetNavigatorView;
  private selectedPaths: Set<string>;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

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
      .addButton(btn => {
        btn
          .setButtonText('Export')
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              await this.runExport(selectedTemplate, statusEl);
            } finally {
              btn.setDisabled(false);
            }
          });
      })
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
          folderPath: f.parent?.path ?? '',
        }))
      );

      const tex = generateLatex(fileContents, template);

      statusEl.setText('Compiling PDF (this may take a few seconds)…');
      // compilePdf is synchronous; wrap in setTimeout to let the status text render first
      await new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          try {
            const result = compilePdf(tex, this.plugin.settings.pdflatexPath);
            this.savePdf(result, statusEl).then(resolve).catch(reject);
          } catch (err) {
            reject(err);
          }
        }, 50);
      });
    } catch (err: any) {
      const msg: string = err.message ?? String(err);
      if (msg.toLowerCase().includes('enoent')) {
        statusEl.setText('pdflatex not found. Set its path in Sheet Navigator settings.');
      } else {
        statusEl.setText(`LaTeX error:\n${msg.slice(0, 800)}`);
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
        this.view.exitSelectionMode();
        statusEl.setText('Saved.');
        this.autoCloseTimer = setTimeout(() => this.close(), 1200);
      }
    } finally {
      // Always clean up temp dir
      try { fs.rmSync(result.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  private collectFiles(): TFile[] {
    const seen = new Set<string>();
    const result: TFile[] = [];
    const sorted = [...this.selectedPaths].sort((a, b) => {
      const aNorm = a.startsWith('/') ? a.slice(1) : a;
      const bNorm = b.startsWith('/') ? b.slice(1) : b;
      const aItem = this.app.vault.getAbstractFileByPath(aNorm);
      const bItem = this.app.vault.getAbstractFileByPath(bNorm);
      const aIsFolder = aItem instanceof TFolder;
      const bIsFolder = bItem instanceof TFolder;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    for (const p of sorted) {
      const normalized = p.startsWith('/') ? p.slice(1) : p;
      const item = this.app.vault.getAbstractFileByPath(normalized);
      if (item instanceof TFile && item.extension === 'md') {
        if (!seen.has(item.path)) {
          seen.add(item.path);
          result.push(item);
        }
      } else if (item instanceof TFolder) {
        this.collectFromFolder(item, result, seen);
      }
    }
    return result;
  }

  private collectFromFolder(folder: TFolder, result: TFile[], seen: Set<string>): void {
    const children = [...folder.children].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    for (const child of children) {
      if (child instanceof TFile && child.extension === 'md') {
        if (!seen.has(child.path)) {
          seen.add(child.path);
          result.push(child);
        }
      } else if (child instanceof TFolder) {
        this.collectFromFolder(child, result, seen);
      }
    }
  }

  onClose(): void {
    if (this.autoCloseTimer !== null) clearTimeout(this.autoCloseTimer);
    this.contentEl.empty();
  }
}
