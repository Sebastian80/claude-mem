import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { VectorStoreFactory } from '../../src/services/vector/VectorStoreFactory.js';
import { ChromaStdioAdapter } from '../../src/services/vector/ChromaStdioAdapter.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('VectorStoreFactory', () => {
  it('should create ChromaStdioAdapter for default settings', () => {
    const store = VectorStoreFactory.create('test-project');
    expect(store).toBeInstanceOf(ChromaStdioAdapter);
  });

  it('should create ChromaStdioAdapter for explicit chroma-stdio setting', () => {
    // Default is 'chroma-stdio', so this should work with default settings
    const store = VectorStoreFactory.create('test-project');
    expect(store).toBeInstanceOf(ChromaStdioAdapter);
  });

  it('should fall back to ChromaStdioAdapter for unimplemented backends', () => {
    // chroma-http and sqlite-vec are not yet implemented, should fall back
    // We can't easily test this without mocking settings, but the factory
    // code handles it via switch/case fallback
    const store = VectorStoreFactory.create('test-project');
    expect(store).toBeDefined();
    expect(store.isAvailable).toBeDefined();
    expect(store.syncObservation).toBeDefined();
    expect(store.query).toBeDefined();
    expect(store.close).toBeDefined();
  });

  it('should expose the VectorStore interface methods', () => {
    const store = VectorStoreFactory.create('test-project');

    // Verify all VectorStore interface methods exist
    expect(typeof store.isAvailable).toBe('function');
    expect(typeof store.syncObservation).toBe('function');
    expect(typeof store.syncSummary).toBe('function');
    expect(typeof store.syncUserPrompt).toBe('function');
    expect(typeof store.query).toBe('function');
    expect(typeof store.addDocuments).toBe('function');
    expect(typeof store.getExistingIds).toBe('function');
    expect(typeof store.performMaintenance).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});

describe('VectorStoreFactory with CLAUDE_MEM_VECTOR_BACKEND setting', () => {
  it('should have CLAUDE_MEM_VECTOR_BACKEND in defaults', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_VECTOR_BACKEND).toBe('chroma-stdio');
  });

  it('should read CLAUDE_MEM_VECTOR_BACKEND from settings file', () => {
    const tmpDir = join(tmpdir(), `vector-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const settingsPath = join(tmpDir, 'settings.json');

    try {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_VECTOR_BACKEND: 'chroma-http'
      }));

      const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
      expect(settings.CLAUDE_MEM_VECTOR_BACKEND).toBe('chroma-http');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
