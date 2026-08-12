// Where cut text goes and what it looks like once it gets there. Free of any
// `obsidian` import so it stays unit-testable under jest's node environment —
// the vault I/O that uses these lives in main.ts.

import { parseCritic, type Range } from './critic';

/**
 * Widens a selection until it splits no CriticMarkup construct.
 *
 * Cutting half a mark out of a note leaves `{++neuer Te` in the archive and
 * `xt++}` in the manuscript — two malformed constructs, and the repair command
 * unfolds a mark rather than rejoining a torn one. So the range grows instead.
 *
 * Refusing was the alternative and it is worse here: the markup is folded, so
 * "adjust your selection" asks the writer to aim at something invisible.
 *
 * One forward pass is enough. Entries arrive in order and never nest, so `to`
 * only ever grows into constructs still ahead, and a `from` that reaches back
 * cannot uncover an earlier entry — that would mean two entries overlapped.
 */
export function expandToMarks(content: string, from: number, to: number): Range {
  let lo = from;
  let hi = to;
  for (const mark of parseCritic(content)) {
    // Strict comparisons: a selection ending exactly where a mark begins is
    // adjacent to it, not cutting through it.
    if (mark.from < hi && mark.to > lo) {
      lo = Math.min(lo, mark.from);
      hi = Math.max(hi, mark.to);
    }
  }
  return { from: lo, to: hi };
}

/**
 * Where a note's archive file lives — the origin's full vault-relative path,
 * mirrored under the archive root.
 *
 * The full path rather than the basename, because the navigator documents bare
 * `3.md` as a supported filename: a flat archive would put `Kapitel 7/3.md` and
 * `Kapitel 9/3.md` in the same place.
 */
export function archivePathFor(originPath: string, archiveRoot: string): string {
  const root = archiveRoot.replace(/\/+$/, '');
  return root ? `${root}/${originPath}` : originPath;
}

/**
 * The wikilink an archive file stores to point back at its origin.
 *
 * A link rather than a path string, because the navigator renumbers files on
 * every reorder: `fileManager.renameFile` rewrites inbound links — frontmatter
 * included — so Obsidian keeps the association true and this plugin never has
 * to write into a manuscript file.
 */
export function originLink(originPath: string): string {
  return `[[${originPath.replace(/\.md$/, '')}]]`;
}

/** One entry: a stamped heading and the text, always closed by a newline. */
function entry(stamp: string, text: string): string {
  return `## ${stamp}\n\n${text.trim()}\n`;
}

/**
 * The body of an archive file that does not exist yet.
 *
 * The link is written as a double-quoted YAML scalar, so a title containing a
 * quote has to be escaped — otherwise the frontmatter block is malformed and
 * Obsidian reads no `origin` at all, which would orphan the file silently.
 */
export function newArchive(link: string, stamp: string, text: string): string {
  const escaped = link.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\norigin: "${escaped}"\n---\n\n${entry(stamp, text)}`;
}

/**
 * An archive body plus one more cut.
 *
 * Trailing newlines are normalised to exactly one blank line before the new
 * heading, so a hand-edited file that ends mid-line does not get the next
 * heading welded onto its last word. Nothing already in `existing` is altered.
 */
export function appendEntry(existing: string, stamp: string, text: string): string {
  return `${existing.replace(/\n*$/, '')}\n\n${entry(stamp, text)}`;
}

/** A date as `2026-08-12 14:32` — local, ISO order, sortable, locale-neutral. */
export function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
