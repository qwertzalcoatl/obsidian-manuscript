import { execSync } from 'child_process';
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

// ─── Placeholders for Task 2 & 3 ─────────────────────────────────────────────

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

export function stripMarkdown(content: string): string {
  let text = content;

  // Strip YAML frontmatter
  if (text.startsWith('---')) {
    const end = text.indexOf('---', 3);
    if (end !== -1) text = text.slice(end + 3).trimStart();
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

export function generateLatex(_files: FileContent[], _template: ExportTemplate): string {
  throw new Error('not implemented');
}
