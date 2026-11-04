import type { Logger } from '@aic/core';
import { HOTKEY_ACTIONS, type HotkeyAction, type HotkeyStatus, type Settings } from '@aic/ipc';

/** The part of Electron's globalShortcut we use (injectable for tests). */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * System-wide shortcuts that work while the call app has focus. Re-registered
 * whenever the hotkey settings change; a shortcut another app already owns is
 * reported as not registered instead of failing.
 */
export class Hotkeys {
  #registered = new Map<HotkeyAction, string>();
  #statuses: HotkeyStatus[] = HOTKEY_ACTIONS.map((action) => ({
    action,
    accelerator: null,
    registered: false,
  }));

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly actions: Record<HotkeyAction, () => void>,
    private readonly log: Logger,
  ) {}

  get statuses(): HotkeyStatus[] {
    return this.#statuses.map((s) => ({ ...s }));
  }

  /** Applies the settings. Returns true if anything changed. */
  apply(settings: Settings['hotkeys']): boolean {
    const wanted = HOTKEY_ACTIONS.map((action) => [action, settings[action]] as const);
    // Only when the shortcuts themselves change (any settings change calls this).
    if (this.#statuses.every((s) => s.accelerator === settings[s.action])) return false;

    this.unregisterAll();
    const used = new Set<string>();
    this.#statuses = wanted.map(([action, accelerator]) => {
      if (!accelerator) return { action, accelerator: null, registered: false };
      if (used.has(accelerator)) return { action, accelerator, registered: false };
      let ok = false;
      try {
        ok = this.registry.register(accelerator, () => {
          try {
            this.actions[action]();
          } catch (err) {
            this.log.warn('hotkey action failed', { action, err });
          }
        });
      } catch (err) {
        this.log.warn('hotkey rejected', { action, accelerator, err });
      }
      if (ok) {
        used.add(accelerator);
        this.#registered.set(action, accelerator);
      } else {
        this.log.warn('hotkey is taken by another app', { action, accelerator });
      }
      return { action, accelerator, registered: ok };
    });
    return true;
  }

  unregisterAll(): void {
    for (const accelerator of this.#registered.values()) {
      try {
        this.registry.unregister(accelerator);
      } catch {
        // already gone
      }
    }
    this.#registered.clear();
  }
}
