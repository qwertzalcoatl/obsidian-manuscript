import {
  Plugin,
  ItemView,
  WorkspaceLeaf,
  TFile,
  TFolder,
  TAbstractFile,
  Menu,
  Modal,
  Setting,
  PluginSettingTab,
  App,
  FileSystemAdapter,
  MarkdownView,
  Editor,
  Notice,
  setIcon,
  type Hotkey,
} from "obsidian";
import { extractSnippet } from "./text";
import { parseCritic, renderAccepted, renderRejected } from "./critic";
import { criticEditorExtension, renderCriticMarkup } from "./critic-render";
import { ReviewView, VIEW_TYPE_REVIEW, readLiveContent } from "./review-view";
import {
  parseItemName,
  displayTitle,
  compareItems,
  computeRenamePlan,
  fullNameOf,
  makeTempName,
  isTempName,
  recoverTempName,
  type NameItem,
  type PlanItem,
} from "./naming";

const VIEW_TYPE = "sheet-navigator-view";

/** Keystrokes rarely change the markup count; no need to recount on each one. */
const COUNT_DEBOUNCE = 300;

/** The constructs a selection can be wrapped in directly, without a prompt. */
type MarkupKind = "comment" | "highlight" | "deletion" | "insertion";

const WRAPPERS: Record<Exclude<MarkupKind, "comment">, [string, string]> = {
  highlight: ["{==", "==}"],
  deletion: ["{--", "--}"],
  insertion: ["{++", "++}"],
};

interface SheetNavigatorSettings {
  orderingEnabled: boolean;
  reviewEnabled: boolean;
}

const DEFAULT_SETTINGS: SheetNavigatorSettings = {
  orderingEnabled: false,
  reviewEnabled: true,
};

interface HistoryEntry {
  path: string;
  name: string;
}

interface DragState {
  name: string;
  isFolder: boolean;
  el: HTMLElement;
}

// ─── Path helpers ───
// The view tracks folders as "/"-prefixed paths ("/" for the vault root);
// the vault API uses bare relative paths ("" for the root).

function toVaultPath(viewPath: string): string {
  return viewPath === "/" ? "" : viewPath.slice(1);
}

