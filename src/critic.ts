// CriticMarkup parsing and the transforms that resolve it.
//
// Free of any `obsidian` import so it stays unit-testable under jest's node
// environment — and so Live Preview, Reading view, the review drawer and the
// card previews all agree by construction about what counts as markup. When
// they disagree about that, a note renders one way and rewrites another.

import { frontmatterLength } from './text';

export type Kind =
  | 'insertion'
  | 'deletion'
  | 'substitution'
  | 'highlight'
  | 'comment';

/** What accepting or rejecting an entry does to the document. */
export type Mode = 'accept' | 'reject' | 'resolve';

export interface Range {
  from: number;
  to: number;
}

/**
 * Where an entry's pieces sit in the source.
 *
 * The parser reports this so Live Preview and Reading view don't each
 * re-derive marker lengths from the raw text. Two copies of that arithmetic
 * would eventually disagree, and the disagreement would look like one mode
 * rendering a note the other one doesn't.
 */
export interface Spans {
  /** Syntax markers to hide: opening, closing, and a substitution's arrow. */
  markers: Range[];
  /** The quoted text. Null for a standalone comment, which quotes nothing. */
  quote: Range | null;
  /** Substitution only — where the replacement text sits. */
  replacement: Range | null;
  /** The whole comment construct, markers included. Hidden outright. */
  comment: Range | null;
  /**
   * The comment's text alone, inside its markers. Zero-width for an empty
   * `{>><<}` — so callers test this against null and never for emptiness.
   *
   * Reported rather than left to be worked out, because the marker is two
   * characters for one of Obsidian's own `%%…%%` notes and three for a
   * CriticMarkup one, and on an attached comment `native` describes the anchor
   * rather than the note. `{--ging--}%%zu spät?%%` is otherwise inexpressible.
   */
  commentBody: Range | null;
}

/**
 * One reviewable item: a construct plus the comment attached to it, if any.
 *
 * Offsets are into the exact string they were parsed from and are invalidated
 * by any edit — callers re-parse rather than cache. `quote` and `replacement`
 * are verbatim document text (the transforms write them back), so they are
 * never trimmed; only `comment` is.
 */
export interface Entry {
  kind: Kind;
  /** Offset of the opening marker. */
  from: number;
  /** Offset past the closing marker, attached comment included. */
  to: number;
  /** Manuscript text the card shows. Empty for a standalone comment. */
  quote: string;
  /** Substitution only — the proposed replacement. */
  replacement?: string;
  /** Attached or standalone comment body, trimmed. */
  comment: string | null;
  /** The line the entry sits on, trimmed — context for standalone comments. */
  line: string;
  /** Came from Obsidian's `%%…%%` rather than CriticMarkup braces. */
  native: boolean;
  /** Source geometry for the inline renderers. */
  spans: Spans;
}

interface Raw extends Range {
  kind: Kind;
  quote: string;
  replacement?: string;
  native: boolean;
  /** Marker runs belonging to this construct alone. */
  markers: Range[];
  /** Where `quote` sits — for a comment, where its body sits. */
  quoteAt: Range;
  replacementAt?: Range;
}

// ─── Skip regions ───
// Markup inside code or frontmatter is not markup. Computed once and shared by
// every scan below.

const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Fenced code blocks. An unclosed fence runs to the end of the note. */
function fencedRegions(content: string): Range[] {
  const out: Range[] = [];
  let offset = 0;
  let open: { char: string; len: number; from: number } | null = null;

  for (const line of content.split('\n')) {
    const match = FENCE_RE.exec(line);
    if (open === null) {
      if (match) open = { char: match[1][0], len: match[1].length, from: offset };
    } else if (
      match &&
      match[1][0] === open.char &&
      match[1].length >= open.len &&
      // A closing fence carries nothing but the fence; ``` js opens, it never closes.
      line.slice(match[0].length).trim() === ''
    ) {
      out.push({ from: open.from, to: offset + line.length });
      open = null;
    }
    offset += line.length + 1;
  }

  if (open) out.push({ from: open.from, to: content.length });
  return out;
}

/**
 * Inline code spans. A run of N backticks closes on the next run of exactly N,
 * and never across a blank line — the same rule CommonMark uses.
 */
