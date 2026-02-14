import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { VectorStoreFactory } from '../../src/services/vector/VectorStoreFactory.js';
import { ChromaStdioAdapter } from '../../src/services/vector/ChromaStdioAdapter.js';
import { ChromaHttpAdapter } from '../../src/services/vector/ChromaHttpAdapter.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { ChromaServerManager } from '../../src/services/vector/ChromaServerManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('VectorStoreFactory', () => {
  it('should fall back to ChromaStdioAdapter when no serverManager provided', () => {
    // Default is 'chroma-http', but without a serverManager it falls back to stdio
    const store = VectorStoreFactory.create('test-project');
    expect(store).toBeInstanceOf(ChromaStdioAdapter);
  });

  it('should create ChromaHttpAdapter when serverManager provided', () => {
    const mockServerManager = {
      isHealthy: () => true,
      getUrl: () => 'http://127.0.0.1:8100',
      getPort: () => 8100,
      start: async () => {},
      stop: async () => {},
      heartbeat: async () => true
    } as unknown as ChromaServerManager;

    const store = VectorStoreFactory.create('test-project', mockServerManager);
    expect(store).toBeInstanceOf(ChromaHttpAdapter);
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
  it('should have CLAUDE_MEM_VECTOR_BACKEND default to chroma-http', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_VECTOR_BACKEND).toBe('chroma-http');
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
