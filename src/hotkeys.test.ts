/**
 * Whether this plugin's default hotkeys can actually fire.
 *
 * A binding on a punctuation key is layout-dependent, and getting it wrong fails
 * silently: the command exists, the palette runs it, and the keystroke does
 * nothing. That is worth a test rather than a keyboard.
 *
 * Everything below the imports is Obsidian's own logic, read out of
 * `Obsidian.app/Contents/Resources/obsidian.asar` and reproduced verbatim in
 * shape. Three rules carry the whole file:
 *
 *   getModifiers(evt)      ctrlKey→'Ctrl', metaKey→'Meta', altKey→'Alt',
 *                          shiftKey→'Shift', then compileModifiers
 *   compileModifiers(list) list.map(m => m === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : m)
 *                              .sort().join(',')
 *   isMatch(hotkey, ctx)   hotkey.modifiers === ctx.modifiers &&
 *                          (hotkey.key === ctx.vkey ||
 *                           hotkey.key.toLowerCase() === ctx.key.toLowerCase())
 *
 * `vkey` comes from a keyCode table and names the *physical* key by its US label.
 * `key` is the character the layout actually produces. A binding fires when it
 * equals one or the other.
 */

import {
  COMMENT_HOTKEYS,
  hotkeysFor,
  SUGGEST_CHANGE_HOTKEYS,
  SUGGEST_DELETION_HOTKEYS,
} from './hotkeys';

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

function compileModifiers(list: string[], mac: boolean): string {
  return list
    .map((m) => (m === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : m))
    .sort()
    .join(',');
}

interface Ctx {
  modifiers: string;
  key: string;
  vkey: string;
}

/**
 * What Obsidian hands its matcher for one keystroke.
 *
 * `held` names the physical modifier keys down, the way an event reports them —
 * never `Mod`, which exists only in a hotkey definition.
 */
function press(held: string[], which: number, char: string, mac = true): Ctx {
  return {
    modifiers: compileModifiers(held, mac),
    key: char,
    vkey: KEYCODE_TO_VKEY[which] ?? `Key${which}`,
  };
}

function isMatch(hotkey: Hotkey, ctx: Ctx, mac = true): boolean {
  return (
    compileModifiers(hotkey.modifiers, mac) === ctx.modifiers &&
    (hotkey.key === ctx.vkey || hotkey.key.toLowerCase() === ctx.key.toLowerCase())
  );
}

const fires = (hotkeys: Hotkey[], ctx: Ctx, mac = true) =>
  hotkeys.some((h) => isMatch(h, ctx, mac));

// The physical key a German Mac labels '-' sits where a US board has '/', and the
// one it labels '+' sits where US has ']'. Unshifted they type '-' and '+'.
const GERMAN_MINUS = press(['Ctrl', 'Meta'], 191, '-');
const GERMAN_PLUS = press(['Ctrl', 'Meta'], 221, '+');

// A US board types '-' on keyCode 189 and reaches '+' only over 187, which types
// '=' unshifted — so that is the character the event carries.
const US_MINUS = press(['Ctrl', 'Meta'], 189, '-');
const US_EQUALS = press(['Ctrl', 'Meta'], 187, '=');

describe('Suggest deletion — ⌃⌘ and the minus key', () => {
  it('fires on a German layout', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, GERMAN_MINUS)).toBe(true);
  });

  it('fires on a US layout', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, US_MINUS)).toBe(true);
  });
});

describe('Suggest a change — ⌃⌘ and the plus key', () => {
  it('fires on a German layout', () => {
    expect(fires(SUGGEST_CHANGE_HOTKEYS, GERMAN_PLUS)).toBe(true);
  });

  it('fires on a US layout, where that key types an equals sign', () => {
    expect(fires(SUGGEST_CHANGE_HOTKEYS, US_EQUALS)).toBe(true);
  });
});

