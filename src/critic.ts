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
  /** Written with its markers on their own lines. See isBlockForm. */
  blockForm: boolean;
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
 *
 * In the block form a newline against the inside edge of a marker belongs to
 * the marker rather than to the body. That one rule is what lets
 *
 *     {--
 *     Zwei Absätze.
 *
 *     Und noch einer.
 *     --}
 *
 * need no special handling anywhere else: the marker lines vanish whole in both
 * display modes, the card shows the prose without a blank line at either end,
 * and rejecting writes the passage back without the two newlines that were never
 * part of it. Without the rule, rejecting a block-form cut leaves the note one
 * blank line heavier above and below the restored passage, every time.
 *
 * It applies to the block form only, and that is not a refinement — it is what
 * keeps the rule from destroying the case it looks most like. A merge is a
 * substitution whose quoted half is a paragraph break and nothing else,
 * `{~~\n\n~> ~~}`, and there the newlines are the entire content. Absorbing
 * them leaves a mark that quotes nothing and substitutes nothing.
 *
 * `body.length > lead` guards the degenerate `{--\n--}`, where one newline
 * would otherwise be claimed by both markers.
 */
function simple(
  kind: Kind,
  from: number,
  to: number,
  body: string,
  markerLen: number,
  native: boolean,
  blockForm = false
): Raw {
  const lead = blockForm && body.startsWith('\n') ? 1 : 0;
  const trail = blockForm && body.length > lead && body.endsWith('\n') ? 1 : 0;
  const bodyFrom = from + markerLen + lead;
  const bodyTo = to - markerLen - trail;
  return {
    kind,
    from,
    to,
    quote: body.slice(lead, body.length - trail),
    native,
    blockForm,
    markers: [
      { from, to: bodyFrom },
      { from: bodyTo, to },
    ],
    quoteAt: { from: bodyFrom, to: bodyTo },
  };
}

/**
 * Whether a match was written with its markers on their own lines.
 *
 * Three conditions, and the first is the one that carries the weight: nothing
 * but whitespace before the opening marker on its line. That is what tells a
 * block-form cut from a merge — `…hinaus.{~~\n\n~> ~~}Der Regen…` has a
 * sentence in front of its opener, so its newlines stay content.
 *
 * Deliberately silent about what follows the closing marker, because a note
 * attaches there: `setComment` writes `{>>…<<}` flush against `to`, so
 * requiring a clear line after the closer would make a block-form cut stop
 * being one the moment the writer explained it.
 */
function isBlockForm(content: string, from: number, to: number, markerLen: number): boolean {
  const lineStart = content.lastIndexOf('\n', from - 1) + 1;
  return (
    content.slice(lineStart, from).trim() === '' &&
    content[from + markerLen] === '\n' &&
    content[to - markerLen - 1] === '\n'
  );
}