function inlineCodeRegions(content: string, fenced: Range[]): Range[] {
  const out: Range[] = [];
  let i = 0;

  while (i < content.length) {
    if (content[i] !== '`' || covers(fenced, i)) {
      i++;
      continue;
    }

    let openLen = 0;
    while (content[i + openLen] === '`') openLen++;

    let j = i + openLen;
    let close = -1;
    while (j < content.length) {
      if (content[j] === '`') {
        let runLen = 0;
        while (content[j + runLen] === '`') runLen++;
        if (runLen === openLen) {
          close = j + runLen;
          break;
        }
        j += runLen;
      } else if (content[j] === '\n' && content[j + 1] === '\n') {
        break;
      } else {
        j++;
      }
    }

    if (close === -1) {
      i += openLen; // unterminated — the backticks are literal
      continue;
    }
    out.push({ from: i, to: close });
    i = close;
  }

  return out;
}

function skipRegions(content: string): Range[] {
  const fm = frontmatterLength(content);
  const fenced = fencedRegions(content);
  const regions = fenced.concat(inlineCodeRegions(content, fenced));
  if (fm > 0) regions.push({ from: 0, to: fm });
  return regions;
}

/** True when `offset` falls inside any range. */
function covers(ranges: Range[], offset: number): boolean {
  return ranges.some((r) => offset >= r.from && offset < r.to);
}

/** True when [from, to) touches any range at all. */
function overlaps(ranges: Range[], from: number, to: number): boolean {
  return ranges.some((r) => from < r.to && to > r.from);
}

// ─── Scanning ───

// One alternation so constructs are found in document order and an unterminated
// marker simply fails to match — it stays literal text rather than swallowing
// the rest of the note, the same tolerance stripFrontmatter applies.
const CRITIC_RE =
  /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~~\}|\{==([\s\S]*?)==\}|\{>>([\s\S]*?)<<\}/g;

const NATIVE_COMMENT_RE = /%%([\s\S]*?)%%/g;
const NATIVE_HIGHLIGHT_RE = /==([^\n]+?)==/g;

/**
 * A construct whose body is one run: everything between a fixed-length opening
 * and closing marker. Covers every form except a substitution.
 */
function simple(
  kind: Kind,
  from: number,
  to: number,
  body: string,
  markerLen: number,
  native: boolean
): Raw {
  const bodyFrom = from + markerLen;
  return {
    kind,
    from,
    to,
    quote: body,
    native,
    markers: [
      { from, to: bodyFrom },
      { from: to - markerLen, to },
    ],
    quoteAt: { from: bodyFrom, to: to - markerLen },
  };
}

/** A blank line ends a paragraph, and no construct may cross one. */
const BLANK_LINE = /\n[ \t]*\n/;

/**
 * A note's text, made safe to put inside its own markers.
 *
 * The format has no escape syntax, so what a body cannot hold is defused
 * rather than escaped. A blank line makes BLANK_LINE above refuse the whole
 * construct and the note stops rendering — the loudest possible failure for
 * the quietest possible keystroke. The closing marker ends the construct
 * early, truncating the note and spilling the rest into the manuscript.
 *
 * A space goes into the sequence rather than the sequence being dropped: the
 * realistic collision is a German writer setting guillemets as >>Wort<< with a
 * brace immediately after, and `<< }` leaves that legible while costing the
 * parser its terminator. Nothing is lost silently either — the card is redrawn
 * from the document, so what was stored is what shows.
 *
 * The two terminators need different treatment, which is why this is a table
 * of two cases and not one clever expression over `close`.
 */
export function sanitizeComment(text: string, close: '<<}' | '%%' = '<<}'): string {
  const flat = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n')
    .trim();

  // A doubled character is a harder container than a three-character one: the
  // body must hold no `%%`, and must not end in a `%` either, or the closing
  // marker borrows it and the note loses its last character silently. The
  // space that prevents that never shows — parseCritic trims what it reports.
  if (close === '%%') return flat.replace(/%(?=%|$)/g, '% ');

  // `<<}` needs only the sequence itself broken. A body ending in `<` or `<<`
  // is safe: the marker is three characters, so an adjacent one cannot
  // complete it without the brace, and the non-greedy scan stops at the first
  // real one. The opening `{>>` needs nothing at all — inside a body it is
  // ordinary text. split/join rather than a regex, because escaping `<<}` is
  // a place to make a mistake that fails silently instead of at compile time.
  return flat.split('<<}').join('<< }');
}

