// The Review drawer: every editorial mark in the active sheet, in document
// order, with the one or two decisions each one admits.
//
// Comments are per sheet only, so there is no vault-wide index — the drawer
// reads the file you are looking at and nothing else.

import {
  App,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Scope,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from 'obsidian';
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
import { parseEditorial, type EditorialBlock } from './editorial';
import type { EditorView as CmEditorView } from '@codemirror/view';
import { flashEntry, flashRange } from './critic-render';

/**
 * One line of the drawer.
 *
 * `type` rather than `kind`: `kind` already means a CriticMarkup construct
 * everywhere else in this codebase, and a row is a different axis. A mark and
 * an editorial comment share the list and nothing else — one is an edit to
 * settle, the other is prose about the passage.
 */
type Row =
  | { type: 'mark'; card: Card }
  | { type: 'editorial'; block: EditorialBlock };

/** Where a row begins in the sheet, which is also what its card is stamped with. */
function rowFrom(row: Row): number {
  return row.type === 'mark' ? row.card.entry.from : row.block.from;
}

export const VIEW_TYPE_REVIEW = 'manuscript-review';

/** Long enough for a card's collapse animation to finish before the repaint. */
const REFRESH_DELAY = 200;

const COMMENT_HOTKEY = Platform.isMacOS ? '⌘⇧M' : 'Ctrl+Shift+M';

/**
 * The note as the user currently sees it: the editor's text when it is open,
 * so unsaved keystrokes count, and the cached file otherwise.
 *
 * Shared with the navigator's toolbar badge — reading the two counts from
 * different sources is how they end up disagreeing on screen.
 */
export async function readLiveContent(app: App, file: TFile): Promise<string> {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) {
      return view.editor.getValue();
    }
  }
  return app.vault.cachedRead(file);
}

/**
 * An entry plus the exact source it was parsed from.
 *
 * Offsets are only meaningful against the string that produced them, so the
 * raw slice travels with the card and is re-checked immediately before any
 * write. Without it, resolving the third card after typing above it would
 * delete a span that has since moved.
 */
interface Card {
  entry: Entry;
  raw: string;
}

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

export class ReviewView extends ItemView {
  private headerEl!: HTMLElement;
  private listEl!: HTMLElement;
  private cards: Card[] = [];
  /**
   * Editorial comments, kept beside the marks rather than among them.
   *
   * Two lists because there are two parsers: parseCritic stays pure
   * CriticMarkup and never learns about callouts, which is also why an
   * editorial comment cannot reach the toolbar count.
   */
  private blocks: EditorialBlock[] = [];
  private file: TFile | null = null;
  private refreshTimer: number | null = null;
  /**
   * Where the last focused entry sits, so a repaint can re-mark its card.
   * Every refresh rebuilds the list from scratch — without this, the focus a
   * click just applied would vanish on the next repaint, however triggered.
   */
  private focusedOffset: number | null = null;
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
  /** Pushed while a note field is open, so ⌘↵ reaches it. See claimSubmitKey. */
  private submitScope: Scope | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  /**
   * The one way to open and close a note field.
   *
   * Every assignment goes through here so the scope below cannot be left
   * pushed: a field is open exactly when `editing` is set, and the claim on ⌘↵
   * lasts exactly that long. Balancing it on the textarea's blur instead looks
   * equivalent and is not — removing a focused element from the document fires
   * no blur, and committing a note does precisely that, by way of the repaint.
   */
  private setEditing(next: { offset: number; draft: string } | null): void {
    this.editing = next;
    if (next === null) this.releaseSubmitKey();
    else this.claimSubmitKey();
  }

