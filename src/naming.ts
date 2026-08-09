// Filename parsing, ordering and renumbering.
//
// Deliberately free of any `obsidian` import so it stays unit-testable under
// jest's node environment. Callers pass plain { name, extension, isFolder }
// shapes; `name` is always the *display* name (basename for files, folder name
// for folders), never the on-disk name with its extension.

export interface ParsedName {
  /** Numeric prefix exactly as written, e.g. "1" or "1.2". Null when absent. */
  number: string | null;
  /** Separator between number and title as written. "" for number-only names. */
  separator: string;
  /** Title with the numeric prefix removed. "" for number-only names. */
  title: string;
}

const DASH = /[-–—]/;

/** Number-only names are capped at this many dot-separated segments. */
const MAX_BARE_SEGMENTS = 2;

/**
 * Parses a display name into its numeric prefix and title.
 *
 * One parser for both files and folders — the previous split between
 * parseItemName and parseFolderName let a card render unnumbered while a
 * reorder renumbered it, which corrupted names on disk.
 *
 * Two rules do the discriminating; src/naming.test.ts is their arbiter:
 *
 *  - A dash with no whitespace around it only separates when the title does
 *    not start with a digit, so "1-Kapitel" is chapter 1 but the date-shaped
 *    "2025-01-01 Journal" stays unnumbered.
 *  - A name consumed entirely by the number token is only treated as
 *    number-only when it has at most two segments, so "1.2" is a number but
 *    the date-shaped "2026.04.12" keeps its name.
 */
export function parseItemName(name: string): ParsedName {
  const unnumbered = (): ParsedName => ({
    number: null,
    separator: "",
    title: name.trim(),
  });
  const bare = (num: string): ParsedName =>
    num.split(".").length <= MAX_BARE_SEGMENTS
      ? { number: num, separator: "", title: "" }
      : unnumbered();

  const match = name.match(/^(\d+(?:\.\d+)*)([\s\S]*)$/);
  if (!match) return unnumbered();

  const [, num, rest] = match;
  if (rest === "") return bare(num);

  const sep = rest.match(/^([ \t]*[-–—][ \t]*|\s+)/);
  if (!sep) return unnumbered();

  const separator = sep[1];
  const title = rest.slice(separator.length).trim();
  if (!title) return bare(num);

  const isBareDash = DASH.test(separator) && !/\s/.test(separator);
  if (isBareDash && /^\d/.test(title)) return unnumbered();

  return { number: num, separator, title };
}

/**
 * Rebuilds a display name around a new number, normalising the separator's
 * spacing while preserving which dash character the user chose. An item that
 * had no number yet gets the default " – ".
 */
export function buildName(newNumber: number | string, parsed: ParsedName): string {
  if (!parsed.title) return String(newNumber);
  return `${newNumber}${normalizeSeparator(parsed.separator)}${parsed.title}`;
}

function normalizeSeparator(separator: string): string {
  if (separator === "") return " – ";
  const dash = separator.match(DASH);
  return dash ? ` ${dash[0]} ` : " ";
}

export const UNTITLED = "Untitled";

/**
 * The title to show on a card. Number-only names return the muted placeholder
 * rather than repeating the number that the badge already shows.
 */
export function displayTitle(parsed: ParsedName): { text: string; isUntitled: boolean } {
  return parsed.title
    ? { text: parsed.title, isUntitled: false }
    : { text: UNTITLED, isUntitled: true };
}

// ─── Ordering ────────────────────────────────────────────────────────────────

export interface NameItem {
  /** Display name — basename for files, folder name for folders. */
  name: string;
  isFolder: boolean;
}

/**
 * Sort order: folders first, then numbered before unnumbered, then by numeric
 * value, then by title. Sorting on the parsed number rather than on the raw
 * string guarantees the badges a user sees always read in ascending order.
 */
export function compareItems(a: NameItem, b: NameItem): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

  const pa = parseItemName(a.name);
  const pb = parseItemName(b.name);

  if ((pa.number === null) !== (pb.number === null)) {
    return pa.number === null ? 1 : -1;
  }
  if (pa.number !== null && pb.number !== null) {
    const byNumber = compareNumbers(pa.number, pb.number);
    if (byNumber !== 0) return byNumber;
  }

  const byTitle = pa.title.localeCompare(pb.title, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (byTitle !== 0) return byTitle;

  return a.name.localeCompare(b.name);
}

