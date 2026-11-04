/** Global shortcuts. Zod-free so the renderer can import it. */

export const HOTKEY_ACTIONS = ['toggleCopilot', 'pauseListening'] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export interface HotkeyStatus {
  action: HotkeyAction;
  accelerator: string | null;
  /** False if another app already uses the shortcut. */
  registered: boolean;
}

const MODIFIERS = [
  'CommandOrControl',
  'CmdOrCtrl',
  'Command',
  'Cmd',
  'Control',
  'Ctrl',
  'Alt',
  'Option',
  'AltGr',
  'Shift',
  'Super',
  'Meta',
] as const;
/** Modifiers that make a shortcut safe to register globally (Shift alone would eat typing). */
const STRONG_MODIFIERS = new Set<string>(MODIFIERS.filter((m) => m !== 'Shift'));
const NAMED_KEYS = new Set([
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Enter',
  'Return',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Esc',
  'Plus',
]);

/** True for an Electron accelerator with at least one non-Shift modifier and one key. */
export function isValidAccelerator(value: string): boolean {
  const parts = value.split('+');
  if (parts.length < 2) return false;
  const key = parts.at(-1)!;
  const mods = parts.slice(0, -1);
  if (new Set(mods).size !== mods.length) return false;
  if (!mods.every((m) => (MODIFIERS as readonly string[]).includes(m))) return false;
  if (!mods.some((m) => STRONG_MODIFIERS.has(m))) return false;
  return (
    /^[A-Z0-9]$/.test(key) ||
    /^F([1-9]|1[0-9]|2[0-4])$/.test(key) ||
    NAMED_KEYS.has(key) ||
    /^[`\-=[\];',./\\]$/.test(key)
  );
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
};

/**
 * Turns a key press into an Electron accelerator, or null while only
 * modifiers are held or the key isn't supported. Uses `code`, so the result
 * doesn't depend on the keyboard layout.
 */
export function acceleratorFromKey(
  e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean },
  platform: string,
): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code];
  if (!key) return null;
  const mac = platform === 'darwin';
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl');
  if (mac && e.ctrlKey) mods.push('Control');
  if (!mac && e.metaKey) mods.push('Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const accelerator = [...mods, key].join('+');
  return isValidAccelerator(accelerator) ? accelerator : null;
}

/** "CommandOrControl+Alt+Space" → "Ctrl + Alt + Space" (or ⌘ on macOS). */
export function formatAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin';
  return accelerator
    .split('+')
    .map((p) =>
      p === 'CommandOrControl' || p === 'CmdOrCtrl'
        ? mac
          ? '⌘'
          : 'Ctrl'
        : p === 'Super'
          ? mac
            ? '⌘'
            : 'Win'
          : p === 'Alt' && mac
            ? '⌥'
            : p,
    )
    .join(' + ');
}
