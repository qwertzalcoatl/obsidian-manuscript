// Editorial comments: a block of editorial prose standing in the manuscript,
// carried by an Obsidian callout rather than by CriticMarkup.
//
// It is deliberately not a sixth construct in critic.ts. Every CriticMarkup
// mark says "change these characters, accept it or reject it"; an editorial
// comment says "this passage does not work yet", which has no span, no accepted
// form and nothing to reject. Keeping the two parsers apart is also what keeps
// editorial comments out of the toolbar count for free — that count is
// parseCritic's length, and parseCritic never learns about callouts.
//
// Pure string-in, data-out, with no Obsidian imports, for the same reason
// critic.ts and archive.ts are.

/** One editorial comment, as it sits in the sheet. */
export interface EditorialBlock {
  /** Offset of the `>` opening the callout. */
  from: number;
  /** Offset past the last character of the last quoted line. */
  to: number;
  /** The title written after the identifier, trimmed. Empty when none was. */
  title: string;
  /** The body, one quote marker stripped from each line, trimmed. */
  body: string;
}

/**
 * The callout identifier, and the title the command writes beside it.
 *
 * One word and no spaces: it goes into an Obsidian callout header and into a
 * CSS attribute selector, and both are simpler for it. The title is written out
 * rather than left to Obsidian's capitalisation of the identifier, which would
 * render "Editorial".
 */
const IDENTIFIER = 'editorial';
const TITLE = 'Editorial comment';

/**
 * The opening line: the marker, the identifier, an optional fold state, and
 * whatever title follows.
 *
 * Case-insensitive because Obsidian is. A block Obsidian renders and this
 * parser refuses would be visible in the manuscript and absent from the drawer,
 * which is the one failure the two have to agree not to have.
 */
const OPENER = /^>[ \t]*\[!editorial\][+-]?[ \t]*(.*)$/i;

/** A line's content without the CR that a CRLF sheet leaves on it. */
function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** One `>` off the front, and the single space that conventionally follows it. */
function withoutMarker(line: string): string {
  const rest = line.slice(1);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/**
 * Every editorial comment in `content`, in document order.
 *
 * A block opens on a line matching OPENER and runs through every consecutive
 * line that begins with `>`. The first line that does not ends it — a blank
 * line and a line of prose alike, which is also where Obsidian stops drawing
 * the callout.
 *
 * Markdown's lazy continuation is not honoured. A body line has to carry its
 * marker, which keeps the rule one sentence long and matches what Obsidian
 * renders.
 */
export function parseEditorial(content: string): EditorialBlock[] {
  const lines = content.split('\n');

  // Where each line begins. Computed once rather than re-derived per block:
  // the offsets are what the drawer scrolls to, and an off-by-one here would
  // land the editor a character into the marker.
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }

  const out: EditorialBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const head = withoutCr(lines[i]);
    const opener = OPENER.exec(head);
    if (opener === null) {
      i++;
      continue;
    }

    let to = starts[i] + head.length;
    const body: string[] = [];

    let j = i + 1;
    while (j < lines.length) {
      const line = withoutCr(lines[j]);
      if (!line.startsWith('>')) break;
      body.push(withoutMarker(line));
      to = starts[j] + line.length;
      j++;
    }

    out.push({
      from: starts[i],
      to,
      title: opener[1].trim(),
      body: body.join('\n').trim(),
    });

    // Resume past the block rather than one line on: an editorial comment
    // cannot open inside another one.
    i = j;
  }

  return out;
}

/**
 * What Insert editorial comment writes, and where the caret goes in it.
 *
 * Here rather than in the command for the reason suggestChange is: this is
 * marker arithmetic, and marker arithmetic in main.ts is what broke the comment
 * hotkey once already. The caret lands past the body's marker, so the first
 * character typed is prose rather than a second `>`.
 */
export function editorialSkeleton(): { text: string; caret: number } {
  const text = `> [!${IDENTIFIER}] ${TITLE}\n> `;
  return { text, caret: text.length };
}

/**
 * The whole edit the command makes: where to write, what to write, and where
 * the caret ends up.
 *
 * Two things are decided here rather than at the call site.
 *
 * **The insertion moves to the start of the caret's line.** A callout has to
 * begin a line, and writing one at an arbitrary caret would split the sentence
 * it was standing in. Above the line is predictable; halfway through a word is
 * not.
 *
 * **Blank lines are added only where the sheet lacks them.** Without one above,
 * the callout joins the paragraph before it; without one below, it swallows the
 * paragraph after — Obsidian draws a single box around both, and the drawer
 * reports the prose as part of the comment. Since the insertion point always
 * follows a newline or opens the file, the text before it needs at most one
 * newline to become a blank line.
 */
export function editorialInsertion(
  content: string,
  caretAt: number
): { at: number; text: string; caret: number } {
  const at = content.lastIndexOf('\n', Math.max(0, caretAt - 1)) + 1;
  const before = content.slice(0, at);
  const after = content.slice(at);

  const skeleton = editorialSkeleton();

  const prefix = before === '' || before.endsWith('\n\n') ? '' : '\n';
  // A blank current line already provides half the separation; a line with
  // prose on it provides none.
  const suffix = after === '' ? '' : after.startsWith('\n') ? '\n' : '\n\n';

  return {
    at,
    text: `${prefix}${skeleton.text}${suffix}`,
    caret: at + prefix.length + skeleton.caret,
  };
}
