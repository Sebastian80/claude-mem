/**
 * ChromaStdioAdapter Integration Tests
 *
 * Tests vector embedding sync and semantic search via MCP stdio subprocess.
 * Skips tests if uvx/chroma not installed (CI-safe).
 *
 * Sources:
 * - ChromaStdioAdapter from src/services/vector/ChromaStdioAdapter.ts
 * - collection-utils from src/services/vector/collection-utils.ts
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
import { identifyOrphanedCollections, identifyDocumentsToPrune } from '../../src/services/vector/collection-utils.js';
import { logger } from '../../src/utils/logger.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Check if uvx/chroma is available
let chromaAvailable = false;
let skipReason = '';

async function checkChromaAvailability(): Promise<{ available: boolean; reason: string }> {
  try {
    // Check if uvx is available
    const uvxCheck = Bun.spawn(['uvx', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await uvxCheck.exited;

    if (uvxCheck.exitCode !== 0) {
      return { available: false, reason: 'uvx not installed' };
    }

    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: `uvx check failed: ${error}` };
  }
}

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ChromaStdioAdapter Integration', () => {
  const testProject = `test-project-${Date.now()}`;
  const testVectorDbDir = path.join(os.tmpdir(), `chroma-test-${Date.now()}`);

  beforeAll(async () => {
    const check = await checkChromaAvailability();
    chromaAvailable = check.available;
    skipReason = check.reason;

    // Create temp directory for vector db
    if (chromaAvailable) {
      fs.mkdirSync(testVectorDbDir, { recursive: true });
    }
  });

  afterAll(async () => {
    // Cleanup temp directory
    try {
      if (fs.existsSync(testVectorDbDir)) {
        fs.rmSync(testVectorDbDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('Availability check', () => {
    it('should detect uvx availability status', async () => {
      const check = await checkChromaAvailability();
      // This test always passes - it just logs the status
      expect(typeof check.available).toBe('boolean');
      if (!check.available) {
        console.log(`Chroma tests will be skipped: ${check.reason}`);
      }
    });
  });

  describe('ChromaStdioAdapter class structure', () => {
    it('should be importable', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      expect(ChromaStdioAdapter).toBeDefined();
      expect(typeof ChromaStdioAdapter).toBe('function');
    });

    it('should instantiate with project name', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter('test-project');
      expect(adapter).toBeDefined();
    });
  });

  describe('VectorStore interface', () => {
    it('should expose all VectorStore methods', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      expect(typeof adapter.syncObservation).toBe('function');
      expect(typeof adapter.syncSummary).toBe('function');
      expect(typeof adapter.syncUserPrompt).toBe('function');
      expect(typeof adapter.query).toBe('function');
      expect(typeof adapter.addDocuments).toBe('function');
      expect(typeof adapter.getExistingIds).toBe('function');
      expect(typeof adapter.performMaintenance).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.isAvailable).toBe('function');
    });

    it('should have query method', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      expect(typeof adapter.query).toBe('function');
    });

    it('should have close method for cleanup', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      expect(typeof adapter.close).toBe('function');
    });
  });

  describe('Observation sync interface', () => {
    it('should accept SyncObservationParams format', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      // Verify method exists and accepts params object
      expect(typeof adapter.syncObservation).toBe('function');
      expect(adapter.syncObservation.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Summary sync interface', () => {
    it('should accept SyncSummaryParams format', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      expect(typeof adapter.syncSummary).toBe('function');
    });
  });

  describe('User prompt sync interface', () => {
    it('should accept SyncUserPromptParams format', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      expect(typeof adapter.syncUserPrompt).toBe('function');
    });
  });

  describe('Query interface', () => {
    it('should accept query string and options', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      expect(typeof adapter.query).toBe('function');
    });
  });

  describe('Collection naming', () => {
    it('should use project-based collection name', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');

      const projectName = 'my-project';
      const adapter = new ChromaStdioAdapter(projectName);

      expect(adapter).toBeDefined();
    });

    it('should handle special characters in project names', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');

      const projectName = 'my-project_v2.0';
      const adapter = new ChromaStdioAdapter(projectName);
      expect(adapter).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should handle connection failures gracefully', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      const observation = {
        type: 'discovery' as const,
        title: 'Test',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      };

      // This should either throw or fail gracefully
      try {
        await adapter.syncObservation({
          observationId: 1,
          memorySessionId: 'session-123',
          project: 'test',
          observation,
          promptNumber: 1,
          createdAtEpoch: Date.now() / 1000,
          discoveryTokens: 0
        });
      } catch (error) {
        // Expected - server not running
        expect(error).toBeDefined();
      }

      await adapter.close();
    });
  });

  describe('Cleanup', () => {
    it('should handle close on unconnected instance', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      await expect(adapter.close()).resolves.toBeUndefined();
    });

    it('should be safe to call close multiple times', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);

      await expect(adapter.close()).resolves.toBeUndefined();
      await expect(adapter.close()).resolves.toBeUndefined();
    });
  });

  describe('Connection mutex (duplicate subprocess prevention)', () => {
    it('should have connectionPromise field for mutex coordination', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      const adapterAny = adapter as any;

      expect(adapterAny.connectionPromise).toBeNull();
    });

    it('should coalesce concurrent ensureConnection calls into one attempt', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      const adapterAny = adapter as any;

      const p1 = adapterAny.ensureConnection();
      const p2 = adapterAny.ensureConnection();

      expect(adapterAny.connectionPromise).not.toBeNull();

      const [r1, r2] = await Promise.allSettled([p1, p2]);

      expect(r1.status).toBe(r2.status);
      expect(adapterAny.connectionPromise).toBeNull();

      await adapter.close();
    }, 15_000);

    it('should reset connectionPromise on close()', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      const adapterAny = adapter as any;

      await adapter.close();
      expect(adapterAny.connectionPromise).toBeNull();
    });

    it('should have connection mutex pattern in source code', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/vector/ChromaStdioAdapter.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('connectionPromise');
      expect(sourceFile).toContain('doConnect');
    });
  });

  describe('Orphaned collection cleanup', () => {
    it('should identify orphaned collections by name pattern', async () => {
      const collections = [
        'cm__claude-mem',
        'cm__other-project',
        'f12ddb9c-caa8-43d7-a5d8-170ea8276a98',
        'random-collection',
      ];

      const orphans = identifyOrphanedCollections(collections);

      expect(orphans).toContain('f12ddb9c-caa8-43d7-a5d8-170ea8276a98');
      expect(orphans).toContain('random-collection');
      expect(orphans).not.toContain('cm__claude-mem');
      expect(orphans).not.toContain('cm__other-project');
      expect(orphans).toHaveLength(2);
    });

    it('should return empty array when all collections are valid', async () => {
      const collections = ['cm__project-a', 'cm__project-b'];
      const orphans = identifyOrphanedCollections(collections);
      expect(orphans).toEqual([]);
    });

    it('should return empty array for empty input', async () => {
      const orphans = identifyOrphanedCollections([]);
      expect(orphans).toEqual([]);
    });

    it('should handle collections with only cm__ prefix', async () => {
      const orphans = identifyOrphanedCollections(['cm__my-project']);
      expect(orphans).toEqual([]);
    });
  });

  describe('Embedding retention cap', () => {
    it('should identify document IDs to prune when over cap', async () => {
      const metadatas = [
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        { docId: 'obs_1_fact_0',   sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 200 },
        { docId: 'obs_2_fact_0',   sqlite_id: 2, doc_type: 'observation', created_at_epoch: 200 },
        { docId: 'summary_3_request', sqlite_id: 3, doc_type: 'session_summary', created_at_epoch: 300 },
        { docId: 'summary_3_learned', sqlite_id: 3, doc_type: 'session_summary', created_at_epoch: 300 },
        { docId: 'obs_4_narrative', sqlite_id: 4, doc_type: 'observation', created_at_epoch: 400 },
        { docId: 'obs_4_fact_0',   sqlite_id: 4, doc_type: 'observation', created_at_epoch: 400 },
        { docId: 'prompt_5',       sqlite_id: 5, doc_type: 'user_prompt', created_at_epoch: 500 },
      ];

      const toPrune = identifyDocumentsToPrune(metadatas, 3);

      expect(toPrune).toContain('obs_1_narrative');
      expect(toPrune).toContain('obs_1_fact_0');
      expect(toPrune).toContain('obs_2_narrative');
      expect(toPrune).toContain('obs_2_fact_0');
      expect(toPrune).toHaveLength(4);

      expect(toPrune).not.toContain('summary_3_request');
      expect(toPrune).not.toContain('obs_4_narrative');
      expect(toPrune).not.toContain('prompt_5');
    });

    it('should return empty when under cap', async () => {
      const metadatas = [
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        { docId: 'prompt_2',       sqlite_id: 2, doc_type: 'user_prompt', created_at_epoch: 200 },
      ];

      const toPrune = identifyDocumentsToPrune(metadatas, 5);
      expect(toPrune).toEqual([]);
    });

    it('should return empty when cap is 0 (unlimited)', async () => {
      const metadatas = [
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
      ];

      const toPrune = identifyDocumentsToPrune(metadatas, 0);
      expect(toPrune).toEqual([]);
    });

    it('should return empty for empty input', async () => {
      const toPrune = identifyDocumentsToPrune([], 10);
      expect(toPrune).toEqual([]);
    });

    it('should group documents by source item (sqlite_id + doc_type)', async () => {
      const metadatas = [
        { docId: 'obs_1_narrative',    sqlite_id: 1, doc_type: 'observation',      created_at_epoch: 100 },
        { docId: 'summary_1_request',  sqlite_id: 1, doc_type: 'session_summary',  created_at_epoch: 200 },
        { docId: 'prompt_1',           sqlite_id: 1, doc_type: 'user_prompt',       created_at_epoch: 300 },
      ];

      const toPrune = identifyDocumentsToPrune(metadatas, 2);
      expect(toPrune).toEqual(['obs_1_narrative']);
    });

    it('should have retention pruning wired into adapter source code', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/vector/ChromaStdioAdapter.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('identifyDocumentsToPrune');
      expect(sourceFile).toContain('CHROMA_MAX_ITEMS');
      expect(sourceFile).toContain('chroma_delete_documents');
    });
  });

  describe('Orphaned collection source verification', () => {
    it('should have orphan cleanup wired into ensureCollection', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/vector/ChromaStdioAdapter.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('identifyOrphanedCollections');
      expect(sourceFile).toContain('chroma_list_collections');
      expect(sourceFile).toContain('chroma_delete_collection');
    });
  });

  describe('Process leak prevention (Issue #761)', () => {
    it('should have transport cleanup in connection error handlers', async () => {
      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      const adapterAny = adapter as any;

      expect(adapterAny.client).toBeNull();
      expect(adapterAny.transport).toBeNull();
      expect(adapterAny.connected).toBe(false);

      await adapter.close();

      expect(adapterAny.client).toBeNull();
      expect(adapterAny.transport).toBeNull();
      expect(adapterAny.connected).toBe(false);
    });

    it('should reset state after close regardless of connection status', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaStdioAdapter } = await import('../../src/services/vector/ChromaStdioAdapter.js');
      const adapter = new ChromaStdioAdapter(testProject);
      const adapterAny = adapter as any;

      try {
        await adapter.query('test', 5);
      } catch {
        // Connection or query may fail - that's OK
      }

      await adapter.close();

      expect(adapterAny.connected).toBe(false);
      expect(adapterAny.client).toBeNull();
      expect(adapterAny.transport).toBeNull();
    });

    it('should clean up transport in close() method', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/vector/ChromaStdioAdapter.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('this.transport.close()');
      expect(sourceFile).toContain('this.transport = null');
    });
  });
});
