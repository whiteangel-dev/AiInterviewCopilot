import { describe, expect, it } from 'vitest';
import { acceleratorFromKey, formatAccelerator, isValidAccelerator } from './hotkeys';
import { DEFAULT_SETTINGS, SettingsPatchSchema } from './settings';

const key = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe('hotkeys', () => {
  it('accepts shortcuts with a real modifier and a supported key', () => {
    expect(isValidAccelerator('CommandOrControl+Alt+Space')).toBe(true);
    expect(isValidAccelerator('Alt+F9')).toBe(true);
    expect(isValidAccelerator('Ctrl+Shift+\\')).toBe(true);
    expect(isValidAccelerator('Shift+A')).toBe(false); // would eat typing
    expect(isValidAccelerator('A')).toBe(false);
    expect(isValidAccelerator('Ctrl+Ctrl+A')).toBe(false);
    expect(isValidAccelerator('Ctrl+Hyper+A')).toBe(false);
    expect(isValidAccelerator('Ctrl+Alt+F25')).toBe(false);
  });

  it('records key presses as layout-independent accelerators', () => {
    expect(acceleratorFromKey(key('Space', { ctrlKey: true, altKey: true }), 'win32')).toBe(
      'CommandOrControl+Alt+Space',
    );
    expect(acceleratorFromKey(key('KeyP', { metaKey: true }), 'darwin')).toBe('CommandOrControl+P');
    expect(acceleratorFromKey(key('Digit1', { altKey: true, shiftKey: true }), 'win32')).toBe(
      'Alt+Shift+1',
    );
    expect(acceleratorFromKey(key('KeyA', { shiftKey: true }), 'win32')).toBeNull();
    expect(acceleratorFromKey(key('ControlLeft', { ctrlKey: true }), 'win32')).toBeNull();
  });

  it('formats accelerators for display', () => {
    expect(formatAccelerator('CommandOrControl+Alt+Space', 'win32')).toBe('Ctrl + Alt + Space');
    expect(formatAccelerator('CommandOrControl+Alt+Space', 'darwin')).toBe('⌘ + ⌥ + Space');
  });

  it('validates hotkey settings', () => {
    expect(DEFAULT_SETTINGS.hotkeys.toggleCopilot).toBe('CommandOrControl+Alt+Space');
    expect(SettingsPatchSchema.safeParse({ hotkeys: { toggleCopilot: null } }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ hotkeys: { toggleCopilot: 'Shift+A' } }).success).toBe(
      false,
    );
    expect(SettingsPatchSchema.safeParse({ copilot: { opacity: 0.2 } }).success).toBe(false);
    expect(
      SettingsPatchSchema.safeParse({ audio: { backend: 'native', appName: 'Zoom.exe' } }).success,
    ).toBe(true);
  });
});
