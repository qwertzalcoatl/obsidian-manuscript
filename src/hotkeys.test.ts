/**
 * Whether this plugin's default hotkeys can actually fire.
 *
 * A binding on a punctuation key is layout-dependent, and getting it wrong fails
 * silently: the command exists, the palette runs it, and the keystroke simply
 * does nothing. That is worth a test rather than a keyboard.
 *
 * `isMatch` and `contextOf` below are Obsidian's own logic, read out of
 * `Obsidian.app/Contents/Resources/obsidian.asar` and reproduced here. The two
 * lines that matter:
 *
 *   isMatch = (hotkey, ctx) =>
 *     hotkey.modifiers === ctx.modifiers &&
 *     (hotkey.key === ctx.vkey || hotkey.key.toLowerCase() === ctx.key.toLowerCase())
 *
 *   ctx.vkey = KEYCODE_TO_VKEY[evt.which] ?? 'Key' + evt.which
 *
 * `vkey` is derived from `which`, which follows the *physical* key under a
 * US mapping — so it is the US label of whatever key the finger is on. `key` is
 * the character the layout actually produces, Shift included. A binding fires
 * when it equals one or the other.
 */

import { SUGGEST_CHANGE_HOTKEYS, SUGGEST_DELETION_HOTKEYS } from './hotkeys';

interface Hotkey {
  modifiers: string[];
  key: string;
}

/** The part of Obsidian's keyCode table this test needs. Same values, same source. */
const KEYCODE_TO_VKEY: Record<number, string> = {
  187: '=',
  189: '-',
  191: '/',
  221: ']',
};

interface Ctx {
  modifiers: string;
  key: string;
  vkey: string;
}

/** What Obsidian hands its hotkey matcher for one keystroke. */
function contextOf(modifiers: string[], which: number, char: string): Ctx {
  return {
    modifiers: modifiers.join(','),
    key: char,
    vkey: KEYCODE_TO_VKEY[which] ?? `Key${which}`,
  };
}

function isMatch(hotkey: Hotkey, ctx: Ctx): boolean {
  return (
    hotkey.modifiers.join(',') === ctx.modifiers &&
    (hotkey.key === ctx.vkey || hotkey.key.toLowerCase() === ctx.key.toLowerCase())
  );
}

const fires = (hotkeys: Hotkey[], ctx: Ctx) => hotkeys.some((h) => isMatch(h, ctx));

// The physical key a German Mac labels '-' sits where a US board has '/', and the
// one it labels '+' sits where US has ']'. Shift turns them into '_' and '*'.
const GERMAN_MINUS = contextOf(['Mod', 'Shift'], 191, '_');
const GERMAN_PLUS = contextOf(['Mod', 'Shift'], 221, '*');

// A US board reaches '-' unshifted on keyCode 189 and '+' as Shift over 187.
const US_MINUS = contextOf(['Mod', 'Shift'], 189, '_');
const US_PLUS = contextOf(['Mod', 'Shift'], 187, '+');

describe('Suggest deletion — ⌘⇧ and the minus key', () => {
  it('fires on a German layout', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, GERMAN_MINUS)).toBe(true);
  });

  it('fires on a US layout', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, US_MINUS)).toBe(true);
  });
});

describe('Suggest a change — ⌘⇧ and the plus key', () => {
  it('fires on a German layout', () => {
    expect(fires(SUGGEST_CHANGE_HOTKEYS, GERMAN_PLUS)).toBe(true);
  });

  it('fires on a US layout', () => {
    expect(fires(SUGGEST_CHANGE_HOTKEYS, US_PLUS)).toBe(true);
  });
});

describe('neither binding answers a key it has no business with', () => {
  it('ignores ⌘⇧M, which belongs to Comment on selection', () => {
    const m = contextOf(['Mod', 'Shift'], 77, 'M');
    expect(fires(SUGGEST_DELETION_HOTKEYS, m)).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, m)).toBe(false);
  });

  it('ignores the same keys without Shift, which Obsidian uses for zoom', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, contextOf(['Mod'], 189, '-'))).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, contextOf(['Mod'], 187, '='))).toBe(false);
  });

  it('does not answer each other’s key', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, GERMAN_PLUS)).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, GERMAN_MINUS)).toBe(false);
  });
});