/** Segment-wise numeric compare so 1.9 sorts before 1.10. */
function compareNumbers(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = i < as.length ? parseInt(as[i], 10) : -1;
    const bv = i < bs.length ? parseInt(bs[i], 10) : -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// ─── Renumbering ─────────────────────────────────────────────────────────────

export interface PlanItem extends NameItem {
  /** File extension without the dot; "" for folders. */
  extension: string;
}

export interface RenameOp {
  item: PlanItem;
  newName: string;
  /** Name as it will exist on disk, extension included. */
  newFullName: string;
}

export type RenamePlan =
  | { ok: true; ops: RenameOp[] }
  | { ok: false; reason: string };

export function fullNameOf(item: { name: string; extension: string }): string {
  return item.extension ? `${item.name}.${item.extension}` : item.name;
}

export interface RenamePlanInput {
  /** Every visible child of the folder, both types. */
  items: PlanItem[];
  /**
   * Every on-disk child name in the folder, including hidden and non-markdown
   * ones, so the plan can be checked against names it cannot see.
   */
  siblingNames: string[];
  draggedName: string;
  targetName: string;
  insertBefore: boolean;
}

/**
 * Works out which items need renaming after a drag, without touching disk.
 *
 * Only items that already carry a number are renumbered. Unnumbered items keep
 * their exact filename and stay sorted to the end — dragging one adjacent to or
 * into the numbered run is the single action that gives it a number.
 *
 * Folders and files are numbered as separate sequences, so a drag never mixes
 * the two; a cross-group drop is rejected rather than silently reinterpreted.
 */
export function computeRenamePlan(input: RenamePlanInput): RenamePlan {
  const { items, siblingNames, draggedName, targetName, insertBefore } = input;

  const dragged = items.find((i) => i.name === draggedName);
  const target = items.find((i) => i.name === targetName);
  if (!dragged) return { ok: false, reason: `"${draggedName}" is no longer in this folder` };
  if (!target) return { ok: false, reason: `"${targetName}" is no longer in this folder` };
  if (dragged === target) return { ok: true, ops: [] };
  if (dragged.isFolder !== target.isFolder) {
    return { ok: false, reason: "Folders and notes are numbered separately" };
  }

  const group = items
    .filter((i) => i.isFolder === dragged.isFolder)
    .sort(compareItems);

  const order = group.filter((i) => i !== dragged);
  const targetIdx = order.indexOf(target);
  if (targetIdx === -1) return { ok: false, reason: "Drop target vanished" };
  order.splice(targetIdx + (insertBefore ? 0 : 1), 0, dragged);

  const isNumbered = (i: PlanItem) => parseItemName(i.name).number !== null;
  const draggedIdx = order.indexOf(dragged);
  const lastNumberedIdx = order.reduce(
    (acc, item, idx) => (item !== dragged && isNumbered(item) ? idx : acc),
    -1
  );

  // An unnumbered item joins the sequence when it lands inside the numbered run
  // or directly below it. Dropped deeper into the unnumbered tail it is left
  // alone — which is also why such a drag is a no-op.
  const draggedJoins = isNumbered(dragged) || draggedIdx <= lastNumberedIdx + 1;

  const sequence = order.filter((i) => (i === dragged ? draggedJoins : isNumbered(i)));

  const ops: RenameOp[] = [];
  sequence.forEach((item, idx) => {
    const newName = buildName(idx + 1, parseItemName(item.name));
    if (newName === item.name) return;
    ops.push({ item, newName, newFullName: fullNameOf({ ...item, name: newName }) });
  });

  const renamedAway = new Set(ops.map((op) => fullNameOf(op.item)));
  const taken = new Set(siblingNames.filter((n) => !renamedAway.has(n)));
  for (const op of ops) {
    if (taken.has(op.newFullName)) {
      return { ok: false, reason: `"${op.newFullName}" already exists` };
    }
    taken.add(op.newFullName);
  }

  return { ok: true, ops };
}

// ─── Two-phase rename scratch names ──────────────────────────────────────────

/**
 * Anchored, and non-greedy in the random segment. A greedy `/^__sn_.*_/` would
 * strip through the *last* underscore, turning "__sn_ab12cd34_2 – My_File.md"
 * into "File.md" — this regex is the recovery path, so it must not eat names.
 */
export const TEMP_PREFIX_RE = /^__sn_[a-z0-9]+_/;

export function makeTempName(token: string, fullName: string): string {
  return `__sn_${token}_${fullName}`;
}

export function isTempName(fullName: string): boolean {
  return TEMP_PREFIX_RE.test(fullName);
}

/**
 * Recovers the name an interrupted reorder was renaming *towards* — the temp
 * name encodes its own destination, so stripping the prefix rolls the rename
 * forward rather than backwards. Returns null when the name is not a temp name.
 */
export function recoverTempName(fullName: string): string | null {
  if (!isTempName(fullName)) return null;
  const recovered = fullName.replace(TEMP_PREFIX_RE, "");
  return recovered.length > 0 ? recovered : null;
}
