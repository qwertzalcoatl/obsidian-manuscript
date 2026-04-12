import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Modal, Notice, Platform, Setting, TFile, TFolder } from 'obsidian';

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

export function generateLatex(files: FileContent[], template: ExportTemplate): string {
  const def = TEMPLATES.find(t => t.id === template);
  if (!def) throw new Error(`Unknown template: ${template}`);

  const body = files
    .map(f => stripMarkdown(f.content))
    .filter(text => text.length > 0)
    .join('\n\n\\bigskip\n\n');

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
      `-output-directory=${tmpDir}`,
      texPath,
    ];

    // Two passes: first builds the PDF, second resolves any cross-references
    execFileSync(pdflatexPath, args, { stdio: 'pipe', cwd: tmpDir });
    execFileSync(pdflatexPath, args, { stdio: 'pipe', cwd: tmpDir });

    if (!fs.existsSync(pdfPath)) {
      throw new Error('pdflatex ran but produced no PDF. Check your LaTeX installation.');
    }

    return { pdfPath, tmpDir };
  } catch (err: any) {
    // Clean up on failure, then rethrow with pdflatex stderr for diagnosis
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const stderr = err.stderr ? (err.stderr as Buffer).toString().slice(-2000) : '';
    throw new Error(stderr || err.message);
  }
}

// ─── Export Modal (stub — replaced in Task 11) ────────────────────────────────

export class ExportModal {
  constructor(
    _app: App,
    _plugin: any,
    _view: any,
    _paths: Set<string>
  ) {}
  open(): void {}
}