function scanCritic(content: string, skip: Range[]): Raw[] {
  const out: Raw[] = [];
  CRITIC_RE.lastIndex = 0;

  for (let m = CRITIC_RE.exec(content); m !== null; m = CRITIC_RE.exec(content)) {
    const from = m.index;
    const to = from + m[0].length;

    // An opening marker that only finds its partner several paragraphs later
    // is a typo, not a construct — and honouring it would swallow whole
    // paragraphs. Reading view cannot see across a block boundary either, so
    // refusing here is also what keeps the two display modes agreeing.
    //
    // Resume one character in rather than past the match: a real construct
    // sitting inside the rejected span still has to be found.
    if (BLANK_LINE.test(m[0])) {
      CRITIC_RE.lastIndex = from + 1;
      continue;
    }

    if (overlaps(skip, from, to)) continue;

    if (m[1] !== undefined) {
      out.push(simple('insertion', from, to, m[1], 3, false));
    } else if (m[2] !== undefined) {
      out.push(simple('deletion', from, to, m[2], 3, false));
    } else if (m[3] !== undefined) {
      // Splits on the first ~>; a body without one is a malformed substitution
      // and is treated as a deletion of exactly what it holds.
      const arrow = m[3].indexOf('~>');
      if (arrow === -1) {
        out.push(simple('deletion', from, to, m[3], 3, false));
      } else {
        const oldFrom = from + 3;
        const arrowFrom = oldFrom + arrow;
        const newFrom = arrowFrom + 2;
        out.push({
          kind: 'substitution',
          from,
          to,
          quote: m[3].slice(0, arrow),
          replacement: m[3].slice(arrow + 2),
          native: false,
          markers: [
            { from, to: oldFrom },
            { from: arrowFrom, to: newFrom },
            { from: to - 3, to },
          ],
          quoteAt: { from: oldFrom, to: arrowFrom },
          replacementAt: { from: newFrom, to: to - 3 },
        });
      }
    } else if (m[4] !== undefined) {
      out.push(simple('highlight', from, to, m[4], 3, false));
    } else {
      out.push(simple('comment', from, to, m[5], 3, false));
    }
  }

  return out;
}

function scanNative(content: string, skip: Range[], taken: Range[]): Raw[] {
  const out: Raw[] = [];
  const blocked = skip.concat(taken);

  NATIVE_COMMENT_RE.lastIndex = 0;
  for (
    let m = NATIVE_COMMENT_RE.exec(content);
    m !== null;
    m = NATIVE_COMMENT_RE.exec(content)
  ) {
    const to = m.index + m[0].length;
    if (overlaps(blocked, m.index, to)) continue;
    out.push(simple('comment', m.index, to, m[1], 2, true));
  }

  // Highlights are candidates only. A lone ==text== is ordinary Obsidian
  // markdown, not an editorial mark, so it survives the attachment pass below
  // only if a comment actually latched onto it.
  const withComments = blocked.concat(out);
  NATIVE_HIGHLIGHT_RE.lastIndex = 0;
  for (
    let m = NATIVE_HIGHLIGHT_RE.exec(content);
    m !== null;
    m = NATIVE_HIGHLIGHT_RE.exec(content)
  ) {
    const to = m.index + m[0].length;
    if (overlaps(withComments, m.index, to)) continue;
    out.push(simple('highlight', m.index, to, m[1], 2, true));
  }

  return out;
}

// ─── Parsing ───

/** The line `offset` sits on, trimmed. */
function lineAt(content: string, offset: number): string {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  let end = content.indexOf('\n', offset);
  if (end === -1) end = content.length;
  return content.slice(start, end).trim();
}

/**
 * Every reviewable item in the note, in document order.
 *
 * A comment immediately following another construct — whitespace but no
 * newline between them — is attached to it and reported as one entry.
 */
export function parseCritic(content: string): Entry[] {
  const skip = skipRegions(content);
  const critic = scanCritic(content, skip);
  const raws = critic
    .concat(scanNative(content, skip, critic))
    .sort((a, b) => a.from - b.from);

  const entries: Entry[] = [];

  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i];

    if (raw.kind === 'comment') {
      entries.push({
        kind: 'comment',
        from: raw.from,
        to: raw.to,
        quote: '',
        comment: raw.quote.trim(),
        line: lineAt(content, raw.from),
        native: raw.native,
        // The construct is hidden whole, so its own markers are not listed
        // separately — they are inside what gets replaced.
        spans: {
          markers: [],
          quote: null,
          replacement: null,
          comment: { from: raw.from, to: raw.to },
          commentBody: raw.quoteAt,
        },
      });
      continue;
    }

    const next = raws[i + 1];
    const attached =
      next !== undefined &&
      next.kind === 'comment' &&
      /^[ \t]*$/.test(content.slice(raw.to, next.from));

    // A bare ==highlight== is ordinary markdown until a comment claims it.
    if (raw.native && raw.kind === 'highlight' && !attached) continue;

    entries.push({
      kind: raw.kind,
      from: raw.from,
      to: attached ? next.to : raw.to,
      quote: raw.quote,
      ...(raw.replacement !== undefined ? { replacement: raw.replacement } : {}),
      comment: attached ? next.quote.trim() : null,
      line: lineAt(content, raw.from),
      native: raw.native,
      spans: {
        markers: raw.markers,
        quote: raw.quoteAt,
        replacement: raw.replacementAt ?? null,
        comment: attached ? { from: next.from, to: next.to } : null,
        commentBody: attached ? next.quoteAt : null,
      },
    });

    if (attached) i++;
  }

  return entries;
}

