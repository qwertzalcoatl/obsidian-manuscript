# Writable Review Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Review drawer the place a comment is read, written, edited and decided — ⌘⇧M opens a note field on the card instead of parking the caret in invisible text.

**Architecture:** Every decision moves into `critic.ts` as pure functions over a string and an `Entry` — where the comment body sits (`Spans.commentBody`), what a note may contain (`sanitizeComment`), and what the document becomes when a note is set (`setComment`). `review-view.ts` keeps only wiring: an `editing` record that `paint()` rebuilds the field from, and a suppression guard so a repaint cannot eat keystrokes. `main.ts` loses `wrapSelection`'s comment branch entirely.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), Obsidian plugin API, Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-08-11-writable-review-drawer-design.md`

## Global Constraints

- **No new dependencies.**
- **Branch:** `writable-review-drawer`, off `criticmarkup-edit-through`. Not `main`.
- **`src/critic.ts` is modified, deliberately and only as Tasks 1-3 describe** — one new `Spans` member and two new exported functions. Nothing else in that file changes except two docstrings that still describe the deleted comment glyph.
- **`src/review-view.ts` cannot be imported under test.** `src/__mocks__/obsidian.ts` has no `ItemView`, so `export class ReviewView extends ItemView` throws at module evaluation, and `Platform.isMacOS` is read at module scope. Do not try to fix this — it is why Tasks 1-3 exist and why Tasks 5-7 end in hand verification instead of assertions.
- **`nonEmpty()` is a trap here.** `{>><<}` has a zero-width body. Any range that describes a comment body is tested against `null`, never for emptiness.
- **`Range` is ambiguous.** `src/critic.ts` exports `Range` as `{ from: number; to: number }`; `@codemirror/state` exports a generic `Range<T>`. Never import the latter into `critic-render.ts`.
- **Run tests with:** `npm test`. A single file: `npx jest src/critic.test.ts`. Build: `npm run build`. Typecheck: `npx tsc --noEmit`.
- **Commit style:** lowercase conventional prefix, imperative subject, body explaining *why* — see `git log`. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **House voice.** Comments explain why a thing is the way it is, in prose, and name the failure they prevent. Read `src/critic-render.ts` before writing any.

---

### Task 1: Report where a comment's text sits

`Spans` describes every part of a construct except the one this feature writes into. `parseCritic` already computes it — the comment's `Raw` carries `quoteAt` — and both branches that build an entry throw it away.

**Files:**
- Modify: `src/critic.ts:32-41` (`Spans`), `src/critic.ts:344-358` (the standalone-comment branch), `src/critic.ts:368-386` (the attached branch)
- Test: `src/critic.test.ts`

**Interfaces:**
- Produces: `Spans.commentBody: Range | null` — the comment's text alone, inside its markers; zero-width when the note is empty; null wherever `spans.comment` is null.

- [ ] **Step 1: Write the failing tests**

Append to `src/critic.test.ts`:

```ts
describe('parseCritic — where a comment body sits', () => {
  const bodyOf = (content: string) => {
    const spans = parseCritic(content)[0].spans;
    const body = spans.commentBody;
    return body === null ? null : content.slice(body.from, body.to);
  };

  it('reports the text inside a standalone comment', () => {
    expect(bodyOf('{>>Mehr Luft<<}')).toBe('Mehr Luft');
  });

  it('reports the text inside an attached comment', () => {
    expect(bodyOf('Sie {--ging--}{>>zu spät?<<} fort.')).toBe('zu spät?');
  });

  it('reports a zero-width range for an empty note, not null', () => {
    const spans = parseCritic('Sie {==ging==}{>><<} fort.')[0].spans;
    expect(spans.commentBody).toEqual({ from: 17, to: 17 });
  });

  it('reports the two-character markers of a native comment', () => {
    expect(bodyOf('%%Mehr Luft%%')).toBe('Mehr Luft');
  });

  it('reports a native note attached to a CriticMarkup anchor', () => {
    // entry.native describes the anchor here, so nothing else in Entry can
    // say that this note's markers are two characters rather than three.
    expect(bodyOf('Sie {--ging--}%%zu spät?%% fort.')).toBe('zu spät?');
  });

  it('reports null where there is no comment at all', () => {
    expect(parseCritic('Sie {--ging--} fort.')[0].spans.commentBody).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic.test.ts -t "where a comment body sits"`
Expected: FAIL — `commentBody` does not exist on `Spans`.

- [ ] **Step 3: Add the member**

In `src/critic.ts`, replace the `comment` member of `Spans` and add the new one. The existing docstring is stale — the glyph it names was deleted two commits ago:

```ts
  /** The whole comment construct, markers included. Hidden outright. */
  comment: Range | null;
  /**
   * The comment's text alone, inside its markers. Zero-width for an empty
   * `{>><<}` — so callers test this against null and never for emptiness.
   *
   * Reported rather than left to be worked out, because the marker is two
   * characters for one of Obsidian's own `%%…%%` notes and three for a
   * CriticMarkup one, and on an attached comment `native` describes the
   * anchor rather than the note. `{--ging--}%%zu spät?%%` is otherwise
   * inexpressible.
   */
  commentBody: Range | null;
```

- [ ] **Step 4: Stop discarding it in both branches**

In the standalone-comment branch of `parseCritic`, the comment above `spans` also names the glyph. Replace both:

```ts
        // The construct is hidden whole, so its own markers are not listed
        // separately — they are inside what gets replaced.
        spans: {
          markers: [],
          quote: null,
          replacement: null,
          comment: { from: raw.from, to: raw.to },
          commentBody: raw.quoteAt,
        },
```

