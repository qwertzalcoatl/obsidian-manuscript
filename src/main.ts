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
  Notice,
  Platform,
} from "obsidian";
import { checkPdflatex, ExportModal } from './export';

const VIEW_TYPE = "sheet-navigator-view";
const PREVIEW_LENGTH = 120;

interface SheetNavigatorSettings {
  orderingEnabled: boolean;
  latexExportEnabled: boolean;
  pdflatexPath: string;
}

const DEFAULT_SETTINGS: SheetNavigatorSettings = {
  orderingEnabled: false,
  latexExportEnabled: false,
  pdflatexPath: 'pdflatex',
};

interface ParsedName {
  number: string | null;
  separator: string;
  title: string;
}

interface HistoryEntry {
  path: string;
  name: string;
}

interface DragState {
  name: string;
  el: HTMLElement;
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
  exportBtnEl: HTMLElement | null = null;
  selectedPaths: Set<string> = new Set();
  isSelectionMode: boolean = false;

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
      this.app.workspace.on("file-open", () => this.highlightActive())
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.isReordering) return;
        if (
          file instanceof TFile &&
          file.parent &&
          this.getPathStr(file.parent) === this.currentPath
        ) {
          this.renderCurrentFolder();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", () => {
        if (!this.isReordering) this.renderCurrentFolder();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        if (!this.isReordering) this.renderCurrentFolder();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", () => {
        if (!this.isReordering) this.renderCurrentFolder();
      })
    );

    this.registerDomEvent(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isSelectionMode) {
        this.exitSelectionMode();
      }
    });

    this.renderCurrentFolder();
  }

  getPathStr(folder: TFolder): string {
    return folder.path === "" ? "/" : "/" + folder.path;
  }

  getFolderByPath(path: string): TFolder {
    if (path === "/") return this.app.vault.getRoot();
    const folderPath = path.startsWith("/") ? path.slice(1) : path;
    const af = this.app.vault.getAbstractFileByPath(folderPath);
    if (af instanceof TFolder) return af;
    return this.app.vault.getRoot();
  }

  sortChildren(folder: TFolder): TAbstractFile[] {
    const children = [...folder.children].filter((c) => {
      if (c.name.startsWith(".")) return false;
      if (c instanceof TFile && c.extension !== "md") return false;
      return true;
    });

    children.sort((a, b) => {
      const aIsFolder = a instanceof TFolder;
      const bIsFolder = b instanceof TFolder;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    return children;
  }

  parseItemName(name: string): ParsedName {
    // Number + dash separator + title
    const m1 = name.match(/^([\d]+(?:\.[\d]+)*)([\s]*[–—-][\s]+)(.+)$/);
    if (m1) return { number: m1[1], separator: m1[2], title: m1[3] };

    // Number + space + title (no dash)
    const m2 = name.match(/^([\d]+(?:\.[\d]+)*)\s+(.+)$/);
    if (m2) return { number: m2[1], separator: " ", title: m2[2] };

    // Just a number
    const m3 = name.match(/^([\d]+(?:\.[\d]+)*)$/);
    if (m3) return { number: m3[1], separator: "", title: "" };

    // No number prefix
    return { number: null, separator: "", title: name };
  }

  buildNewName(newNumber: number, parsed: ParsedName): string {
    if (parsed.title) {
      const sep = parsed.separator || " – ";
      return `${newNumber}${sep}${parsed.title}`;
    }
    return `${newNumber}`;
  }

  parseFolderName(name: string): { number: string | null; title: string } {
    const match = name.match(/^(\d+)\s*[-–—]\s*(.+)$/);
    if (match) return { number: match[1], title: match[2] };
    return { number: null, title: name };
  }

  async renderCurrentFolder(): Promise<void> {
    const folder = this.getFolderByPath(this.currentPath);
    const ordering = this.plugin.settings.orderingEnabled;

    // Header
    this.headerEl.empty();

    if (this.currentPath !== "/") {
      const backBtn = this.headerEl.createDiv({ cls: "sheet-nav-back" });
      const arrow = backBtn.createSpan({ cls: "sheet-nav-back-arrow" });
      arrow.setText("‹");
      const parentName =
        this.history.length > 0
          ? this.history[this.history.length - 1].name
          : "Vault";
      backBtn.createSpan({ text: parentName, cls: "sheet-nav-back-label" });
      backBtn.addEventListener("click", () => this.goUp());
    }

    const titleRow = this.headerEl.createDiv({ cls: "sheet-nav-title-row" });
    const title = titleRow.createDiv({ cls: "sheet-nav-title" });
    title.setText(folder.name || "Vault");

    const toolbar = titleRow.createDiv({ cls: "sheet-nav-toolbar" });

    const newBtn = toolbar.createDiv({
      cls: "sheet-nav-toolbar-btn",
      attr: { "aria-label": "New note" },
    });
    newBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
    newBtn.addEventListener("click", () => this.createNewNote());

    if (Platform.isDesktop && this.plugin.settings.latexExportEnabled) {
      const exportBtn = toolbar.createDiv({
        cls: "sheet-nav-toolbar-btn sheet-nav-export-btn",
        attr: { "aria-label": "Export to PDF" },
      });
      exportBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      this.exportBtnEl = exportBtn;

      exportBtn.classList.add("is-dimmed");

      exportBtn.addEventListener("click", () => {
        if (!Platform.isDesktop || !this.plugin.settings.latexExportEnabled) return;
        if (this.selectedPaths.size === 0) {
          new Notice("Right-click items to select them for export.");
          return;
        }
        new ExportModal(this.app, this.plugin, this, new Set(this.selectedPaths)).open();
      });
    } else {
      this.exportBtnEl = null;
    }

    // List
    this.listEl.empty();

    const children = this.sortChildren(folder);

    for (const child of children) {
      if (child instanceof TFolder) {
        this.renderFolderCard(child, ordering);
      } else if (child instanceof TFile && child.extension === "md") {
        await this.renderFileCard(child, ordering);
      }
    }

    this.highlightActive();
    this.updateSelectionUI();
  }

  makeDraggable(card: HTMLElement, itemName: string): void {
    card.setAttribute("draggable", "true");
    card.dataset.itemName = itemName;

    card.addEventListener("dragstart", (e: DragEvent) => {
      this.dragState = { name: itemName, el: card };
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
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      if (!this.dragState || this.dragState.name === itemName) return;

      this.clearDropIndicators();
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        card.classList.add("drop-above");
      } else {
        card.classList.add("drop-below");
      }
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-above");
      card.classList.remove("drop-below");
    });

    card.addEventListener("drop", async (e: DragEvent) => {
      e.preventDefault();
      if (!this.dragState || this.dragState.name === itemName) return;

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;

      this.clearDropIndicators();
      await this.reorder(this.dragState.name, itemName, insertBefore);
      this.dragState = null;
    });
  }

  clearDropIndicators(): void {
    this.listEl
      .querySelectorAll(".drop-above, .drop-below")
      .forEach((el) => {
        el.classList.remove("drop-above");
        el.classList.remove("drop-below");
      });
  }

  async reorder(
    draggedName: string,
    targetName: string,
    insertBefore: boolean
  ): Promise<void> {
    this.isReordering = true;

    try {
      const folder = this.getFolderByPath(this.currentPath);
      const children = this.sortChildren(folder);

      const ordered = [...children];
      const fromIdx = ordered.findIndex((c) => c.name === draggedName);
      if (fromIdx === -1) return;
      const [moved] = ordered.splice(fromIdx, 1);

      let toIdx = ordered.findIndex((c) => c.name === targetName);
      if (toIdx === -1) return;
      if (!insertBefore) toIdx++;
      ordered.splice(toIdx, 0, moved);

      // Build rename plan
      const renames: { child: TAbstractFile; newFullName: string }[] = [];
      for (let i = 0; i < ordered.length; i++) {
        const child = ordered[i];
        const isFile = child instanceof TFile;
        const displayName = isFile
          ? (child as TFile).basename
          : child.name;
        const parsed = this.parseItemName(displayName);

        const newNum = i + 1;
        let newDisplayName: string;

        if (parsed.number !== null) {
          newDisplayName = this.buildNewName(newNum, parsed);
        } else {
          newDisplayName = `${newNum} – ${parsed.title}`;
        }

        const newFullName = isFile
          ? `${newDisplayName}.${(child as TFile).extension}`
          : newDisplayName;

        if (newFullName !== child.name) {
          renames.push({ child, newFullName });
        }
      }

      if (renames.length === 0) return;

      // Phase 1: rename to temp names (avoids conflicts)
      const tempItems: { tempPath: string; finalFullName: string }[] = [];
      for (const r of renames) {
        const parentPath = r.child.parent ? r.child.parent.path : "";
        const tempName = `__sn_${Math.random().toString(36).slice(2, 10)}_${r.newFullName}`;
        const tempPath = parentPath
          ? `${parentPath}/${tempName}`
          : tempName;
        await this.app.fileManager.renameFile(r.child, tempPath);
        tempItems.push({ tempPath, finalFullName: r.newFullName });
      }

      // Phase 2: rename temp to final
      for (const t of tempItems) {
        const af = this.app.vault.getAbstractFileByPath(t.tempPath);
        if (af) {
          const parentPath = af.parent ? af.parent.path : "";
          const finalPath = parentPath
            ? `${parentPath}/${t.finalFullName}`
            : t.finalFullName;
          await this.app.fileManager.renameFile(af, finalPath);
        }
      }
    } finally {
      this.isReordering = false;
    }

    await this.renderCurrentFolder();
  }

  renderFolderCard(folder: TFolder, ordering: boolean): void {
    const card = this.listEl.createDiv({
      cls: "sheet-nav-card sheet-nav-folder-card",
    });
    card.dataset.itemName = folder.name;
    card.dataset.absPath = folder.path;

    if (ordering) {
      const dragHandle = card.createDiv({ cls: "sheet-nav-drag-handle" });
      dragHandle.setText("⠿");
    }

    const parsed = this.parseFolderName(folder.name);

    if (parsed.number) {
      const numEl = card.createDiv({ cls: "sheet-nav-chapter-num" });
      numEl.setText(parsed.number);
    }

    const content = card.createDiv({ cls: "sheet-nav-folder-content" });

    const nameEl = content.createDiv({ cls: "sheet-nav-card-name" });
    nameEl.setText(parsed.title);

    const mdFiles = folder.children.filter(
      (c) => c instanceof TFile && c.extension === "md"
    );
    const subfolders = folder.children.filter((c) => c instanceof TFolder);
    const countEl = content.createDiv({ cls: "sheet-nav-card-meta" });
    const parts: string[] = [];
    if (subfolders.length > 0)
      parts.push(
        `${subfolders.length} folder${subfolders.length > 1 ? "s" : ""}`
      );
    if (mdFiles.length > 0)
      parts.push(
        `${mdFiles.length} note${mdFiles.length > 1 ? "s" : ""}`
      );
    countEl.setText(parts.join(" · "));

    const chevron = card.createDiv({ cls: "sheet-nav-chevron" });
    chevron.setText("›");

    // Card-level: handles selection anywhere on the card (number, padding, content)
    card.addEventListener("click", (e: MouseEvent) => {
      if (!this.isSelectionMode) return;
      e.shiftKey ? this.selectRange(folder.path) : this.toggleSelection(folder.path);
    });
    // Content-level: handles navigation when not in selection mode
    content.addEventListener("click", () => {
      if (this.isSelectionMode) return; // card-level handles it
      this.drillInto(folder);
    });
    chevron.addEventListener("click", (e: MouseEvent) => {
      // Chevron always drills in — stopPropagation prevents card-level selection handler
      e.stopPropagation();
      this.drillInto(folder);
    });
    card.addEventListener("contextmenu", (e) =>
      this.showContextMenu(e, folder)
    );

    if (ordering) {
      this.makeDraggable(card, folder.name);
    }
  }

  async renderFileCard(file: TFile, ordering: boolean): Promise<void> {
    const card = this.listEl.createDiv({
      cls: "sheet-nav-card sheet-nav-file-card",
    });
    card.dataset.path = file.path;
    card.dataset.itemName = file.name;
    card.dataset.absPath = file.path;

    if (ordering) {
      const dragHandle = card.createDiv({ cls: "sheet-nav-drag-handle" });
      dragHandle.setText("⠿");
    }

    const parsed = this.parseItemName(file.basename);

    if (parsed.number) {
      const numEl = card.createDiv({ cls: "sheet-nav-file-num" });
      numEl.setText(parsed.number);
    }

    const content = card.createDiv({ cls: "sheet-nav-file-content" });

    const displayName = parsed.title || parsed.number || file.basename;
    const titleEl = content.createDiv({ cls: "sheet-nav-card-title" });
    titleEl.setText(displayName);

    try {
      const rawContent = await this.app.vault.cachedRead(file);
      const snippet = this.extractSnippet(rawContent);
      if (snippet) {
        const previewEl = content.createDiv({
          cls: "sheet-nav-card-preview",
        });
        previewEl.setText(snippet);
      }
    } catch {
      // File might not be readable
    }

    // Card-level: handles selection anywhere on the card
    card.addEventListener("click", (e: MouseEvent) => {
      if (!this.isSelectionMode) return;
      e.shiftKey ? this.selectRange(file.path) : this.toggleSelection(file.path);
    });
    // Content-level: opens note when not in selection mode
    content.addEventListener("click", () => {
      if (this.isSelectionMode) return;
      this.app.workspace.openLinkText(file.path, "", false);
    });

    card.addEventListener("contextmenu", (e) =>
      this.showContextMenu(e, file)
    );

    if (ordering) {
      this.makeDraggable(card, file.name);
    }
  }

  async createNewNote(): Promise<void> {
    const folder = this.getFolderByPath(this.currentPath);
    const children = this.sortChildren(folder);

    let maxNum = 0;
    for (const child of children) {
      const name =
        child instanceof TFile ? (child as TFile).basename : child.name;
      const parsed = this.parseItemName(name);
      if (parsed.number !== null) {
        const n = parseInt(parsed.number, 10);
        if (n > maxNum) maxNum = n;
      }
    }
    const nextNum = maxNum + 1;

    const folderPath = folder.path || "";
    const filePath = folderPath
      ? `${folderPath}/${nextNum}.md`
      : `${nextNum}.md`;

    const newFile = await this.app.vault.create(filePath, "");
    await this.app.workspace.openLinkText(newFile.path, "", false);
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
          new RenameModal(
            this.app,
            abstractFile,
            async (newName: string) => {
              const oldPath = abstractFile.path;
              const parentPath = oldPath.substring(
                0,
                oldPath.lastIndexOf("/")
              );
              const ext = isFolder
                ? ""
                : "." + (abstractFile as TFile).extension;
              const newPath = parentPath
                ? parentPath + "/" + newName + ext
                : newName + ext;
              await this.app.fileManager.renameFile(
                abstractFile,
                newPath
              );
            }
          ).open();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(async () => {
          const label = isFolder ? "folder" : "note";
          const confirmed = confirm(
            `Delete ${label} "${abstractFile.name}"?`
          );
          if (confirmed) {
            await this.app.vault.trash(abstractFile, true);
          }
        });
    });

    menu.addSeparator();

    menu.addItem((item) => {
      item
        .setTitle("Copy vault path")
        .setIcon("copy")
        .onClick(() => {
          navigator.clipboard.writeText(abstractFile.path);
          new Notice("Vault path copied");
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Copy absolute path")
        .setIcon("copy")
        .onClick(() => {
          const adapter = this.app.vault.adapter;
          if (adapter instanceof FileSystemAdapter) {
            const absPath =
              adapter.getBasePath() + "/" + abstractFile.path;
            navigator.clipboard.writeText(absPath);
            new Notice("Absolute path copied");
          }
        });
    });

    if (Platform.isDesktop && this.plugin.settings.latexExportEnabled) {
      menu.addSeparator();
      menu.addItem(item => {
        item
          .setTitle(
            this.selectedPaths.has(abstractFile.path)
              ? 'Deselect'
              : 'Select for export'
          )
          .setIcon('check-square')
          .onClick(() => {
            if (this.selectedPaths.has(abstractFile.path)) {
              this.toggleSelection(abstractFile.path);
            } else {
              if (!this.isSelectionMode) {
                this.enterSelectionMode(abstractFile.path);
              } else {
                this.toggleSelection(abstractFile.path);
              }
            }
          });
      });
    }

    menu.showAtMouseEvent(e);
  }

  extractSnippet(content: string): string {
    let text = content;
    if (text.startsWith("---")) {
      const endIdx = text.indexOf("---", 3);
      if (endIdx !== -1) text = text.slice(endIdx + 3);
    }

    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    const snippet = lines.slice(0, 3).join(" ");
    if (snippet.length > PREVIEW_LENGTH) {
      return snippet.slice(0, PREVIEW_LENGTH) + "…";
    }
    return snippet || "";
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
    if (this.isSelectionMode) this.exitSelectionMode();
    this.history.push({
      path: this.currentPath,
      name: this.getFolderByPath(this.currentPath).name || "Vault",
    });
    this.currentPath = this.getPathStr(folder);
    this.renderCurrentFolder();
  }

  goUp(): void {
    if (this.isSelectionMode) this.exitSelectionMode();
    if (this.history.length > 0) {
      const prev = this.history.pop()!;
      this.currentPath = prev.path;
    } else {
      this.currentPath = "/";
    }
    this.renderCurrentFolder();
  }

  // ─── Selection ───────────────────────────────────────────────────────────

  enterSelectionMode(absPath: string): void {
    this.isSelectionMode = true;
    this.selectedPaths.add(absPath);
    this.updateSelectionUI();
  }

  exitSelectionMode(): void {
    this.isSelectionMode = false;
    this.selectedPaths.clear();
    this.updateSelectionUI();
  }

  toggleSelection(absPath: string): void {
    if (this.selectedPaths.has(absPath)) {
      this.selectedPaths.delete(absPath);
      if (this.selectedPaths.size === 0) {
        this.isSelectionMode = false;
      }
    } else {
      this.selectedPaths.add(absPath);
      this.isSelectionMode = true;
    }
    this.updateSelectionUI();
  }

  selectRange(targetPath: string): void {
    if (this.selectedPaths.size === 0) {
      this.selectedPaths.add(targetPath);
      this.isSelectionMode = true;
      this.updateSelectionUI();
      return;
    }

    // All visible item paths in visual order
    const allPaths: string[] = [];
    this.listEl.querySelectorAll<HTMLElement>('[data-abs-path]').forEach(el => {
      const p = el.dataset.absPath;
      if (p) allPaths.push(p);
    });

    // Anchor = last item added to selection
    const anchor = [...this.selectedPaths][this.selectedPaths.size - 1];
    const fromIdx = allPaths.indexOf(anchor);
    const toIdx = allPaths.indexOf(targetPath);

    if (fromIdx === -1 || toIdx === -1) {
      this.selectedPaths.add(targetPath);
    } else {
      const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      for (let i = start; i <= end; i++) {
        this.selectedPaths.add(allPaths[i]);
      }
    }

    this.isSelectionMode = true;
    this.updateSelectionUI();
  }

  updateSelectionUI(): void {
    // Update card highlight states
    this.listEl.querySelectorAll<HTMLElement>('[data-abs-path]').forEach(el => {
      const p = el.dataset.absPath ?? '';
      el.classList.toggle('is-selected', this.selectedPaths.has(p));
    });

    // Update export button dim/active state
    if (this.exportBtnEl) {
      const hasSelection = this.selectedPaths.size > 0;
      this.exportBtnEl.classList.toggle('is-dimmed', !hasSelection);
      this.exportBtnEl.classList.toggle('is-active', hasSelection);
    }

    // Update selection mode body class for cursor hint
    this.containerEl.classList.toggle('is-selection-mode', this.isSelectionMode);
  }

  async onClose(): Promise<void> {
    this.containerEl.empty();
  }
}

