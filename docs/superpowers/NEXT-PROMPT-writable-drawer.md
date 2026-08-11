# Prompt: make the Review drawer writable

Paste everything below the line into a fresh Claude Code session started in
`/Users/abrell/Developer/sheet-navigator`.

---

We just shipped CriticMarkup **edit-through** on the branch `criticmarkup-edit-through`. That work is complete and committed (235 tests green, build and typecheck clean), but it left one command knowingly broken and one design decision unfinished. I want you to close both properly, not patch them.

**Start by reading these two documents.** They carry the reasoning, and I don't want it re-derived from scratch:

- `docs/superpowers/specs/2026-08-11-criticmarkup-edit-through-design.md`
- `docs/superpowers/plans/2026-08-11-criticmarkup-edit-through.md`

Then read `src/critic-render.ts`, `src/review-view.ts`, and the `loadReview()` section of `src/main.ts`.

## The two rules that govern this plugin's editorial layer

These came out of the last design conversation and are settled. Everything below follows from them:

1. **You never see CriticMarkup syntax.** Marked-up prose is prose you edit in place. Braces appear only via the `Show markup source at cursor` command, which exists for repairing malformed constructs and folds itself back when the caret leaves.
2. **The comment lives in the drawer.** The editor pane shows the manuscript; the Review drawer is the entire editorial layer. There is no comment glyph in either display mode — a construct carrying a note is drawn with a dotted underline (`sn-critic-has-comment`) and the note itself is on its card.

## What is broken, and why

`⌘⇧M` (*Comment on selection*) no longer works. `wrapSelection` at `src/main.ts:1467` writes `{==Text==}{>><<}` and parks the caret just past the `{>>` so the note can be typed into the sentence (`src/main.ts:1473`). Verified by probing the real decorations:

```
doc:     "Sie {==ging==}{>><<} fort."
caret:   17
hidden:  [4,7)='{=='   [11,14)='==}'   [14,20)='{>><<}'
caret strictly inside a hidden range?  true
```

Offset 17 sits inside a range that is now both **invisible** and **atomic**. You would be typing into text that never renders, and the first arrow keypress would eject the caret out of it. It worked before only because the old reveal rule unfolded any construct the cursor entered — the exact behaviour edit-through removed.

The other four authoring commands are unaffected; they either don't move the caret or leave it at a marker's edge rather than inside one.

**The deeper error:** rule 2 was adopted without following it through. Comments can now be *read* in the drawer but not *written* or *edited* there, so the lifecycle has no coherent home. The previous spec listed "editable comments" under **Out of scope** because I'd declined it earlier in the conversation — but that answer predated the decision to remove the glyph, and I let it stand anyway. Two patches were proposed at the time (unfold-while-typing; a modal prompt). Both work around the gap rather than closing it. Don't reach for either.

## What I want built

The drawer becomes the surface where a comment is **read, written, edited and decided**.

- `⌘⇧M` on a selection wraps it in `{==…==}{>><<}`, opens the drawer, focuses the new card's note field, and you type there.
- Clicking a card's note makes it editable; the edit writes back into `{>>…<<}`.
- No syntax appears anywhere. No modal.

This should *delete* code, not add layers. `wrapSelection`'s comment special case and its caret arithmetic go entirely, and `activateReviewView(focus = false)` at `src/main.ts:1553` exists specifically so the caret stays in the manuscript to type a comment — that reason inverts for comments and the parameter's use needs revisiting.

## Three complications — name these in the design, don't discover them

**An empty comment renders as nothing.** `src/review-view.ts:261` does `if (entry.comment)`, and `{>><<}` parses to `comment: ''`, which is falsy. The card you need to type into isn't drawn. The empty case has to become a first-class state.

**A repaint mid-typing destroys the field.** `requestRefresh` (`src/review-view.ts:137`) fires on `editor-change` and rebuilds every card from scratch after `REFRESH_DELAY` = 200ms (`src/review-view.ts:33`). This bug already bit once — `focusedOffset` (`src/review-view.ts:78`) exists so a repaint can restore the focus a click applied. An open, half-typed textarea is the same bug with a worse failure: keystrokes vanish. **This is the real work in the feature.** Either extend the `focusedOffset` treatment to editing state, or suppress repaints while a field is open.

**The note can break its own container.** CriticMarkup has no escape syntax. Typing `<<}` closes the construct early; two newlines trip the `BLANK_LINE` guard at `src/critic.ts:220` and the construct stops parsing entirely. The write-back must constrain what it accepts — decide this deliberately.

The write path itself is already safe and should be reused rather than reinvented: `act()` (`src/review-view.ts:346`) guards with a byte-identical raw check plus a fresh parse agreeing before it touches anything (`src/review-view.ts:361`), and `write()` (`src/review-view.ts:437`) narrows to a `minimalEdit` so the caret and scroll don't jump.

## One behaviour change to confirm with me

This makes the drawer **required** for commenting. Today you can leave a note with the sidebar closed; afterwards `⌘⇧M` always opens it. I think that's correct under rule 2, but it's a real change to my most-used hotkey — raise it explicitly rather than letting me find it.

Also update the drawer's empty-state text, which currently reads *"Nothing to review. Select text and press ⌘⇧M to leave a note."*

## Constraints

- **No new dependencies.**
- **`src/critic.ts` stays unmodified** unless there is a compelling reason — the parser already reports what's needed. If you think you need a change there, say why first.
- **Tests are pure functions over state where possible**, driven through `EditorState` without an `EditorView` — see `src/critic-live.test.ts` for the established pattern. Run with `npm test`; build with `npm run build`; typecheck with `npx tsc --noEmit`.
- **Match the house voice in comments and commit messages.** This codebase explains *why* a thing is the way it is, in prose, and it is unusually good at it. Read a few comments in `src/critic-render.ts` before writing any. End commit messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Work on a branch off `criticmarkup-edit-through`, not `main`.

## Process

Brainstorm it with me first, then write a spec, then a plan, then execute. Don't skip to implementation — the last cycle went well because the design was argued out before any code was written, and the one defect that got through was caught by review, not by tests.

## Still unverified from the previous cycle

None of this has run in Obsidian yet. Don't assume it works, and don't treat these as done:

1. **The `~~` collision.** With the caret inside a substitution's replacement half, do Obsidian's own `~~` strikethrough markers stay hidden behind our replace decorations? Reasoning says yes — hiding is additive and Obsidian "reveals" by omitting its own hide-decoration, which can't undo ours — but it is the spec's one load-bearing promise and remains a prediction.
2. **The standalone-comment line collapse.** Block decorations are *permitted* from `decorations.compute` (confirmed: `dynamicDecorationMap[i] = typeof d == "function"`), but the range shape `[line.from - 1, line.to]` is validated at draw time and hasn't been. The plan carries a documented fallback.
3. **Backspace boundaries**, all four, plus confirming Obsidian's list-outdent still works elsewhere in a note.
4. **Arrow traversal** across a substitution.
5. **A commented substitution** now stacks four treatments — dotted underline, strikethrough, bottom border, and a `→` pseudo-element. It may read as mud; the plan gives two fallbacks.
6. **The repair command** — toggle on, toggle off, auto-fold on clicking away.