In the attached branch, add the member beside `comment`:

```ts
      spans: {
        markers: raw.markers,
        quote: raw.quoteAt,
        replacement: raw.replacementAt ?? null,
        comment: attached ? { from: next.from, to: next.to } : null,
        commentBody: attached ? next.quoteAt : null,
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/critic.test.ts -t "where a comment body sits"`
Expected: PASS.

- [ ] **Step 6: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0. Every existing test passes untouched — this adds a field and changes no behaviour.

- [ ] **Step 7: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "$(cat <<'EOF'
feat: report where a comment's text sits

parseCritic already computed the body's range and threw it away, so
anything writing into a note would have had to re-derive the marker
length from the source — the exact duplication Spans exists to prevent.
It also settles a case Entry cannot express on its own: on an attached
comment, `native` describes the anchor, not the note.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Defuse what a note may not contain

CriticMarkup has no escape syntax. A note holding its own closing marker truncates itself and spills the rest into the manuscript; a note holding a blank line stops the construct parsing at all. Neither can be represented, so both are defused where a note is written.

**Files:**
- Modify: `src/critic.ts` (new export, below `BLANK_LINE` at line 220)
- Test: `src/critic.test.ts`

**Interfaces:**
- Produces: `sanitizeComment(text: string, close?: string): string` — `close` defaults to `'<<}'` and is `'%%'` for one of Obsidian's own comments.

- [ ] **Step 1: Write the failing tests**

Append to `src/critic.test.ts` (add `sanitizeComment` to the import from `./critic`):

```ts
describe('sanitizeComment — what a note may contain', () => {
  it('keeps ordinary prose intact', () => {
    expect(sanitizeComment('Zu früh im Kapitel.')).toBe('Zu früh im Kapitel.');
  });

  it('keeps a single newline — notes run to several lines', () => {
    expect(sanitizeComment('Erstens.\nZweitens.')).toBe('Erstens.\nZweitens.');
  });

  it('collapses a blank line, which would end the construct', () => {
    expect(sanitizeComment('Erstens.\n\nZweitens.')).toBe('Erstens.\nZweitens.');
  });

  it('collapses a run of blank lines carrying spaces and tabs', () => {
    expect(sanitizeComment('Erstens.\n \n\t\nZweitens.')).toBe('Erstens.\nZweitens.');
  });

  it('normalises CRLF', () => {
    expect(sanitizeComment('Erstens.\r\nZweitens.')).toBe('Erstens.\nZweitens.');
  });

  it('defuses the closing marker', () => {
    expect(sanitizeComment('siehe >>Wort<<}')).toBe('siehe >>Wort<< }');
  });

  it('leaves the opening marker alone, which the parser reads as text', () => {
    expect(sanitizeComment('siehe {>>oben')).toBe('siehe {>>oben');
  });

  it('defuses %% only for a native note', () => {
    expect(sanitizeComment('100%% sicher', '%%')).toBe('100% % sicher');
    expect(sanitizeComment('100%% sicher')).toBe('100%% sicher');
  });

  it('keeps a native note from ending in a stray %', () => {
    // %%a%%% hands the closing marker the body's last character, and the note
    // reads back as "a". The trailing space is invisible: the parser trims.
    expect(sanitizeComment('a%', '%%')).toBe('a% ');
  });

  it('leaves <<} alone in a native note, where it terminates nothing', () => {
    expect(sanitizeComment('siehe >>Wort<<}', '%%')).toBe('siehe >>Wort<<}');
  });

  it('trims, so a note reads back the way the parser reports it', () => {
    expect(sanitizeComment('  zu spät?\n')).toBe('zu spät?');
  });

  it('gives an empty string for whitespace alone', () => {
    expect(sanitizeComment('  \n\t ')).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic.test.ts -t sanitizeComment`
Expected: FAIL — `sanitizeComment` is not exported.

- [ ] **Step 3: Implement**

In `src/critic.ts`, directly below the `BLANK_LINE` constant (line 220):

```ts
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
 * realistic collision is a German writer setting guillemets as >>Wort<< with
 * a brace immediately after, and `<< }` leaves that legible while costing the
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
  // ordinary text.
  return flat.split('<<}').join('<< }');
}
```

