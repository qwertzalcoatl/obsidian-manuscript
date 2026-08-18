# Marks Across Paragraphs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one CriticMarkup mark span several paragraphs and let marks nest inside one another, add a checker that names a broken marker, and bind the two suggestion commands to `⌘⇧-` and `⌘⇧+`.

**Architecture:** Everything rests on one parse. `src/critic.ts` holds the parser and the transforms and imports nothing from `obsidian`, so it is unit-testable under jest's node environment; `src/critic-render.ts` renders the same parse in Obsidian's two display modes; `src/review-view.ts` lists it in the drawer. The parse gains three properties — a mark may cross a blank line, a mark's body is scanned for further marks, and a newline against the inside edge of a marker belongs to the marker — and everything else follows from those.

**Tech Stack:** TypeScript, esbuild, jest + ts-jest, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), the Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-08-18-marks-across-paragraphs-design.md`

## Global Constraints

- `src/critic.ts` and `src/text.ts` must not import from `obsidian`. They are tested under jest's node environment, and `src/__mocks__/obsidian.ts` exists only for the files that do.
- User-facing copy lives in `src/main.ts` and `src/review-view.ts`. `src/critic.ts` carries none and gains none.
- No new syntax. Every construct this plan reads is standard CriticMarkup.
- Cards and decorations carry no type labels. A cut is shown struck through, an addition underlined; treatment carries the meaning.
- Run the whole suite with `npm test`. A single file: `npx jest src/critic.test.ts`. A single case: `npx jest src/critic.test.ts -t 'name of the case'`.
- Commit after every task. Commit messages are lower-case, imperative, `feat:` / `fix:` / `refactor:` / `docs:` / `test:`, and end with the Co-Authored-By trailer this repository already uses.

---

# Phase 1 — `src/critic.ts` alone

Pure parsing and transforms. Nothing on screen changes in this phase; every task is verified by `npx jest src/critic.test.ts`.

---

### Task 1: A mark may cross a blank line

**Files:**
- Modify: `src/critic.ts` — delete `BLANK_LINE` (around line 203) and the `if (BLANK_LINE.test(m[0]))` block inside `scanCritic`
- Modify: `src/critic.test.ts:181` — the two cases that assert the refusal
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new. `parseCritic(content: string): Entry[]` keeps its signature and starts returning entries it used to refuse.

- [ ] **Step 1: Replace the two cases that assert the refusal**

In `src/critic.test.ts`, delete the case `refuses a construct that crosses a blank line` together with the three-line comment above it, and rewrite the case below it — `still finds a real construct inside a rejected span` — because there is no longer a rejected span. Put these in their place:

```ts
  it('reads a deletion that crosses a blank line', () => {
    const src = 'Sie stand am Fenster{-- und sah hinaus.\n\nDer Regen--} hatte aufgehört.';
    const e = one(src);
    expect(e.kind).toBe('deletion');
    expect(e.quote).toBe(' und sah hinaus.\n\nDer Regen');
  });

  it('reads an insertion that crosses a blank line', () => {
    const e = one('Ein {++neuer\n\nAbsatz++} hier.');
    expect(e.kind).toBe('insertion');
    expect(e.quote).toBe('neuer\n\nAbsatz');
  });

  it('reads a comment that crosses a blank line', () => {
    const e = one('{>>oben\n\nunten<<}');
    expect(e.kind).toBe('comment');
    expect(e.comment).toBe('oben\n\nunten');
  });

  // The merge of the design spec: the quoted half is the paragraph break
  // itself, and accepting it makes one paragraph out of two.
  it('reads a substitution whose quoted half is a paragraph break', () => {
    const e = one('…hinaus.{~~\n\n~> ~~}Der Regen…');
    expect(e.kind).toBe('substitution');
    expect(e.quote).toBe('\n\n');
    expect(e.replacement).toBe(' ');
  });
```

- [ ] **Step 2: Run the tests to watch them fail**

Run: `npx jest src/critic.test.ts -t 'crosses a blank line'`
Expected: three failures. Each `one(...)` call reports `expect(received).toHaveLength(1)` against a received length of `0`, because `parseCritic` still refuses these.

- [ ] **Step 3: Delete the refusal**

In `src/critic.ts`, delete this constant and its comment:

```ts
/** A blank line ends a paragraph, and no construct may cross one. */
const BLANK_LINE = /\n[ \t]*\n/;
```

and delete this block from `scanCritic`, comment included:

```ts
    if (BLANK_LINE.test(m[0])) {
      CRITIC_RE.lastIndex = from + 1;
      continue;
    }
```

Then rewrite the paragraph in `sanitizeComment`'s doc comment that explains why a blank line in a note is dangerous. It currently reads that a blank line "makes BLANK_LINE above refuse the whole construct and the note stops rendering". That is no longer true, and the flattening it describes stays for a different reason. Replace that sentence with:

```
 * A blank line inside a note is flattened rather than kept: a note is one
 * remark, and the drawer shows it in a field one line high. The manuscript is
 * where prose with paragraphs in it belongs.
```

- [ ] **Step 4: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: let a mark cross a blank line"
```

---

### Task 2: A newline against a marker belongs to the marker

This is the rule that makes the block form need no special handling anywhere else. It also fixes a pre-existing shabbiness: accepting a mark that sits alone between two blank lines currently leaves two blank lines behind.

