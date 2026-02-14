import { describe, it, expect } from 'bun:test';
import { identifyOrphanedCollections, identifyDocumentsToPrune } from '../../src/services/vector/collection-utils.js';

describe('identifyOrphanedCollections', () => {
  it('should identify collections without cm__ prefix', () => {
    const collections = ['cm__project-a', 'random-uuid-name', 'cm__project-b', 'another-orphan'];
    const orphans = identifyOrphanedCollections(collections);

    expect(orphans).toEqual(['random-uuid-name', 'another-orphan']);
  });

  it('should return empty array when all collections follow naming convention', () => {
    const collections = ['cm__project-a', 'cm__project-b'];
    const orphans = identifyOrphanedCollections(collections);

    expect(orphans).toEqual([]);
  });

  it('should return empty array for empty input', () => {
    expect(identifyOrphanedCollections([])).toEqual([]);
  });

  it('should treat all collections as orphaned when none have prefix', () => {
    const collections = ['uuid-1', 'uuid-2', 'test-collection'];
    const orphans = identifyOrphanedCollections(collections);

    expect(orphans).toEqual(collections);
  });
});

describe('identifyDocumentsToPrune', () => {
  it('should prune oldest items beyond the cap', () => {
    const metadatas = [
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_1_fact_0', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 2000 },
      { docId: 'obs_3_narrative', sqlite_id: 3, doc_type: 'observation', created_at_epoch: 3000 },
    ];

    // Cap at 2 source items → obs_1 (oldest) should be pruned
    const toPrune = identifyDocumentsToPrune(metadatas, 2);

    expect(toPrune).toContain('obs_1_narrative');
    expect(toPrune).toContain('obs_1_fact_0');
    expect(toPrune).toHaveLength(2);
  });

  it('should return empty when under cap', () => {
    const metadatas = [
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 2000 },
    ];

    const toPrune = identifyDocumentsToPrune(metadatas, 5);
    expect(toPrune).toEqual([]);
  });

  it('should return empty when maxItems is 0 (unlimited)', () => {
    const metadatas = [
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
    ];

    expect(identifyDocumentsToPrune(metadatas, 0)).toEqual([]);
  });

  it('should return empty for empty input', () => {
    expect(identifyDocumentsToPrune([], 10)).toEqual([]);
  });

  it('should group by doc_type + sqlite_id', () => {
    // Same sqlite_id but different doc_types = different source items
    const metadatas = [
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'summary_1_request', sqlite_id: 1, doc_type: 'session_summary', created_at_epoch: 2000 },
      { docId: 'prompt_1', sqlite_id: 1, doc_type: 'user_prompt', created_at_epoch: 3000 },
    ];

    // Cap at 2 → oldest (observation:1 at epoch 1000) should be pruned
    const toPrune = identifyDocumentsToPrune(metadatas, 2);
    expect(toPrune).toEqual(['obs_1_narrative']);
  });

  it('should prune all documents belonging to an item', () => {
    const metadatas = [
      // Item 1: 3 documents
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_1_fact_0', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_1_fact_1', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      // Item 2: 1 document
      { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 2000 },
    ];

    const toPrune = identifyDocumentsToPrune(metadatas, 1);
    expect(toPrune).toHaveLength(3);
    expect(toPrune).toContain('obs_1_narrative');
    expect(toPrune).toContain('obs_1_fact_0');
    expect(toPrune).toContain('obs_1_fact_1');
  });

  it('should return empty when exactly at cap', () => {
    const metadatas = [
      { docId: 'obs_1_narrative', sqlite_id: 1, doc_type: 'observation', created_at_epoch: 1000 },
      { docId: 'obs_2_narrative', sqlite_id: 2, doc_type: 'observation', created_at_epoch: 2000 },
    ];

    const toPrune = identifyDocumentsToPrune(metadatas, 2);
    expect(toPrune).toEqual([]);
  });
});