`split`/`join` rather than a regex: `<<}` would otherwise have to be escaped, and an escaping mistake here is a silent hole rather than a compile error. The trim comes before the `%` pass so that `$` means the real end of the note, and so the space that pass may add survives it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/critic.test.ts -t sanitizeComment`
Expected: PASS.

- [ ] **Step 5: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "$(cat <<'EOF'
feat: defuse what a note may not contain

CriticMarkup has no escape syntax, so a note holding its own closing
marker truncates itself and spills into the manuscript, and one holding
a blank line stops the construct parsing at all. Neither is
representable; both are defused at the one point a note gets written.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Set a note on an entry

The transform the drawer commits through. Sibling to `applyEntry`: that one resolves a construct, this one authors the note attached to it.

**Files:**
- Modify: `src/critic.ts` (new export, directly below `applyEntry`)
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: `Spans.commentBody` (Task 1), `sanitizeComment` (Task 2), `applyEntry` (existing)
- Produces: `setComment(content: string, entry: Entry, text: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `src/critic.test.ts` (add `setComment` to the import):

```ts
describe('setComment — writing a note into the source', () => {
  const set = (content: string, text: string) =>
    setComment(content, parseCritic(content)[0], text);

  it('adds a note to an anchor that has none', () => {
    expect(set('Sie {--ging--} fort.', 'zu spät?')).toBe(
      'Sie {--ging--}{>>zu spät?<<} fort.'
    );
  });

  it('replaces an existing note', () => {
    expect(set('Sie {--ging--}{>>zu spät?<<} fort.', 'zu früh?')).toBe(
      'Sie {--ging--}{>>zu früh?<<} fort.'
    );
  });

  it('fills an empty note left by the comment command', () => {
    expect(set('Sie {==ging==}{>><<} fort.', 'warum?')).toBe(
      'Sie {==ging==}{>>warum?<<} fort.'
    );
  });

  it('keeps one of Obsidian\'s own notes in its own form', () => {
    expect(set('Sie {--ging--}%%zu spät?%% fort.', 'zu früh?')).toBe(
      'Sie {--ging--}%%zu früh?%% fort.'
    );
  });

  it('sanitises on the way in', () => {
    expect(set('Sie {--ging--} fort.', '  Erstens.\n\nZweitens.  ')).toBe(
      'Sie {--ging--}{>>Erstens.\nZweitens.<<} fort.'
    );
  });

  it('removes an emptied note and leaves the anchor', () => {
    expect(set('Sie {--ging--}{>>zu spät?<<} fort.', '')).toBe('Sie {--ging--} fort.');
  });

  it('removes an emptied standalone comment', () => {
    expect(set('Sie ging.{>>Mehr Luft<<}', '')).toBe('Sie ging.');
  });

  it('takes the line with it when the comment had the line to itself', () => {
    expect(set('Sie ging.\n{>>Mehr Luft<<}\nDann Stille.', '')).toBe(
      'Sie ging.\nDann Stille.'
    );
  });

  it('changes nothing when there is no note and nothing to write', () => {
    const content = 'Sie {--ging--} fort.';
    expect(set(content, '   ')).toBe(content);
  });

  // The property that matters: a note can never break the container it is
  // written into. Split by terminator because the expected text differs —
  // parseCritic trims, and the %% rule may leave a trailing space behind.
  const HOSTILE = ['<<}', '{>>', '%%', 'a\n\nb', 'a\nb', '}', '>>Wort<<}', '%'];

  it('never lets a note break a CriticMarkup container', () => {
    const anchors = [
      'Sie {--ging--} fort.',
      'Sie {++leise ++}ging.',
      'Das {~~kalte~>fahle~~} Licht.',
      'Sie {==ging==} fort.',
      'Sie {==ging==}{>>warum?<<} fort.',
      'Sie {==ging==}{>><<} fort.',
      'Sie ging.{>>Mehr Luft<<}',
    ];

    for (const content of anchors) {
      const before = parseCritic(content);
      for (const text of HOSTILE) {
        const after = setComment(content, before[0], text);
        const reparsed = parseCritic(after);
        expect(reparsed).toHaveLength(before.length);
        // Found by offset, not by index: a hostile body that made the scan
        // split differently would otherwise pass or fail for the wrong reason.
        const written = reparsed.find((e) => e.from === before[0].from);
        expect(written?.comment).toBe(sanitizeComment(text).trim());
      }
    }
  });

  it('never lets a note break one of Obsidian\'s own containers', () => {
    const content = 'Sie {--ging--}%%zu spät?%% fort.';
    const before = parseCritic(content);

    for (const text of HOSTILE) {
      const after = setComment(content, before[0], text);
      const reparsed = parseCritic(after);
      expect(reparsed).toHaveLength(1);
      const written = reparsed.find((e) => e.from === before[0].from);
      expect(written?.comment).toBe(sanitizeComment(text, '%%').trim());
      // Still Obsidian's own form, not converted to CriticMarkup on the way.
      expect(after).toContain('%%');
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic.test.ts -t setComment`
Expected: FAIL — `setComment` is not exported.

- [ ] **Step 3: Implement**

In `src/critic.ts`, directly below `applyEntry`:

```ts
/**
 * The document with `entry`'s note set to `text`.
 *
 * The counterpart to applyEntry above: that one resolves a construct, this
 * one writes the note attached to it. Same contract — the offsets must come
 * from a parse of this same string — and the same reason for living here
 * rather than in the drawer, which is that the delimiters are this file's
 * business and nowhere else's.
 *
 * An empty note is not a note. Clearing one removes its construct, and on a
 * standalone comment that is exactly what resolving it does, line-emptying
 * rule included, so the work is handed to applyEntry rather than repeated.
 */
export function setComment(content: string, entry: Entry, text: string): string {
  const { comment, commentBody } = entry.spans;

  // Two characters for one of Obsidian's own notes, three for CriticMarkup.
  // The difference between the two ranges is the only thing that says which,
  // since `native` describes the anchor on an attached comment.
  const close: '<<}' | '%%' =
    comment !== null && commentBody !== null && commentBody.from - comment.from === 2
      ? '%%'
      : '<<}';
  const body = sanitizeComment(text, close);

  if (comment === null || commentBody === null) {
    // A note flush against the construct attaches to it: the rule up in
    // parseCritic is whitespace but no newline between the two, and no gap
    // at all satisfies it.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/critic.test.ts -t setComment`
Expected: PASS.

- [ ] **Step 5: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "$(cat <<'EOF'
feat: write a note back into the source

The transform the drawer commits through — sibling to applyEntry, which
resolves a construct where this one authors the note attached to it. It
lives here because the delimiters are this file's business: nothing
outside it should have to know that a note ends in <<} or %%.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Collapse every line a comment owns