// ─── Transforms ───

/**
 * What an entry collapses to.
 *
 * Annotations ignore the mode: unwrapping a highlight and deleting a comment
 * are their only possible outcomes, so there is nothing to get wrong. A
 * suggestion asked to "resolve" is a different matter — see below.
 */
function resolvedText(entry: Entry, mode: Mode): string {
  switch (entry.kind) {
    case 'highlight':
      return entry.quote;
    case 'comment':
      return '';
    case 'insertion':
      if (mode === 'accept') return entry.quote;
      if (mode === 'reject') return '';
      break;
    case 'deletion':
      if (mode === 'accept') return '';
      if (mode === 'reject') return entry.quote;
      break;
    case 'substitution':
      if (mode === 'accept') return entry.replacement ?? '';
      if (mode === 'reject') return entry.quote;
      break;
  }
  // A suggestion asked to "resolve" has no defined outcome. Refusing beats
  // guessing: the wrong guess silently rewrites a manuscript.
  throw new Error(`Cannot ${mode} a ${entry.kind}.`);
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

/**
 * Applies non-overlapping edits right to left, so offsets to the left of the
 * one being written stay valid.
 *
 * An edit that empties the line it sits on takes the line with it — otherwise
 * resolving a comment that occupied its own line would leave a blank line
 * behind every time.
 */
function applyEdits(content: string, edits: Edit[]): string {
  let out = content;

  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    let { from, to } = edit;

    if (edit.text === '') {
      const lineStart = out.lastIndexOf('\n', from - 1) + 1;
      let lineEnd = out.indexOf('\n', to);
      const atEof = lineEnd === -1;
      if (atEof) lineEnd = out.length;

      const aloneOnLine =
        out.slice(lineStart, from).trim() === '' && out.slice(to, lineEnd).trim() === '';

      if (aloneOnLine) {
        from = lineStart;
        // Take the line's own newline, or the one before it at end of file, so
        // the surrounding paragraphs close up instead of gaining a gap.
        to = atEof ? lineEnd : lineEnd + 1;
        if (atEof && lineStart > 0) from = lineStart - 1;
      }
    }

    out = out.slice(0, from) + edit.text + out.slice(to);
  }

  return out;
}

/** Rewrites a single entry. Offsets must come from a parse of this same string. */
export function applyEntry(content: string, entry: Entry, mode: Mode): string {
  return applyEdits(content, [
    { from: entry.from, to: entry.to, text: resolvedText(entry, mode) },
  ]);
}

function renderAll(content: string, suggestionMode: 'accept' | 'reject'): string {
  const edits = parseCritic(content).map((entry) => ({
    from: entry.from,
    to: entry.to,
    // Annotations have no accept/reject distinction — they resolve either way.
    text: resolvedText(
      entry,
      entry.kind === 'highlight' || entry.kind === 'comment' ? 'resolve' : suggestionMode
    ),
  }));
  return applyEdits(content, edits);
}

/**
 * The manuscript as it currently reads: insertions kept, deletions gone,
 * substitutions resolved to the new text, highlights unwrapped, comments
 * dropped. What the card previews show and what "Accept all" writes.
 */
export function renderAccepted(content: string): string {
  return renderAll(content, 'accept');
}

/** The manuscript with every suggestion turned down. Annotations still go. */
export function renderRejected(content: string): string {
  return renderAll(content, 'reject');
}

/**
 * The smallest single replacement turning `before` into `after`, or null when
 * they already match.
 *
 * The transforms above return a whole document, but writing a whole document
 * back to the editor is not equivalent to changing the part that differs:
 * CodeMirror maps the caret through the change, and replacing [0, len) sends
 * it to the top of the note. Narrowing the write to the bytes that actually
 * moved leaves the caret, the selection and the scroll position where the
 * writer left them.
 */
export function minimalEdit(
  before: string,
  after: string
): { from: number; to: number; text: string } | null {
  if (before === after) return null;

  const shorter = Math.min(before.length, after.length);
  let start = 0;
  while (start < shorter && before[start] === after[start]) start++;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  return { from: start, to: endBefore, text: after.slice(start, endAfter) };
}