// ─── Settings Tab ───

class SheetNavigatorSettingTab extends PluginSettingTab {
  plugin: SheetNavigatorPlugin;
  private validationTimer: ReturnType<typeof setTimeout> | null = null;

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
        "Drag-and-drop to reorder. Items are renumbered by renaming their numeric prefix (1, 2, 3…)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.orderingEnabled)
          .onChange(async (value) => {
            this.plugin.settings.orderingEnabled = value;
            await this.plugin.saveSettings();
            const leaves =
              this.app.workspace.getLeavesOfType(VIEW_TYPE);
            for (const leaf of leaves) {
              const view = leaf.view as SheetNavigatorView;
              if (view && view.renderCurrentFolder) {
                view.renderCurrentFolder();
              }
            }
          })
      );

    if (!Platform.isDesktop) return;

    containerEl.createEl('h3', { text: 'PDF Export' });

    new Setting(containerEl)
      .setName('Enable PDF export')
      .setDesc('Adds export to PDF via pdflatex. Requires a TeX distribution (MacTeX, MiKTeX, or TeX Live).')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.latexExportEnabled)
          .onChange(async value => {
            this.plugin.settings.latexExportEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (!this.plugin.settings.latexExportEnabled) return;

    new Setting(containerEl)
      .setName('pdflatex path')
      .setDesc('Full path to the pdflatex binary, or just "pdflatex" if it is on your PATH.')
      .addText(text => {
        text.setValue(this.plugin.settings.pdflatexPath);
        text.onChange(async value => {
          this.plugin.settings.pdflatexPath = value.trim() || 'pdflatex';
          await this.plugin.saveSettings();
          this.validatePdflatex(statusEl);
        });
      });

    const statusEl = containerEl.createDiv({ cls: 'sn-pdflatex-status' });

    // Validate on first render
    this.validatePdflatex(statusEl);
  }

  private validatePdflatex(statusEl: HTMLElement): void {
    // Cancel any pending check so stale callbacks never update a detached element
    if (this.validationTimer !== null) {
      clearTimeout(this.validationTimer);
      this.validationTimer = null;
    }
    statusEl.setText('Checking…');
    statusEl.className = 'sn-pdflatex-status';
    // Snapshot the path now; run after paint so "Checking…" renders first
    const pathToCheck = this.plugin.settings.pdflatexPath;
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      const found = checkPdflatex(pathToCheck);
      statusEl.setText(
        found
          ? '✓ pdflatex found'
          : '✗ Not found — install MacTeX, MiKTeX, or TeX Live'
      );
      statusEl.className = `sn-pdflatex-status ${found ? 'sn-pdflatex-found' : 'sn-pdflatex-missing'}`;
    }, 0);
  }
}

