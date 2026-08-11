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
import type { EditorView as CmEditorView } from '@codemirror/view';
import { flashEntry } from './critic-render';

export const VIEW_TYPE_REVIEW = 'sheet-navigator-review';

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

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
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
    this.containerEl.addClass('sheet-review');

    this.headerEl = this.containerEl.createDiv({ cls: 'sheet-review-header' });
    this.listEl = this.containerEl.createDiv({ cls: 'sheet-review-list' });

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

  // ─── Painting ───

  private paint(): void {
    // A field cannot outlive its card. Without this a stale record would
    // suppress every reload for the rest of the session.
    const open = this.editing;
    if (open !== null && !this.cards.some((c) => c.entry.from === open.offset)) {
      this.editing = null;
    }

    this.paintHeader();
    this.listEl.empty();

    if (!this.file) {
      this.listEl
        .createDiv({ cls: 'sheet-review-empty' })
        .setText('Open a note to review it.');
      return;
    }

    if (this.cards.length === 0) {
      this.listEl
        .createDiv({ cls: 'sheet-review-empty' })
        .setText(`Nothing to review. Select text and press ${COMMENT_HOTKEY} to leave a note.`);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const card of this.cards) fragment.appendChild(this.buildCard(card));
    this.listEl.appendChild(fragment);

    // Fresh elements know nothing of the focus their predecessors carried.
    // Re-marked without scrolling: a repaint mid-typing that also yanked the
    // list to the focused card would fight the reader's own scrolling.
    if (this.focusedOffset !== null) {
      const offset = this.focusedOffset;
      const index = this.cards.findIndex(
        (c) => offset >= c.entry.from && offset < c.entry.to
      );
      this.listEl.children[index]?.addClass('is-focused');
    }

    // The field is rebuilt with everything else, so it is re-focused here:
    // focus() on an element that is not yet in the document does nothing, and
    // the cards were appended a moment ago.
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
  }

  private paintHeader(): void {
    this.headerEl.empty();

    const titleRow = this.headerEl.createDiv({ cls: 'sheet-review-title-row' });
    titleRow.createDiv({ cls: 'sheet-review-title' }).setText(this.file?.basename ?? 'Review');

    if (this.cards.length > 0) {
      titleRow.createDiv({ cls: 'sheet-review-count' }).setText(String(this.cards.length));

      const more = titleRow.createDiv({
        cls: 'sheet-review-more',
        attr: { 'aria-label': 'More actions' },
      });
      setIcon(more, 'more-horizontal');
      more.addEventListener('click', (e) => this.showBulkMenu(e));
    }
  }

  private buildCard(card: Card): HTMLElement {
    const { entry } = card;
    const el = createDiv({ cls: 'sheet-review-card' });
    el.dataset.kind = entry.kind;
    el.tabIndex = 0;

    const quote = el.createDiv({ cls: 'sheet-review-quote' });
    this.paintQuote(quote, entry);

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

    const actions = el.createDiv({ cls: 'sheet-review-actions' });

    // The way into a note that does not exist yet. Here rather than as a
    // placeholder line of its own: this row already hides until the card is
    // hovered or focused, so the affordance costs no height in a list of forty
    // cards, and :focus-within puts it in the tab order for free. An empty
    // {>><<} and no comment at all take the same route — the difference is
    // setComment's, not the card's.
    if (!entry.comment) {
      const add = actions.createEl('button', { cls: 'sheet-review-action', text: 'Note' });
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

    if (entry.kind === 'substitution') {
      span(entry.quote.trim(), 'sn-critic-deletion');
      el.createSpan({ cls: 'sheet-review-arrow' }).setText('→');
      span((entry.replacement ?? '').trim(), 'sn-critic-insertion');
      return;
    }

    const cls =
      entry.kind === 'insertion'
        ? 'sn-critic-insertion'
        : entry.kind === 'deletion'
          ? 'sn-critic-deletion'
          : 'sn-critic-highlight';
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

  private addButton(
    parent: HTMLElement,
    label: string,
    mode: Mode,
    card: Card,
    cardEl: HTMLElement,
    primary = false
  ): void {
    const btn = parent.createEl('button', {
      cls: `sheet-review-action${primary ? ' is-primary' : ''}`,
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
    const file = this.file;
    if (!file) return;
    const view = this.editorViewFor(file);
    if (!view) return;

    const { editor } = view;
    const from = editor.offsetToPos(card.entry.from);
    const to = editor.offsetToPos(card.entry.to);
    editor.scrollIntoView({ from, to }, true);

    // `cm` is Obsidian's undocumented-but-established handle on the CodeMirror
    // view; without it there is no way to dispatch the flash, so it degrades
    // to scroll-without-flash if a future Obsidian drops the property.
    const cm = (editor as unknown as { cm?: CmEditorView }).cm;
    if (cm) flashEntry(cm, card.entry);

    this.listEl
      .querySelectorAll('.sheet-review-card.is-focused')
      .forEach((el) => el.removeClass('is-focused'));
    const index = this.cards.indexOf(card);
    this.listEl.children[index]?.addClass('is-focused');
    this.focusedOffset = card.entry.from;
  }

  /** Scrolls the drawer to the card covering `offset` and focuses it. */
  focusAt(offset: number): void {
    const index = this.cards.findIndex(
      (c) => offset >= c.entry.from && offset < c.entry.to
    );
    if (index === -1) return;

    const el = this.listEl.children[index];
    if (!(el instanceof HTMLElement)) return;

    this.listEl.querySelectorAll('.sheet-review-card.is-focused').forEach((c) => c.removeClass('is-focused'));
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
   * or what was stored. Everything after that is one path, which is what makes
   * an empty note behave the same either way: setComment removes the
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
}
