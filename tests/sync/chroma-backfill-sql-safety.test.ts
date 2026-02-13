/**
 * ChromaSync Backfill SQL Safety Tests
 *
 * Verifies that ensureBackfilled() uses parameterized SQL queries
 * instead of string interpolation for ID exclusion clauses.
 * Prevents SQL injection via Chroma metadata IDs.
 *
 * Sources:
 * - ChromaSync backfill logic from src/services/sync/ChromaSync.ts
 * - SQLite parameterized query patterns
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ChromaSync Backfill SQL Safety', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'success').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('Parameterized SQL in backfill exclusion clauses', () => {
    it('should NOT use string interpolation for NOT IN clauses', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // The vulnerable pattern: direct `.join(',')` without `.map(() => '?')`
      // e.g. `NOT IN (${existingObsIds.join(',')})` interpolates raw values into SQL
      // Safe pattern `NOT IN (${ids.map(() => '?').join(',')})` should NOT match
      const vulnerablePattern = /NOT IN \(\$\{existing\w+Ids\.join\(/g;
      const matches = sourceFile.match(vulnerablePattern);

      expect(matches).toBeNull();
    });

    it('should use parameterized placeholders for observation exclusion', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // The safe pattern: `NOT IN (${ids.map(() => '?').join(',')})`
      // This generates ?,?,? placeholders for prepared statement binding
      expect(sourceFile).toContain("existingObsIds.map(() => '?').join(',')");
    });

    it('should use parameterized placeholders for summary exclusion', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain("existingSummaryIds.map(() => '?').join(',')");
    });

    it('should use parameterized placeholders for prompt exclusion', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain("existingPromptIds.map(() => '?').join(',')");
    });

    it('should spread exclusion IDs into query parameters', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // All three queries must pass exclusion IDs as bound parameters
      // The pattern: .all(this.project, ...existingXxxIds)
      expect(sourceFile).toContain('...existingObsIds');
      expect(sourceFile).toContain('...existingSummaryIds');
      expect(sourceFile).toContain('...existingPromptIds');
    });
  });

  describe('Metadata ID coercion (defense-in-depth)', () => {
    it('should coerce sqlite_id to Number when reading from Chroma metadata', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // Defense-in-depth: even with parameterized queries, validate that
      // IDs from Chroma metadata are numeric before using them
      expect(sourceFile).toContain('Number(meta.sqlite_id)');
      expect(sourceFile).toContain('Number.isFinite');
    });
  });
});
