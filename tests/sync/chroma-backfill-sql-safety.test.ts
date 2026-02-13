/**
 * ChromaSync Backfill SQL Safety Tests
 *
 * Verifies that the parameterized exclusion pattern used in ensureBackfilled()
 * correctly excludes IDs via bound parameters, and that the Number coercion
 * defense filters non-numeric metadata values.
 *
 * Mock Justification: NONE (0% mock code)
 * - Uses real SQLite with ':memory:' - tests actual SQL execution
 * - Validates parameterized NOT IN clauses against real data
 *
 * Sources:
 * - ChromaSync.ensureBackfilled() exclusion pattern
 * - ChromaSync.getExistingChromaIds() Number coercion
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('Backfill SQL Parameterization', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        text TEXT
      )
    `);
    // Insert test rows
    const insert = db.prepare('INSERT INTO observations (project, text) VALUES (?, ?)');
    insert.run('test-project', 'observation 1');
    insert.run('test-project', 'observation 2');
    insert.run('test-project', 'observation 3');
    insert.run('test-project', 'observation 4');
    insert.run('test-project', 'observation 5');
    insert.run('other-project', 'other observation');
  });

  afterEach(() => {
    db.close();
  });

  it('should exclude IDs using parameterized NOT IN clause', () => {
    // Replicate the exact pattern from ChromaSync.ensureBackfilled():
    //   existingObsIds.map(() => '?').join(',')
    //   .all(this.project, ...existingObsIds)
    const existingObsIds = [1, 3, 5];
    const exclusionClause = existingObsIds.length > 0
      ? `AND id NOT IN (${existingObsIds.map(() => '?').join(',')})`
      : '';

    const results = db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all('test-project', ...existingObsIds) as { id: number; project: string; text: string }[];

    // Should return only IDs 2 and 4 (excluded 1, 3, 5)
    expect(results.map(r => r.id)).toEqual([2, 4]);
  });

  it('should return all rows when exclusion list is empty', () => {
    const existingObsIds: number[] = [];
    const exclusionClause = existingObsIds.length > 0
      ? `AND id NOT IN (${existingObsIds.map(() => '?').join(',')})`
      : '';

    const results = db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all('test-project', ...existingObsIds) as { id: number }[];

    expect(results.map(r => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should exclude all rows when all IDs are in exclusion list', () => {
    const existingObsIds = [1, 2, 3, 4, 5];
    const exclusionClause = `AND id NOT IN (${existingObsIds.map(() => '?').join(',')})`;

    const results = db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all('test-project', ...existingObsIds) as { id: number }[];

    expect(results).toEqual([]);
  });

  it('should scope exclusion to project filter', () => {
    // Exclude ID 1, but query for 'other-project' — ID 1 belongs to 'test-project'
    const existingObsIds = [1];
    const exclusionClause = `AND id NOT IN (${existingObsIds.map(() => '?').join(',')})`;

    const results = db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all('other-project', ...existingObsIds) as { id: number; project: string }[];

    // The 'other-project' row has ID 6, which is not excluded
    expect(results.length).toBe(1);
    expect(results[0].project).toBe('other-project');
  });
});

describe('Chroma Metadata ID Coercion', () => {
  // Replicates the Number coercion + isFinite check from getExistingChromaIds():
  //   const id = Number(meta.sqlite_id);
  //   if (!Number.isFinite(id)) continue;

  function coerceIds(metadatas: { sqlite_id: unknown; doc_type: string }[]): Set<number> {
    const ids = new Set<number>();
    for (const meta of metadatas) {
      if (meta.sqlite_id) {
        const id = Number(meta.sqlite_id);
        if (!Number.isFinite(id)) continue;
        ids.add(id);
      }
    }
    return ids;
  }

  it('should accept numeric integer IDs', () => {
    const ids = coerceIds([
      { sqlite_id: 1, doc_type: 'observation' },
      { sqlite_id: 42, doc_type: 'observation' },
    ]);
    expect(ids).toEqual(new Set([1, 42]));
  });

  it('should accept string-encoded numeric IDs', () => {
    const ids = coerceIds([
      { sqlite_id: '1', doc_type: 'observation' },
      { sqlite_id: '42', doc_type: 'observation' },
    ]);
    expect(ids).toEqual(new Set([1, 42]));
  });

  it('should reject non-numeric string values', () => {
    const ids = coerceIds([
      { sqlite_id: 'not-a-number', doc_type: 'observation' },
      { sqlite_id: '1; DROP TABLE observations', doc_type: 'observation' },
      { sqlite_id: 'abc', doc_type: 'observation' },
    ]);
    expect(ids.size).toBe(0);
  });

  it('should reject Infinity and NaN', () => {
    const ids = coerceIds([
      { sqlite_id: Infinity, doc_type: 'observation' },
      { sqlite_id: -Infinity, doc_type: 'observation' },
      { sqlite_id: NaN, doc_type: 'observation' },
    ]);
    expect(ids.size).toBe(0);
  });

  it('should skip falsy sqlite_id values', () => {
    const ids = coerceIds([
      { sqlite_id: null, doc_type: 'observation' },
      { sqlite_id: undefined, doc_type: 'observation' },
      { sqlite_id: 0, doc_type: 'observation' },  // 0 is falsy — skipped by `if (meta.sqlite_id)`
      { sqlite_id: '', doc_type: 'observation' },
    ]);
    expect(ids.size).toBe(0);
  });

  it('should filter mixed valid and invalid IDs', () => {
    const ids = coerceIds([
      { sqlite_id: 1, doc_type: 'observation' },
      { sqlite_id: 'garbage', doc_type: 'observation' },
      { sqlite_id: 3, doc_type: 'observation' },
      { sqlite_id: Infinity, doc_type: 'observation' },
      { sqlite_id: '5', doc_type: 'observation' },
    ]);
    expect(ids).toEqual(new Set([1, 3, 5]));
  });
});