// A letter needs no list: M is M on every layout, and isMatch lowercases both
// sides, so the shifted character an event carries makes no difference.
describe('Comment on selection — ⌃⌘M', () => {
  it('fires whatever case the event reports', () => {
    expect(fires(COMMENT_HOTKEYS, press(['Ctrl', 'Meta'], 77, 'm'))).toBe(true);
    expect(fires(COMMENT_HOTKEYS, press(['Ctrl', 'Meta'], 77, 'M'))).toBe(true);
  });

  it('no longer answers the ⌘⇧M it used to be bound to', () => {
    expect(fires(COMMENT_HOTKEYS, press(['Meta', 'Shift'], 77, 'M'))).toBe(false);
  });
});

describe('no binding answers a key it has no business with', () => {
  it('keeps the three apart', () => {
    const m = press(['Ctrl', 'Meta'], 77, 'm');
    expect(fires(SUGGEST_DELETION_HOTKEYS, m)).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, m)).toBe(false);
    expect(fires(COMMENT_HOTKEYS, GERMAN_MINUS)).toBe(false);
    expect(fires(COMMENT_HOTKEYS, GERMAN_PLUS)).toBe(false);
  });

  // The reason these moved off ⌘⇧: Obsidian binds ⌘- to Zoom out and ⌘=/⌘⇧= to
  // Zoom in, and the zoom binding won.
  it('ignores the zoom shortcuts, with and without Shift', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, press(['Meta'], 189, '-'))).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, press(['Meta'], 187, '='))).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, press(['Meta', 'Shift'], 187, '+'))).toBe(false);
  });

  it('does not answer each other’s key', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, GERMAN_PLUS)).toBe(false);
    expect(fires(SUGGEST_CHANGE_HOTKEYS, GERMAN_MINUS)).toBe(false);
  });
});

// compileModifiers turns 'Mod' into 'Ctrl' off macOS, so ['Mod','Ctrl'] becomes
// 'Ctrl,Ctrl' — and getModifiers pushes 'Ctrl' once, so no keystroke can ever
// produce that string. hotkeysFor swaps the pair for Ctrl+Alt there.
describe('off macOS', () => {
  it('the macOS pair cannot fire, which is why hotkeysFor exists', () => {
    expect(fires(SUGGEST_DELETION_HOTKEYS, press(['Ctrl'], 189, '-', false), false)).toBe(
      false
    );
    expect(compileModifiers(['Mod', 'Ctrl'], false)).toBe('Ctrl,Ctrl');
  });

  const win = (hk: Parameters<typeof hotkeysFor>[0]) => hotkeysFor(hk, false);
  const ctrlAlt = (which: number, char: string) => press(['Ctrl', 'Alt'], which, char, false);

  it('fires on Ctrl+Alt with a US layout', () => {
    expect(fires(win(SUGGEST_DELETION_HOTKEYS), ctrlAlt(189, '-'), false)).toBe(true);
    expect(fires(win(SUGGEST_CHANGE_HOTKEYS), ctrlAlt(187, '='), false)).toBe(true);
    expect(fires(win(COMMENT_HOTKEYS), ctrlAlt(77, 'm'), false)).toBe(true);
  });

  it('fires on Ctrl+Alt with a German layout', () => {
    expect(fires(win(SUGGEST_DELETION_HOTKEYS), ctrlAlt(191, '-'), false)).toBe(true);
    expect(fires(win(SUGGEST_CHANGE_HOTKEYS), ctrlAlt(221, '+'), false)).toBe(true);
  });

  it('does not answer plain Ctrl, which is Zoom out and friends', () => {
    expect(fires(win(SUGGEST_DELETION_HOTKEYS), press(['Ctrl'], 189, '-', false), false)).toBe(
      false
    );
  });

  it('leaves the macOS bindings alone', () => {
    expect(hotkeysFor(COMMENT_HOTKEYS, true)).toBe(COMMENT_HOTKEYS);
  });
});