/**
 * A note's text, made safe to put inside its own markers.
 *
 * The format has no escape syntax, so what a body cannot hold is defused
 * rather than escaped. A blank line inside a note is flattened rather than
 * kept: a note is one remark, and the drawer shows it in a field that grows
 * with its text but reads as one. The manuscript is where prose with
 * paragraphs in it belongs. The closing marker ends the construct early,
 * truncating the note and spilling the rest into the manuscript.
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

/** The construct one regex match describes. */
function rawAt(content: string, m: RegExpExecArray, from: number, to: number): Raw {
  const blockForm = isBlockForm(content, from, to, 3);

  if (m[1] !== undefined) return simple('insertion', from, to, m[1], 3, false, blockForm);
  if (m[2] !== undefined) return simple('deletion', from, to, m[2], 3, false, blockForm);
  if (m[4] !== undefined) return simple('highlight', from, to, m[4], 3, false, blockForm);
  if (m[5] !== undefined) return simple('comment', from, to, m[5], 3, false, blockForm);

  // Splits on the first ~>; a body without one is a malformed substitution and
  // is treated as a deletion of exactly what it holds. checkMarkup says so on
  // the card, because a writer who meant "replace" got "cut".
  const body = m[3];
  const arrow = body.indexOf('~>');
  if (arrow === -1) return simple('deletion', from, to, body, 3, false, blockForm);

  const lead = blockForm && body.startsWith('\n') ? 1 : 0;
  const trail = blockForm && body.length > lead && body.endsWith('\n') ? 1 : 0;
  const oldHalf = body.slice(lead, arrow);
  const newHalf = body.slice(arrow + 2, body.length - trail);
  // The arrow is a marker with an inside edge on both sides, so it takes a
  // newline from each — which is what makes `{~~\nalt\n~>\nneu\n~~}` report
  // `alt` and `neu` rather than `alt\n` and `\nneu`.
  const oldTrail = blockForm && oldHalf.endsWith('\n') ? 1 : 0;
  const newLead = blockForm && newHalf.startsWith('\n') ? 1 : 0;

  const bodyFrom = from + 3 + lead;
  const arrowFrom = from + 3 + arrow - oldTrail;
  const arrowTo = from + 3 + arrow + 2 + newLead;
  const bodyTo = to - 3 - trail;

  return {
    kind: 'substitution',
    from,
    to,
    quote: oldHalf.slice(0, oldHalf.length - oldTrail),
    replacement: newHalf.slice(newLead),
    native: false,
    blockForm,
    markers: [
      { from, to: bodyFrom },
      { from: arrowFrom, to: arrowTo },
      { from: bodyTo, to },
    ],
    quoteAt: { from: bodyFrom, to: arrowFrom },
    replacementAt: { from: arrowTo, to: bodyTo },
  };
}

function scanCritic(content: string, skip: Range[]): Raw[] {
  return scanWindow(content, skip, 0, content.length);
}

/**
 * Every construct between `from` and `to`, and every construct inside those.
 *
 * A window rather than a substring, so offsets stay absolute and no caller has
 * to add anything back. Its own regex object rather than the module-level one,
 * because the recursion would otherwise share `lastIndex` with its caller.
 *
 * Nesting is not a luxury here: it is what a mark spanning paragraphs produces.
 * Wrap three paragraphs of an already-reviewed draft in a cut and the marks that
 * were already there are now inside it.
 *
 * A body is scanned; a comment's body is not. Braces in a note are literal text
 * — a note is a remark about the manuscript rather than part of it — and
 * scanning one would turn `{>>siehe {--alt--}<<}` into a mark nobody wrote.
 */