**Files:**
- Modify: `src/critic.ts` — `simple()`, the substitution branch of `scanCritic`, and `applyEdits`
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: no signature change. `Entry.quote`, `Entry.replacement` and `Entry.spans` change meaning for a mark whose body begins or ends with a newline.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/critic.test.ts`:

```ts
describe('parseCritic — the block form', () => {
  const BLOCK = 'A.\n\n{--\nP1\n\nP2\n--}\n\nB.';

  it('leaves the newlines beside the markers out of the quote', () => {
    const e = one(BLOCK);
    expect(e.kind).toBe('deletion');
    expect(e.quote).toBe('P1\n\nP2');
  });

  it('gives each marker the newline against its inside edge', () => {
    const e = one(BLOCK);
    // '{--\n' and '\n--}', four characters each.
    expect(e.spans.markers).toEqual([
      { from: 4, to: 8 },
      { from: 14, to: 18 },
    ]);
    expect(e.spans.quote).toEqual({ from: 8, to: 14 });
  });

  it('restores the passage with no blank line gained, on reject', () => {
    expect(applyEntry(BLOCK, one(BLOCK), 'reject')).toBe('A.\n\nP1\n\nP2\n\nB.');
  });

  it('closes the gap on accept', () => {
    expect(applyEntry(BLOCK, one(BLOCK), 'accept')).toBe('A.\n\nB.');
  });

  it('reads a block-form substitution', () => {
    const e = one('{~~\nalt\n~>\nneu\n~~}');
    expect(e.kind).toBe('substitution');
    expect(e.quote).toBe('alt');
    expect(e.replacement).toBe('neu');
  });

  it('counts a lone newline once', () => {
    const e = one('{--\n--}');
    expect(e.quote).toBe('');
  });

  // The same rule improves the single-line case, which used to leave the note
  // with one blank line more than it started with.
  it('closes the gap around a resolved own-line comment', () => {
    const src = 'A.\n\n{>>note<<}\n\nB.';
    expect(applyEntry(src, one(src), 'resolve')).toBe('A.\n\nB.');
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `npx jest src/critic.test.ts -t 'the block form'`
Expected: six failures. The quote comes back as `'\nP1\n\nP2\n'`, the marker ranges as `{from:4,to:7}` and `{from:15,to:18}`, reject returns `'A.\n\n\nP1\n\nP2\n\n\nB.'`, and accept returns `'A.\n\n\nB.'`.

- [ ] **Step 3: Absorb the newline in `simple()`**

Replace the whole of `simple()` in `src/critic.ts`:

```ts
/**
 * A construct whose body is one run: everything between a fixed-length opening
 * and closing marker. Covers every form except a substitution.
 *
 * A newline against the inside edge of a marker belongs to the marker rather
 * than to the body. That one rule is what lets the block form —
 *
 *     {--
 *     Zwei Absätze.
 *
 *     Und noch einer.
 *     --}
 *
 * — need no special handling anywhere else: the marker lines vanish whole in
 * both display modes, the card shows the prose without a blank line at either
 * end, and rejecting writes the passage back without the two newlines that
 * were never part of it. Without the rule, rejecting a block-form cut leaves
 * the note one blank line heavier above and below the restored passage, every
 * time.
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
  native: boolean
): Raw {
  const lead = body.startsWith('\n') ? 1 : 0;
  const trail = body.length > lead && body.endsWith('\n') ? 1 : 0;
  const bodyFrom = from + markerLen + lead;
  const bodyTo = to - markerLen - trail;
  return {
    kind,
    from,
    to,
    quote: body.slice(lead, body.length - trail),
    native,
    markers: [
      { from, to: bodyFrom },
      { from: bodyTo, to },
    ],
    quoteAt: { from: bodyFrom, to: bodyTo },
  };
}
```

- [ ] **Step 4: Absorb the newline in the substitution branch**

In `scanCritic`, replace the `else` branch of `if (arrow === -1)` — the block that builds the substitution `Raw` — with this. The arrow has two inside edges, so it can absorb a newline on each side:

```ts
      } else {
        const body = m[3];
        const lead = body.startsWith('\n') ? 1 : 0;
        const trail = body.length > lead && body.endsWith('\n') ? 1 : 0;
        const oldHalf = body.slice(lead, arrow);
        const newHalf = body.slice(arrow + 2, body.length - trail);
        // The arrow is a marker with an inside edge on both sides, so it takes
        // a newline from each — which is what makes `{~~\nalt\n~>\nneu\n~~}`
        // report `alt` and `neu` rather than `alt\n` and `\nneu`.
        const oldTrail = oldHalf.endsWith('\n') ? 1 : 0;
        const newLead = newHalf.startsWith('\n') ? 1 : 0;

        const bodyFrom = from + 3 + lead;
        const arrowFrom = from + 3 + arrow - oldTrail;
        const arrowTo = from + 3 + arrow + 2 + newLead;
        const bodyTo = to - 3 - trail;

        out.push({
          kind: 'substitution',
          from,
          to,
          quote: oldHalf.slice(0, oldHalf.length - oldTrail),
          replacement: newHalf.slice(newLead),
          native: false,
          markers: [
            { from, to: bodyFrom },
            { from: arrowFrom, to: arrowTo },
            { from: bodyTo, to },
          ],
          quoteAt: { from: bodyFrom, to: arrowFrom },
          replacementAt: { from: arrowTo, to: bodyTo },
        });
      }
```

- [ ] **Step 5: Close the doubled gap in `applyEdits`**

`applyEdits` currently declares `aloneOnLine` with `const` and uses it once, inside the `if (edit.text === '')` branch. Replace everything from that declaration to the end of the `if (aloneOnLine) { … }` block with:

```ts
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
        // newline above is the separator and removing it would join two
        // paragraphs that were never meant to join.
        if (from > 0 && out[from - 1] === '\n' && out[to] === '\n') to++;
      }
```

The only new lines are the comment and the `if` at the end; everything above them is what was already there.

- [ ] **Step 6: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file. If the pre-existing cases `removes the whole line when the entry was alone on it` or `removes a trailing own-line entry without leaving a blank line` fail, the new `if` is firing where it should not — it requires a newline on **both** sides.

- [ ] **Step 7: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: give a marker the newline against its inside edge"
```

---

### Task 3: A mark inside a mark

**Files:**
- Modify: `src/critic.ts` — extract the per-match branch logic out of `scanCritic` into `rawAt()`, make the scan recursive, and bound the attachment test in `parseCritic`
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `parseCritic` returns a flat array, sorted by `from`, in which an inner mark's `[from, to)` lies inside an outer mark's. No tree, no `children`.

- [ ] **Step 1: Write the failing tests**

Add to `src/critic.test.ts`:

```ts
describe('parseCritic — marks inside marks', () => {
  it('reads a substitution inside a deletion', () => {
    const es = parseCritic('{--Sie zählte. {~~Dann~>Schließlich~~} Ende.--}');
    expect(es).toHaveLength(2);
    expect(es[0].kind).toBe('deletion');
    expect(es[1].kind).toBe('substitution');
    expect(es[1].from).toBeGreaterThan(es[0].from);
    expect(es[1].to).toBeLessThan(es[0].to);
  });

  it('reads a deletion inside an insertion across a blank line', () => {
    const es = parseCritic('{++ vergessen\n\nspäter {--echt--} hier ++}');
    expect(es.map((e) => e.kind)).toEqual(['insertion', 'deletion']);
    expect(es[1].quote).toBe('echt');
  });

  // Braces in a note are literal text. A comment is a remark about the
  // manuscript, not part of it, so nothing inside one is a mark.
  it('leaves braces inside a comment body alone', () => {
    const es = parseCritic('{>>siehe {--alt--}<<}');
    expect(es).toHaveLength(1);
    expect(es[0].kind).toBe('comment');
    expect(es[0].comment).toBe('siehe {--alt--}');
  });

  // The one case the format cannot express: the first closing marker has no
  // way to say which opener it belongs to.
  it('closes same-kind nesting at the first closer', () => {
    const es = parseCritic('{--a {--b--} c--}');
    expect(es).toHaveLength(1);
    expect(es[0].quote).toBe('a {--b');
  });

  // Only the recursion can reach this. `slice(raw.to, next.from)` runs
  // backwards for a nested comment, returns the empty string, and the
  // whitespace test passes — which used to set the outer entry's end to a
  // point before its own closing marker.
  it('does not attach a comment that sits inside the mark before it', () => {
    const src = '{--foo{>>bar<<}--}';
    const es = parseCritic(src);
    expect(es).toHaveLength(2);
    expect(es[0].to).toBe(src.length);
    expect(es[0].comment).toBeNull();
    expect(es[1].kind).toBe('comment');
    expect(es[1].comment).toBe('bar');
  });

  it('still attaches a comment that follows a nested mark', () => {
    const es = parseCritic('{--foo {==bar==}{>>warum<<} baz--}');
    expect(es).toHaveLength(2);
    expect(es[0].kind).toBe('deletion');
    expect(es[1].kind).toBe('highlight');
    expect(es[1].comment).toBe('warum');
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `npx jest src/critic.test.ts -t 'marks inside marks'`
Expected: the two nesting cases fail with a received length of `1`; `does not attach a comment` fails with a received length of `1`; the same-kind and comment-body cases already pass.

- [ ] **Step 3: Extract the per-match branch logic**

In `src/critic.ts`, above `scanCritic`, add a function holding exactly the branch logic that is currently inside the loop. Move the code rather than rewriting it — including the substitution branch as Task 2 left it, and the comment about splitting on the first arrow:

```ts
/** The construct one regex match describes. */
function rawAt(m: RegExpExecArray, from: number, to: number): Raw {
  if (m[1] !== undefined) return simple('insertion', from, to, m[1], 3, false);
  if (m[2] !== undefined) return simple('deletion', from, to, m[2], 3, false);
  if (m[4] !== undefined) return simple('highlight', from, to, m[4], 3, false);
  if (m[5] !== undefined) return simple('comment', from, to, m[5], 3, false);

  // Splits on the first ~>; a body without one is a malformed substitution
  // and is treated as a deletion of exactly what it holds. checkMarkup says
  // so on the card, because a writer who meant "replace" got "cut".
  const body = m[3];
  const arrow = body.indexOf('~>');
  if (arrow === -1) return simple('deletion', from, to, body, 3, false);

  const lead = body.startsWith('\n') ? 1 : 0;
  const trail = body.length > lead && body.endsWith('\n') ? 1 : 0;
  const oldHalf = body.slice(lead, arrow);
  const newHalf = body.slice(arrow + 2, body.length - trail);
  // The arrow is a marker with an inside edge on both sides, so it takes a
  // newline from each — which is what makes `{~~\nalt\n~>\nneu\n~~}` report
  // `alt` and `neu` rather than `alt\n` and `\nneu`.
  const oldTrail = oldHalf.endsWith('\n') ? 1 : 0;
  const newLead = newHalf.startsWith('\n') ? 1 : 0;

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
    markers: [
      { from, to: bodyFrom },
      { from: arrowFrom, to: arrowTo },
      { from: bodyTo, to },
    ],
    quoteAt: { from: bodyFrom, to: arrowFrom },
    replacementAt: { from: arrowTo, to: bodyTo },
  };
}
```

- [ ] **Step 4: Make the scan recursive**

Replace `scanCritic` with a window-bounded recursion. It keeps the existing skip-region rule and adds one of its own: a comment's body is not scanned.

```ts
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
 * A body is scanned; a comment's body is not. Braces in a note are literal
 * text — a note is a remark about the manuscript rather than part of it — and
 * scanning one would turn `{>>siehe {--alt--}<<}` into a mark nobody wrote.
 */
function scanWindow(content: string, skip: Range[], from: number, to: number): Raw[] {
  const out: Raw[] = [];
  const re = new RegExp(CRITIC_RE.source, 'g');
  re.lastIndex = from;

  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const start = m.index;
    const end = start + m[0].length;

    // A match escaping the window means the text inside it is malformed, and
    // the closing marker found belongs to something further out. Stopping is
    // what leaves that marker for checkMarkup to report.
    if (end > to) break;
    if (overlaps(skip, start, end)) continue;

    const raw = rawAt(m, start, end);
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
```

- [ ] **Step 5: Bound the attachment test**

In `parseCritic`, the `attached` test currently reads:

```ts
    const attached =
      next !== undefined &&
      next.kind === 'comment' &&
      /^[ \t]*$/.test(content.slice(raw.to, next.from));
```

Add the bound, with the reason:

```ts
    // `next.from >= raw.to` is what stops a *nested* comment from being read
    // as an attached one. Inside `{--foo{>>bar<<}--}` the comment starts before
    // the deletion ends, so the slice runs backwards, returns the empty string,
    // and the whitespace test passes — setting this entry's `to` to a point
    // before its own closing marker and invalidating every offset downstream.
    const attached =
      next !== undefined &&
      next.kind === 'comment' &&
      next.from >= raw.to &&
      /^[ \t]*$/.test(content.slice(raw.to, next.from));
```

- [ ] **Step 6: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file. Native forms are unaffected — `scanNative` receives the critic raws as `taken` and still refuses anything overlapping them, so a `%%note%%` inside a deletion stays out of the parse as it does today.

- [ ] **Step 7: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: read a mark that sits inside another mark"
```

---

### Task 4: Accept all and Reject all settle from the inside out

**Files:**
- Modify: `src/critic.ts` — `renderAll`
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `renderAccepted(content: string): string` and `renderRejected(content: string): string` keep their signatures. `applyEdits` keeps its non-overlap contract and is only ever handed top-level edits.

- [ ] **Step 1: Write the failing tests**

```ts
describe('renderAccepted / renderRejected — nested marks', () => {
  const NESTED = '{--Sie zählte. {~~Dann~>Schließlich~~} Ende.--}';

  it('accepting the cut takes the mark inside it too', () => {
    expect(renderAccepted(NESTED)).toBe('');
  });

  // The case that forces inside-out order. Rejecting a cut keeps its quoted
  // text verbatim, and that text still holds a substitution.
  it('rejecting the cut leaves no markup behind', () => {
    expect(renderRejected(NESTED)).toBe('Sie zählte. Dann Ende.');
  });

  it('accepting an insertion keeps the resolved text of a mark inside it', () => {
    expect(renderAccepted('{++neu {--weg--} da++}')).toBe('neu  da');
  });

  it('rejecting an insertion drops what was inside it', () => {
    expect(renderRejected('{++neu {--weg--} da++}')).toBe('');
  });
});
```

- [ ] **Step 2: Run them to watch them fail**

Run: `npx jest src/critic.test.ts -t 'nested marks'`
Expected: `rejecting the cut leaves no markup behind` receives `'Sie zählte. {~~Dann~>Schließlich~~} Ende.'`. The other three may pass or throw `Cannot accept a substitution` from `applyEdits` receiving overlapping edits — either way, the reject case is the one that pins the requirement.

- [ ] **Step 3: Resolve from the inside out**

Replace `renderAll` in `src/critic.ts`:

```ts
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
 * first would leave markup in a note that had just been declared settled.
 *
 * The recursion terminates because every pass removes at least one construct's
 * markers, so the string it recurses on is strictly shorter. The `includes`
 * guard keeps it from re-parsing prose that plainly holds nothing.
 */
function renderAll(content: string, suggestionMode: 'accept' | 'reject'): string {
  const entries = parseCritic(content);
  const edits = topLevel(entries).map((entry) => ({
    from: entry.from,
    to: entry.to,
    text: resolveDeep(entry, suggestionMode),
  }));
  return applyEdits(content, edits);
}

function resolveDeep(entry: Entry, suggestionMode: 'accept' | 'reject'): string {
  const text = resolvedText(
    entry,
    entry.kind === 'highlight' || entry.kind === 'comment' ? 'resolve' : suggestionMode
  );
  return text.includes('{') ? renderAll(text, suggestionMode) : text;
}
```

- [ ] **Step 4: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "fix: settle nested marks from the inside out"
```

---

### Task 5: The checker

**Files:**
- Modify: `src/critic.ts` — add `FaultKind`, `Fault` and `checkMarkup`
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces:

```ts
export type FaultKind = 'unmatched-opener' | 'unmatched-closer' | 'no-arrow' | 'empty-body';

export interface Fault {
  kind: FaultKind;
  /** What to reveal in the editor: the marker, or the whole malformed construct. */
  at: Range;
  /** The entry this fault belongs to, or null when no entry claims it. */
  entryFrom: number | null;
}

export function checkMarkup(content: string): Fault[];
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('checkMarkup', () => {
  const kinds = (content: string) => checkMarkup(content).map((f) => f.kind);

  it('finds nothing in a note whose marks are all closed', () => {
    expect(checkMarkup('Sie {--ging--} fort. {++leise++}')).toEqual([]);
  });

  it('reports an opening marker with no closing marker', () => {
    const faults = checkMarkup('Sie {-- ging fort.');
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('unmatched-opener');
    expect(faults[0].at).toEqual({ from: 4, to: 7 });
    expect(faults[0].entryFrom).toBeNull();
  });

  it('reports a closing marker with no opening marker', () => {
    expect(kinds('Sie ging fort--} und blieb.')).toEqual(['unmatched-closer']);
  });

  it('reports both, in document order', () => {
    expect(kinds('a ++} b {-- c')).toEqual(['unmatched-closer', 'unmatched-opener']);
  });

  // Legal nesting. This was on an earlier draft of the fault list in error.
  it('says nothing about a mark inside a mark', () => {
    expect(checkMarkup('{--a {++b++} c--}')).toEqual([]);
  });

  // Same-kind nesting is the one case the format cannot express, and the
  // leftover closer is how it shows up.
  it('reports the leftover of same-kind nesting as one unmatched closer', () => {
    expect(kinds('{--a {--b--} c--}')).toEqual(['unmatched-closer']);
  });

  it('ignores markers in fenced code, inline code and frontmatter', () => {
    expect(checkMarkup('---\ntitle: {--\n---\n\n`{--` und\n\n```\n{--\n```\n')).toEqual([]);
  });

  it('reports a substitution with no arrow, against its own entry', () => {
    const src = '{~~Dann drehte sie sich um~~}';
    const faults = checkMarkup(src);
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('no-arrow');
    expect(faults[0].entryFrom).toBe(0);
    expect(faults[0].at).toEqual({ from: 0, to: src.length });
  });

  it('reports an empty body, against its own entry', () => {
    expect(kinds('{----}')).toEqual(['empty-body']);
    expect(kinds('{====}')).toEqual(['empty-body']);
  });

  // An empty replacement is a half-written suggestion, not a malformed mark:
  // `Suggest a change` writes exactly that and the placeholder stands in it.
  it('says nothing about an insertion or a replacement still being typed', () => {
    expect(checkMarkup('{++++}')).toEqual([]);
    expect(checkMarkup('{~~alt~>~~}')).toEqual([]);
  });

  // A lone `%%` or `==` is ordinary Obsidian markdown far more often than it
  // is a broken mark.
  it('says nothing about Obsidian’s own markers', () => {
    expect(checkMarkup('Ein ==Wort== und %% eine Notiz %%')).toEqual([]);
  });
});
```

Add `checkMarkup` to the import list at the top of `src/critic.test.ts`.

- [ ] **Step 2: Run them to watch them fail**

Run: `npx jest src/critic.test.ts -t 'checkMarkup'`
Expected: every case fails with `checkMarkup is not a function`.

- [ ] **Step 3: Write `checkMarkup`**

Add to `src/critic.ts`, after `parseCritic` and before the `─── Transforms ───` banner:

```ts
// ─── Checking ───

export type FaultKind = 'unmatched-opener' | 'unmatched-closer' | 'no-arrow' | 'empty-body';

/**
 * Something wrong with the markup that the parser cannot report by failing.
 *
 * `entryFrom` is the join to the drawer: a fault that belongs to a construct
 * the parser accepted is drawn on that construct's card, because the card that
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
 * The point is that stray markup is silent: a marker that never finds its
 * partner does not match, so the braces sit in the prose as ordinary text and
 * nothing tells the writer. This is derived from `parseCritic` rather than
 * forming a second opinion about what counts as markup — the same reason every
 * renderer in this plugin reads its geometry from one parse.
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

    // An empty deletion or highlight is malformed rather than half-written —
    // no command produces one. An empty insertion or replacement is the
    // opposite: that is what `Suggest a change` writes, and the placeholder
    // stands in it until the words arrive.
    if ((entry.kind === 'deletion' || entry.kind === 'highlight') && entry.quote === '') {
      faults.push({ kind: 'empty-body', at, entryFrom: entry.from });
    }
  }

  return faults.sort((a, b) => a.at.from - b.at.from);
}
```

- [ ] **Step 4: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: name what is wrong with a note's markup"
```

---

### Task 6: Which form a selection wants

**Files:**
- Modify: `src/critic.ts` — add `wrapForm`, and give `suggestChange` a form argument
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Task 2, whose newline rule is what makes the block form parse back correctly.
- Produces:

```ts
export function wrapForm(content: string, from: number, to: number): 'inline' | 'block';
export function suggestChange(
  selection: string,
  form?: 'inline' | 'block'
): { text: string; caret: number } | null;
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('wrapForm', () => {
  const SHEET = 'A.\n\nP1\n\nP2\n\nB.';

  it('asks for the block form when whole paragraphs are selected', () => {
    expect(wrapForm(SHEET, 4, 10)).toBe('block');
  });

  it('asks for the inline form for one whole paragraph', () => {
    expect(wrapForm(SHEET, 4, 6)).toBe('inline');
  });

  it('asks for the inline form from mid-sentence to mid-sentence', () => {
    const src = 'Sie stand am Fenster und sah hinaus.\n\nDer Regen hatte aufgehört.';
    expect(wrapForm(src, 20, 44)).toBe('inline');
  });

  it('asks for the block form for a whole note of two paragraphs', () => {
    const src = 'P1\n\nP2';
    expect(wrapForm(src, 0, src.length)).toBe('block');
  });

  it('asks for the inline form when only the start is clean', () => {
    expect(wrapForm(SHEET, 4, 9)).toBe('inline');
  });
});

describe('suggestChange — the block form', () => {
  it('writes a replacement with the arrow on its own line', () => {
    const change = suggestChange('P1\n\nP2', 'block');
    expect(change?.text).toBe('{~~\nP1\n\nP2\n~>\n~~}');
  });

  it('puts the caret in the empty replacement, between two hidden markers', () => {
    const change = suggestChange('alt', 'block');
    // The block form written for 'alt' is `{~~\nalt\n~>\n~~}`; the empty
    // replacement sits where the arrow marker ends.
    const e = one(change!.text);
    expect(e.spans.replacement).toEqual({ from: change!.caret, to: change!.caret });
  });

  it('leaves the inline form as it was', () => {
    expect(suggestChange('alt')).toEqual({ text: '{~~alt~>~~}', caret: 8 });
    expect(suggestChange('')).toEqual({ text: '{++++}', caret: 3 });
  });
});
```

Add `wrapForm` to the import list.

- [ ] **Step 2: Run them to watch them fail**

Run: `npx jest src/critic.test.ts -t 'wrapForm'`
Expected: failures with `wrapForm is not a function`, and the block `suggestChange` cases receiving the inline text.

- [ ] **Step 3: Write `wrapForm` and extend `suggestChange`**

Add above `suggestChange` in `src/critic.ts`:

```ts
/**
 * Whether a selection should be wrapped with its markers on their own lines.
 *
 * `block` when the selection crosses a paragraph boundary **and** both its
 * edges sit on one. Anything else is `inline`, and that is what makes a
 * paragraph merge expressible rather than a special case: markers inside two
 * sentences say "join these", markers on their own lines say "these whole
 * paragraphs".
 *
 * One whole paragraph is deliberately `inline`. The block form would add two
 * lines of syntax and change nothing about how the mark renders or resolves.
 */
export function wrapForm(content: string, from: number, to: number): 'inline' | 'block' {
  if (!/\n[ \t]*\n/.test(content.slice(from, to))) return 'inline';

  const before = content.slice(0, from);
  const after = content.slice(to);
  const atParagraphStart = before === '' || /(?:^|\n)[ \t]*\n[ \t]*$/.test(before);
  const atParagraphEnd = after === '' || /^[ \t]*\n[ \t]*(?:\n|$)/.test(after);

  return atParagraphStart && atParagraphEnd ? 'block' : 'inline';
}
```

Then change `suggestChange`'s signature and add the block branch. Keep the existing doc comment and add a paragraph about the block form:

```ts
export function suggestChange(
  selection: string,
  form: 'inline' | 'block' = 'inline'
): { text: string; caret: number } | null {
  if (selection === '') return { text: '{++++}', caret: 3 };

  if (selection.includes('~>') || selection.includes('~~}')) return null;

  // The block form's arrow sits on its own line. Task 2's rule gives each
  // marker the newline against its inside edge, so this parses back with the
  // quoted half exactly `selection` and the replacement exactly empty — and
  // the caret lands on the boundary between the arrow marker and the closing
  // one, which is the only position in an empty replacement the caret can hold.
  if (form === 'block') {
    return { text: `{~~\n${selection}\n~>\n~~}`, caret: 3 + 1 + selection.length + 1 + 2 };
  }

  return { text: `{~~${selection}~>~~}`, caret: 3 + selection.length + 2 };
}
```

- [ ] **Step 4: Run the tests to watch them pass**

Run: `npx jest src/critic.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: choose the block form from the shape of the selection"
```

---

# Phase 2 — Live Preview and the drawer

After this phase the feature is usable: you can write a mark that spans paragraphs, see it, and settle it. The last task of the phase is the one piece of Reading view that cannot wait until phase 3.

---

### Task 7: The parser says which form a mark is in

**Files:**
- Modify: `src/critic.ts` — add `blockForm` to `Entry`, set it in `parseCritic`
- Test: `src/critic.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `Entry` gains `blockForm: boolean`. True when the opening marker absorbed a newline, which is exactly when the mark was written with its markers on their own lines.

- [ ] **Step 1: Write the failing test**

```ts
describe('parseCritic — blockForm', () => {
  it('is true for a mark whose markers sit on their own lines', () => {
    expect(one('{--\nP1\n\nP2\n--}').blockForm).toBe(true);
  });

  it('is false for a mark inside a sentence, even across a blank line', () => {
    expect(one('Sie{-- ging.\n\nDann--} kam sie.').blockForm).toBe(false);
  });

  it('is false for a standalone comment', () => {
    expect(one('{>>Notiz<<}').blockForm).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic.test.ts -t 'blockForm'`
Expected: the first case receives `undefined` rather than `true`.

- [ ] **Step 3: Report it from the parser**

Add to the `Entry` interface in `src/critic.ts`, after `native`:

```ts
  /**
   * Written with its markers on their own lines.
   *
   * Reported rather than re-derived, for the reason `spans` exists: three
   * consumers need it — the two renderers and the drawer card — and each one
   * working it out from marker lengths is how they come to disagree. True
   * exactly when the opening marker absorbed a newline, which is the rule in
   * `simple()`.
   */
  blockForm: boolean;
```

In `parseCritic`, both `entries.push` calls need it. The standalone-comment branch takes `blockForm: false` — a note has no form. The general branch computes it from the opening marker:

```ts
      blockForm: raw.markers.length > 0 && content[raw.markers[0].to - 1] === '\n',
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. TypeScript will flag any object literal building an `Entry` without the new field — `src/critic-live.test.ts` and `src/critic-render.test.ts` build theirs through `parseCritic`, so there should be none, but `npx tsc --noEmit` is the check.

- [ ] **Step 5: Commit**

```bash
git add src/critic.ts src/critic.test.ts
git commit -m "feat: report whether a mark was written in the block form"
```

---

### Task 8: The innermost mark wins

Three places find "the mark at this position" with `.find()`, which returns the outermost. With nesting, the writer means the innermost one.

**Files:**
- Modify: `src/critic-render.ts` — add `entryAt()`, use it in the click handler of `criticEditorExtension`
- Modify: `src/main.ts:1543-1547` — the `toggle-markup-source` command
- Modify: `src/review-view.ts:382-387` — `rowStartCovering`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `export function entryAt(entries: Entry[], pos: number): Entry | null` from `src/critic-render.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/critic-live.test.ts`, and add `entryAt` to its import list from `./critic-render`:

```ts
describe('entryAt — the innermost mark wins', () => {
  const NESTED = '{--Sie zählte. {~~Dann~>Schließlich~~} Ende.--}';

  it('returns the inner mark for a position inside it', () => {
    const entries = parseCritic(NESTED);
    const inner = entries.find((e) => e.kind === 'substitution')!;
    expect(entryAt(entries, inner.from + 4)?.kind).toBe('substitution');
  });

  it('returns the outer mark for a position only it covers', () => {
    const entries = parseCritic(NESTED);
    expect(entryAt(entries, 5)?.kind).toBe('deletion');
  });

  it('returns null outside every mark', () => {
    expect(entryAt(parseCritic('Sie ging fort.'), 3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-live.test.ts -t 'innermost mark wins'`
Expected: `entryAt is not a function`.

- [ ] **Step 3: Write `entryAt` and use it**

Add to `src/critic-render.ts`, below `isRevealed`:

```ts
/**
 * The narrowest mark covering `pos`, or null.
 *
 * Narrowest rather than first: with nesting, a position inside an inner mark is
 * also inside the mark containing it, and a `.find()` over a list sorted by
 * start offset answers with the outer one. Clicking a substitution inside a cut
 * means the substitution.
 */
export function entryAt(entries: Entry[], pos: number): Entry | null {
  let best: Entry | null = null;
  for (const entry of entries) {
    if (pos < entry.from || pos > entry.to) continue;
    if (best === null || entry.to - entry.from < best.to - best.from) best = entry;
  }
  return best;
}
```

In the `click` handler of `criticEditorExtension`, replace

```ts
        const hit = view.state.field(criticField).find((e) => pos >= e.from && pos <= e.to);
        if (hit) onReveal(hit.from);
```

with

```ts
        const hit = entryAt(view.state.field(criticField), pos);
        if (hit) onReveal(hit.from);
```

In `src/main.ts`, in the `toggle-markup-source` command, replace

```ts
        const entry = cm.state
          .field(criticField)
          .find((e) => pos >= e.from && pos <= e.to);
        if (!entry) return false;
```

with

```ts
        // The innermost construct at the caret: repairing a substitution that
        // sits inside a cut means the substitution.
        const entry = entryAt(cm.state.field(criticField), pos);
        if (!entry) return false;
```

and add `entryAt` to the `./critic-render` import list in `src/main.ts`.

In `src/review-view.ts`, replace the body of `rowStartCovering`:

```ts
  private rowStartCovering(offset: number): number | null {
    // Narrowest wins: a nested mark's card is the one a click inside it means.
    let best: { from: number; width: number } | null = null;
    const consider = (from: number, to: number) => {
      if (offset < from || offset >= to) return;
      if (best === null || to - from < best.width) best = { from, width: to - from };
    };
    for (const card of this.cards) consider(card.entry.from, card.entry.to);
    for (const block of this.blocks) consider(block.from, block.to);
    return best === null ? null : best.from;
  }
```

- [ ] **Step 4: Pin the two things nesting could break in CodeMirror**

The spec names both as risks to confirm rather than to design around. Add to `src/critic-live.test.ts`:

```ts
describe('criticDecorations — what nesting could break', () => {
  // Overlapping mark decorations are fine; two overlapping *replacing* ones
  // are not. The case that can produce them is an unanchored comment whose
  // whole line is collapsed with a block replacement, sitting inside a mark
  // that spans the paragraphs around it.
  it('does not throw on a collapsed comment line inside a spanning mark', () => {
    expect(() => paint('{--P1\n\n{>>Notiz<<}\n\nP2--}')).not.toThrow();
  });

  // hiddenRanges walks entry by entry, so nesting returns the outer mark's
  // closing marker before the inner mark's opening one. Both consumers pass
  // sort: true, so this is safe — asserted rather than assumed, because the
  // failure would be a thrown range set on a note that merely nests.
  it('produces hidden ranges out of document order without complaint', () => {
    const state = EditorState.create({
      doc: '{--a {++b++} c--}',
      extensions: [unfoldField, criticField],
    });
    const ranges = hiddenRanges(state);
    expect(ranges.length).toBeGreaterThan(2);
    expect(() => RangeSet.of(ranges.map((r) => Decoration.replace({}).range(r.from, r.to)), true))
      .not.toThrow();
  });
});
```

This needs `RangeSet` from `@codemirror/state` and `Decoration` from `@codemirror/view` in the test file's imports.

- [ ] **Step 5: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

If `does not throw on a collapsed comment line inside a spanning mark` fails with an overlapping-decoration error from CodeMirror, take the fallback the spec allows: in `criticDecorations`, use `lineCollapseRange` only when no other entry contains this one, and hide the comment construct alone when one does. Add a comment saying why, and keep the test.

- [ ] **Step 6: Commit**

```bash
git add src/critic-render.ts src/main.ts src/review-view.ts src/critic-live.test.ts
git commit -m "fix: answer with the innermost mark at a position"
```

---

### Task 9: A paragraph break inside a mark draws as a pilcrow

**Files:**
- Modify: `src/critic-render.ts` — add `PilcrowWidget` and `pilcrowRanges()`, emit them from `criticDecorations`
- Modify: `src/review-view.ts` — `paintQuote` renders the glyph
- Modify: `styles.css` — `.ms-critic-pilcrow`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: Task 7 (`Entry.blockForm`).
- Produces: nothing other files call. The widget's `cls` is `ms-critic-pilcrow`, which `classOf` in `src/critic-live.test.ts` already reads off a widget.

- [ ] **Step 1: Write the failing test**

```ts
describe('criticDecorations — the paragraph break inside a mark', () => {
  it('draws a pilcrow at a newline inside an inline mark', () => {
    const marks = paint('Sie{-- ging.\n\nDann--} kam.').filter(
      (p) => p.cls === 'ms-critic-pilcrow'
    );
    expect(marks).toHaveLength(2);
  });

  // In the block form the breaks separate whole paragraphs, which the reader
  // already sees as paragraphs.
  it('draws none in the block form', () => {
    const marks = paint('{--\nP1\n\nP2\n--}').filter((p) => p.cls === 'ms-critic-pilcrow');
    expect(marks).toHaveLength(0);
  });

  it('draws one in a merge, where there is nothing else to see', () => {
    const marks = paint('hinaus.{~~\n\n~> ~~}Der').filter(
      (p) => p.cls === 'ms-critic-pilcrow'
    );
    expect(marks).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-live.test.ts -t 'paragraph break inside a mark'`
Expected: the first and third cases receive `0`.

- [ ] **Step 3: Add the widget**

In `src/critic-render.ts`, below `PlaceholderWidget`:

```ts
/**
 * A paragraph break inside a mark, made visible.
 *
 * A struck-through blank line is invisible, so without this the merge —
 * `{~~\n\n~> ~~}`, a substitution whose quoted half is the break itself — has
 * nothing on screen to say it exists at all, and its card reads as an arrow
 * with empty text on either side.
 *
 * A widget beside the newline rather than a replacement of it: an inline
 * replacing decoration may not span a line break, and the break is real until
 * the mark is accepted, so the paragraphs should still read as two.
 *
 * A convention rather than a label, which is why it is a glyph and not the word
 * "Absatzumbruch". Text editors have shown whitespace this way for forty years.
 */
class PilcrowWidget extends WidgetType {
  readonly cls = 'ms-critic-pilcrow';
  readonly text = '¶';

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }

  eq(): boolean {
    return true;
  }
}

// side: -1 draws it before the position, so it lands at the end of the line the
// newline closes rather than at the start of the next one.
const PILCROW = Decoration.widget({ widget: new PilcrowWidget(), side: -1 });

/**
 * Where an entry wants a pilcrow: every newline in a body it is changing.
 *
 * The block form is excluded — there the newlines against the markers belong to
 * the markers, and the ones between paragraphs separate paragraphs the reader
 * can already see.
 */
function pilcrowRanges(state: EditorState, entry: Entry): number[] {
  if (entry.blockForm) return [];
  const out: number[] = [];
  for (const body of [entry.spans.quote, entry.spans.replacement]) {
    if (!nonEmpty(body)) continue;
    const text = state.doc.sliceString(body.from, body.to);
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
      out.push(body.from + i);
    }
  }
  return out;
}
```

In `criticDecorations`, after the two `mark(...)` calls for quote and replacement and before `if (revealed) continue;`, add:

```ts
    for (const at of pilcrowRanges(state, entry)) {
      ranges.push({ from: at, to: at, value: PILCROW });
    }
```

- [ ] **Step 4: Show it on the card**

In `src/review-view.ts`, replace the `span` helper inside `paintQuote` so that an inline-form body shows its breaks as glyphs, and a block-form body keeps them:

```ts
    // A break inside an inline mark is part of what the mark changes, so the
    // card shows it the way the editor does. In the block form the breaks are
    // paragraph separators and the card sets them as breaks — see the
    // white-space rule on .ms-review-quote.
    const withBreaks = (text: string) =>
      entry.blockForm ? text : text.replace(/\n/g, '¶');

    const span = (text: string, cls: string) =>
      el.createSpan({ cls }).setText(withBreaks(text));
```

`entry.quote.trim()` at the two call sites stays as it is; `withBreaks` runs inside `span`.

- [ ] **Step 5: Style it**

Add to `styles.css`, after the `.ms-critic-arrow` rule:

```css
/* A paragraph break inside a mark. Dimmer than the prose it sits in — it says
   where a break is, and is not itself something to read. The decoration around
   it (strikethrough, underline) is inherited from the body's own mark, so this
   rule sets colour and nothing else. */
.ms-critic-pilcrow {
  color: var(--text-faint);
  padding: 0 0.1em;
}
```

- [ ] **Step 6: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/critic-render.ts src/review-view.ts styles.css src/critic-live.test.ts
git commit -m "feat: show a paragraph break inside a mark as a pilcrow"
```

---

### Task 10: A nested card is indented, and a long quote is clamped

**Files:**
- Modify: `src/review-view.ts` — `Row`, `rows()`, `buildCard`
- Modify: `styles.css` — `.ms-review-quote`, `.ms-review-card.is-nested`
- Test: verified by hand in Obsidian; the depth arithmetic is covered by a unit test on the helper

**Interfaces:**
- Consumes: Task 3.
- Produces: `Row` for a mark gains `depth: number`. `buildCard(card: Card, depth: number)`.

- [ ] **Step 1: Write the failing test**

Add to `src/critic.test.ts` — the helper is pure, so it lives in `src/critic.ts` beside `topLevel`:

```ts
describe('nestingDepth', () => {
  it('is zero for marks that stand alone', () => {
    const es = parseCritic('{--a--} und {++b++}');
    expect(es.map((e) => nestingDepth(es, e))).toEqual([0, 0]);
  });

  it('counts the marks containing each one', () => {
    const es = parseCritic('{--a {++b {==c==}++} d--}');
    expect(es.map((e) => nestingDepth(es, e))).toEqual([0, 1, 2]);
  });
});
```

Add `nestingDepth` to the import list.

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic.test.ts -t 'nestingDepth'`
Expected: `nestingDepth is not a function`.

- [ ] **Step 3: Write it**

In `src/critic.ts`, beside `topLevel`, and export it:

```ts
/**
 * How many marks contain `entry`.
 *
 * The drawer indents a card by this, which is how it says that settling the
 * mark above erases this one — without a label having to say so.
 */
export function nestingDepth(entries: Entry[], entry: Entry): number {
  return entries.filter((o) => o !== entry && o.from <= entry.from && o.to >= entry.to).length;
}
```

- [ ] **Step 4: Indent the card**

In `src/review-view.ts`, change the `Row` union's mark arm and `rows()`:

```ts
type Row =
  | { type: 'mark'; card: Card; depth: number }
  | { type: 'editorial'; block: EditorialBlock };
```

```ts
  private rows(): Row[] {
    const entries = this.cards.map((c) => c.entry);
    const rows: Row[] = [
      ...this.cards.map((card) => ({
        type: 'mark' as const,
        card,
        depth: nestingDepth(entries, card.entry),
      })),
      ...this.blocks.map((block) => ({ type: 'editorial' as const, block })),
    ];
    return rows.sort((a, b) => rowFrom(a) - rowFrom(b));
  }
```

Add `nestingDepth` to the `./critic` import list. In `paint()`, pass the depth through:

```ts
        row.type === 'mark'
          ? this.buildCard(row.card, row.depth)
          : this.buildEditorialCard(row.block)
```

and in `buildCard`, take it and apply it:

```ts
  private buildCard(card: Card, depth: number): HTMLElement {
    const { entry } = card;
    const el = createDiv({ cls: 'ms-review-card' });
    if (depth > 0) {
      el.addClass('is-nested');
      el.style.setProperty('--ms-nesting', String(depth));
    }
```

- [ ] **Step 5: Style both**

In `styles.css`, add `white-space: pre-wrap` to `.ms-review-quote` and clamp it, with the comment explaining why:

```css
.ms-review-quote {
  font-family: var(--font-monospace);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-normal);
  word-break: break-word;
  /* A block-form cut carries paragraph breaks, and setText writes the body into
     one element — without this, HTML collapses three paragraphs into one
     run-on line. On a single-line quote it changes nothing. */
  white-space: pre-wrap;
  /* Six lines, not two: a card for a three-paragraph cut would otherwise fill
     the sidebar. In CSS rather than by truncating in JS, so the full text stays
     selectable. */
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

and, after `.ms-review-card.is-resolving`:

```css
/* A mark inside another mark. The indent is the whole statement: settling the
   card above erases this one, and a step to the right says so without a label. */
.ms-review-card.is-nested {
  padding-left: calc(var(--size-4-3) + var(--ms-nesting, 1) * var(--size-4-4));
}
```

- [ ] **Step 6: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Check it by hand**

Run `npm run build`, reload Obsidian, and in a scratch note write
`{--Sie zählte. {~~Dann~>Schließlich~~} Ende.--}`. The drawer must show two cards, the second indented, and accepting the outer one must remove both.

- [ ] **Step 8: Commit**

```bash
git add src/critic.ts src/review-view.ts styles.css src/critic.test.ts
git commit -m "feat: indent a nested card and clamp a long quote"
```

---

### Task 11: The drawer and the editor report a broken marker

**Files:**
- Modify: `src/review-view.ts` — a third `Row` arm, `buildProblemCard`, fault wording, a warning line on a card
- Modify: `src/critic-render.ts` — a `faultField` and a decoration on a stray marker
- Modify: `styles.css` — `.ms-critic-fault`, `.ms-review-problem`
- Test: `src/critic-live.test.ts`

**Interfaces:**
- Consumes: Task 5 (`checkMarkup`, `Fault`, `FaultKind`).
- Produces: nothing other files call.

- [ ] **Step 1: Write the failing test**

```ts
describe('criticDecorations — a stray marker is painted', () => {
  it('marks an opening marker with no closer', () => {
    const painted = paint('Sie {-- ging fort.').filter((p) => p.cls === 'ms-critic-fault');
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ from: 4, to: 7 });
  });

  it('leaves a note whose marks are closed alone', () => {
    expect(paint('Sie {--ging--} fort.').filter((p) => p.cls === 'ms-critic-fault')).toEqual([]);
  });
});
```

The `paint` helper builds its state with `extensions: [unfoldField, criticField]`; add `faultField` to that array and to the import list.

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-live.test.ts -t 'stray marker is painted'`
Expected: `faultField` is not exported.

- [ ] **Step 3: Add the field and the decoration**

In `src/critic-render.ts`, beside `criticField`:

```ts
/**
 * The note's faults, recomputed on every edit for the same reason `criticField`
 * re-parses the whole document: deciding whether a marker is stray needs the
 * rest of the note, and a scene file is small enough that the honest answer is
 * also the fast one.
 */
export const faultField = StateField.define<Fault[]>({
  create: (state) => faults(state),
  update: (value, tr) => (tr.docChanged ? faults(tr.state) : value),
});

function faults(state: EditorState): Fault[] {
  const text = state.doc.toString();
  return mightHaveMarkup(text) ? checkMarkup(text) : [];
}
```

Import `checkMarkup` and `type Fault` from `./critic`. In `criticDecorations`, after the loop over `criticField`, add:

```ts
  // A marker that never found its partner is the silent failure this whole
  // check exists for: it does not match, so the braces sit in the prose looking
  // like ordinary text. Painting them is what stops them looking ordinary.
  for (const fault of state.field(faultField)) {
    if (fault.entryFrom !== null) continue;
    ranges.push({
      from: fault.at.from,
      to: fault.at.to,
      value: Decoration.mark({
        class: 'ms-critic-fault',
        attributes: { 'aria-label': 'Broken markup: this marker has no partner.' },
      }),
    });
  }
```

Add `faultField` to the `criticEditorExtension` array, beside `criticField`, and to the `EditorView.decorations.compute` dependency list:

```ts
    EditorView.decorations.compute(
      [criticField, faultField, unfoldField, 'selection'],
      criticDecorations
    ),
```

- [ ] **Step 4: Add the drawer row**

In `src/review-view.ts`, extend the union and `rowFrom`:

```ts
type Row =
  | { type: 'mark'; card: Card; depth: number }
  | { type: 'editorial'; block: EditorialBlock }
  | { type: 'problem'; fault: Fault };
```

```ts
function rowFrom(row: Row): number {
  if (row.type === 'mark') return row.card.entry.from;
  if (row.type === 'editorial') return row.block.from;
  return row.fault.at.from;
}
```

Add a field `private faults: Fault[] = [];` beside `blocks`, set it in `load()` next to the other two (`this.faults = checkMarkup(content);`) and clear it in both places that clear `this.cards`.

Add `checkMarkup`, `type Fault` and `type FaultKind` to the `./critic` import list.

Add the wording — this is user-facing copy, so it lives here and not in `src/critic.ts`:

```ts
/**
 * What a fault says on its card.
 *
 * Here rather than in critic.ts, which carries no user-facing copy: the parser
 * reports what is wrong, and the drawer is what says it in a sentence.
 */
const FAULT_TEXT: Record<FaultKind, string> = {
  'unmatched-opener': 'An opening marker with no closing marker.',
  'unmatched-closer': 'A closing marker with no opening marker.',
  'no-arrow': 'No ~> in this mark, so it reads as a cut rather than a replacement.',
  'empty-body': 'This mark has nothing in it.',
};
```

Include the standalone faults in `rows()`:

```ts
      ...this.faults
        .filter((fault) => fault.entryFrom === null)
        .map((fault) => ({ type: 'problem' as const, fault })),
```

Build the card. No Accept, no Reject, no Resolve, no note field — the shape an editorial row already has, and for the same reason: there is nothing to settle, only something to fix:

```ts
  /**
   * A broken marker's card.
   *
   * No actions, for the reason an editorial card has none: nothing here can be
   * settled, because the markup does not say anything yet. Clicking it puts the
   * marker under the reader's eye in the manuscript, which is where it is
   * repaired — `Show markup source at cursor` is the tool for that.
   *
   * Because it never writes, `stillThere` and the `editing` record need nothing
   * from it.
   */
  private buildProblemCard(fault: Fault): HTMLElement {
    const el = createDiv({ cls: 'ms-review-card' });
    el.dataset.kind = 'problem';
    el.dataset.offset = String(fault.at.from);
    el.tabIndex = 0;

    el.createDiv({ cls: 'ms-review-problem' }).setText(FAULT_TEXT[fault.kind]);
    el.createDiv({ cls: 'ms-review-quote' }).setText(
      this.rawText.slice(fault.at.from, Math.min(fault.at.from + 40, this.rawText.length))
    );

    const go = () => this.revealRange(fault.at.from, fault.at.to);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });

    return el;
  }
```

This needs two small supports.

First, `this.rawText` — the sheet's text as last read. Add `private rawText = '';` beside `blocks`, set it in `load()` (`this.rawText = content;`) and reset it to `''` in both places that clear `this.cards`.

Second, `revealRange`. `buildEditorialCard`'s click handler already scrolls the editor to a plain range and flashes it; lift that into a method so both cards call one implementation rather than two copies:

```ts
  /**
   * Scrolls the editor to a range and washes it, for a row that is not a mark.
   *
   * An editorial comment and a broken marker both need this and neither has
   * `spans` to derive a band from — `flashEntry` cannot serve them, which is
   * why `flashRange` exists.
   */
  private revealRange(from: number, to: number): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view?.editor as unknown as { cm?: CmEditorView } | undefined)?.cm;
    if (!cm) return;
    cm.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    flashRange(cm, from, to);
  }
```

Match this against what `buildEditorialCard` does today and keep whatever it already gets right — the point is one implementation, not a new one.

Wire the row into `paint()`:

```ts
        row.type === 'mark'
          ? this.buildCard(row.card, row.depth)
          : row.type === 'editorial'
            ? this.buildEditorialCard(row.block)
            : this.buildProblemCard(row.fault)
```

And in `paint()`'s empty-state guard, add the faults so a note whose only content is a broken marker does not read as "nothing to review":

```ts
    if (this.cards.length === 0 && this.blocks.length === 0 && this.faults.length === 0) {
```

- [ ] **Step 5: Put a fault on the card it belongs to**

In `buildCard`, after the `quote` div and before the note field, add:

```ts
    // A fault that belongs to this construct is drawn on this construct's card:
    // the card that renders wrong is the one that should carry the warning.
    const fault = this.faults.find((f) => f.entryFrom === entry.from);
    if (fault) {
      el.createDiv({ cls: 'ms-review-problem' }).setText(FAULT_TEXT[fault.kind]);
    }
```

- [ ] **Step 6: Style them**

```css
/* A marker with no partner. Painted because the failure is silent otherwise:
   an unmatched marker does not parse, so the braces sit in the prose looking
   exactly like text the writer typed on purpose. */
.ms-critic-fault {
  color: var(--text-error);
  background: var(--background-modifier-error);
  border-radius: 3px;
}

/* What is wrong, in a sentence, on a card. Reads before the quote below it. */
.ms-review-problem {
  font-family: var(--font-text);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-error);
  margin-bottom: var(--size-2-2);
}

.ms-review-card[data-kind="problem"]::before {
  background: var(--text-error);
}
```

- [ ] **Step 7: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Check it by hand**

Build, reload, and type `Sie {-- ging fort.` into a scratch note. The `{--` must be painted, and the drawer must show one card reading *An opening marker with no closing marker.* with no buttons on it. Then write `{~~Dann~~}`: one card, struck through, carrying the no-arrow sentence and still offering Accept and Reject.

- [ ] **Step 9: Commit**

```bash
git add src/critic-render.ts src/review-view.ts styles.css src/critic-live.test.ts
git commit -m "feat: report a broken marker in the drawer and in the prose"
```

---

### Task 12: Reading view hides a marker it cannot pair

Ten lines, and they are what keeps a reader from seeing braces between this phase and the next.

**Files:**
- Modify: `src/critic-render.ts` — `renderCriticMarkup`
- Test: `src/critic-render.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces: no signature change yet. `renderCriticMarkup(root: HTMLElement)` keeps its shape; Task 14 adds the second parameter.

- [ ] **Step 1: Write the failing test**

```ts
describe('renderCriticMarkup — a mark that spans two blocks', () => {
  it('hides an unmatched marker rather than showing braces', () => {
    const root = render('<p>Sie ging{-- fort.</p><p>Der Regen--} blieb.</p>');
    expect(root.textContent).toBe('Sie ging fort.Der Regen blieb.');
  });

  it('leaves an unmatched marker inside code alone', () => {
    const root = render('<p>So schreibt man <code>{--</code> hin.</p>');
    expect(root.textContent).toBe('So schreibt man {-- hin.');
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-render.test.ts -t 'spans two blocks'`
Expected: the first case receives `'Sie ging{-- fort.Der Regen--} blieb.'`.

- [ ] **Step 3: Hide what cannot be paired**

In `renderCriticMarkup`, after the `for (const entry of parseCritic(text))` loop and before `if (ops.length > 0)`, add:

```ts
    // A marker this block cannot pair belongs to a mark that opened in an
    // earlier block or closes in a later one. Obsidian hands a post-processor
    // one block at a time, so the partner is not here to be found — and a brace
    // shown to a reader is worse than a passage left unstyled. Task 14 gives
    // this the note's source and styles the passage too; until then, hiding is
    // the whole of it.
    for (const fault of checkMarkup(text)) {
      if (fault.entryFrom !== null) continue;
      ops.push({ ...fault.at, op: 'hide' });
    }
```

`checkMarkup` skips code and frontmatter itself, which is what makes the second test pass without a second guard here.

- [ ] **Step 4: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/critic-render.ts src/critic-render.test.ts
git commit -m "feat: hide a marker Reading view cannot pair"
```

---

# Phase 3 — Reading view

The design's only real risk. `applyOps` is rebuilt first, under test, before anything asks it to nest.

---

### Task 13: `applyOps` can nest one wrapper inside another

**Files:**
- Modify: `src/critic-render.ts` — `applyOps`
- Test: `src/critic-render.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: no signature change. `applyOps(spans: NodeSpan[], ops: Op[])` gains the ability to apply a `wrap` whose range lies inside another `wrap`'s.

- [ ] **Step 1: Write the failing test**

```ts
describe('renderCriticMarkup — a mark inside a mark', () => {
  it('nests the inner styling inside the outer', () => {
    const root = render('<p>{--Sie zählte {~~Dann~>Schließlich~~} Ende.--}</p>');
    expect(root.textContent).toBe('Sie zählte Dann→Schließlich Ende.');

    const outer = root.querySelector('.ms-critic-deletion');
    expect(outer).not.toBeNull();
    // The whole cut, and the substitution's own halves inside it.
    expect(outer?.textContent).toContain('Sie zählte');
    expect(root.querySelectorAll('.ms-critic-insertion')).toHaveLength(1);
    expect(root.querySelector('.ms-critic-insertion')?.textContent).toBe('Schließlich');
  });

  it('keeps every character of a nested highlight', () => {
    const root = render('<p>{++neu {==wichtig==} da++}</p>');
    expect(root.textContent).toBe('neu wichtig da');
    expect(root.querySelector('.ms-critic-highlight')?.textContent).toBe('wichtig');
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-render.test.ts -t 'a mark inside a mark'`
Expected: characters missing from `textContent`.

The mechanism, because the fix only makes sense once it is clear: `applyOps` sorts operations by start offset descending, so the inner wrap runs first. `isolate` reaches the middle of a text node by calling `splitText` twice, and `splitText` **truncates the node it is called on** and returns a new one. `spans` still holds the original node, which is now shorter than it was. The outer wrap then calls `slices(spans, …)`, which measures each span as `span.start + span.node.data.length` — and those lengths no longer add up to the block's text. The outer wrap claims the wrong characters, or none.

- [ ] **Step 3: Rebuild `applyOps`**

So `spans` cannot be computed once and reused across operations that split nodes. It has to be re-derived from the DOM before each one. Replace `applyOps` with:

```ts
/**
 * Applies every operation to the block, outermost wrap first.
 *
 * The order is the opposite of what it used to be, and the reason is nesting.
 * This function splits text nodes and replaces them with elements, so a
 * reference to a text node is only valid until something replaces it. Running
 * the inner wrap first therefore left the outer one holding a node that was no
 * longer in the document, and the outer wrap wrote into nothing — a paragraph
 * rendered with pieces missing.
 *
 * Widest first, and the node list re-derived from the DOM before each
 * operation, so an inner wrap finds the nodes its enclosing wrap created. The
 * offsets stay valid throughout because nothing here changes the block's text,
 * only how it is wrapped — except `hide` and `text`, which do, and which are
 * therefore run last, narrowest first, after every wrap is in place.
 */
function applyOps(block: HTMLElement, root: HTMLElement, ops: Op[]): void {
  const wraps = ops.filter((op) => op.op === 'wrap');
  const rest = ops.filter((op) => op.op !== 'wrap');

  // Widest first: an enclosing wrap has to exist before the wrap inside it
  // looks for the nodes to claim.
  for (const op of [...wraps].sort((a, b) => b.to - b.from - (a.to - a.from))) {
    applyOne(nodeSpansOf(block, root), op);
  }

  // Removals and replacements last, right to left, so each one leaves the
  // offsets to its left untouched.
  for (const op of [...rest].sort((a, b) => b.from - a.from)) {
    applyOne(nodeSpansOf(block, root), op);
  }
}

/**
 * The block's own text nodes with their offsets, as the DOM stands right now.
 *
 * Both arguments are load-bearing. `block` bounds the walk, and `blockOf`
 * filters what the walk finds — without the filter, a section holding loose
 * text alongside a paragraph would have `block === root`, and the walk would
 * collect the paragraph's nodes into the offsets belonging to the loose text.
 * That is the same rule `textNodesByBlock` groups by, applied a second time
 * because the nodes have moved since it ran.
 */
function nodeSpansOf(block: HTMLElement, root: HTMLElement): NodeSpan[] {
  const spans: NodeSpan[] = [];
  let offset = 0;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('code, pre')) return NodeFilter.FILTER_REJECT;
      if (blockOf(node, root) !== block) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const text = n as Text;
    spans.push({ node: text, start: offset });
    offset += text.data.length;
  }
  return spans;
}

/** One operation, over the node slices it covers. */
function applyOne(spans: NodeSpan[], op: Op): void {
  const parts = slices(spans, op.from, op.to);

  if (op.op === 'wrap') {
    // A wrapper per slice rather than one across all of them: the slices can
    // sit under different parents — `{++**fett** und kursiv++}` arrives that
    // way — and one element cannot span two parents.
    for (let i = parts.length - 1; i >= 0; i--) {
      const slice = parts[i];
      if (slice.end <= slice.start) continue;
      const piece = isolate(slice.node, slice.start, slice.end);
      const wrapper = document.createElement('span');
      wrapper.className = op.cls;
      wrapper.setAttribute('aria-label', op.label);
      piece.replaceWith(wrapper);
      wrapper.appendChild(piece);
    }
    return;
  }

  for (let i = parts.length - 1; i >= 0; i--) {
    const slice = parts[i];
    if (slice.end <= slice.start) continue;
    const piece = isolate(slice.node, slice.start, slice.end);

    if (op.op === 'hide') {
      piece.remove();
      continue;
    }

    // A marker split across text nodes would otherwise get one element per
    // node. Only the first slice becomes it; the rest simply go.
    if (i > 0) {
      piece.remove();
      continue;
    }
    const el = document.createElement('span');
    el.className = op.cls;
    el.textContent = op.text;
    piece.replaceWith(el);
  }
}
```

The one caller changes: `renderCriticMarkup` currently loops `for (const [, nodes] of textNodesByBlock(root))` and calls `applyOps(spans, ops)`. Change the loop header to `for (const [block, nodes] of textNodesByBlock(root))` and the call to `applyOps(block, root, ops)`. The local `spans` array stays, because building the ops still needs the offsets `text` was concatenated from — it is only the *applying* that can no longer trust it.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, including every pre-existing case in `src/critic-render.test.ts`. Those cases are the regression net for this rewrite; if any of them fails, the new ordering is wrong rather than the old cases being stale.

- [ ] **Step 5: Commit**

```bash
git add src/critic-render.ts src/critic-render.test.ts
git commit -m "refactor: let Reading view nest one wrapper inside another"
```

---

### Task 14: Reading view styles a mark that spans blocks

**Files:**
- Modify: `src/critic-render.ts` — `SectionSource`, `Straddle`, `straddles()`, `renderCriticMarkup`
- Modify: `src/main.ts:1524` — pass `ctx.getSectionInfo(el)`
- Test: `src/critic-render.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 12 and 13.
- Produces:

```ts
export interface SectionSource { text: string; lineStart: number; lineEnd: number }
export function renderCriticMarkup(root: HTMLElement, source?: SectionSource): void;
```

- [ ] **Step 1: Write the failing test**

```ts
describe('renderCriticMarkup — a mark across blocks, with the source', () => {
  const SOURCE = 'Sie ging{-- fort.\n\nDer Regen--} blieb.';

  /** Renders one block with the section info Obsidian would supply. */
  function renderBlock(html: string, lineStart: number, lineEnd: number): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = html;
    renderCriticMarkup(root, { text: SOURCE, lineStart, lineEnd });
    return root;
  }

  it('strikes the tail of the block the mark opens in', () => {
    const root = renderBlock('<p>Sie ging{-- fort.</p>', 0, 0);
    expect(root.textContent).toBe('Sie ging fort.');
    expect(root.querySelector('.ms-critic-deletion')?.textContent).toBe(' fort.');
  });

  it('strikes the head of the block the mark closes in', () => {
    const root = renderBlock('<p>Der Regen--} blieb.</p>', 2, 2);
    expect(root.textContent).toBe('Der Regen blieb.');
    expect(root.querySelector('.ms-critic-deletion')?.textContent).toBe('Der Regen');
  });

  it('strikes a whole block that lies inside the mark', () => {
    const source = 'a{--\n\nmitten\n\nb--}';
    const root = document.createElement('div');
    root.innerHTML = '<p>mitten</p>';
    renderCriticMarkup(root, { text: source, lineStart: 2, lineEnd: 2 });
    expect(root.querySelector('.ms-critic-deletion')?.textContent).toBe('mitten');
  });

  it('falls back to hiding the marker when no source is supplied', () => {
    const root = renderBlock('<p>Sie ging{-- fort.</p>', 0, 0);
    const bare = document.createElement('div');
    bare.innerHTML = '<p>Sie ging{-- fort.</p>';
    renderCriticMarkup(bare);
    expect(bare.textContent).toBe('Sie ging fort.');
    expect(bare.querySelector('.ms-critic-deletion')).toBeNull();
    expect(root.querySelector('.ms-critic-deletion')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx jest src/critic-render.test.ts -t 'across blocks, with the source'`
Expected: the first three cases find no `.ms-critic-deletion`; the fourth passes already, from Task 12.

- [ ] **Step 3: Write `straddles`**

Add to `src/critic-render.ts`, in the Reading-view section:

```ts
/**
 * What Obsidian tells a post-processor about the block it just rendered.
 *
 * The note's whole source and this block's line range — `getSectionInfo`'s
 * return, restated here so the renderer stays free of any `obsidian` import and
 * stays testable without one.
 */
export interface SectionSource {
  text: string;
  lineStart: number;
  lineEnd: number;
}

/** A mark that reaches into, over, or out of one block. */
interface Straddle {
  kind: Kind;
  /** Where the opening marker starts in the block's rendered text, or null when it opened earlier. */
  opensAt: number | null;
  /** Where the closing marker starts, or null when it closes later. */
  closesAt: number | null;
}

/**
 * The marks reaching across this block's boundaries, and where their markers
 * sit in its rendered text.
 *
 * The one question a block cannot answer for itself. Guessing is not available:
 * a paragraph ending in an unmatched `{--` is either a mark continuing into the
 * next paragraph or a typo, and guessing "continuing" would strike through a
 * tail that Live Preview leaves as plain braces — the two display modes are not
 * allowed to disagree.
 *
 * Only the *kind* is taken from the source. The markers themselves are found in
 * the block's own rendered text, because a marker survives rendering as literal
 * text, so source offsets never have to be mapped onto the DOM. Mapping them
 * would be the expensive part, and this does not do it.
 */
function straddles(source: SectionSource, blockText: string): Straddle[] {
  const lineAt = lineStarts(source.text);
  const blockFrom = lineAt[source.lineStart] ?? 0;
  const blockTo =
    source.lineEnd + 1 < lineAt.length ? lineAt[source.lineEnd + 1] - 1 : source.text.length;

  const out: Straddle[] = [];
  for (const entry of parseCritic(source.text)) {
    const opensBefore = entry.from < blockFrom;
    const closesAfter = entry.to > blockTo;
    if (!opensBefore && !closesAfter) continue; // wholly inside — the block parse has it
    if (entry.to <= blockFrom || entry.from >= blockTo) continue; // not this block at all

    const opener = OPENER[entry.kind];
    out.push({
      kind: entry.kind,
      opensAt: opensBefore ? null : blockText.indexOf(opener),
      closesAt: closesAfter ? null : blockText.indexOf(CLOSER[entry.kind]),
    });
  }
  return out;
}

const OPENER: Record<Kind, string> = {
  insertion: '{++',
  deletion: '{--',
  substitution: '{~~',
  highlight: '{==',
  comment: '{>>',
};

const CLOSER: Record<Kind, string> = {
  insertion: '++}',
  deletion: '--}',
  substitution: '~~}',
  highlight: '==}',
  comment: '<<}',
};

/** Offset of the start of every line, so a line number becomes an offset. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}
```

- [ ] **Step 4: Use it in `renderCriticMarkup`**

Give the function its second parameter and, for a single-block section, emit the straddle operations alongside the ones the block parse produced:

```ts
export function renderCriticMarkup(root: HTMLElement, source?: SectionSource): void {
  const groups = textNodesByBlock(root);
  // Straddle handling needs a line range that describes exactly one block.
  // A section holding several — a callout, a list — gets one range for all of
  // them, so it falls back to the per-block parse. Marks inside a callout are
  // single-paragraph in practice.
  const single = source !== undefined && groups.size === 1;

  for (const [block, nodes] of groups) {
    const spans: NodeSpan[] = [];
    let text = '';
    for (const node of nodes) {
      spans.push({ node, start: text.length });
      text += node.data;
    }

    if (!mightHaveMarkup(text)) continue;

    const ops: Op[] = [];
    for (const entry of parseCritic(text)) {
      // Byte for byte what this loop already contains: the marker hides, the
      // arrow, the quote wrap, the replacement wrap, the comment hide. Nothing
      // in it changes — only what runs after it.
    }

    if (single) {
      for (const straddle of straddles(source, text)) {
        const cls = QUOTE_CLASS[straddle.kind];
        const bodyFrom = straddle.opensAt === null ? 0 : straddle.opensAt + 3;
        const bodyTo = straddle.closesAt === null ? text.length : straddle.closesAt;
        if (straddle.opensAt !== null) {
          ops.push({ from: straddle.opensAt, to: straddle.opensAt + 3, op: 'hide' });
        }
        if (straddle.closesAt !== null) {
          ops.push({ from: straddle.closesAt, to: straddle.closesAt + 3, op: 'hide' });
        }
        // A comment renders as nothing at all, anchored or not — an editorial
        // note has no business interrupting a reader.
        if (straddle.kind === 'comment') {
          ops.push({ from: bodyFrom, to: bodyTo, op: 'hide' });
        } else if (cls && bodyTo > bodyFrom) {
          ops.push({
            from: bodyFrom,
            to: bodyTo,
            op: 'wrap',
            cls,
            label: `Suggested change: ${text.slice(bodyFrom, bodyTo)}`,
          });
        }
      }
    }

    // Whatever is still unpaired after all of that belongs to a mark whose
    // partner is in another block and whose source was not available. Hiding it
    // is better than showing a brace.
    for (const fault of checkMarkup(text)) {
      if (fault.entryFrom !== null) continue;
      if (ops.some((op) => op.from <= fault.at.from && op.to >= fault.at.to)) continue;
      ops.push({ ...fault.at, op: 'hide' });
    }

    if (ops.length > 0) applyOps(block, root, ops);

    // A block-form marker sits alone on its line, so Obsidian renders it as a
    // paragraph of its own — and hiding the marker leaves that paragraph empty,
    // which the reader sees as a blank line where the syntax used to be. An
    // element whose text is entirely gone had nothing in it but markup.
    if (block !== root && block.textContent === '') block.remove();
  }
}
```

- [ ] **Step 5: Pass the section info from `main.ts`**

Replace the registration:

```ts
    // getSectionInfo is the only way a post-processor can learn what the note
    // says outside the block it was handed, which is what a mark spanning two
    // paragraphs needs. It returns null in several contexts — an embedded note,
    // a PDF export — and the renderer is written for that.
    this.registerMarkdownPostProcessor((el, ctx) =>
      renderCriticMarkup(el, ctx.getSectionInfo(el) ?? undefined)
    );
```

- [ ] **Step 6: Run the suite**

Run: `npm test && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Check it by hand**

Build, reload, and in Reading view open a note containing both forms:

```markdown
Sie stand am Fenster.

{--
Der Regen hatte aufgehört.

Irgendwo schlug eine Tür.
--}

Sie ging{-- fort.

Der Regen--} blieb.
```

Every brace must be gone, all four paragraphs of prose must be struck through, and no paragraph may be missing a word.

- [ ] **Step 8: Commit**

```bash
git add src/critic-render.ts src/main.ts src/critic-render.test.ts
git commit -m "feat: style a mark that spans blocks in Reading view"
```

---

# Phase 4 — The hotkeys and the README

---

### Task 15: Two hotkeys, and the commands write the block form

**Files:**
- Modify: `src/main.ts` — `BLOCK_WRAPPERS`, `wrapSelection`, `addSelectionCommand` call for `suggest-deletion`, the `suggest-change` command
- Test: verified by hand; the form decision itself is covered by Task 6

**Interfaces:**
- Consumes: Task 6 (`wrapForm`, `suggestChange(selection, form)`).
- Produces: nothing other files call.

- [ ] **Step 1: Add the block wrappers**

In `src/main.ts`, below `WRAPPERS`:

```ts
/**
 * The same four constructs with their markers on their own lines.
 *
 * Chosen by `wrapForm` rather than by a setting: markers inside two sentences
 * say "join these paragraphs", markers on their own lines say "these whole
 * paragraphs". One key, and the shape of the selection decides which it means.
 *
 * A comment keeps its inline form. A note is one remark about a passage, and
 * where its own markers sit changes nothing about it.
 */
const BLOCK_WRAPPERS: Record<MarkupKind, [string, string]> = {
  highlight: ["{==\n", "\n==}"],
  deletion: ["{--\n", "\n--}"],
  insertion: ["{++\n", "\n++}"],
  comment: ["{==", "==}{>><<}"],
};
```

- [ ] **Step 2: Choose the wrapper in `wrapSelection`**

```ts
    const start = editor.posToOffset(editor.getCursor("from"));
    const end = editor.posToOffset(editor.getCursor("to"));
    const form = wrapForm(editor.getValue(), start, end);
    const [open, close] = (form === "block" ? BLOCK_WRAPPERS : WRAPPERS)[kind];
    editor.replaceSelection(`${open}${selection}${close}`);
```

Add `wrapForm` to the `./critic` import list.

- [ ] **Step 3: Bind the two keys**

Give `suggest-deletion` its hotkey:

```ts
    this.addSelectionCommand("suggest-deletion", "Suggest deletion", "deletion", [
      { modifiers: ["Mod", "Shift"], key: "-" },
    ]);
```

and `suggest-change` its own, in the `addCommand` call:

```ts
    this.addCommand({
      id: "suggest-change",
      name: "Suggest a change",
      // Obsidian binds Cmd+- to Zoom out and Cmd+= to Zoom in, so the bare keys
      // are not available. Minus for a cut, plus for an addition or a
      // replacement, beside the ⌘⇧M this plugin already claims.
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "+" }],
```

- [ ] **Step 4: Let `suggest-change` write the block form**

In the same command, replace the first line of the callback:

```ts
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const change = suggestChange(
          editor.getSelection(),
          wrapForm(editor.getValue(), from, to)
        );
```

and delete the two `posToOffset` lines further down that this replaces, so the offsets are computed once.

- [ ] **Step 5: Build and check by hand**

Run `npm run build`, reload Obsidian, then in a scratch note:

1. Select two whole paragraphs, press `⌘⇧-`. The file must gain `{--\n…\n--}` on their own lines, the drawer must show one card, and the note must still read as two paragraphs struck through.
2. Select from the middle of one sentence across a blank line into the next, press `⌘⇧-`. The markers must be inline, and a struck-through `¶` must appear at the break.
3. Select two whole paragraphs, press `⌘⇧+`. The caret must land in the empty replacement with the placeholder to its right, not to its left — that is the tell that it is inside the construct rather than after it.
4. Press `⌘⇧+` with nothing selected. `{++++}` with the caret in the middle, as before.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat: bind a suggested cut and a suggested change to plus and minus"
```

---

### Task 16: The README says what is true

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the two commands table rows and add the hotkeys**

In the table under *Mark up a draft*, give the two commands their keys:

```markdown
| Command | Needs a selection |
|---|---|
| Comment on selection — `⌘⇧M` | yes |
| Highlight selection | yes |
| Suggest deletion — `⌘⇧-` | yes |
| Suggest a change — `⌘⇧+` | no — with a selection it replaces, without one it inserts |
| Insert editorial comment | no |
```

- [ ] **Step 2: Say that a mark may span paragraphs**

After the two mark tables and the paragraph about `{>>comment<<}` attachment, add:

```markdown
A mark may cover several paragraphs. Where you put its markers says what it
means: inside two sentences it proposes joining them into one paragraph, and on
lines of their own it takes the paragraphs whole.

```markdown
{--
Der Regen hatte aufgehört.

Irgendwo schlug eine Tür.
--}
```

Selecting whole paragraphs writes that form for you; selecting from mid-sentence
to mid-sentence writes the inline one. A paragraph break inside a mark shows as
`¶`, because a struck-through blank line would otherwise be invisible.

Marks may also sit inside one another, which is what happens when you cut a
passage that already carries a suggestion. The drawer indents the inner card
under the outer one; accepting the outer mark settles both.
```

- [ ] **Step 3: Say what the drawer does about broken markup**

In the *Work through the pass* list, after the **Resolve** bullet:

```markdown
- A **broken marker** — one with no partner, or a `{~~…~~}` with no `~>` — gets
  a card with nothing to settle, saying what is wrong. In the prose the marker
  itself is coloured, because braces that do not parse otherwise look exactly
  like text you typed on purpose.
```

- [ ] **Step 4: Rewrite the limitations**

Replace the first two bullets of *Known limitations*:

```markdown
- The same kind of mark cannot nest inside itself: in `{--a {--b--} c--}` the
  first closing marker has no way to say which opener it belongs to. The drawer
  reports the leftover.
- CriticMarkup has no escape syntax, so a selection containing `~>` or `~~}`
  cannot become a substitution, and a note cannot contain `<<}`.
- A mistyped opening marker claims the closing marker of the next mark of its
  kind, so it can strike through several paragraphs at once. `⌘Z` undoes it and
  the drawer names it.
```

Delete the bullet reading *"Whitespace left behind by a resolved mark is yours to tidy"* — a mark that sat between two blank lines now closes the gap behind it.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: say that a mark may span paragraphs and nest"
```