  /**
   * Claims ⌘↵ for the open note field, above Obsidian's own hotkeys.
   *
   * The field's keydown listener ought to be enough and is not: Obsidian
   * dispatches its hotkey table even while a textarea has focus, so a *modified*
   * key can be spoken for before the field ever sees it. That is the difference
   * between Escape, which has always closed the field, and ⌘↵, which never
   * committed anything — same listener, same branchpoint, one of them
   * intercepted upstream. A pushed scope outranks the table.
   *
   * Chained to `app.scope` rather than standing alone, so every other hotkey —
   * ⌘S, ⌘Z, the palette — still resolves while a note is being written.
   */
  private claimSubmitKey(): void {
    if (this.submitScope !== null) return;

    const scope = new Scope(this.app.scope);
    scope.register(['Mod'], 'Enter', () => {
      // Resolved now rather than captured when the scope was pushed: every
      // repaint builds new card objects, and this scope outlives them.
      const open = this.editing;
      if (open === null) return false;
      const card = this.cards.find((c) => c.entry.from === open.offset);
      if (card) this.closeNote(card, true);
      return false;
    });

    this.app.keymap.pushScope(scope);
    this.submitScope = scope;
  }

  private releaseSubmitKey(): void {
    if (this.submitScope === null) return;
    this.app.keymap.popScope(this.submitScope);
    this.submitScope = null;
  }

  getViewType(): string {
    return VIEW_TYPE_REVIEW;
  }

  getDisplayText(): string {
    return 'Review';
  }

