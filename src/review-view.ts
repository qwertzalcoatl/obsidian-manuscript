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
  parseCritic,
  renderAccepted,
  renderRejected,
  type Entry,
  type Mode,
} from './critic';

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

export class ReviewView extends ItemView {
  private headerEl!: HTMLElement;
  private listEl!: HTMLElement;
  private cards: Card[] = [];
  private file: TFile | null = null;
  private refreshTimer: number | null = null;

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
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.requestRefresh())
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

  refresh(): void {
    this.cancelRefresh();
    const file = this.app.workspace.getActiveFile();
    this.file = file && file.extension === 'md' ? file : null;

    if (!this.file) {
      this.cards = [];
      this.paint();
      return;
    }

    const target = this.file;
    void this.readContent(target).then(
      (content) => {
        if (this.file?.path !== target.path) return; // a newer refresh owns the view
        this.cards = parseCritic(content).map((entry) => ({
          entry,
          raw: content.slice(entry.from, entry.to),
        }));
        this.paint();
      },
      (err) => {
        console.error('Sheet Navigator: could not read the sheet for review', err);
        this.cards = [];
        this.paint();
      }
    );
  }

  // ─── Painting ───

  private paint(): void {
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

    if (entry.comment) {
      el.createDiv({ cls: 'sheet-review-comment' }).setText(entry.comment);
    }

    const actions = el.createDiv({ cls: 'sheet-review-actions' });
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

    // Two independent checks, because the cost of being wrong here is a
    // silently mangled manuscript: the source at those offsets must still be
    // byte-identical, and a fresh parse of the live text must still agree that
    // an entry of this kind lives exactly there.
    const content = view.editor.getValue();
    const stillThere =
      content.slice(card.entry.from, card.entry.to) === card.raw &&
      parseCritic(content).some(
        (e) => e.from === card.entry.from && e.to === card.entry.to && e.kind === card.entry.kind
      );

    if (!stillThere) {
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
    this.writeWholeDocument(view, content, next);
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

    this.writeWholeDocument(view, content, next);
    new Notice('Markup resolved. Undo with ' + (Platform.isMacOS ? '⌘Z' : 'Ctrl+Z') + '.');
  }

  /**
   * One replaceRange over the whole document rather than setValue, so the
   * rewrite is a single undoable step and the cursor survives.
   */
  private writeWholeDocument(view: MarkdownView, before: string, after: string): void {
    const { editor } = view;
    editor.replaceRange(after, editor.offsetToPos(0), editor.offsetToPos(before.length));
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

    this.listEl
      .querySelectorAll('.sheet-review-card.is-focused')
      .forEach((el) => el.removeClass('is-focused'));
    const index = this.cards.indexOf(card);
    this.listEl.children[index]?.addClass('is-focused');
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
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