// ─── Rename Modal ───

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

    contentEl.createEl("h3", {
      text: `Rename ${isFolder ? "folder" : "note"}`,
    });

    const currentName = isFolder
      ? this.abstractFile.name
      : (this.abstractFile as TFile).basename;

    let newName = currentName;

    new Setting(contentEl).setName("Name").addText((text) => {
      text.setValue(currentName);
      text.onChange((value) => {
        newName = value;
      });
      setTimeout(() => {
        text.inputEl.focus();
        text.inputEl.select();
      }, 10);
      text.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (newName && newName !== currentName) {
            this.onSubmitCb(newName);
          }
          this.close();
        }
      });
    });

    new Setting(contentEl)
      .addButton((btn) => {
        btn
          .setButtonText("Rename")
          .setCta()
          .onClick(() => {
            if (newName && newName !== currentName) {
              this.onSubmitCb(newName);
            }
            this.close();
          });
      })
      .addButton((btn) => {
        btn.setButtonText("Cancel").onClick(() => this.close());
      });
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

    this.registerView(
      VIEW_TYPE,
      (leaf) => new SheetNavigatorView(leaf, this)
    );

    this.addSettingTab(new SheetNavigatorSettingTab(this.app, this));

    this.addRibbonIcon("layers", "Sheet Navigator", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-sheet-navigator",
      name: "Open Sheet Navigator",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-note-in-current-folder",
      name: "New note in current folder",
      hotkeys: [{ modifiers: ["Shift"], key: "n" }],
      checkCallback: (checking: boolean) => {
        const view = this.getActiveSheetView();
        if (view) {
          if (!checking) view.createNewNote();
          return true;
        }
        return false;
      },
    });
  }

  getActiveSheetView(): SheetNavigatorView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (leaves.length > 0 && leaves[0].view) {
      return leaves[0].view as SheetNavigatorView;
    }
    return null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
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

  onunload(): void {}
}