  getIcon(): string {
    return 'message-square-quote';
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass('ms-review');

    this.headerEl = this.containerEl.createDiv({ cls: 'ms-review-header' });
    this.listEl = this.containerEl.createDiv({ cls: 'ms-review-list' });

    this.registerEvent(this.app.workspace.on('file-open', () => this.requestRefresh()));
    // Only a genuine file switch is worth a repaint here. Clicking from
    // another pane into the editor also lands in this event, with the same
    // file still active — and the repaint it scheduled would destroy the very
    // card focusAt() had just focused for that click, 200ms later. Content
    // changes arrive through editor-change and modify, never through this.
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (this.app.workspace.getActiveFile()?.path !== this.file?.path) this.requestRefresh();
      })
    );
    // Typing in the note, and Claude writing to it from outside, both land here.
    this.registerEvent(this.app.workspace.on('editor-change', () => this.requestRefresh()));
    this.registerEvent(
      this.app.vault.on('modify', (f) => {
        if (f.path === this.file?.path) this.requestRefresh();
      })
    );

    this.refresh();
  }

  async onClose(): Promise<void> {
    this.cancelRefresh();
    // A drawer closed with a field open would otherwise leave ⌘↵ claimed by a
    // view that no longer exists.
    this.releaseSubmitKey();
    this.containerEl.empty();
  }

  private cancelRefresh(): void {
    if (this.refreshTimer === null) return;
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** Coalesces a burst of keystrokes into one repaint. */
  requestRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_DELAY);
  }

  // ─── Reading the sheet ───

  /**
   * The editor showing `file`, if one is open.
   *
   * Found by path rather than through getActiveViewOfType, which reports the
   * sidebar once the drawer itself has focus — exactly when the user is about
   * to click a button.
   */
  private editorViewFor(file: TFile): MarkdownView | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) return view;
    }
    return null;
  }

  private readContent(file: TFile): Promise<string> {
    return readLiveContent(this.app, file);
  }

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
      this.blocks = [];
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
      this.blocks = parseEditorial(content);
    } catch (err) {
      console.error('Manuscript: could not read the sheet for review', err);
      this.cards = [];
      this.blocks = [];
    }
    this.paint();
  }

  // ─── Painting ───

  /**
   * The card built from the entry starting at `offset`, by key rather than by
   * position.
   *
   * paint() appends one element per card, and four callers used to reach back
   * into the list with an index found in `this.cards` — a correspondence that
   * holds only while the two lists stay the same length and the same order.
   * Nothing anywhere said so, and painting anything else into the list breaks
   * it silently: the note field's re-focus below would look inside the wrong
   * card, find no textarea, and the note being typed would lose focus on every
   * repaint — which is how an empty draft gets committed over a real note.
   *
   * An offset is unique within a sheet, since no two entries begin at the same
   * character, so this is a key rather than a coincidence.
   */
  private cardEl(offset: number): HTMLElement | null {
    const el = this.listEl.querySelector(`.ms-review-card[data-offset="${offset}"]`);
    return el instanceof HTMLElement ? el : null;
  }

  /**
   * Marks and editorial comments as one list, in document order.
   *
   * Built fresh on each paint rather than kept as state: the two lists it
   * merges are already the state, and a third copy is a third thing to keep in
   * step. Neither list is long enough for the sort to matter.
   */
  private rows(): Row[] {
    const rows: Row[] = [
      ...this.cards.map((card) => ({ type: 'mark' as const, card })),
      ...this.blocks.map((block) => ({ type: 'editorial' as const, block })),
    ];
    return rows.sort((a, b) => rowFrom(a) - rowFrom(b));
  }

  /**
   * Where the row covering `offset` begins, or null if no row does.
   *
   * A click in the editor lands anywhere inside a construct, while a card is
   * stamped with the offset it starts at — this is the translation between the
   * two.
   */
  private rowStartCovering(offset: number): number | null {
    const card = this.cards.find((c) => offset >= c.entry.from && offset < c.entry.to);
    if (card) return card.entry.from;
    const block = this.blocks.find((b) => offset >= b.from && offset < b.to);
    return block ? block.from : null;
  }

  private paint(): void {
    // A field cannot outlive its card. Without this a stale record would
    // suppress every reload for the rest of the session.
    //
    // It comes before the two early returns below rather than beside the
    // rebuild at the end, because those returns take the empty-list paths and
    // a record stranded there would never be cleared. In practice load() is
    // suppressed while a field is open, so the only paint that reaches here
    // with one set is openNote's — but this guard is what makes that a
    // property of the code rather than of the call graph.
    const open = this.editing;
    if (open !== null && !this.cards.some((c) => c.entry.from === open.offset)) {
      this.setEditing(null);
    }

    this.paintHeader();
    this.listEl.empty();

    if (!this.file) {
      this.listEl
        .createDiv({ cls: 'ms-review-empty' })
        .setText('Open a note to review it.');
      return;
    }

    if (this.cards.length === 0 && this.blocks.length === 0) {
      this.listEl
        .createDiv({ cls: 'ms-review-empty' })
        .setText(
          `Nothing to review. Select a passage and press ${COMMENT_HOTKEY}; the note is typed here.`
        );
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const row of this.rows()) {
      fragment.appendChild(
        row.type === 'mark' ? this.buildCard(row.card) : this.buildEditorialCard(row.block)
      );
    }
    this.listEl.appendChild(fragment);

    // Fresh elements know nothing of the focus their predecessors carried.
    // Re-marked without scrolling: a repaint mid-typing that also yanked the
    // list to the focused card would fight the reader's own scrolling.
    if (this.focusedOffset !== null) {
      const start = this.rowStartCovering(this.focusedOffset);
      if (start !== null) this.cardEl(start)?.addClass('is-focused');
    }

    // The field is rebuilt with everything else, so it is re-focused here:
    // focus() on an element that is not yet in the document does nothing, and
    // the cards were appended a moment ago.
    if (this.editing !== null) {
      const field = this.cardEl(this.editing.offset)?.querySelector('textarea');
      if (field instanceof HTMLTextAreaElement) {
        grow(field);
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
  }

  private paintHeader(): void {
    this.headerEl.empty();

    const titleRow = this.headerEl.createDiv({ cls: 'ms-review-title-row' });
    titleRow.createDiv({ cls: 'ms-review-title' }).setText(this.file?.basename ?? 'Review');

    if (this.cards.length > 0) {
      titleRow.createDiv({ cls: 'ms-review-count' }).setText(String(this.cards.length));

      const more = titleRow.createDiv({
        cls: 'ms-review-more',
        attr: { 'aria-label': 'More actions' },
      });
      setIcon(more, 'more-horizontal');
      more.addEventListener('click', (e) => this.showBulkMenu(e));
    }
  }

  private buildCard(card: Card): HTMLElement {
    const { entry } = card;
    const el = createDiv({ cls: 'ms-review-card' });
    el.dataset.kind = entry.kind;
    // How every other part of this view finds this element again. See cardEl.
    el.dataset.offset = String(entry.from);
    el.tabIndex = 0;

    const quote = el.createDiv({ cls: 'ms-review-quote' });
    this.paintQuote(quote, entry);

    if (this.editing?.offset === entry.from) {
      this.buildNoteField(el, card);
    } else if (entry.comment) {
      const note = el.createDiv({ cls: 'ms-review-comment' });
      note.setText(entry.comment);
      note.addEventListener('click', (e) => {
        // Not the card's own click. reveal() dispatches into the editor, and
        // if that took focus the field would blur, commit and close itself —
        // a click that undoes its own effect.
        e.stopPropagation();
        void this.openNote(entry.from);
      });
    }

    const actions = el.createDiv({ cls: 'ms-review-actions' });

    // The way into a note that does not exist yet. Here rather than as a
    // placeholder line of its own: this row already hides until the card is
    // hovered or focused, so the affordance costs no height in a list of forty
    // cards, and :focus-within puts it in the tab order for free. An empty
    // {>><<} and no comment at all take the same route — the difference is
    // setComment's, not the card's.
    if (!entry.comment) {
      const add = actions.createEl('button', { cls: 'ms-review-action', text: 'Note' });
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.openNote(entry.from);
      });
    }

    const isSuggestion =
      entry.kind === 'insertion' || entry.kind === 'deletion' || entry.kind === 'substitution';

    if (isSuggestion) {
      this.addButton(actions, 'Reject', 'reject', card, el);
      this.addButton(actions, 'Accept', 'accept', card, el, true);
    } else {
      this.addButton(actions, 'Resolve', 'resolve', card, el, true);
    }

    const reveal = () => this.reveal(card);
    el.addEventListener('click', reveal);
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

    return el;
  }

  /**
   * An editorial comment's card: what it says, and no way to settle it.
   *
   * No Accept, no Reject, no Resolve, and no note field. That is a decision
   * rather than an omission — every destructive action this drawer offers acts
   * on a construct whose whole text is on the card in front of you, and an
   * editorial comment may run to paragraphs of which the card shows two lines.
   * It is deleted in the manuscript, where it can be read first.
   */
  private buildEditorialCard(block: EditorialBlock): HTMLElement {
    const el = createDiv({ cls: 'ms-review-card' });
    el.dataset.kind = 'editorial';
    el.dataset.offset = String(block.from);
    el.tabIndex = 0;

    el.createDiv({ cls: 'ms-review-editorial-title' }).setText(block.title || 'Editorial comment');
    // Clamped in CSS rather than cut here, so the full text stays selectable.
    el.createDiv({ cls: 'ms-review-editorial-body' }).setText(block.body || '—');

    const reveal = () => this.revealRange(block.from, block.to);
    el.addEventListener('click', reveal);
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        reveal();
      }
    });

    return el;
  }

  /**
   * Shows the edit as the edit — struck through, underlined — reusing the very
   * classes the editor decorations use, so a card and its text look alike.
   * A standalone comment has nothing to quote, so it shows its line instead.
   */
  private paintQuote(el: HTMLElement, entry: Entry): void {
    if (entry.kind === 'comment') {
      el.addClass('is-context');
      el.setText(entry.line || '—');
      return;
    }

    const span = (text: string, cls: string) => el.createSpan({ cls }).setText(text);
    // The manuscript's own placeholder, on the card. A construct you have
    // started but not written into is an entry like any other, so it gets a
    // card — and without this the card is a blank line. Exact emptiness rather
    // than trimmed, so the two agree: {++  ++} has a body and gets no
    // placeholder in either place.
    const placeholder = () =>
      el.createSpan({ cls: 'ms-critic-placeholder' }).setText('insert…');

    if (entry.kind === 'substitution') {
      span(entry.quote.trim(), 'ms-critic-deletion');
      el.createSpan({ cls: 'ms-critic-arrow' }).setText('→');
      const replacement = entry.replacement ?? '';
      if (replacement === '') placeholder();
      else span(replacement.trim(), 'ms-critic-insertion');
      return;
    }

    if (entry.kind === 'insertion' && entry.quote === '') {
      placeholder();
      return;
    }

    const cls =
      entry.kind === 'insertion'
        ? 'ms-critic-insertion'
        : entry.kind === 'deletion'
          ? 'ms-critic-deletion'
          : 'ms-critic-highlight';
    span(entry.quote.trim(), cls);
  }

  /**
   * The note field: a textarea that looks like the note it stands in for.
   *
   * Enter breaks a line, because a note is prose and sometimes wants two of
   * them. ⌘↵ and clicking away commit; Escape restores what was stored. The
   * draft is mirrored into `editing` on every keystroke, so a repaint we asked
   * for can put the text back.
   */
  private buildNoteField(parent: HTMLElement, card: Card): void {
    const field = parent.createEl('textarea', { cls: 'ms-review-comment-input' });
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
        // The fallback, not the path this normally takes: claimSubmitKey gets
        // the keystroke first and this listener never runs. Kept for the case
        // where the scope is not pushed, and harmless if both fire — closeNote
        // returns at once the second time, with nothing left to close.
        e.preventDefault();
        e.stopPropagation();
        this.closeNote(card, true);
      }
    });
    field.addEventListener('blur', () => this.closeNote(card, true));
  }

  private addButton(
    parent: HTMLElement,
    label: string,
    mode: Mode,
    card: Card,
    cardEl: HTMLElement,
    primary = false
  ): void {
    const btn = parent.createEl('button', {
      cls: `ms-review-action${primary ? ' is-primary' : ''}`,
      text: label,
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.act(card, mode, cardEl);
    });
  }

  // ─── Acting ───

  /**
   * Rewrites one entry, through the live editor so the change lands in
   * Obsidian's undo history and never clobbers unsaved text.
   *
   * The guard is the point: the offsets came from a parse that may be a
   * keystroke out of date, so the source at those offsets is compared against
   * what the card was built from before anything is written.
   */
  private async act(card: Card, mode: Mode, cardEl: HTMLElement): Promise<void> {
    const file = this.file;
    if (!file) return;

    const view = this.editorViewFor(file);
    if (!view) {
      new Notice('Open this note in an editor to accept or reject its markup.');
      return;
    }

    const content = view.editor.getValue();
    if (!stillThere(content, card)) {
      new Notice('The note changed — the list has been refreshed. Try again.');
      this.refresh();
      return;
    }

    let next: string;
    try {
      next = applyEntry(content, card.entry, mode);
    } catch (err) {
      new Notice(err instanceof Error ? err.message : String(err));
      return;
    }

    this.collapse(cardEl);
    this.write(view, content, next);
  }

  private showBulkMenu(e: MouseEvent): void {
    e.stopPropagation();
    const menu = new Menu();

    const bulk = (title: string, icon: string, transform: (c: string) => string) =>
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => this.applyBulk(transform))
      );

    bulk('Accept all', 'check-check', renderAccepted);
    bulk('Reject all', 'x', renderRejected);
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('Notes are cleared either way').setDisabled(true)
    );

    menu.showAtMouseEvent(e);
  }

  private applyBulk(transform: (content: string) => string): void {
    const file = this.file;
    if (!file) return;

    const view = this.editorViewFor(file);
    if (!view) {
      new Notice('Open this note in an editor to resolve its markup.');
      return;
    }

    const content = view.editor.getValue();
    const next = transform(content);
    if (next === content) {
      new Notice('Nothing to resolve in this note.');
      return;
    }

    this.write(view, content, next);
    new Notice('Markup resolved. Undo with ' + (Platform.isMacOS ? '⌘Z' : 'Ctrl+Z') + '.');
  }

  /**
   * Writes a transform result back as one narrow replacement.
   *
   * Replacing the whole document would be simpler and is what this used to do,
   * but CodeMirror maps the caret through the change and a [0, len) replace
   * sends it to offset 0 — so accepting one comment threw the writer to the
   * top of the scene. Narrowing to the bytes that moved keeps the caret,
   * selection and scroll in place, and still lands as a single undo step.
   */
  private write(view: MarkdownView, before: string, after: string): void {
    const edit = minimalEdit(before, after);
    if (!edit) return;
    const { editor } = view;
    editor.replaceRange(edit.text, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
    this.requestRefresh();
  }

  private collapse(cardEl: HTMLElement): void {
    cardEl.style.height = `${cardEl.offsetHeight}px`;
    // Next frame, so the browser has a height to animate away from.
    window.requestAnimationFrame(() => cardEl.addClass('is-resolving'));
  }

  /** Scrolls the editor to an entry and flashes it. */
  private reveal(card: Card): void {
    // An entry flashes as a band derived from its spans — the quote alone for
    // a mark, quote through replacement for a substitution — rather than as
    // its raw bounds, so the markers around it stay unwashed.
    this.revealRange(card.entry.from, card.entry.to, (cm) => flashEntry(cm, card.entry));
  }

  /** The same for an editorial comment, which has only its own bounds. */
  private revealRange(
    from: number,
    to: number,
    wash?: (cm: CmEditorView) => void
  ): void {
    const file = this.file;
    if (!file) return;
    const view = this.editorViewFor(file);
    if (!view) return;

    const { editor } = view;
    editor.scrollIntoView({ from: editor.offsetToPos(from), to: editor.offsetToPos(to) }, true);

    // `cm` is Obsidian's undocumented-but-established handle on the CodeMirror
    // view; without it there is no way to dispatch the flash, so it degrades
    // to scroll-without-flash if a future Obsidian drops the property.
    const cm = (editor as unknown as { cm?: CmEditorView }).cm;
    if (cm) {
      if (wash) wash(cm);
      else flashRange(cm, from, to);
    }

    this.listEl
      .querySelectorAll('.ms-review-card.is-focused')
      .forEach((el) => el.removeClass('is-focused'));
    this.cardEl(from)?.addClass('is-focused');
    this.focusedOffset = from;
  }

  /** Scrolls the drawer to the card covering `offset` and focuses it. */
  focusAt(offset: number): void {
    const card = this.cards.find((c) => offset >= c.entry.from && offset < c.entry.to);
    if (!card) return;

    const el = this.cardEl(card.entry.from);
    if (el === null) return;

    this.listEl.querySelectorAll('.ms-review-card.is-focused').forEach((c) => c.removeClass('is-focused'));
    el.addClass('is-focused');
    this.focusedOffset = offset;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

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
    this.setEditing(null);
    await this.load();

    const card = this.cards.find((c) => offset >= c.entry.from && offset < c.entry.to);
    if (!card) return;

    this.setEditing({ offset: card.entry.from, draft: card.entry.comment ?? '' });
    this.paint();
  }

  /**
   * Closes the field and writes the result, if writing changes anything.
   *
   * Commit and cancel differ only in which text is written back — the draft,
   * or what was stored. Everything after that is one path, which is what makes
   * an empty note behave the same either way: setComment removes the
   * construct, so abandoning the comment command with Escape leaves a plain
   * highlight rather than a mark promising a note nobody wrote.
   */
  private closeNote(card: Card, commit: boolean): void {
    const editing = this.editing;
    if (editing === null || editing.offset !== card.entry.from) return;

    const text = commit ? editing.draft : (card.entry.comment ?? '');
    this.setEditing(null);

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
}
