import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ChromaHttpAdapter } from '../../src/services/vector/ChromaHttpAdapter.js';
import type { ChromaServerManager } from '../../src/services/vector/ChromaServerManager.js';
import type { VectorStore } from '../../src/services/vector/VectorStore.js';

/**
 * Create a mock ChromaServerManager that reports as healthy.
 */
function createMockServerManager(healthy = true): ChromaServerManager {
  return {
    isHealthy: () => healthy,
    getUrl: () => 'http://127.0.0.1:8100',
    getPort: () => 8100,
    start: async () => {},
    stop: async () => {},
    heartbeat: async () => healthy
  } as unknown as ChromaServerManager;
}

describe('ChromaHttpAdapter', () => {
  describe('constructor and interface', () => {
    it('should implement VectorStore interface', () => {
      const manager = createMockServerManager();
      const adapter = new ChromaHttpAdapter('test-project', manager);

      // Verify all VectorStore interface methods exist
      expect(typeof adapter.isAvailable).toBe('function');
      expect(typeof adapter.syncObservation).toBe('function');
      expect(typeof adapter.syncSummary).toBe('function');
      expect(typeof adapter.syncUserPrompt).toBe('function');
      expect(typeof adapter.query).toBe('function');
      expect(typeof adapter.addDocuments).toBe('function');
      expect(typeof adapter.getExistingIds).toBe('function');
      expect(typeof adapter.performMaintenance).toBe('function');
      expect(typeof adapter.close).toBe('function');
    });
  });

  describe('isAvailable', () => {
    it('should return true when server manager is healthy', () => {
      const manager = createMockServerManager(true);
      const adapter = new ChromaHttpAdapter('test-project', manager);
      expect(adapter.isAvailable()).toBe(true);
    });

    it('should return false when server manager is unhealthy', () => {
      const manager = createMockServerManager(false);
      const adapter = new ChromaHttpAdapter('test-project', manager);
      expect(adapter.isAvailable()).toBe(false);
    });
  });

  describe('sync methods with unhealthy server', () => {
    it('should no-op syncObservation when server is unhealthy', async () => {
      const manager = createMockServerManager(false);
      const adapter = new ChromaHttpAdapter('test-project', manager);

      // Should not throw, just return silently
      await adapter.syncObservation({
        observationId: 1,
        memorySessionId: 'test-session',
        project: 'test-project',
        observation: {
          type: 'discovery',
          title: 'Test',
          subtitle: 'subtitle',
          narrative: 'test narrative',
          facts: ['fact1'],
          concepts: ['concept1'],
          files_read: [],
          files_modified: []
        },
        promptNumber: 1,
        createdAtEpoch: Date.now() / 1000,
        discoveryTokens: 100
      });
    });

    it('should no-op syncSummary when server is unhealthy', async () => {
      const manager = createMockServerManager(false);
      const adapter = new ChromaHttpAdapter('test-project', manager);

      await adapter.syncSummary({
        summaryId: 1,
        memorySessionId: 'test-session',
        project: 'test-project',
        summary: {
          request: 'test request',
          investigated: 'investigated',
          learned: 'learned',
          completed: 'completed',
          next_steps: 'next steps',
          notes: null
        },
        promptNumber: 1,
        createdAtEpoch: Date.now() / 1000,
        discoveryTokens: 100
      });
    });

    it('should no-op syncUserPrompt when server is unhealthy', async () => {
      const manager = createMockServerManager(false);
      const adapter = new ChromaHttpAdapter('test-project', manager);

      await adapter.syncUserPrompt({
        promptId: 1,
        memorySessionId: 'test-session',
        project: 'test-project',
        promptText: 'test prompt',
        promptNumber: 1,
        createdAtEpoch: Date.now() / 1000
      });
    });
  });

  describe('query with unhealthy server', () => {
    it('should return empty results when server is unhealthy', async () => {
      const manager = createMockServerManager(false);
      const adapter = new ChromaHttpAdapter('test-project', manager);

      const result = await adapter.query('test query', 10);
      expect(result.ids).toEqual([]);
      expect(result.distances).toEqual([]);
      expect(result.metadatas).toEqual([]);
    });
  });

  describe('close', () => {
    it('should be safe to call close', async () => {
      const manager = createMockServerManager();
      const adapter = new ChromaHttpAdapter('test-project', manager);

      // Should not throw
      await adapter.close();
    });

    it('should be safe to call close multiple times', async () => {
      const manager = createMockServerManager();
      const adapter = new ChromaHttpAdapter('test-project', manager);

      await adapter.close();
      await adapter.close();
    });
  });

  describe('addDocuments with empty array', () => {
    it('should return immediately for empty documents', async () => {
      const manager = createMockServerManager();
      const adapter = new ChromaHttpAdapter('test-project', manager);

      // Should not throw or attempt network calls
      await adapter.addDocuments([]);
    });
  });
});

describe('ChromaHttpAdapter VectorStoreFactory integration', () => {
  it('should be creatable with chroma-http backend when server manager provided', async () => {
    const { VectorStoreFactory } = await import('../../src/services/vector/VectorStoreFactory.js');
    const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');
    const { writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tmpDir = join(tmpdir(), `http-adapter-factory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