Notes now run to several lines, which the parser has always permitted and nothing has exercised. `lineCollapseRange` reads only the line at `entry.from`, so a two-line standalone note collapses its first line and leaves the second on screen as raw text.

**Files:**
- Modify: `src/critic-render.ts:286-296` (`lineCollapseRange`)
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Produces: no signature change. `lineCollapseRange(state, entry)` spans the line at `entry.from` through the line at `entry.to`.

- [ ] **Step 1: Write the failing tests**

In `src/critic-live.test.ts`, append to the existing `describe('lineCollapseRange — …')` block:

```ts
  it('takes both lines when the comment runs across two', () => {
    expect(collapse('Sie ging.\n{>>Mehr Luft\nim Absatz<<}\nDann Stille.')).toBe(
      '\n{>>Mehr Luft\nim Absatz<<}'
    );
  });

  it('leaves a two-line comment with prose after it on the last line', () => {
    expect(collapse('Sie ging.\n{>>Mehr Luft\nim Absatz<<} Dann Stille.')).toBeNull();
  });

  it('leaves a two-line comment with prose before it on the first line', () => {
    expect(collapse('Sie ging. {>>Mehr Luft\nim Absatz<<}\nDann Stille.')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/critic-live.test.ts -t lineCollapseRange`
Expected: FAIL — the first new case returns `'\n{>>Mehr Luft'`, the second returns a range instead of null. The suffix test slices past the end of the first line, gets `''`, and passes.

- [ ] **Step 3: Implement**

In `src/critic-render.ts`, replace `lineCollapseRange`'s body and extend its docstring:

```ts
/**
 * The line — or lines — an unanchored comment should take with it, or null.
 *
 * Hiding only the construct would leave a blank line mid-paragraph, more
 * conspicuous than the glyph this replaced. The same rule applyEdits already
 * applies in critic.ts when such a comment is resolved: an edit that empties
 * the line it sits on takes the line with it.
 *
 * Read from the first line to the last because a note can run across several
 * of them. Reading only the line at `from` looks right and is not: the suffix
 * test then slices past the end of that line, gets an empty string, agrees the
 * line is clear, and collapses the first line while the rest stays on screen
 * as raw markup.
 *
 * Takes the newline before the block where there is one, so the paragraphs
 * above and below close up rather than trading one gap for another. A comment
 * that is the whole note keeps its line: there is nothing to close.
 */
export function lineCollapseRange(state: EditorState, entry: Entry): Range | null {
  if (entry.kind !== 'comment') return null;

  const first = state.doc.lineAt(entry.from);
  const last = state.doc.lineAt(entry.to);
  if (first.text.slice(0, entry.from - first.from).trim() !== '') return null;
  if (last.text.slice(entry.to - last.from).trim() !== '') return null;

  if (first.from > 0) return { from: first.from - 1, to: last.to };
  if (last.to < state.doc.length) return { from: first.from, to: last.to + 1 };
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/critic-live.test.ts -t lineCollapseRange`
Expected: PASS, including all six pre-existing cases — a single-line comment has `first === last`, so nothing about them changes.

- [ ] **Step 5: Run the full suite, build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/critic-render.ts src/critic-live.test.ts
git commit -m "$(cat <<'EOF'
fix: collapse every line an unanchored comment owns

Notes are about to run to several lines. Reading only the line at
entry.from looks right and is not: the suffix test slices past the end
of that line, gets an empty string, agrees the line is clear, and
collapses the first while the rest stays on screen as raw markup.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Write and edit a note on its card

The drawer's half. Nothing here is unit-testable — see the Global Constraints — so the steps end in a build, a typecheck and four things to try by hand.

**Files:**
- Modify: `src/review-view.ts` (imports, `editing`, `refresh`/`load`, `paint`, `buildCard`, `act`, new `openNote`/`closeNote`/`buildNoteField`, module-level `grow`/`stillThere`)
- Modify: `styles.css` (after the `.sheet-review-comment` rule at line 636)

**Interfaces:**
- Consumes: `setComment`, `sanitizeComment` (Tasks 2-3)
- Produces:
  - `ReviewView.openNote(offset: number): Promise<void>` — public; Task 7 calls it
  - `ReviewView.load(): Promise<void>` — awaitable reload; `refresh()` becomes a wrapper

- [ ] **Step 1: Extend the imports**

In `src/review-view.ts`, add the two transforms to the `./critic` import:

```ts
import {
  applyEntry,
  minimalEdit,
  parseCritic,
  renderAccepted,
  renderRejected,
  setComment,
  type Entry,
  type Mode,
} from './critic';
```

`sanitizeComment` is not imported — `setComment` applies it, and comparing a sanitised draft against the stored note is exactly what `next === content` already answers.

- [ ] **Step 2: Add the two module-level helpers**

Below the `Card` interface (after line 65):

```ts
/**
 * Whether the source still says what the card was built from.
 *
 * Two independent checks, because the cost of being wrong here is a silently
 * mangled manuscript: the bytes at those offsets must still be identical, and
 * a fresh parse of the live text must still agree that an entry of this kind
 * lives exactly there.
 */
function stillThere(content: string, card: Card): boolean {
  return (
    content.slice(card.entry.from, card.entry.to) === card.raw &&
    parseCritic(content).some(
      (e) => e.from === card.entry.from && e.to === card.entry.to && e.kind === card.entry.kind
    )
  );
}

/** Height follows the text: a note is read whole or it is not read. */
function grow(field: HTMLTextAreaElement): void {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}
```

