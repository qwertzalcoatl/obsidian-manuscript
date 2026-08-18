// The two default hotkeys, in a file of their own so a test can check that they
// can actually fire.
//
// Free of any runtime `obsidian` import — only the Hotkey type, which erases —
// so hotkeys.test.ts can read these under jest's node environment.

import type { Hotkey } from 'obsidian';

/**
 * Why each of these is a list rather than one binding.
 *
 * Obsidian matches a keystroke against a hotkey like this, and both halves of the
 * comparison matter:
 *
 *     hotkey.key === event.vkey || hotkey.key.toLowerCase() === event.key.toLowerCase()
 *
 * `vkey` comes from a keyCode table that names the *physical* key by its US
 * label — so on a German board the key printed `-` reports `/`, because that is
 * where `/` sits on a US board. `key` is the character the layout actually
 * produces, Shift applied: German `⇧-` gives `_`, German `⇧+` gives `*`.
 *
 * So a single `key: '-'` fires on a US layout and cannot fire on a German one,
 * which is exactly what shipping one binding did. Listing the characters the
 * shifted key produces makes the same physical key work on both, with no
 * per-platform branching and nothing for the writer to configure.
 *
 * `⌘⇧` rather than a bare `⌘`, because Obsidian binds `⌘-` to Zoom out and `⌘=`
 * to Zoom in. It also puts these beside the `⌘⇧M` this plugin already claims.
 *
 * A layout that reaches these two keys some third way needs a binding recorded in
 * Settings → Hotkeys, which overrides everything here.
 */
export const SUGGEST_DELETION_HOTKEYS: Hotkey[] = [
  { modifiers: ['Mod', 'Shift'], key: '-' }, // US: vkey 189
  { modifiers: ['Mod', 'Shift'], key: '_' }, // German, US: what ⇧ over that key types
];

export const SUGGEST_CHANGE_HOTKEYS: Hotkey[] = [
  { modifiers: ['Mod', 'Shift'], key: '+' }, // US: ⇧ over 187 types '+'
  { modifiers: ['Mod', 'Shift'], key: '*' }, // German: ⇧ over the '+' key types '*'
];
