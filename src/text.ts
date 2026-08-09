// Markdown text handling shared by the navigator's card previews and the PDF
// export. Free of any `obsidian` import so it stays unit-testable under jest's
// node environment.

export const PREVIEW_LENGTH = 120;

/**
 * Removes a YAML frontmatter block.
 *
 * Anchored to line starts, so an unterminated block is left alone rather than
 * swallowing the rest of the note. A blank line directly after the opening
 * fence marks a horizontal rule, not frontmatter — real frontmatter always
 * opens straight onto a key.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const match = content.match(
    /^---[ \t]*\r?\n(?![ \t]*\r?\n)[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
  );
  return match ? content.slice(match[0].length) : content;
}

/**
 * First few lines of a note as plain text for a card preview.
 *
 * Markdown markers are stripped rather than the lines carrying them being
 * dropped, so a note made only of headings still previews.
 */
export function extractSnippet(content: string, maxLength: number = PREVIEW_LENGTH): string {
  const lines = stripFrontmatter(content)
    .split('\n')
    .map(cleanLine)
    .filter((line) => line.length > 0);

  const snippet = lines.slice(0, 3).join(' ');
  if (snippet.length > maxLength) {
    return snippet.slice(0, maxLength).trimEnd() + '…';
  }
  return snippet;
}

function cleanLine(line: string): string {
  let text = line.trim();

  if (/^(?:[-*_][ \t]*){3,}$/.test(text)) return ''; // horizontal rule

  text = text
    .replace(/^>+[ \t]*/, '') // blockquote marker
    .replace(/^#{1,6}[ \t]+/, '') // heading hashes, keeping the heading text
    .replace(/^(?:[-*+]|\d+[.)])[ \t]+/, '') // list marker
    .replace(/^\[[ xX]\][ \t]*/, '') // task checkbox
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target, alias) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    // Word-boundary guarded so snake_case survives.
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, '$1');

  return text.trim();
}
