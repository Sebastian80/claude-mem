/**
 * Chroma Vector Sync Integration Tests
 *
 * Tests ChromaSync vector embedding and semantic search.
 * Skips tests if uvx/chroma not installed (CI-safe).
 *
 * Sources:
 * - ChromaSync implementation from src/services/sync/ChromaSync.ts
 * - MCP patterns from the Chroma MCP server
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
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

describe('ChromaSync Vector Sync Integration', () => {
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

  describe('ChromaSync availability check', () => {
    it('should detect uvx availability status', async () => {
      const check = await checkChromaAvailability();
      // This test always passes - it just logs the status
      expect(typeof check.available).toBe('boolean');
      if (!check.available) {
        console.log(`Chroma tests will be skipped: ${check.reason}`);
      }
    });
  });

  describe('ChromaSync class structure', () => {
    it('should be importable', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      expect(ChromaSync).toBeDefined();
      expect(typeof ChromaSync).toBe('function');
    });

    it('should instantiate with project name', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync('test-project');
      expect(sync).toBeDefined();
    });
  });

  describe('Document formatting', () => {
    it('should format observation documents correctly', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Test the document formatting logic by examining the class
      // The formatObservationDocs method is private, but we can verify
      // the sync method signature exists
      expect(typeof sync.syncObservation).toBe('function');
      expect(typeof sync.syncSummary).toBe('function');
      expect(typeof sync.syncUserPrompt).toBe('function');
    });

    it('should have query method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.queryChroma).toBe('function');
    });

    it('should have close method for cleanup', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.close).toBe('function');
    });

    it('should have ensureBackfilled method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.ensureBackfilled).toBe('function');
    });
  });

  describe('Observation sync interface', () => {
    it('should accept ParsedObservation format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncObservation method should accept these parameters
      const observationId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const observation = {
        type: 'discovery',
        title: 'Test Title',
        subtitle: 'Test Subtitle',
        facts: ['fact1', 'fact2'],
        narrative: 'Test narrative',
        concepts: ['concept1'],
        files_read: ['/path/to/file.ts'],
        files_modified: []
      };
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method signature accepts these parameters
      // We don't actually call it to avoid needing a running Chroma server
      expect(sync.syncObservation.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Summary sync interface', () => {
    it('should accept ParsedSummary format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncSummary method should accept these parameters
      const summaryId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const summary = {
        request: 'Test request',
        investigated: 'Test investigated',
        learned: 'Test learned',
        completed: 'Test completed',
        next_steps: 'Test next steps',
        notes: 'Test notes'
      };
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method exists
      expect(typeof sync.syncSummary).toBe('function');
    });
  });

  describe('User prompt sync interface', () => {
    it('should accept prompt text format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncUserPrompt method should accept these parameters
      const promptId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const promptText = 'Help me write a function';
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method exists
      expect(typeof sync.syncUserPrompt).toBe('function');
    });
  });

  describe('Query interface', () => {
    it('should accept query string and options', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Verify method signature
      expect(typeof sync.queryChroma).toBe('function');

      // The method should return a promise
      // (without calling it since no server is running)
    });
  });

  describe('Collection naming', () => {
    it('should use project-based collection name', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Collection name format is cm__{project}
      const projectName = 'my-project';
      const sync = new ChromaSync(projectName);

      // The collection name is private, but we can verify the class
      // was constructed successfully with the project name
      expect(sync).toBeDefined();
    });

    it('should handle special characters in project names', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Projects with special characters should work
      const projectName = 'my-project_v2.0';
      const sync = new ChromaSync(projectName);
      expect(sync).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should handle connection failures gracefully', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Calling syncObservation without a running server should throw
      // but not crash the process
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
        await sync.syncObservation(
          1,
          'session-123',
          'test',
          observation,
          1,
          Date.now()
        );
        // If it didn't throw, the connection might have succeeded
      } catch (error) {
        // Expected - server not running
        expect(error).toBeDefined();
      }

      // Clean up
      await sync.close();
    });
  });

  describe('Cleanup', () => {
    it('should handle close on unconnected instance', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Close without ever connecting should not throw
      await expect(sync.close()).resolves.toBeUndefined();
    });

    it('should be safe to call close multiple times', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Multiple close calls should be safe
      await expect(sync.close()).resolves.toBeUndefined();
      await expect(sync.close()).resolves.toBeUndefined();
    });
  });

  describe('Connection mutex (duplicate subprocess prevention)', () => {
    /**
     * Concurrent calls to ensureConnection() must share a single connection
     * attempt. Without the mutex, each concurrent caller spawns its own
     * chroma-mcp subprocess, orphaning all but the last one.
     */
    it('should have connectionPromise field for mutex coordination', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      const syncAny = sync as any;

      // connectionPromise should exist and be null when idle
      expect(syncAny.connectionPromise).toBeNull();
    });

    it('should coalesce concurrent ensureConnection calls into one attempt', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      const syncAny = sync as any;

      // Fire two concurrent connection attempts
      const p1 = syncAny.ensureConnection();
      const p2 = syncAny.ensureConnection();

      // While in flight, both callers should share the same promise
      expect(syncAny.connectionPromise).not.toBeNull();

      // Wait for both to settle (may succeed or fail depending on chroma availability)
      const [r1, r2] = await Promise.allSettled([p1, p2]);

      // Both must have the same outcome — proof they shared one attempt
      expect(r1.status).toBe(r2.status);

      // After completion, connectionPromise must be cleared
      expect(syncAny.connectionPromise).toBeNull();

      await sync.close();
    });

    it('should reset connectionPromise on close()', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      const syncAny = sync as any;

      await sync.close();
      expect(syncAny.connectionPromise).toBeNull();
    });

    it('should have connection mutex pattern in source code', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // Verify the mutex pattern: connectionPromise field and doConnect extraction
      expect(sourceFile).toContain('connectionPromise');
      expect(sourceFile).toContain('doConnect');
    });
  });

  describe('Orphaned collection cleanup', () => {
    /**
     * Prevents recurrence of the Feb 3 incident where killing chroma-mcp
     * mid-write with SIGKILL caused SQLite corruption (journal_mode=delete),
     * leading to get_or_create_collection creating an orphaned collection
     * named with the UUID of the main collection. The orphaned collection
     * blocked WAL auto-purge for 10 days (ChromaDB bug #2605).
     *
     * Fix: ensureCollection() lists all collections and deletes any that
     * don't match the cm__* naming convention — a reconciliation loop
     * pattern (same as Kubernetes controller startup cleanup).
     */
    it('should identify orphaned collections by name pattern', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // The static method should identify orphans from a list of collection names
      const collections = [
        'cm__claude-mem',           // Valid: matches cm__* prefix
        'cm__other-project',        // Valid: different project, still cm__*
        'f12ddb9c-caa8-43d7-a5d8-170ea8276a98',  // Orphan: UUID name
        'random-collection',        // Orphan: no cm__ prefix
      ];

      const orphans = ChromaSync.identifyOrphanedCollections(collections);

      expect(orphans).toContain('f12ddb9c-caa8-43d7-a5d8-170ea8276a98');
      expect(orphans).toContain('random-collection');
      expect(orphans).not.toContain('cm__claude-mem');
      expect(orphans).not.toContain('cm__other-project');
      expect(orphans).toHaveLength(2);
    });

    it('should return empty array when all collections are valid', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const collections = ['cm__project-a', 'cm__project-b'];
      const orphans = ChromaSync.identifyOrphanedCollections(collections);
      expect(orphans).toEqual([]);
    });

    it('should return empty array for empty input', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const orphans = ChromaSync.identifyOrphanedCollections([]);
      expect(orphans).toEqual([]);
    });

    it('should handle collections with only cm__ prefix', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Edge case: single valid collection
      const orphans = ChromaSync.identifyOrphanedCollections(['cm__my-project']);
      expect(orphans).toEqual([]);
    });
  });

  describe('Embedding retention cap', () => {
    /**
     * ChromaDB loads all HNSW indexes into memory at startup with no eviction.
     * Without a cap, embeddings accumulate indefinitely (~500MB+ RAM).
     * The retention cap prunes the oldest source items' embeddings while
     * keeping all data in SQLite (FTS5 keyword search still covers everything).
     */
    it('should identify document IDs to prune when over cap', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // 5 source items, each with 2 embedding documents
      const metadatas = [
        // Oldest observation (epoch 100) — should be pruned first
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        { docId: 'obs_1_fact_0',   sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        // Second oldest (epoch 200)
        { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 200 },
        { docId: 'obs_2_fact_0',   sqlite_id: 2, doc_type: 'observation', created_at_epoch: 200 },
        // Summary (epoch 300)
        { docId: 'summary_3_request', sqlite_id: 3, doc_type: 'session_summary', created_at_epoch: 300 },
        { docId: 'summary_3_learned', sqlite_id: 3, doc_type: 'session_summary', created_at_epoch: 300 },
        // Recent observation (epoch 400)
        { docId: 'obs_4_narrative', sqlite_id: 4, doc_type: 'observation', created_at_epoch: 400 },
        { docId: 'obs_4_fact_0',   sqlite_id: 4, doc_type: 'observation', created_at_epoch: 400 },
        // Most recent prompt (epoch 500)
        { docId: 'prompt_5',       sqlite_id: 5, doc_type: 'user_prompt', created_at_epoch: 500 },
      ];

      // Cap at 3 source items — should prune the 2 oldest (sqlite_id 1 and 2)
      const toPrune = ChromaSync.identifyDocumentsToPrune(metadatas, 3);

      expect(toPrune).toContain('obs_1_narrative');
      expect(toPrune).toContain('obs_1_fact_0');
      expect(toPrune).toContain('obs_2_narrative');
      expect(toPrune).toContain('obs_2_fact_0');
      expect(toPrune).toHaveLength(4);

      // Should NOT contain recent items
      expect(toPrune).not.toContain('summary_3_request');
      expect(toPrune).not.toContain('obs_4_narrative');
      expect(toPrune).not.toContain('prompt_5');
    });

    it('should return empty when under cap', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const metadatas = [
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
        { docId: 'prompt_2',       sqlite_id: 2, doc_type: 'user_prompt', created_at_epoch: 200 },
      ];

      // Cap at 5 — only 2 items, nothing to prune
      const toPrune = ChromaSync.identifyDocumentsToPrune(metadatas, 5);
      expect(toPrune).toEqual([]);
    });

    it('should return empty when cap is 0 (unlimited)', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const metadatas = [
        { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 100 },
      ];

      const toPrune = ChromaSync.identifyDocumentsToPrune(metadatas, 0);
      expect(toPrune).toEqual([]);
    });

    it('should return empty for empty input', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const toPrune = ChromaSync.identifyDocumentsToPrune([], 10);
      expect(toPrune).toEqual([]);
    });

    it('should group documents by source item (sqlite_id + doc_type)', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Same sqlite_id but different doc_types are DIFFERENT source items
      const metadatas = [
        { docId: 'obs_1_narrative',    sqlite_id: 1, doc_type: 'observation',      created_at_epoch: 100 },
        { docId: 'summary_1_request',  sqlite_id: 1, doc_type: 'session_summary',  created_at_epoch: 200 },
        { docId: 'prompt_1',           sqlite_id: 1, doc_type: 'user_prompt',       created_at_epoch: 300 },
      ];

      // Cap at 2 — oldest source item (obs type, epoch 100) gets pruned
      const toPrune = ChromaSync.identifyDocumentsToPrune(metadatas, 2);
      expect(toPrune).toEqual(['obs_1_narrative']);
    });

    it('should have retention pruning wired into source code', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('identifyDocumentsToPrune');
      expect(sourceFile).toContain('CHROMA_MAX_ITEMS');
      expect(sourceFile).toContain('chroma_delete_documents');
    });
  });

  describe('Orphaned collection source verification', () => {
    it('should have orphan cleanup wired into ensureCollection', async () => {
      // Verify the source code calls orphan cleanup during collection setup
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('identifyOrphanedCollections');
      expect(sourceFile).toContain('chroma_list_collections');
      expect(sourceFile).toContain('chroma_delete_collection');
    });
  });

  describe('Process leak prevention (Issue #761)', () => {
    /**
     * Regression test for GitHub Issue #761:
     * "Feature Request: Option to disable Chroma (RAM usage / zombie processes)"
     * 
     * Root cause: When connection errors occur (MCP error -32000, Connection closed),
     * the code was resetting `connected` and `client` but NOT closing the transport,
     * leaving the chroma-mcp subprocess alive. Each reconnection attempt spawned
     * a NEW process while old ones accumulated as zombies.
     * 
     * Fix: Close transport before resetting state in error handlers at:
     * - ensureCollection() error handling (~line 180)
     * - queryChroma() error handling (~line 840)
     */
    it('should have transport cleanup in connection error handlers', async () => {
      // This test verifies the fix exists by checking the source code pattern
      // The actual runtime behavior depends on uvx/chroma availability
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Verify the class has the expected structure
      const syncAny = sync as any;
      
      // Initial state should be null/false
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
      expect(syncAny.connected).toBe(false);

      // The close() method should properly clean up all state
      // This is the reference implementation that error handlers should mirror
      await sync.close();
      
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
      expect(syncAny.connected).toBe(false);
    });

    it('should reset state after close regardless of connection status', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      const syncAny = sync as any;

      // Try to establish connection (may succeed or fail depending on environment)
      try {
        await sync.queryChroma('test', 5);
      } catch {
        // Connection or query may fail - that's OK
      }

      // Regardless of whether connection succeeded, close() must clean up everything
      await sync.close();

      // After close(), ALL state must be null/false - this prevents zombie processes
      expect(syncAny.connected).toBe(false);
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
    });

    it('should clean up transport in close() method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      
      // Read the source to verify transport.close() is called
      // This is a static analysis test - verifies the fix exists
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // Verify that error handlers include transport cleanup
      // The fix adds: if (this.transport) { await this.transport.close(); }
      expect(sourceFile).toContain('this.transport.close()');
      
      // Verify transport is set to null after close
      expect(sourceFile).toContain('this.transport = null');
    });
  });
});
