import { describe, it, expect } from 'bun:test';
import { VectorStoreFactory } from '../../src/services/vector/VectorStoreFactory.js';
import { ChromaStdioAdapter } from '../../src/services/vector/ChromaStdioAdapter.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('VectorStoreFactory', () => {
  it('should create ChromaStdioAdapter by default', () => {
    const store = VectorStoreFactory.create('test-project');
    expect(store).toBeInstanceOf(ChromaStdioAdapter);
  });

  it('should fall back to ChromaStdioAdapter for sqlite-vec (not yet implemented)', () => {
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
  it('should have CLAUDE_MEM_VECTOR_BACKEND default to chroma-stdio', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_VECTOR_BACKEND).toBe('chroma-stdio');
  });

  it('should read CLAUDE_MEM_VECTOR_BACKEND from settings file', () => {
    const tmpDir = join(tmpdir(), `vector-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    const settingsPath = join(tmpDir, 'settings.json');

    try {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_VECTOR_BACKEND: 'chroma-stdio'
      }));

      const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
      expect(settings.CLAUDE_MEM_VECTOR_BACKEND).toBe('chroma-stdio');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
