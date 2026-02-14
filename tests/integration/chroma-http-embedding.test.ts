/**
 * ChromaHttpAdapter Integration Test — Real ChromaDB + Client-Side Embeddings
 *
 * Verifies that the ChromaHttpAdapter can:
 * 1. Connect to a real ChromaDB HTTP server
 * 2. Sync observations, summaries, and user prompts (with client-side embeddings)
 * 3. Perform semantic queries that return relevant results
 * 4. Retrieve existing IDs for delta sync
 *
 * Requires: uvx + chromadb Python package (skips gracefully if unavailable)
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { ChromaServerManager } from '../../src/services/vector/ChromaServerManager.js';
import { ChromaHttpAdapter } from '../../src/services/vector/ChromaHttpAdapter.js';
import { logger } from '../../src/utils/logger.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const TEST_PORT = 8199;
const TEST_PROJECT = `integ-test-${Date.now()}`;

let serverManager: ChromaServerManager;
let adapter: ChromaHttpAdapter;
let serverAvailable = false;
let tmpDataDir: string;

// Suppress log noise during tests
let logSpies: ReturnType<typeof spyOn>[] = [];

describe('ChromaHttpAdapter real embedding integration', () => {
  beforeAll(async () => {
    logSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    // Check uvx availability
    try {
      const proc = Bun.spawn(['uvx', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      await proc.exited;
      if (proc.exitCode !== 0) {
        console.log('SKIP: uvx not available');
        return;
      }
    } catch {
      console.log('SKIP: uvx not available');
      return;
    }

    tmpDataDir = path.join(os.tmpdir(), `chroma-http-integ-${Date.now()}`);
    fs.mkdirSync(tmpDataDir, { recursive: true });

    serverManager = new ChromaServerManager(TEST_PORT, tmpDataDir);
    await serverManager.start();
    serverAvailable = serverManager.isHealthy();

    if (!serverAvailable) {
      console.log('SKIP: ChromaDB server failed to start');
      return;
    }

    adapter = new ChromaHttpAdapter(TEST_PROJECT, serverManager);
  }, 60_000);

  afterAll(async () => {
    if (adapter) {
      await adapter.close();
    }
    if (serverManager) {
      await serverManager.stop();
    }
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
    logSpies.forEach(s => s.mockRestore());
  }, 30_000);

  it('server should be healthy', () => {
    if (!serverAvailable) {
      console.log('SKIP: server not available');
      return;
    }
    expect(adapter.isAvailable()).toBe(true);
  });

  it('should sync observations with embeddings', async () => {
    if (!serverAvailable) return;

    await adapter.syncObservation({
      observationId: 1,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      observation: {
        type: 'discovery',
        title: 'Database optimization',
        subtitle: 'Query performance tuning',
        narrative: 'Discovered that adding a composite index on user_id and created_at reduced query time from 2 seconds to 15 milliseconds for the activity feed.',
        facts: [
          'Composite index on (user_id, created_at) improved performance 100x',
          'PostgreSQL query planner was doing a sequential scan before the index'
        ],
        concepts: ['database', 'indexing', 'performance'],
        files_read: ['src/db/migrations/001.sql'],
        files_modified: ['src/db/migrations/002_add_index.sql']
      },
      promptNumber: 1,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 3600,
      discoveryTokens: 500
    });

    await adapter.syncObservation({
      observationId: 2,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      observation: {
        type: 'discovery',
        title: 'React component refactoring',
        subtitle: 'Splitting monolithic component',
        narrative: 'Refactored the UserDashboard component from a 500-line monolith into 5 smaller components with clear responsibilities. Used React Context to share state.',
        facts: [
          'Split UserDashboard into ProfileCard, ActivityFeed, NotificationPanel, SettingsPanel, StatsSummary',
          'React Context replaced prop drilling for user state'
        ],
        concepts: ['react', 'refactoring', 'components'],
        files_read: ['src/components/UserDashboard.tsx'],
        files_modified: [
          'src/components/ProfileCard.tsx',
          'src/components/ActivityFeed.tsx',
          'src/components/NotificationPanel.tsx'
        ]
      },
      promptNumber: 2,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 1800,
      discoveryTokens: 300
    });
  }, 30_000);

  it('should sync summaries with embeddings', async () => {
    if (!serverAvailable) return;

    await adapter.syncSummary({
      summaryId: 10,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      summary: {
        request: 'Optimize the user dashboard page load time',
        investigated: 'Profiled database queries and React render cycles',
        learned: 'The main bottleneck was a missing database index causing full table scans, and the React component re-rendered too frequently due to prop drilling',
        completed: 'Added composite index and refactored components with React Context',
        next_steps: 'Monitor production query times and consider adding Redis cache',
        notes: null
      },
      promptNumber: 3,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 900,
      discoveryTokens: 200
    });
  }, 30_000);

  it('should sync user prompts with embeddings', async () => {
    if (!serverAvailable) return;

    await adapter.syncUserPrompt({
      promptId: 100,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      promptText: 'Help me fix the slow database queries on the user dashboard',
      promptNumber: 1,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 3600
    });

    await adapter.syncUserPrompt({
      promptId: 101,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      promptText: 'Now refactor the UserDashboard React component to be more maintainable',
      promptNumber: 2,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 1800
    });
  }, 30_000);

  it('should return relevant results for semantic database query', async () => {
    if (!serverAvailable) return;

    const result = await adapter.query('database index performance', 5);

    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.distances.length).toBeGreaterThan(0);

    // The database observation (id=1) should be in the results
    expect(result.ids).toContain(1);

    // Distances should be finite positive numbers
    for (const d of result.distances) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  }, 30_000);

  it('should return relevant results for semantic React query', async () => {
    if (!serverAvailable) return;

    const result = await adapter.query('React component splitting refactor', 5);

    expect(result.ids.length).toBeGreaterThan(0);
    // The React observation (id=2) should be in the results
    expect(result.ids).toContain(2);
  }, 30_000);

  it('should rank database results higher for database queries', async () => {
    if (!serverAvailable) return;

    const result = await adapter.query('SQL index optimization slow queries', 10);

    expect(result.ids.length).toBeGreaterThan(0);

    // observation 1 (database) should appear before observation 2 (React)
    const dbIndex = result.ids.indexOf(1);
    const reactIndex = result.ids.indexOf(2);

    // db observation must be in results
    expect(dbIndex).toBeGreaterThanOrEqual(0);

    // If both are present, database one should rank higher (earlier in list = lower distance)
    if (reactIndex >= 0) {
      expect(dbIndex).toBeLessThan(reactIndex);
    }
  }, 30_000);

  it('should find summaries via semantic search', async () => {
    if (!serverAvailable) return;

    const result = await adapter.query('what was the performance bottleneck', 10);

    expect(result.ids.length).toBeGreaterThan(0);
    // Summary (id=10) should be in results
    expect(result.ids).toContain(10);
  }, 30_000);

  it('should find user prompts via semantic search', async () => {
    if (!serverAvailable) return;

    const result = await adapter.query('fix slow queries dashboard', 10);

    expect(result.ids.length).toBeGreaterThan(0);
    // User prompt 100 should be in results
    expect(result.ids).toContain(100);
  }, 30_000);

  it('should return correct existing IDs for delta sync', async () => {
    if (!serverAvailable) return;

    const existing = await adapter.getExistingIds();

    expect(existing.observations.has(1)).toBe(true);
    expect(existing.observations.has(2)).toBe(true);
    expect(existing.summaries.has(10)).toBe(true);
    expect(existing.prompts.has(100)).toBe(true);
    expect(existing.prompts.has(101)).toBe(true);
  }, 30_000);

  it('should handle upsert (re-sync) without duplicating', async () => {
    if (!serverAvailable) return;

    // Re-sync observation 1 with updated narrative
    await adapter.syncObservation({
      observationId: 1,
      memorySessionId: 'session-1',
      project: TEST_PROJECT,
      observation: {
        type: 'discovery',
        title: 'Database optimization',
        subtitle: 'Query performance tuning',
        narrative: 'UPDATED: The composite index was the key fix. Query time dropped from 2s to 15ms.',
        facts: [
          'Composite index on (user_id, created_at) improved performance 100x',
          'PostgreSQL query planner was doing a sequential scan before the index'
        ],
        concepts: ['database', 'indexing', 'performance'],
        files_read: ['src/db/migrations/001.sql'],
        files_modified: ['src/db/migrations/002_add_index.sql']
      },
      promptNumber: 1,
      createdAtEpoch: Math.floor(Date.now() / 1000) - 3600,
      discoveryTokens: 500
    });

    // Existing IDs should NOT have duplicates
    const existing = await adapter.getExistingIds();
    expect(existing.observations.has(1)).toBe(true);
    // Set ensures uniqueness, but collection shouldn't have duplicate docs either
    expect(existing.observations.size).toBe(2);
  }, 30_000);
});
