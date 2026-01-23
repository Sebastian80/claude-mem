/**
 * SettingsWatcher
 *
 * Watches settings.json for changes and emits events when relevant settings change.
 * Uses mtime polling (simpler than fs.watch, works across platforms).
 *
 * Features:
 * - Debounces rapid changes (waits 500ms after last change)
 * - Validates settings via SettingsDefaultsManager (handles legacy shapes + migrations)
 * - Only emits when relevant keys change
 */

import { EventEmitter } from 'events';
import { statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { SettingsDefaultsManager, SettingsDefaults } from '../../../shared/SettingsDefaultsManager.js';
import { logger } from '../../../utils/logger.js';

/**
 * Settings keys that trigger generator restart when changed
 */
export const RESTART_TRIGGER_KEYS: (keyof SettingsDefaults)[] = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_MODEL',
  'CLAUDE_MEM_GEMINI_MODEL',
  'CLAUDE_MEM_OPENAI_MODEL',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENAI_API_KEY',
  'CLAUDE_MEM_GEMINI_BASE_URL',
  'CLAUDE_MEM_OPENAI_BASE_URL',
];

export interface SettingsChangeEvent {
  oldSettings: SettingsDefaults;
  newSettings: SettingsDefaults;
  changedKeys: (keyof SettingsDefaults)[];
  restartRequired: boolean;
}

export class SettingsWatcher extends EventEmitter {
  private lastMtime: number = 0;
  private lastHash: string = '';
  private lastSettings: SettingsDefaults | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs: number = 500;

  constructor(
    private settingsPath: string,
    private pollMs: number = 2000
  ) {
    super();
  }

  /**
   * Start watching for settings changes
   */
  start(): void {
    // Initial read to establish baseline
    this.readAndHashSettings();

    this.pollInterval = setInterval(() => {
      this.checkForChanges();
    }, this.pollMs);

    logger.info('SETTINGS', 'SettingsWatcher started', {
      path: this.settingsPath,
      pollMs: this.pollMs,
      debounceMs: this.debounceMs
    });
  }

  /**
   * Stop watching for settings changes
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    logger.info('SETTINGS', 'SettingsWatcher stopped');
  }

  /**
   * Get the current settings (cached)
   */
  getCurrentSettings(): SettingsDefaults | null {
    return this.lastSettings;
  }

  /**
   * Force a re-read of settings (useful after programmatic changes)
   */
  forceRefresh(): void {
    this.emitIfChanged();
  }

  /**
   * Read settings and compute hash for change detection
   */
  private readAndHashSettings(): void {
    try {
      const content = readFileSync(this.settingsPath, 'utf8');
      this.lastHash = createHash('md5').update(content).digest('hex');
      this.lastSettings = SettingsDefaultsManager.loadFromFile(this.settingsPath);

      try {
        const stats = statSync(this.settingsPath);
        this.lastMtime = stats.mtimeMs;
      } catch {
        // File might not exist yet
      }
    } catch {
      // File doesn't exist or can't be read - use defaults
      this.lastSettings = SettingsDefaultsManager.getAllDefaults();
      this.lastHash = '';
    }
  }

  /**
   * Check if settings file has changed (by mtime)
   */
  private checkForChanges(): void {
    try {
      const stats = statSync(this.settingsPath);
      if (stats.mtimeMs === this.lastMtime) return;

      this.lastMtime = stats.mtimeMs;

      // Debounce: wait for writes to settle
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.emitIfChanged();
      }, this.debounceMs);
    } catch {
      // File doesn't exist or can't be read - ignore
    }
  }

  /**
   * Read settings, compare with cached, and emit if changed
   */
  private emitIfChanged(): void {
    try {
      const content = readFileSync(this.settingsPath, 'utf8');

      // CRITICAL: Validate JSON BEFORE calling loadFromFile
      // loadFromFile returns defaults on error, which would cause spurious restarts
      try {
        JSON.parse(content);
      } catch {
        logger.debug('SETTINGS', 'Ignoring invalid/partial JSON in settings file');
        return;
      }

      const newHash = createHash('md5').update(content).digest('hex');

      // Skip if content hasn't changed
      if (newHash === this.lastHash) return;

      // Load settings via SettingsDefaultsManager (handles legacy shapes + migrations)
      const newSettings = SettingsDefaultsManager.loadFromFile(this.settingsPath);

      const oldSettings = this.lastSettings || SettingsDefaultsManager.getAllDefaults();

      // Find which keys changed
      const changedKeys = this.findChangedKeys(oldSettings, newSettings);

      // Update cached state
      this.lastHash = newHash;
      this.lastSettings = newSettings;

      // Skip if no keys actually changed (e.g., whitespace-only change)
      if (changedKeys.length === 0) return;

      // Check if any restart-trigger keys changed
      const restartRequired = changedKeys.some(key =>
        RESTART_TRIGGER_KEYS.includes(key as keyof SettingsDefaults)
      );

      const event: SettingsChangeEvent = {
        oldSettings,
        newSettings,
        changedKeys,
        restartRequired
      };

      logger.info('SETTINGS', 'Settings changed', {
        changedKeys,
        restartRequired
      });

      this.emit('change', event);
    } catch (error) {
      logger.debug('SETTINGS', 'Error reading settings file', {}, error as Error);
    }
  }

  /**
   * Find which keys differ between old and new settings
   */
  private findChangedKeys(
    oldSettings: SettingsDefaults,
    newSettings: SettingsDefaults
  ): (keyof SettingsDefaults)[] {
    const changedKeys: (keyof SettingsDefaults)[] = [];

    const allKeys = new Set([
      ...Object.keys(oldSettings),
      ...Object.keys(newSettings)
    ]) as Set<keyof SettingsDefaults>;

    for (const key of allKeys) {
      if (oldSettings[key] !== newSettings[key]) {
        changedKeys.push(key);
      }
    }

    return changedKeys;
  }
}