- [ ] **Step 3: Add the editing record**

Below `focusedOffset` (line 78):

```ts
  /**
   * The note being written, and its text so far.
   *
   * Keyed on the entry's start offset, the same key focusedOffset uses,
   * because every repaint builds new elements — the field has to be a product
   * of painting rather than something applied afterwards. That is what the
   * comment command needs: it writes markup, waits for the reload, and only
   * then is there a card to type into.
   */
  private editing: { offset: number; draft: string } | null = null;
```

- [ ] **Step 4: Split `refresh()` into an awaitable `load()`**

Replace the whole of `refresh()` (lines 166-196) with:

```ts
  /** Fire-and-forget reload, for the events and the callers that cannot await. */
  refresh(): void {
    void this.load();
  }

  /**
   * Re-reads the sheet and repaints.
   *
   * Awaitable because opening a note field has to happen after the read that
   * produced its card: the comment command writes the markup, and the card to
   * type into does not exist until the drawer has parsed the text again.
   *
   * A reload while a field is open is dropped rather than deferred — it would
   * rebuild the textarea out from under the keystrokes, which is the same bug
   * focusedOffset exists for with a worse ending. Closing the field always
   * reloads, so nothing stays stale longer than a note takes to write, and
   * what goes stale meanwhile is the other cards. The guard sits here rather
   * than in requestRefresh because act() and the plugin's refreshViews both
   * call refresh directly.
   */
  async load(): Promise<void> {
    this.cancelRefresh();
    if (this.editing !== null) return;

    const file = this.app.workspace.getActiveFile();
    const next = file && file.extension === 'md' ? file : null;
    // Offsets from one note mean nothing in another.
    if (next?.path !== this.file?.path) this.focusedOffset = null;
    this.file = next;

    if (!this.file) {
      this.cards = [];
      this.paint();
      return;
    }

    const target = this.file;
    try {
      const content = await this.readContent(target);
      if (this.file?.path !== target.path) return; // a newer reload owns the view
      this.cards = parseCritic(content).map((entry) => ({
        entry,
        raw: content.slice(entry.from, entry.to),
      }));
    } catch (err) {
      console.error('Sheet Navigator: could not read the sheet for review', err);
      this.cards = [];
    }
    this.paint();
  }
```

- [ ] **Step 5: Reconcile and rebuild the field in `paint()`**

At the very top of `paint()`, before `paintHeader()`:

```ts
    // A field cannot outlive its card. Without this a stale record would
    // suppress every reload for the rest of the session.
    const open = this.editing;
    if (open !== null && !this.cards.some((c) => c.entry.from === open.offset)) {
      this.editing = null;
    }
```

And at the very end of `paint()`, after the `focusedOffset` block:

```ts
    // The field is rebuilt with everything else, so it is re-focused here:
    // focus() on an element that is not yet in the document does nothing,
    // and the cards were appended a moment ago.
    if (this.editing !== null) {
      const offset = this.editing.offset;
      const index = this.cards.findIndex((c) => c.entry.from === offset);
      const field = this.listEl.children[index]?.querySelector('textarea');
      if (field instanceof HTMLTextAreaElement) {
        grow(field);
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
```

- [ ] **Step 6: Draw the note row**

In `buildCard`, replace the comment block (lines 261-263) with:

```ts
    if (this.editing?.offset === entry.from) {
      this.buildNoteField(el, card);
    } else if (entry.comment) {
      const note = el.createDiv({ cls: 'sheet-review-comment' });
      note.setText(entry.comment);
      note.addEventListener('click', (e) => {
        // Not the card's own click. reveal() dispatches into the editor, and
        // if that took focus the field would blur, commit and close itself —
        // a click that undoes its own effect.
        e.stopPropagation();
        void this.openNote(entry.from);
      });
    }
```

`entry.comment` is truthy only for a note with text, so `''` and `null` both fall through to nothing — the two states the card draws alike. Task 6 gives them their affordance.

- [ ] **Step 7: Guard the card's keydown handler**

In `buildCard`, replace the keydown listener (lines 278-283):

```ts
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      // Only the card's own keys. The textarea inside it sends Space and Enter
      // up here too, where preventDefault would eat a word break and scroll
      // the editor instead of typing.
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        reveal();
      }
    });
```

- [ ] **Step 8: Build the field**

Add below `paintQuote`:

```ts
  /**
   * The note field: a textarea that looks like the note it stands in for.
   *
   * Enter breaks a line, because a note is prose and sometimes wants two of
   * them. ⌘↵ and clicking away commit; Escape restores what was stored. The
   * draft is mirrored into `editing` on every keystroke so a repaint we asked
   * for can put the text back.
   */
  private buildNoteField(parent: HTMLElement, card: Card): void {
    const field = parent.createEl('textarea', { cls: 'sheet-review-comment-input' });
    field.value = this.editing?.draft ?? '';
    field.rows = 1;
    field.placeholder = 'Write a note…';

    field.addEventListener('click', (e) => e.stopPropagation());
    field.addEventListener('input', () => {
      if (this.editing !== null) this.editing.draft = field.value;
      grow(field);
    });
    field.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeNote(card, false);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        this.closeNote(card, true);
      }
    });
    field.addEventListener('blur', () => this.closeNote(card, true));
  }
```

- [ ] **Step 9: Open and close**

Add below `focusAt`:

