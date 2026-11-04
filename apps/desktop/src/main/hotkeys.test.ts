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
    const answer = vi.fn();
    const hotkeys = new Hotkeys(
      r,
      { toggleCopilot: toggle, pauseListening: vi.fn(), answerNow: answer, regenerate: vi.fn() },
      log,
    );
    const keys = {
      toggleCopilot: 'CommandOrControl+Alt+Space',
      pauseListening: 'Alt+F9',
      answerNow: 'CommandOrControl+Alt+Enter',
      regenerate: null,
    };
    expect(hotkeys.apply(keys)).toBe(true);
    expect(hotkeys.statuses).toEqual([
      { action: 'toggleCopilot', accelerator: 'CommandOrControl+Alt+Space', registered: true },
      { action: 'pauseListening', accelerator: 'Alt+F9', registered: false },
      { action: 'answerNow', accelerator: 'CommandOrControl+Alt+Enter', registered: true },
      { action: 'regenerate', accelerator: null, registered: false },
    ]);
    active.get('CommandOrControl+Alt+Enter')!();
    expect(answer).toHaveBeenCalledOnce();
    active.get('CommandOrControl+Alt+Space')!();
    expect(toggle).toHaveBeenCalledOnce();

    // Same settings: nothing to do.
    expect(hotkeys.apply({ ...keys })).toBe(false);
    expect(
      hotkeys.apply({
        toggleCopilot: 'Alt+K',
        pauseListening: null,
        answerNow: null,
        regenerate: null,
      }),
    ).toBe(true);
    expect([...active.keys()]).toEqual(['Alt+K']);
    hotkeys.unregisterAll();
    expect(active.size).toBe(0);
  });

  it('does not register one shortcut for two actions', () => {
    const { r } = registry();
    const hotkeys = new Hotkeys(
      r,
      { toggleCopilot: vi.fn(), pauseListening: vi.fn(), answerNow: vi.fn(), regenerate: vi.fn() },
      log,
    );
    hotkeys.apply({
      toggleCopilot: 'Alt+K',
      pauseListening: 'Alt+K',
      answerNow: null,
      regenerate: null,
    });
    expect(hotkeys.statuses.map((s) => s.registered)).toEqual([true, false, false, false]);
  });
});