function scanWindow(content: string, skip: Range[], from: number, to: number): Raw[] {
  const out: Raw[] = [];
  const re = new RegExp(CRITIC_RE.source, 'g');
  re.lastIndex = from;

  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const start = m.index;
    const end = start + m[0].length;

    // A match escaping the window means the text inside it is malformed and the
    // closing marker it found belongs to something further out. Stopping is what
    // leaves that marker for checkMarkup to report.
    if (end > to) break;
    if (overlaps(skip, start, end)) continue;

    const raw = rawAt(content, m, start, end);
    out.push(raw);

    if (raw.kind !== 'comment') {
      out.push(...scanWindow(content, skip, raw.quoteAt.from, raw.quoteAt.to));
      if (raw.replacementAt) {
        out.push(...scanWindow(content, skip, raw.replacementAt.from, raw.replacementAt.to));
      }
    }

    re.lastIndex = end;
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
    // `next.from >= raw.to` is what stops a *nested* comment from being read as
    // an attached one. Inside `{--foo{>>bar<<}--}` the comment starts before the
    // deletion ends, so the slice runs backwards, returns the empty string, and
    // the whitespace test passes — setting this entry's `to` to a point before
    // its own closing marker and invalidating every offset downstream.
    const attached =
      next !== undefined &&
      next.kind === 'comment' &&
      next.from >= raw.to &&
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

// ─── Checking ───

export type FaultKind = 'unmatched-opener' | 'unmatched-closer' | 'no-arrow' | 'empty-body';

/**
 * Something wrong with the markup that the parser cannot report by failing.
 *
 * `entryFrom` is the join to the drawer: a fault belonging to a construct the
 * parser accepted is drawn on that construct's card, because the card that
 * renders wrong is the one that should carry the warning. A fault with no entry
 * gets a row of its own.
 */
export interface Fault {
  kind: FaultKind;
  /** What to reveal in the editor: the marker, or the whole malformed construct. */
  at: Range;
  /** The entry this fault belongs to, or null when no entry claims it. */
  entryFrom: number | null;
}

/** Every CriticMarkup marker, opening and closing. Obsidian's own are not here. */
const TOKEN_RE = /\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|\{==|==\}|\{>>|<<\}/g;

/**
 * Everything wrong with a note's markup, in document order.
 *
 * The point is that stray markup is silent. A marker that never finds its
 * partner does not match, so the braces sit in the prose as ordinary text and
 * nothing tells the writer — a failure the plugin has always had and never
 * reported.
 *
 * Derived from `parseCritic` rather than forming a second opinion about what
 * counts as markup, for the reason every renderer here reads its geometry from
 * one parse: two opinions eventually differ, and the difference looks like the
 * plugin lying about one of them.
 *
 * A marker inside a comment counts as consumed, because a note's braces are
 * literal text. That falls out of `spans.comment` covering the whole construct.
 */
export function checkMarkup(content: string): Fault[] {
  const skip = skipRegions(content);
  const entries = parseCritic(content);
  const faults: Fault[] = [];

  const consumed: Range[] = [];
  for (const entry of entries) {
    for (const marker of entry.spans.markers) {
      if (marker.to > marker.from) consumed.push(marker);
    }
    if (entry.spans.comment !== null) consumed.push(entry.spans.comment);
  }

  TOKEN_RE.lastIndex = 0;
  for (let m = TOKEN_RE.exec(content); m !== null; m = TOKEN_RE.exec(content)) {
    const at = { from: m.index, to: m.index + m[0].length };
    if (overlaps(skip, at.from, at.to)) continue;
    if (consumed.some((r) => at.from >= r.from && at.to <= r.to)) continue;
    faults.push({
      kind: m[0].startsWith('{') ? 'unmatched-opener' : 'unmatched-closer',
      at,
      entryFrom: null,
    });
  }

  for (const entry of entries) {
    if (entry.native) continue;
    const at = { from: entry.from, to: entry.to };

    // A `{~~…~~}` the parser had to read as a deletion, because there was no
    // arrow to split on. The writer meant "replace" and got "cut".
    if (entry.kind === 'deletion' && content.startsWith('{~~', entry.from)) {
      faults.push({ kind: 'no-arrow', at, entryFrom: entry.from });
      continue;
    }

    // An empty deletion or highlight is malformed rather than half-written — no
    // command produces one. An empty insertion or replacement is the opposite:
    // that is exactly what `Suggest a change` writes, and the placeholder stands
    // in it until the words arrive.
    if ((entry.kind === 'deletion' || entry.kind === 'highlight') && entry.quote === '') {
      faults.push({ kind: 'empty-body', at, entryFrom: entry.from });
    }
  }

  return faults.sort((a, b) => a.at.from - b.at.from);
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

        // A mark that sat between two blank lines leaves two behind: the one
        // above it and the one below. Take one of them, so the paragraphs it
        // stood between end up separated the way every other pair in the note
        // is. Both sides have to be blank — with text on either side the single
        // newline above is the separator, and removing it would join two
        // paragraphs that were never meant to join.
        if (from > 0 && out[from - 1] === '\n' && out[to] === '\n') to++;
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

/**
 * The document with `entry`'s note set to `text`.
 *
 * The counterpart to applyEntry above: that one resolves a construct, this one
 * writes the note attached to it. Same contract — the offsets must come from a
 * parse of this same string — and the same reason for living here rather than
 * in the drawer, which is that the delimiters are this file's business and
 * nowhere else's.
 *
 * An empty note is not a note. Clearing one removes its construct, and on a
 * standalone comment that is exactly what resolving it does, line-emptying
 * rule included, so the work is handed to applyEntry rather than repeated.
 */
export function setComment(content: string, entry: Entry, text: string): string {
  const { comment, commentBody } = entry.spans;

  // Two characters for one of Obsidian's own notes, three for CriticMarkup.
  // The distance between the two ranges is the only thing that says which,
  // since `native` describes the anchor on an attached comment.
  const close: '<<}' | '%%' =
    comment !== null && commentBody !== null && commentBody.from - comment.from === 2
      ? '%%'
      : '<<}';
  const body = sanitizeComment(text, close);

  if (comment === null || commentBody === null) {
    // A note flush against the construct attaches to it: the rule up in
    // parseCritic is whitespace but no newline between the two, and no gap at
    // all satisfies it.
    return body === ''
      ? content
      : `${content.slice(0, entry.to)}{>>${body}<<}${content.slice(entry.to)}`;
  }

  if (body !== '') {
    return content.slice(0, commentBody.from) + body + content.slice(commentBody.to);
  }

  if (entry.kind === 'comment') return applyEntry(content, entry, 'resolve');
  return content.slice(0, comment.from) + content.slice(comment.to);
}

/**
 * What the Suggest a change command writes, and where the caret goes in it.
 *
 * Here rather than in the command because this is marker arithmetic, and marker
 * arithmetic in main.ts is what broke the comment hotkey: it put the caret three
 * characters into a six-character marker that edit-through had made both
 * invisible and atomic. These offsets are safe for the opposite reason — an
 * empty body is the boundary between two hidden ranges rather than a position
 * inside one — and critic-live.test.ts asserts exactly that against
 * hiddenRanges, which is the check the last one was missing.
 *
 * Both constructs are written empty on purpose. The words are typed into the
 * manuscript afterwards, which is where manuscript text belongs.
 */
export function suggestChange(selection: string): { text: string; caret: number } | null {
  if (selection === '') return { text: '{++++}', caret: 3 };

  // A selection carrying either of the substitution's own markers cannot be
  // wrapped in one: `~>` splits the construct in the wrong place and `~~}`
  // closes it early, and both do it quietly. Refusing beats guessing, for the
  // same reason resolvedText throws rather than picking an outcome.
  if (selection.includes('~>') || selection.includes('~~}')) return null;

  return { text: `{~~${selection}~>~~}`, caret: 3 + selection.length + 2 };
}

/** The entries no other entry contains, in document order. */
function topLevel(entries: Entry[]): Entry[] {
  return entries.filter(
    (e) => !entries.some((o) => o !== e && o.from <= e.from && o.to >= e.to)
  );
}

/**
 * Settles every mark in a note, innermost first.
 *
 * Two steps rather than one, because `applyEdits` requires its edits not to
 * overlap and nested entries overlap by definition. Only the top-level marks
 * become edits; what each one resolves to is settled recursively first.
 *
 * Rejecting is what forces this order. Rejecting a cut keeps its quoted text
 * verbatim, and that text can still hold a mark — so settling the outer one
 * first would leave markup in a note that had just been declared settled. Worse
 * than leaving it: the outer edit carries offsets taken before the inner edit
 * shortened the string, so it overwrites whatever the inner one wrote.
 */
function renderAll(content: string, suggestionMode: 'accept' | 'reject'): string {
  const edits = topLevel(parseCritic(content)).map((entry) => ({
    from: entry.from,
    to: entry.to,
    text: resolveDeep(entry, suggestionMode),
  }));
  return applyEdits(content, edits);
}

/**
 * What one mark resolves to, with any mark inside it resolved first.
 *
 * The recursion terminates because every pass removes at least one construct's
 * markers, so the string it recurses on is strictly shorter. The `includes`
 * guard keeps it from re-parsing prose that plainly holds nothing — which also
 * spares a fragment beginning with `---` from being read as frontmatter.
 */
function resolveDeep(entry: Entry, suggestionMode: 'accept' | 'reject'): string {
  // Annotations have no accept/reject distinction — they resolve either way.
  const text = resolvedText(
    entry,
    entry.kind === 'highlight' || entry.kind === 'comment' ? 'resolve' : suggestionMode
  );
  return text.includes('{') ? renderAll(text, suggestionMode) : text;
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