```ts
  /**
   * Opens the note field on the card covering `offset`, reloading first.
   *
   * The reload is why this is async, and why load() is: the comment command
   * writes markup and then asks for the card, which does not exist until the
   * drawer has parsed the text again.
   *
   * Does nothing when no card covers the offset. That happens when a write
   * from the field just closed moved the entries along, and clicking again
   * lands correctly — better than opening a field on the wrong note.
   */
  async openNote(offset: number): Promise<void> {
    // Any open field has already committed on blur; clearing here keeps a
    // record that should not exist from suppressing the reload below.
    this.editing = null;
    await this.load();

    const card = this.cards.find((c) => offset >= c.entry.from && offset < c.entry.to);
    if (!card) return;

    this.editing = { offset: card.entry.from, draft: card.entry.comment ?? '' };
    this.paint();
  }

  /**
   * Closes the field and writes the result, if writing changes anything.
   *
   * Commit and cancel differ only in which text is written back — the draft,
   * or what was stored. Everything after that is one path, which is what
   * makes an empty note behave the same either way: setComment removes the
   * construct, so abandoning the comment command with Escape leaves a plain
   * highlight rather than a mark promising a note nobody wrote.
   */
  private closeNote(card: Card, commit: boolean): void {
    const editing = this.editing;
    if (editing === null || editing.offset !== card.entry.from) return;

    const text = commit ? editing.draft : (card.entry.comment ?? '');
    this.editing = null;

    const file = this.file;
    const view = file ? this.editorViewFor(file) : null;
    if (!view) {
      new Notice('Open this note in an editor to write on its markup.');
      this.refresh();
      return;
    }

    const content = view.editor.getValue();
    if (!stillThere(content, card)) {
      new Notice('The note changed — the list has been refreshed. Try again.');
      this.refresh();
      return;
    }

    const next = setComment(content, card.entry, text);
    // Reloading is what returns the card to its resting state, and what shows
    // anything that was suppressed while the field was open.
    if (next === content) this.refresh();
    else this.write(view, content, next);
  }
```

- [ ] **Step 10: Use the extracted guard in `act()`**

In `act()`, replace the inline check (lines 356-371) with:

```ts
    const content = view.editor.getValue();
    if (!stillThere(content, card)) {
      new Notice('The note changed — the list has been refreshed. Try again.');
      this.refresh();
      return;
    }
```

The comment that stood above it now lives on `stillThere`.

- [ ] **Step 11: Style the note and the field**

Two edits in `styles.css`.

First, add four properties to the **existing** `.sheet-review-comment` rule (line
636-646), keeping its font, size, colour and `margin-top` exactly as they are, and
extend the comment above it with a second paragraph:

```css
/* …existing paragraph about the reading font and full contrast…

   It is also prose you edit, not a label — the same change the editor pane made
   for marked-up text, for the same reason. The hover tint is what says so before
   the click: an I-beam alone is easy to miss in a sidebar. The negative margin
   keeps the tinted box aligned with the text above it rather than inset. */
.sheet-review-comment {
  /* …existing declarations, unchanged… */
  cursor: text;
  margin-inline: -4px;
  padding-inline: 4px;
  border-radius: 4px;
}
```

Then add the new rules directly below it:

```css
.sheet-review-comment:hover {
  background-color: var(--background-modifier-hover);
}

/* Invisible as a control. Committing a note should change nothing on screen
   except where the caret is, so the field borrows every measurement from the
   note it stands in for and brings no chrome of its own. The placeholder is
   the only thing that marks an empty one — which is the state the comment
   command opens. Height comes from grow() in review-view.ts. */
.sheet-review-comment-input {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  resize: none;
  overflow: hidden;
  font-family: var(--font-text);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-normal);
}

.sheet-review-comment-input:focus,
.sheet-review-comment-input:focus-visible {
  border: none;
  outline: none;
  box-shadow: none;
}

.sheet-review-comment-input::placeholder {
  color: var(--text-faint);
}
```

- [ ] **Step 12: Build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0. No test changes — every decision this task makes was tested in Tasks 1-4.

- [ ] **Step 13: Verify by hand in Obsidian**

Open a note containing `Sie {--ging--}{>>zu spät?<<} fort.` with the drawer open.

1. Click the note text on the card. A field opens with the caret in it, the text unchanged, and no visible border.
2. Type, then click elsewhere in the drawer. The note updates on the card and in the manuscript, and **the caret and scroll position in the editor pane have not moved.**
3. Open it again, type, press Escape. The old text is back.
4. Open it, press Enter twice, type, and commit. The stored note has one line break, not two, and the construct still renders as a dotted underline rather than as raw braces.
5. Open a field, type, wait three seconds without touching anything, type again. Nothing is lost. (This is the repaint: `editor-change` fires on the write, and `REFRESH_DELAY` is 200ms.)
6. Press the space bar in an open field. It types a space; it does not scroll the editor.
7. **The stale card.** With a field open, change the file from outside Obsidian so the
   entry moves, then press Escape. `card` is the object the card was built from, one
   parse old, so the cancel path must land on the refused-with-a-notice branch — not
   write its own stale text back. Confirm the notice, and confirm the manuscript is
   untouched.

**If the open field is hard to tell from the resting note**, add `background-color: var(--background-modifier-form-field);` to `.sheet-review-comment-input` and note it in the commit body. Do not add a border — the field sits flush with a 13px prose line and a border would shift every card by two pixels on open.

- [ ] **Step 14: Commit**