function toViewPath(vaultPath: string): string {
  return vaultPath === "" ? "/" : "/" + vaultPath;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentOf(vaultPath: string): string {
  const idx = vaultPath.lastIndexOf("/");
  return idx === -1 ? "" : vaultPath.slice(0, idx);
}

function basenameOf(vaultPath: string): string {
  const idx = vaultPath.lastIndexOf("/");
  return idx === -1 ? vaultPath : vaultPath.slice(idx + 1);
}

/** Display name — basename for files, folder name for folders. */
function displayNameOf(item: TAbstractFile): string {
  return item instanceof TFile ? item.basename : item.name;
}

// ─── View ───

export class SheetNavigatorView extends ItemView {
  plugin: SheetNavigatorPlugin;
  currentPath: string;
  history: HistoryEntry[];
  dragState: DragState | null;
  isReordering: boolean;
  headerEl!: HTMLElement;
  listEl!: HTMLElement;

  /**
   * Bumped by every render. The async preview pass compares against it before
   * touching the DOM, so a render that is overtaken cannot write its cards into
   * its successor's list.
   */
  private renderSeq = 0;
  private queuedRender: number | null = null;
  private previewTargets = new Map<string, { preview: HTMLElement; badge: HTMLElement }>();
  /** Scratch-named leftovers we failed to recover — shown rather than hidden. */
  private unrecoverableTempPaths = new Set<string>();

  /**
   * Open markup in the active sheet, for the toolbar button's badge.
   *
   * A plain field rather than something the button owns: renderHeader runs on
   * every vault event, so the button element is destroyed and rebuilt
   * constantly. A cachedRead resolving later would write into a detached node.
   */
  private activeMarkupCount = 0;
  private countTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SheetNavigatorPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentPath = "/";
    this.history = [];
    this.dragState = null;
    this.isReordering = false;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Sheets";
  }
  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    this.containerEl.empty();
    this.containerEl.addClass("sheet-navigator");

    this.headerEl = this.containerEl.createDiv({ cls: "sheet-nav-header" });
    this.listEl = this.containerEl.createDiv({ cls: "sheet-nav-list" });

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.highlightActive();
        this.refreshActiveMarkupCount();
      })
    );

    // Also on every edit, not just on switching files: accepting a suggestion
    // in the drawer changes the count, and vault "modify" only lands on
    // Obsidian's save debounce — long enough for the two badges to disagree.
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.refreshActiveMarkupCount())
    );

    // A modify touches one note's text, never the folder's structure — repaint
    // that single card instead of rebuilding the list and losing scroll.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isReordering) return;
        if (file instanceof TFile) void this.updateCardPreview(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isReordering) return;
        if (this.affectsCurrentView(file.path)) this.requestRender();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.isReordering) return;
        if (this.isCurrentOrAncestor(file.path)) {
          new Notice(`"${file.name}" was deleted — moved up a level.`);
          this.requestRender();
        } else if (this.affectsCurrentView(file.path)) {
          this.requestRender();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        // Runs during a reorder too, so the tracked paths follow the two-phase
        // rename hops instead of being pruned as missing.
        const remapped = this.remapPaths(oldPath, file.path);
        if (this.isReordering) return;
        if (remapped || this.affectsCurrentView(oldPath) || this.affectsCurrentView(file.path)) {
          this.requestRender();
        }
      })
    );

    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelQueuedRender();
    this.previewTargets.clear();
    this.containerEl.empty();
  }

  private cancelQueuedRender(): void {
    if (this.queuedRender === null) return;
    window.cancelAnimationFrame(this.queuedRender);
    this.queuedRender = null;
  }

  // ─── Folder resolution ───

  getPathStr(folder: TFolder): string {
    return toViewPath(folder.path);
  }

  /** Null when the path no longer resolves — callers must not fall back to root blindly. */
  getFolderByPath(path: string): TFolder | null {
    if (path === "/") return this.app.vault.getRoot();
    const af = this.app.vault.getAbstractFileByPath(toVaultPath(path));
    return af instanceof TFolder ? af : null;
  }

  /**
   * The current folder, or the nearest ancestor that still exists. Walking up
   * keeps the view somewhere real after a folder is renamed or deleted out from
   * under it, instead of silently teleporting to the vault root.
   */
  private resolveCurrentFolder(): TFolder {
    const folder = this.getFolderByPath(this.currentPath);
    if (folder) return folder;

    while (this.currentPath !== "/") {
      this.currentPath = toViewPath(parentOf(toVaultPath(this.currentPath)));
      this.history.pop();
      const ancestor = this.getFolderByPath(this.currentPath);
      if (ancestor) return ancestor;
    }
    this.history = [];
    return this.app.vault.getRoot();
  }

  private parentIsCurrent(vaultPath: string): boolean {
    return toViewPath(parentOf(vaultPath)) === this.currentPath;
  }

  /**
   * True when a change at this path can alter what is on screen: either the
   * item sits in the current folder, or one level deeper, where it changes the
   * "N notes" count on a folder card we are showing.
   */
  private affectsCurrentView(vaultPath: string): boolean {
    return this.parentIsCurrent(vaultPath) || this.parentIsCurrent(parentOf(vaultPath));
  }

  private isCurrentOrAncestor(vaultPath: string): boolean {
    const current = toVaultPath(this.currentPath);
    return current === vaultPath || current.startsWith(vaultPath + "/");
  }

  /**
   * Rewrites every tracked path after a rename. Without this the view loses the
   * folder it is sitting in and `history` keeps dead entries.
   */
  private remapPaths(oldPath: string, newPath: string): boolean {
    const remap = (p: string): string | null => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
      return null;
    };

    let changed = false;

    const nextCurrent = remap(toVaultPath(this.currentPath));
    if (nextCurrent !== null) {
      this.currentPath = toViewPath(nextCurrent);
      changed = true;
    }

    this.history = this.history.map((entry) => {
      const next = remap(toVaultPath(entry.path));
      if (next === null) return entry;
      changed = true;
      return { path: toViewPath(next), name: basenameOf(next) || "Vault" };
    });

    return changed;
  }

  // ─── Children ───

  /** Single source of truth for what the navigator shows — and counts. */
  visibleChildren(folder: TFolder): TAbstractFile[] {
    return folder.children.filter((c) => {
      if (c.name.startsWith(".")) return false;
      if (isTempName(c.name) && !this.unrecoverableTempPaths.has(c.path)) return false;
      if (c instanceof TFile && c.extension !== "md") return false;
      return true;
    });
  }

  sortChildren(folder: TFolder): TAbstractFile[] {
    return this.visibleChildren(folder).sort((a, b) =>
      compareItems(toNameItem(a), toNameItem(b))
    );
  }

  // ─── Render ───

  /** Coalesces a burst of vault events into a single repaint. */
  requestRender(): void {
    // A reorder is a burst of renames that passes through inconsistent
    // intermediate states; it repaints once when it settles.
    if (this.isReordering) return;
    if (this.queuedRender !== null) return;
    this.queuedRender = window.requestAnimationFrame(() => {
      this.queuedRender = null;
      this.render();
    });
  }

  /**
   * Synchronous by design. The previous version awaited a file read per card
   * while the list was already emptied, so a click landing mid-loop produced a
   * list holding cards from two different folders.
   */
  render(): void {
    // Mid-reorder every affected child is parked under a scratch name that
    // visibleChildren filters out, so painting now would show an empty folder.
    // drillInto and goUp call this directly, so the guard belongs here too —
    // the reorder repaints once it settles, using whatever currentPath is then.
    if (this.isReordering) return;

    const seq = ++this.renderSeq;
    let folder: TFolder;

    try {
      folder = this.resolveCurrentFolder();

      const children = this.sortChildren(folder);
      const scrollTop = this.listEl.scrollTop;

      this.renderHeader(folder);

      this.previewTargets.clear();
      const fragment = document.createDocumentFragment();
      for (const child of children) {
        fragment.appendChild(
          child instanceof TFolder
            ? this.buildFolderCard(child)
            : this.buildFileCard(child as TFile)
        );
      }
      if (children.length === 0) {
        const empty = createDiv({ cls: "sheet-nav-empty" });
        empty.setText(
          this.currentPath === "/"
            ? "This vault has no notes yet."
            : "No notes in this folder."
        );
        fragment.appendChild(empty);
      }

      this.applyNumberColumnWidths(children);
      this.listEl.empty();
      this.listEl.appendChild(fragment);
      this.listEl.scrollTop = scrollTop;

      this.highlightActive();
    } catch (err) {
      this.renderErrorState(err);
      return;
    }

    this.fillPreviews(seq).catch((err) =>
      console.error("Sheet Navigator: preview pass failed", err)
    );
    this.sweepTempNames(folder).catch((err) =>
      console.error("Sheet Navigator: temp-name sweep failed", err)
    );
  }

  private renderErrorState(err: unknown): void {
    console.error("Sheet Navigator: render failed", err);
    this.listEl.empty();
    const box = this.listEl.createDiv({ cls: "sheet-nav-empty" });
    box.setText("Could not display this folder. Try navigating up a level.");
  }

  private renderHeader(folder: TFolder): void {
    this.headerEl.empty();

    if (this.currentPath !== "/") {
      const backBtn = this.headerEl.createDiv({ cls: "sheet-nav-back" });
      backBtn.createSpan({ cls: "sheet-nav-back-arrow" }).setText("‹");
      const parentName =
        this.history.length > 0
          ? this.history[this.history.length - 1].name
          : "Vault";
      backBtn.createSpan({ text: parentName, cls: "sheet-nav-back-label" });
      backBtn.addEventListener("click", () => this.goUp());
    }

    const titleRow = this.headerEl.createDiv({ cls: "sheet-nav-title-row" });
    titleRow.createDiv({ cls: "sheet-nav-title" }).setText(folder.name || "Vault");

    const toolbar = titleRow.createDiv({ cls: "sheet-nav-toolbar" });

    const newBtn = toolbar.createDiv({
      cls: "sheet-nav-toolbar-btn",
      attr: { "aria-label": "New note" },
    });
    setIcon(newBtn, "file-plus");
    newBtn.addEventListener("click", () => void this.createNewNote());

    if (!this.plugin.settings.reviewEnabled) return;

    const count = this.activeMarkupCount;
    const reviewBtn = toolbar.createDiv({
      cls: `sheet-nav-toolbar-btn sheet-nav-review-btn${count > 0 ? " is-active" : " is-dimmed"}`,
      attr: {
        "aria-label": count > 0 ? `Review (${count})` : "Review — nothing marked up",
      },
    });
    setIcon(reviewBtn, "message-square-quote");
    if (count > 0) {
      reviewBtn.createSpan({ cls: "sheet-nav-review-count" }).setText(String(count));
    }
    reviewBtn.addEventListener("click", () => void this.plugin.activateReviewView());
  }

  /**
   * Re-reads the active sheet's markup count and repaints the toolbar badge.
   *
   * Debounced because it is wired to editor-change: the count only moves when
   * markup is added or resolved, so parsing on every keystroke would be work
   * spent to reach the same answer.
   */
  refreshActiveMarkupCount(): void {
    if (!this.plugin.settings.reviewEnabled) return;
    if (this.countTimer !== null) window.clearTimeout(this.countTimer);
    this.countTimer = window.setTimeout(() => {
      this.countTimer = null;
      void this.recountActiveMarkup();
    }, COUNT_DEBOUNCE);
  }

  private async recountActiveMarkup(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    let next = 0;
    if (file && file.extension === "md") {
      try {
        next = parseCritic(await readLiveContent(this.app, file)).length;
      } catch {
        next = 0;
      }
    }

    if (next === this.activeMarkupCount) return;
    this.activeMarkupCount = next;
    this.requestRender();
  }

  /**
   * Publishes the two facts the stylesheet needs to size the number column: how
   * wide the widest number in each group is, and whether the group has any
   * numbers at all. A folder nobody numbers collapses the column entirely; a
   * mixed folder reserves it on every card so the titles line up.
   */
  private applyNumberColumnWidths(children: TAbstractFile[]): void {
    const widest = (isFolder: boolean) =>
      children.reduce((max, child) => {
        if (child instanceof TFolder !== isFolder) return max;
        const num = parseItemName(displayNameOf(child)).number;
        return num ? Math.max(max, num.length) : max;
      }, 0);

    const folderChars = widest(true);
    const fileChars = widest(false);

    this.listEl.style.setProperty("--sn-folder-num-chars", String(folderChars || 1));
    this.listEl.style.setProperty("--sn-file-num-chars", String(fileChars || 1));
    this.listEl.dataset.folderNums = folderChars > 0 ? "some" : "none";
    this.listEl.dataset.fileNums = fileChars > 0 ? "some" : "none";
  }

  // ─── Cards ───

  private buildFolderCard(folder: TFolder): HTMLElement {
    const ordering = this.plugin.settings.orderingEnabled;
    const card = createDiv({ cls: "sheet-nav-card sheet-nav-folder-card" });

    if (ordering) card.createDiv({ cls: "sheet-nav-drag-handle" }).setText("⠿");

    const parsed = parseItemName(folder.name);

    // The slot is always present: omitting it when there is no number is what
    // made a list mixing "1 – Prolog" and "Anhang" line up raggedly.
    const numEl = card.createDiv({ cls: "sheet-nav-chapter-num" });
    if (parsed.number) numEl.setText(parsed.number);

    const content = card.createDiv({ cls: "sheet-nav-folder-content" });

    const label = displayTitle(parsed);
    const nameEl = content.createDiv({ cls: "sheet-nav-card-name" });
    nameEl.setText(label.text);
    if (label.isUntitled) nameEl.addClass("is-untitled");

    const visible = this.visibleChildren(folder);
    const noteCount = visible.filter((c) => c instanceof TFile).length;
    const folderCount = visible.filter((c) => c instanceof TFolder).length;
    const parts: string[] = [];
    if (folderCount > 0) parts.push(`${folderCount} folder${folderCount > 1 ? "s" : ""}`);
    if (noteCount > 0) parts.push(`${noteCount} note${noteCount > 1 ? "s" : ""}`);
    content.createDiv({ cls: "sheet-nav-card-meta" }).setText(parts.join(" · "));

    const chevron = card.createDiv({ cls: "sheet-nav-chevron" });
    chevron.setText("›");

    card.addEventListener("click", () => this.drillInto(folder));
    chevron.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      this.drillInto(folder);
    });
    card.addEventListener("contextmenu", (e) => this.showContextMenu(e, folder));

    if (ordering) this.makeDraggable(card, folder);

    return card;
  }

  private buildFileCard(file: TFile): HTMLElement {
    const ordering = this.plugin.settings.orderingEnabled;
    const card = createDiv({ cls: "sheet-nav-card sheet-nav-file-card" });
    card.dataset.path = file.path;

    if (ordering) card.createDiv({ cls: "sheet-nav-drag-handle" }).setText("⠿");

    const parsed = parseItemName(file.basename);

    const numEl = card.createDiv({ cls: "sheet-nav-file-num" });
    if (parsed.number) numEl.setText(parsed.number);

    const content = card.createDiv({ cls: "sheet-nav-file-content" });

    // displayTitle never echoes the number the badge already shows, so a note
    // named "3.md" no longer renders "3" twice.
    const label = displayTitle(parsed);
    const titleLine = content.createDiv({ cls: "sheet-nav-title-line" });
    const titleEl = titleLine.createDiv({ cls: "sheet-nav-card-title" });
    titleEl.setText(label.text);
    if (label.isUntitled) titleEl.addClass("is-untitled");

    // Filled by the preview pass, which already reads this file — an empty
    // badge collapses, so a note with no markup shows nothing.
    const badgeEl = titleLine.createDiv({ cls: "sheet-nav-card-badge" });

    // Always created, even for an empty note, so card heights stay uniform.
    const previewEl = content.createDiv({ cls: "sheet-nav-card-preview" });
    this.previewTargets.set(file.path, { preview: previewEl, badge: badgeEl });

    card.addEventListener("click", () => {
      void this.app.workspace.openLinkText(file.path, "", false);
    });

    card.addEventListener("contextmenu", (e) => this.showContextMenu(e, file));

    if (ordering) this.makeDraggable(card, file);

    return card;
  }

  // ─── Previews (async tail) ───

  /**
   * A card's preview text and markup count from one read.
   *
   * Editorial markup is resolved to its accepted form first, so a scene whose
   * opening sentence carries a comment previews as prose rather than as braces.
   */
  private summarise(content: string): { text: string; count: number } {
    if (!this.plugin.settings.reviewEnabled) {
      return { text: extractSnippet(content), count: 0 };
    }
    // Most notes carry no markup, and for those renderAccepted would parse a
    // second time only to hand back the string it was given.
    const count = parseCritic(content).length;
    return {
      text: extractSnippet(count === 0 ? content : renderAccepted(content)),
      count,
    };
  }

  private paintBadge(el: HTMLElement, count: number): void {
    el.empty();
    el.toggleClass("is-visible", count > 0);
    if (count === 0) return;
    setIcon(el, "message-square");
    el.createSpan().setText(String(count));
    el.setAttribute("aria-label", `${count} open in review`);
  }

  private async fillPreviews(seq: number): Promise<void> {
    const targets = [...this.previewTargets.entries()];
    if (targets.length === 0) return;

    const summaries = await Promise.all(
      targets.map(async ([path, els]) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        try {
          return { els, ...this.summarise(await this.app.vault.cachedRead(file)) };
        } catch {
          return null;
        }
      })
    );

    if (seq !== this.renderSeq) return; // a newer render owns the DOM now
    for (const summary of summaries) {
      if (!summary) continue;
      summary.els.preview.setText(summary.text);
      this.paintBadge(summary.els.badge, summary.count);
    }
  }

  private async updateCardPreview(file: TFile): Promise<void> {
    const els = this.previewTargets.get(file.path);
    if (!els) return;
    const seq = this.renderSeq;
    let summary: { text: string; count: number };
    try {
      summary = this.summarise(await this.app.vault.cachedRead(file));
    } catch {
      return;
    }
    if (seq !== this.renderSeq) return;
    els.preview.setText(summary.text);
    this.paintBadge(els.badge, summary.count);
  }

  // ─── Drag and drop ───

  /**
   * Takes the item rather than a name so the display name — the key
   * computeRenamePlan matches on — can only be derived one way. Handing it
   * `file.name` instead of `file.basename` silently breaks every file drag.
   */
  makeDraggable(card: HTMLElement, item: TAbstractFile): void {
    const itemName = displayNameOf(item);
    const isFolder = item instanceof TFolder;
    card.setAttribute("draggable", "true");

    const isCompatible = () =>
      this.dragState !== null &&
      this.dragState.name !== itemName &&
      this.dragState.isFolder === isFolder;

    card.addEventListener("dragstart", (e: DragEvent) => {
      this.dragState = { name: itemName, isFolder, el: card };
      card.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", itemName);
      }
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      this.clearDropIndicators();
      this.dragState = null;
    });

    card.addEventListener("dragover", (e: DragEvent) => {
      // Not calling preventDefault marks this card as an invalid drop target,
      // which is how a folder/file cross-drop is refused.
      if (!isCompatible()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

      this.clearDropIndicators();
      const rect = card.getBoundingClientRect();
      card.classList.add(
        e.clientY < rect.top + rect.height / 2 ? "drop-above" : "drop-below"
      );
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-above");
      card.classList.remove("drop-below");
    });

    card.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      if (!isCompatible() || !this.dragState) return;

      const rect = card.getBoundingClientRect();
      const insertBefore = e.clientY < rect.top + rect.height / 2;
      const draggedName = this.dragState.name;

      this.clearDropIndicators();
      this.dragState = null;
      void this.reorder(draggedName, itemName, insertBefore);
    });
  }

  clearDropIndicators(): void {
    this.listEl.querySelectorAll(".drop-above, .drop-below").forEach((el) => {
      el.classList.remove("drop-above");
      el.classList.remove("drop-below");
    });
  }

  // ─── Reorder ───

  async reorder(
    draggedName: string,
    targetName: string,
    insertBefore: boolean
  ): Promise<void> {
    const folder = this.getFolderByPath(this.currentPath);
    if (!folder) return;

    // Start from a clean slate — leftovers from an interrupted reorder would
    // otherwise be planned around as if they were real names.
    await this.sweepTempNames(folder);

    const children = this.sortChildren(folder);
    const byFullName = new Map<string, TAbstractFile>();
    for (const child of children) byFullName.set(child.name, child);

    const plan = computeRenamePlan({
      items: children.map(toPlanItem),
      siblingNames: folder.children.map((c) => c.name),
      draggedName,
      targetName,
      insertBefore,
    });

    if (!plan.ok) {
      new Notice(`Cannot reorder: ${plan.reason}`);
      return;
    }
    if (plan.ops.length === 0) {
      this.requestRender();
      return;
    }

    // Resolve every op to a live item before touching disk. Skipping an
    // unresolvable one mid-flight would half-apply the plan and leave two items
    // sharing a number — the corruption this rewrite exists to prevent.
    const work: { item: TAbstractFile; finalName: string }[] = [];
    for (const op of plan.ops) {
      const item = byFullName.get(fullNameOf(op.item));
      if (!item) {
        new Notice(`Cannot reorder: "${fullNameOf(op.item)}" is no longer in this folder.`);
        return;
      }
      work.push({ item, finalName: op.newFullName });
    }

    this.isReordering = true;
    this.cancelQueuedRender(); // a frame queued before this point would paint mid-rename
    try {
      // Phase 1 — park under scratch names so no two renames collide. The
      // scratch name encodes its own destination, which is what lets an
      // interrupted run be rolled forward rather than guessed at.
      for (const w of work) {
        const temp = makeTempName(tempToken(), w.finalName);
        await this.app.fileManager.renameFile(w.item, joinPath(folder.path, temp));
      }

      // Phase 2 — settle on the final names.
      for (const w of work) {
        await this.app.fileManager.renameFile(
          w.item,
          joinPath(folder.path, w.finalName)
        );
      }
    } catch (err) {
      console.error("Sheet Navigator: reorder failed", err);
      new Notice(
        `Reorder failed: ${err instanceof Error ? err.message : String(err)}`
      );
      await this.sweepTempNames(folder);
    } finally {
      this.isReordering = false;
    }

    this.requestRender();
  }

  /**
   * Finishes any rename left parked under a scratch name. Runs on every folder
   * render, not just view open, because a crash inside a nested folder would
   * otherwise never be reached — and those items are hidden from the list, so
   * an unswept folder would hide them permanently.
   */
  private async sweepTempNames(folder: TFolder): Promise<void> {
    const stuck = folder.children.filter(
      (c) => isTempName(c.name) && !this.unrecoverableTempPaths.has(c.path)
    );
    if (stuck.length === 0) return;

    const failed: string[] = [];
    for (const child of stuck) {
      const recovered = recoverTempName(child.name);
      const target = recovered ? joinPath(folder.path, recovered) : null;
      if (!target || this.app.vault.getAbstractFileByPath(target)) {
        failed.push(child.path);
        continue;
      }
      try {
        await this.app.fileManager.renameFile(child, target);
      } catch (err) {
        console.error("Sheet Navigator: could not recover", child.path, err);
        failed.push(child.path);
      }
    }

    // Merge rather than replace: the set spans folders, and dropping another
    // folder's entry would re-hide an item that has no recovery attempt pending.
    for (const path of failed) this.unrecoverableTempPaths.add(path);
    for (const path of [...this.unrecoverableTempPaths]) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        this.unrecoverableTempPaths.delete(path); // renamed by hand, or gone
      }
    }

    if (failed.length > 0) {
      new Notice(
        `Sheet Navigator: ${failed.length} item(s) from an interrupted reorder need renaming by hand.`
      );
    }
    this.requestRender();
  }

  // ─── Actions ───

  async createNewNote(): Promise<void> {
    const folder = this.getFolderByPath(this.currentPath);
    if (!folder) {
      new Notice("This folder no longer exists.");
      return;
    }

    let next = 1;
    for (const child of this.visibleChildren(folder)) {
      const parsed = parseItemName(displayNameOf(child));
      if (parsed.number === null) continue;
      const n = parseInt(parsed.number, 10);
      if (Number.isFinite(n) && n >= next) next = n + 1;
    }

    let filePath: string | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = joinPath(folder.path, `${next + attempt}.md`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        filePath = candidate;
        break;
      }
    }
    if (!filePath) {
      new Notice("Could not find a free note number in this folder.");
      return;
    }

    try {
      const newFile = await this.app.vault.create(filePath, "");
      await this.app.workspace.openLinkText(newFile.path, "", false);
    } catch (err) {
      new Notice(
        `Could not create the note: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  showContextMenu(e: MouseEvent, abstractFile: TAbstractFile): void {
    e.preventDefault();
    e.stopPropagation();

    const menu = new Menu();
    const isFolder = abstractFile instanceof TFolder;

    menu.addItem((item) => {
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() => {
          new RenameModal(this.app, abstractFile, async (newName: string) => {
            const ext = isFolder ? "" : "." + (abstractFile as TFile).extension;
            const newPath = joinPath(parentOf(abstractFile.path), newName + ext);
            try {
              await this.app.fileManager.renameFile(abstractFile, newPath);
            } catch (err) {
              new Notice(
                `Could not rename: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }).open();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => {
          const label = isFolder ? "folder" : "note";
          new ConfirmModal(
            this.app,
            `Delete ${label}?`,
            `"${abstractFile.name}" will be moved to trash.`,
            "Delete",
            async () => {
              try {
                await this.app.vault.trash(abstractFile, true);
              } catch (err) {
                new Notice(
                  `Could not delete: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
          ).open();
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setTitle("Copy vault path")
        .setIcon("copy")
        .onClick(() => this.copyToClipboard(abstractFile.path, "Vault path copied"));
    });

    menu.addItem((item) => {
      item
        .setTitle("Copy absolute path")
        .setIcon("copy")
        .onClick(() => {
          const adapter = this.app.vault.adapter;
          if (!(adapter instanceof FileSystemAdapter)) {
            new Notice("Absolute paths are not available on this platform.");
            return;
          }
          this.copyToClipboard(
            adapter.getBasePath() + "/" + abstractFile.path,
            "Absolute path copied"
          );
        });
    });

    menu.showAtMouseEvent(e);
  }

  private copyToClipboard(text: string, success: string): void {
    navigator.clipboard.writeText(text).then(
      () => new Notice(success),
      () => new Notice("Could not copy to clipboard.")
    );
  }

  highlightActive(): void {
    const activeFile = this.app.workspace.getActiveFile();
    this.listEl.querySelectorAll(".sheet-nav-card").forEach((card) => {
      card.classList.remove("is-active");
    });
    if (activeFile) {
      const activeCard = this.listEl.querySelector(
        `[data-path="${CSS.escape(activeFile.path)}"]`
      );
      if (activeCard) activeCard.classList.add("is-active");
    }
  }

  drillInto(folder: TFolder): void {
    this.history.push({
      path: this.currentPath,
      name: this.getFolderByPath(this.currentPath)?.name || "Vault",
    });
    this.currentPath = this.getPathStr(folder);
    this.render();
  }

  goUp(): void {
    if (this.history.length > 0) {
      this.currentPath = this.history.pop()!.path;
    } else {
      this.currentPath = toViewPath(parentOf(toVaultPath(this.currentPath)));
    }
    this.render();
  }
}

function toNameItem(item: TAbstractFile): NameItem {
  return { name: displayNameOf(item), isFolder: item instanceof TFolder };
}

function toPlanItem(item: TAbstractFile): PlanItem {
  return {
    name: displayNameOf(item),
    extension: item instanceof TFile ? item.extension : "",
    isFolder: item instanceof TFolder,
  };
}

/** Non-empty [a-z0-9] token, matching what TEMP_PREFIX_RE recognises. */
function tempToken(): string {
  return Math.random().toString(36).slice(2, 10) || "x0";
}

// ─── Settings Tab ───

class SheetNavigatorSettingTab extends PluginSettingTab {
  plugin: SheetNavigatorPlugin;

  constructor(app: App, plugin: SheetNavigatorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Sheet Navigator" });

    new Setting(containerEl)
      .setName("Enable ordering")
      .setDesc(
        "Drag-and-drop to reorder. Numbered items are renumbered sequentially; items without a number keep their name."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.orderingEnabled)
          .onChange(async (value) => {
            this.plugin.settings.orderingEnabled = value;
            await this.plugin.saveSettings();
            for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
              const view = leaf.view;
              if (view instanceof SheetNavigatorView) view.requestRender();
            }
          })
      );

    new Setting(containerEl)
      .setName("Enable review")
      .setDesc(
        "Render CriticMarkup inline and list it in the Review drawer. Turning this off leaves the markup as plain text."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.reviewEnabled).onChange(async (value) => {
          this.plugin.settings.reviewEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
          new Notice("Reload Obsidian to finish applying this change.");
        })
      );
  }
}

// ─── Modals ───

class RenameModal extends Modal {
  abstractFile: TAbstractFile;
  onSubmitCb: (newName: string) => Promise<void>;

  constructor(
    app: App,
    abstractFile: TAbstractFile,
    onSubmit: (newName: string) => Promise<void>
  ) {
    super(app);
    this.abstractFile = abstractFile;
    this.onSubmitCb = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    const isFolder = this.abstractFile instanceof TFolder;

    contentEl.createEl("h3", { text: `Rename ${isFolder ? "folder" : "note"}` });

    const currentName = displayNameOf(this.abstractFile);
    let newName = currentName;

    const submit = () => {
      const trimmed = newName.trim();
      if (trimmed && trimmed !== currentName) void this.onSubmitCb(trimmed);
      this.close();
    };

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setValue(currentName);
      text.onChange((value) => {
        newName = value;
      });
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 10);
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Rename").setCta().onClick(submit))
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface MarkupPromptOptions {
  title: string;
  /** The text being acted on, shown as monospace context. Omitted for an insertion. */
  context?: string;
  label: string;
  initial: string;
  /** Submitting this value would be a no-op, so the modal just closes. */
  unchanged?: string;
  onSubmit: (value: string) => void;
}

/** Asks for the text of a suggestion — the new wording, or what to insert. */
class MarkupPromptModal extends Modal {
  constructor(
    app: App,
    private opts: MarkupPromptOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const { title, context, label, initial, unchanged, onSubmit } = this.opts;

    contentEl.createEl("h3", { text: title });
    if (context) contentEl.createEl("p", { cls: "sn-replace-original", text: context });

    let value = initial;
    const submit = () => {
      this.close();
      const trimmed = value.trim();
      if (trimmed && trimmed !== unchanged) onSubmit(trimmed);
    };

    new Setting(contentEl).setName(label).addText((text) => {
      text.setValue(initial);
      text.onChange((v) => {
        value = v;
      });
      window.setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 10);
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Suggest").setCta().onClick(submit))
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Replaces window.confirm(), which blocks the renderer. */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private confirmLabel: string,
    private onConfirm: () => Promise<void> | void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.body });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.close();
            void this.onConfirm();
          })
      )
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─── Plugin ───

export default class SheetNavigatorPlugin extends Plugin {
  settings!: SheetNavigatorSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new SheetNavigatorView(leaf, this));
    this.registerView(VIEW_TYPE_REVIEW, (leaf) => new ReviewView(leaf));

    this.addSettingTab(new SheetNavigatorSettingTab(this.app, this));

    this.addRibbonIcon("layers", "Sheet Navigator", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-sheet-navigator",
      name: "Open Sheet Navigator",
      callback: () => void this.activateView(),
    });

    if (this.settings.reviewEnabled) this.loadReview();

    this.addCommand({
      id: "new-note-in-current-folder",
      name: "New note in current folder",
      hotkeys: [{ modifiers: ["Mod"], key: "n" }],
      checkCallback: (checking: boolean) => {
        const view = this.getActiveSheetView();
        if (view) {
          if (!checking) void view.createNewNote();
          return true;
        }
        return false;
      },
    });
  }

  // ─── Review ───

  /**
   * Rendering, commands and the context menu, all behind the one setting.
   *
   * Registered once at load rather than checked at each call site: an editor
   * extension cannot be unregistered, which is why flipping the toggle asks
   * for a reload rather than pretending to take effect immediately.
   */
  /** A command that wraps the selection and is unavailable without one. */
  private addSelectionCommand(
    id: string,
    name: string,
    kind: MarkupKind,
    hotkeys?: Hotkey[]
  ): void {
    this.addCommand({
      id,
      name,
      ...(hotkeys ? { hotkeys } : {}),
      editorCheckCallback: (checking, editor) => {
        if (!editor.somethingSelected()) return false;
        if (!checking) void this.wrapSelection(editor, kind);
        return true;
      },
    });
  }

  private loadReview(): void {
    this.registerEditorExtension(
      criticEditorExtension((offset) => this.focusReviewCard(offset))
    );
    this.registerMarkdownPostProcessor((el) => renderCriticMarkup(el));

    this.addCommand({
      id: "open-review-panel",
      name: "Open review panel",
      callback: () => void this.activateReviewView(),
    });

    // One command per construct the format supports, named so that typing
    // "suggest" in the palette turns up all three suggestion types together
    // and "markup" turns up the whole-note actions.
    this.addSelectionCommand("comment-on-selection", "Comment on selection", "comment", [
      { modifiers: ["Mod", "Shift"], key: "m" },
    ]);
    this.addSelectionCommand("highlight-selection", "Highlight selection", "highlight");
    this.addSelectionCommand("suggest-deletion", "Suggest deletion", "deletion");

    // The only one that also works without a selection: inserting text is
    // proposing something that is not there yet, so there may be nothing to
    // wrap. With a selection it marks what you just wrote as a proposal.
    this.addCommand({
      id: "suggest-insertion",
      name: "Suggest insertion…",
      editorCallback: (editor) => {
        if (editor.somethingSelected()) {
          void this.wrapSelection(editor, "insertion");
          return;
        }
        const at = editor.getCursor();
        new MarkupPromptModal(this.app, {
          title: "Suggest insertion",
          label: "Text to insert",
          initial: "",
          onSubmit: (text) => {
            editor.replaceRange(`{++${text}++}`, at);
            void this.activateReviewView(false);
          },
        }).open();
      },
    });

    this.addCommand({
      id: "suggest-replacement",
      name: "Suggest replacement…",
      editorCheckCallback: (checking, editor) => {
        if (!editor.somethingSelected()) return false;
        if (!checking) {
          // Captured now, not inside the callback: the modal takes focus, and
          // re-reading the selection afterwards is how you replace the wrong
          // range — or nothing at all.
          const selection = editor.getSelection();
          const from = editor.getCursor("from");
          const to = editor.getCursor("to");
          new MarkupPromptModal(this.app, {
            title: "Replace with",
            context: selection,
            label: "New text",
            initial: selection,
            unchanged: selection,
            onSubmit: (replacement) => {
              editor.replaceRange(`{~~${selection}~>${replacement}~~}`, from, to);
              void this.activateReviewView(false);
            },
          }).open();
        }
        return true;
      },
    });

    this.addCommand({
      id: "accept-all-markup",
      name: "Accept all markup in this note",
      editorCallback: (editor) => this.resolveAll(editor, renderAccepted),
    });

    this.addCommand({
      id: "reject-all-markup",
      name: "Reject all markup in this note",
      editorCallback: (editor) => this.resolveAll(editor, renderRejected),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!editor.somethingSelected()) return;
        menu.addSeparator();
        const wrap = (title: string, icon: string, kind: MarkupKind) =>
          menu.addItem((item) =>
            item
              .setTitle(title)
              .setIcon(icon)
              .onClick(() => void this.wrapSelection(editor, kind))
          );
        wrap("Comment on selection", "message-square-quote", "comment");
        wrap("Highlight selection", "highlighter", "highlight");
        wrap("Suggest deletion", "strikethrough", "deletion");
        wrap("Suggest insertion", "diff", "insertion");
      })
    );
  }

  /**
   * Wraps the selection in markup and opens the drawer.
   *
   * For a comment the cursor lands between the `{>>` and `<<}` so the note can
   * be typed straight into the manuscript — the drawer is for reviewing, the
   * editor is for writing.
   */
  private async wrapSelection(editor: Editor, kind: MarkupKind): Promise<void> {
    const selection = editor.getSelection();
    if (!selection) return;

    const start = editor.posToOffset(editor.getCursor("from"));

    if (kind === "comment") {
      const anchor = `{==${selection}==}`;
      editor.replaceSelection(`${anchor}{>><<}`);
      // Just past the `{>>`, so the note can be typed immediately.
      editor.setCursor(editor.offsetToPos(start + anchor.length + 3));
    } else {
      editor.replaceSelection(`${WRAPPERS[kind][0]}${selection}${WRAPPERS[kind][1]}`);
    }

    await this.activateReviewView(false);
  }

  private resolveAll(editor: Editor, transform: (content: string) => string): void {
    const content = editor.getValue();
    const next = transform(content);
    if (next === content) {
      new Notice("No markup in this note.");
      return;
    }
    editor.replaceRange(next, editor.offsetToPos(0), editor.offsetToPos(content.length));
  }

  /**
   * Highlights the card covering `offset`, if the drawer happens to be open.
   *
   * Deliberately does not open it: clicking inside a marked-up paragraph is
   * something you do while writing, and having a sidebar spring out each time
   * would be the plugin interrupting rather than answering.
   */
  private focusReviewCard(offset: number): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      if (leaf.view instanceof ReviewView) leaf.view.focusAt(offset);
    }
  }

  /** Repaints both views after a settings change. */
  refreshViews(): void {
    this.getActiveSheetView()?.requestRender();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)) {
      if (leaf.view instanceof ReviewView) leaf.view.refresh();
    }
  }

  getActiveSheetView(): SheetNavigatorView | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof SheetNavigatorView) return leaf.view;
    }
    return null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const leftLeaf = workspace.getLeftLeaf(false);
      if (leftLeaf) {
        await leftLeaf.setViewState({ type: VIEW_TYPE, active: true });
        leaf = leftLeaf;
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Opens the Review drawer in the right sidebar.
   *
   * `focus` is false when a command created markup: the caret should stay in
   * the manuscript so the comment can be typed, with the drawer merely visible.
   */
  async activateReviewView(focus = true): Promise<void> {
    const { workspace } = this.app;

    // Captured before revealing, so focus goes back to the exact editor the
    // caret was in rather than to whichever leaf happens to be most recent.
    const editorLeaf = focus ? null : workspace.getActiveViewOfType(MarkdownView)?.leaf ?? null;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      await rightLeaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
      leaf = rightLeaf;
    }

    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof ReviewView) leaf.view.requestRefresh();
    if (editorLeaf) workspace.setActiveLeaf(editorLeaf, { focus: true });
  }

  onunload(): void {}
}
