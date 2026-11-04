import { createLogger } from '@aic/core';
import { describe, expect, it, vi } from 'vitest';
import { Hotkeys, type ShortcutRegistry } from './hotkeys';

function registry(taken: string[] = []) {
  const active = new Map<string, () => void>();
  const r: ShortcutRegistry = {
    register: (accel, cb) => {
      if (taken.includes(accel) || active.has(accel)) return false;
      active.set(accel, cb);
      return true;
    },
    unregister: (accel) => void active.delete(accel),
  };
  return { r, active };
}

const log = createLogger({ console: false, scope: 'test' });

describe('Hotkeys', () => {
  it('registers, re-registers on change, and reports shortcuts other apps own', () => {
    const { r, active } = registry(['Alt+F9']);
    const toggle = vi.fn();
    const hotkeys = new Hotkeys(r, { toggleCopilot: toggle, pauseListening: vi.fn() }, log);
    expect(
      hotkeys.apply({ toggleCopilot: 'CommandOrControl+Alt+Space', pauseListening: 'Alt+F9' }),
    ).toBe(true);
    expect(hotkeys.statuses).toEqual([
      { action: 'toggleCopilot', accelerator: 'CommandOrControl+Alt+Space', registered: true },
      { action: 'pauseListening', accelerator: 'Alt+F9', registered: false },
    ]);
    active.get('CommandOrControl+Alt+Space')!();
    expect(toggle).toHaveBeenCalledOnce();

    // Same settings: nothing to do.
    expect(
      hotkeys.apply({ toggleCopilot: 'CommandOrControl+Alt+Space', pauseListening: 'Alt+F9' }),
    ).toBe(false);
    expect(hotkeys.apply({ toggleCopilot: 'Alt+K', pauseListening: null })).toBe(true);
    expect([...active.keys()]).toEqual(['Alt+K']);
    hotkeys.unregisterAll();
    expect(active.size).toBe(0);
  });

  it('does not register one shortcut for two actions', () => {
    const { r } = registry();
    const hotkeys = new Hotkeys(r, { toggleCopilot: vi.fn(), pauseListening: vi.fn() }, log);
    hotkeys.apply({ toggleCopilot: 'Alt+K', pauseListening: 'Alt+K' });
    expect(hotkeys.statuses.map((s) => s.registered)).toEqual([true, false]);
  });
});