```bash
git add src/review-view.ts styles.css
git commit -m "$(cat <<'EOF'
feat: write and edit a note on its card

Comments could be read in the drawer but not written there, which left
the lifecycle without a home — and the only place to write one was a
range that edit-through made invisible and atomic.

The repaint is the real work. A reload while a field is open is dropped
rather than deferred, and the field is rebuilt from view state on every
paint: the comment command writes markup, waits for the reload, and only
then is there a card to type into.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Offer a note where there is none

`{>><<}` and no comment at all draw the same card, so both need the same way in. It goes in the actions row, which is already the card's "things you can do here" surface and already costs no height until the card is hovered or focused.

**Files:**
- Modify: `src/review-view.ts` (`buildCard`, the actions block at lines 265-274)

**Interfaces:**
- Consumes: `openNote` (Task 5). Produces nothing new.

- [ ] **Step 1: Add the button**

In `buildCard`, immediately after `const actions = el.createDiv({ cls: 'sheet-review-actions' });` and before the `isSuggestion` branch:

```ts
    // The way into a note that does not exist yet. Here rather than as a
    // placeholder line of its own: this row already hides until the card is
    // hovered or focused, so the affordance costs no height in a list of
    // forty cards, and :focus-within puts it in the tab order for free.
    // An empty {>><<} and no comment at all take the same route — the
    // difference is setComment's, not the card's.
    if (!entry.comment) {
      const add = actions.createEl('button', { cls: 'sheet-review-action', text: 'Note' });
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.openNote(entry.from);
      });
    }
```

Not `is-primary`: Accept and Resolve are the primary act on a card, and a second accent button would flatten that.

- [ ] **Step 2: Build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0.

- [ ] **Step 3: Verify by hand in Obsidian**

In a note containing `Sie {--ging--} fort.` and `Sie ging.{>>Mehr Luft<<}`:

1. Hover the deletion's card. A **Note** button appears to the left of Reject and Accept.
2. Click it, type, commit. `{>>…<<}` appears in the source flush against `--}`, the card shows the note, and the manuscript shows a dotted underline over `ging`.
3. Tab to a card with the drawer focused and confirm the button is reachable and the row appears.
4. **With a field already open on another card**, click this card's **Note** button.
   Blur commits first and the reload rebuilds every row, so the button moves out from
   under the pointer mid-click; confirm the field still opens on the right card, and
   if it does not, that a second click gets there.
5. Confirm the comment card — which has a note — shows **Resolve** and no **Note** button.

- [ ] **Step 4: Commit**

```bash
git add src/review-view.ts
git commit -m "$(cat <<'EOF'
feat: offer a note on a card that has none

An empty {>><<} and no comment at all draw the same card, so both need
the same way in. The actions row already hides until the card is wanted,
so the affordance costs no height in a list of forty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: ⌘⇧M hands the note to the drawer

The broken command. `wrapSelection` loses its comment branch and its caret arithmetic; what stays kind-dependent is only where focus lands, which is the actual difference between the four commands now.

**Files:**
- Modify: `src/main.ts:52-56` (`WRAPPERS`), `src/main.ts:1460-1483` (`wrapSelection`), `src/main.ts:1547-1552` (the `activateReviewView` docstring)
- Modify: `src/review-view.ts:214` (the empty-state text)
- Modify: `README.md`

**Interfaces:**
- Consumes: `ReviewView.openNote` (Task 5)
- Produces: `SheetNavigatorPlugin.startNote(offset: number): Promise<void>` — private

- [ ] **Step 1: Give WRAPPERS its missing member**

In `src/main.ts`, replace the `WRAPPERS` declaration:

```ts
const WRAPPERS: Record<MarkupKind, [string, string]> = {
  highlight: ["{==", "==}"],
  deletion: ["{--", "--}"],
  insertion: ["{++", "++}"],
  // A comment is an anchor plus an empty note. Nothing goes between the note's
  // own markers here — that text is typed on the card, and an empty note that
  // is never written gets removed again when the field closes.
  comment: ["{==", "==}{>><<}"],
};
```

The `Exclude<MarkupKind, "comment">` goes; the branch it existed for goes with it.

- [ ] **Step 2: Collapse `wrapSelection`**

Replace `wrapSelection` and its docstring:

```ts
  /**
   * Wraps the selection in markup and opens the drawer.
   *
   * A comment is the one kind whose content is not manuscript text, so it is
   * the one kind that takes the caret with it: the note is typed on its card,
   * with the drawer focused and the field already open. The other three leave
   * the caret in the sentence, which is where writing carries on.
   */
  private async wrapSelection(editor: Editor, kind: MarkupKind): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) return;

    const start = editor.posToOffset(editor.getCursor("from"));
    const [open, close] = WRAPPERS[kind];
    editor.replaceSelection(`${open}${selection}${close}`);

    if (kind === "comment") await this.startNote(start);
    else await this.activateReviewView(false);
  }

  /**
   * Opens the drawer with the caret in the note field of the entry at `offset`.
   *
   * Two waits, both load-bearing: revealLeaf has to have resolved before the
   * view can be asked for anything, and openNote re-reads the sheet before it
   * looks for the card, because the markup was written a moment ago and the
   * drawer has not parsed it yet.
   */
  private async startNote(offset: number): Promise<void> {
    await this.activateReviewView();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      if (leaf.view instanceof ReviewView) await leaf.view.openNote(offset);
    }
  }
```

- [ ] **Step 3: Correct the `activateReviewView` docstring**

```ts
  /**
   * Opens the Review drawer in the right sidebar.
   *
   * `focus` is false when a command created markup: the caret should stay in
   * the manuscript, with the drawer merely visible. A comment inverts that
   * and does not come through here — its content is not manuscript text, so
   * the caret follows it into the drawer. See startNote.
   */
```

