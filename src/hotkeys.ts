// The two default hotkeys, in a file of their own so a test can check that they
// can actually fire.
//
// Free of any runtime `obsidian` import — only the Hotkey type, which erases —
// so hotkeys.test.ts can read these under jest's node environment.

import type { Hotkey } from 'obsidian';

/**
 * Why these sit on ⌃⌘, and why each is a list.
 *
 * **The modifier.** ⌘⇧ was the obvious choice and it does not survive contact
 * with Obsidian, which binds ⌘- to Zoom out and both ⌘= and ⌘⇧= to Zoom in. Zoom
 * won. ⌃⌘ is free, keeps the minus-means-cut and plus-means-add reading, and is
 * still one hand.
 *
 * **The list.** Obsidian matches a keystroke like this, and both halves matter:
 *
 *     hotkey.key === event.vkey || hotkey.key.toLowerCase() === event.key.toLowerCase()
 *
 * `vkey` comes from a keyCode table that names the *physical* key by its US
 * label — so on a German board the key printed `-` reports `/`, because that is
 * where `/` sits on a US board. `key` is the character the layout actually types.
 * So one entry cannot cover both: a German writer's minus key matches on the
 * character, a US writer's on the vkey. The plus key needs the same treatment
 * plus one more entry, because a US board reaches `+` only over the `=` key,
 * which types `=` when no Shift is held.
 *
 * **What this does not cover.** `compileModifiers` rewrites `Mod` to `Ctrl` off
 * macOS, so `['Mod','Ctrl']` becomes the string `Ctrl,Ctrl` there — and no
 * keystroke can produce that, because an event reports Ctrl once. These are macOS
 * bindings. A writer on Windows or Linux, or on a layout that reaches these keys
 * some third way, records their own in Settings → Hotkeys, which overrides
 * everything here. hotkeys.test.ts pins that limit rather than leaving it to be
 * rediscovered.
 */
export const SUGGEST_DELETION_HOTKEYS: Hotkey[] = [
  { modifiers: ['Mod', 'Ctrl'], key: '-' }, // German: the character; US: the vkey
];

export const SUGGEST_CHANGE_HOTKEYS: Hotkey[] = [
  { modifiers: ['Mod', 'Ctrl'], key: '+' }, // German: the character
  { modifiers: ['Mod', 'Ctrl'], key: '=' }, // US: that key types '=' unshifted
];
