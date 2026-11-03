import { parseStoredSettings, type Settings, type SettingsSection } from '@aic/ipc';
import type { Db } from '../open';
import { appSettings } from '../schema';

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  load(): Settings {
    const rows = this.db.select().from(appSettings).all();
    return parseStoredSettings(Object.fromEntries(rows.map((r) => [r.section, r.value])));
  }

  /** Writes the given sections of `settings` in one transaction. */
  save(settings: Settings, sections: readonly SettingsSection[]): void {
    if (sections.length === 0) return;
    const now = Date.now();
    this.db.transaction((tx) => {
      for (const section of sections) {
        const value = settings[section] as Record<string, unknown>;
        tx.insert(appSettings)
          .values({ section, value, updatedAt: now })
          .onConflictDoUpdate({ target: appSettings.section, set: { value, updatedAt: now } })
          .run();
      }
    });
  }
}