- [ ] **Step 4: Correct the drawer's empty state**

In `src/review-view.ts`, line 214:

```ts
        .setText(
          `Nothing to review. Select a passage and press ${COMMENT_HOTKEY}; the note is typed here.`
        );
```

The old text — *"…press ⌘⇧M to leave a note"* — described the model where the note was left in the manuscript.

- [ ] **Step 5: Build and typecheck**

Run: `npm test && npm run build && npx tsc --noEmit`
Expected: all exit 0. `Record<MarkupKind, …>` now demands all four keys, so a missing `comment` entry would have failed here.

- [ ] **Step 6: Verify by hand in Obsidian — the risky step**

This is the handoff the spec names as most likely not to work first try.

1. With the drawer **closed**, select a word and press ⌘⇧M. The drawer opens, a card appears for the new highlight, and **the caret is in its note field**. Type; the characters land in the field, not in the manuscript.
2. Press ⌘↵. The note shows on the card, the word carries a dotted underline, and no brace is visible anywhere.
3. Repeat with the drawer already **open**, and again with the drawer open but the editor in a different pane.
4. Select a word, press ⌘⇧M, press Escape. The source reads `{==Wort==}` — a plain highlight, no empty note left behind.
5. Right-click a selection → **Comment on selection**. Same behaviour as the hotkey.
6. Confirm the other three wrapping commands still leave the caret in the manuscript, and that **Suggest insertion…** and **Suggest replacement…** still open their modals and still leave the caret there.

**If the field does not take focus**, the cause is ordering, not the field: log inside `openNote` after `await this.load()` to confirm the card was found. A card found but not focused means `revealLeaf` restored focus after `paint()`; a card not found means the read ran before the editor's change reached `readLiveContent`.

- [ ] **Step 7: Bring the README in line**

`README.md` describes the old model in four places.

1. **Line 75**, the paragraph opening *"Comments live in the drawer, not in the prose."* Replace its first two sentences:

> Comments live in the drawer, not in the prose — and they are written there too. A mark carrying one is drawn with a dotted underline; the note itself is on its card, where you click it to write or change it.

Keep the third sentence, about an unanchored comment, unchanged.

2. **The command table, line 95.** Replace the row:

```
| Comment on selection — `⌘⇧M` | yes | `{==Text==}`, then the drawer opens with the caret in its note field |
```

3. **Working through a pass**, after the *"Click a card to jump to it in the editor"* paragraph, add a bullet to the existing list — first, above **Accept / Reject**:

```
- **Click a card's note** to write or change it; `⌘↵` or clicking away commits, `Escape` cancels. A note cleared to nothing is removed, and a card with no note yet offers one from its actions row.
```

4. **Known limitations**, as a new bullet:

```
- A note may run to several lines but cannot hold a blank line or its own `<<}` — CriticMarkup has no escape syntax, so a blank line would end the mark and `<<}` would close it early. Both are defused as the note is written, and what the card shows afterwards is what was stored.
```

- [ ] **Step 8: Commit**

```bash
git add src/main.ts src/review-view.ts README.md
git commit -m "$(cat <<'EOF'
feat: hand a new comment to the drawer to be written

⌘⇧M parked the caret between {>> and <<}, which edit-through had made
both invisible and atomic — you would be typing into text that never
renders. The note is typed on its card instead, so the command writes
the container and hands over the offset.

wrapSelection loses its comment branch entirely: WRAPPERS gains the
member it was missing, and what stays kind-dependent is only where the
caret goes, which is the actual difference between these commands now.

The cost, deliberately: commenting requires the drawer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

In a real vault, after Task 7. None of this can be reached from Jest.

- [ ] **An editing pass.** Open a scene with several marks. Write for a few minutes: comment a passage, edit an existing note, clear one, accept a suggestion, click between cards while a field is open. Confirm no brace ever appears, no keystroke is lost, and nothing corrupts.
- [ ] **A note across a repaint from outside.** With a field open, change the file from outside Obsidian. Confirm the drawer catches up the moment the field closes, and that a stale write is refused with the existing notice rather than landing in the wrong place.
- [ ] **A multi-line note in the manuscript.** Confirm it renders as nothing, that the prose around it closes up, and that arrowing through the line does not strand the caret inside it.
- [ ] **Undo.** Commit a note, press ⌘Z once, confirm the note comes back as it was and the construct stays folded.

### Carried forward from the previous cycle — still unverified

None of this ran in Obsidian. It is not done, and this work touches the last two directly.

- [ ] **The Obsidian `~~` collision.** Caret inside a substitution's replacement half: confirm Obsidian's own `~~` markers stay hidden behind our replace decorations. The reasoning says a `Decoration.replace` cannot be undone by another extension declining to add its own hide-decoration, but it is the spec's one load-bearing promise.
- [ ] **The standalone-comment line collapse** as a block decoration — now also for a note spanning two lines. If the caret strands itself on a hidden line or the editor throws, the fallback is in the edit-through plan, Task 6 Step 7.
- [ ] **Backspace boundaries**, all four, plus confirming Obsidian's list-outdent still works elsewhere in a note.
- [ ] **Arrow traversal** across a substitution.
- [ ] **A commented substitution**, which stacks a dotted underline, a strikethrough, a bottom border and a `→` pseudo-element. If it reads as mud, the two fallbacks are in the edit-through plan, Task 7 Step 8.
- [ ] **The repair command** — toggle on, toggle off, auto-fold on clicking away.
