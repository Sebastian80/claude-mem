/**
 * Collection utilities: Pure functions for vector collection maintenance
 *
 * Extracted from ChromaSync static methods. Used by all VectorStore adapters
 * for orphan cleanup and retention enforcement.
 */

/** Valid collection name prefix — all claude-mem collections use cm__<project> */
const COLLECTION_PREFIX = 'cm__';

/**
 * Identify orphaned collections that don't follow the cm__<project> naming convention.
 * Orphaned collections are created when chroma-mcp is killed mid-write (SIGKILL)
 * and ChromaDB's get_or_create_collection creates a collection named with a UUID
 * on the corrupted SQLite state (journal_mode=delete, not crash-safe).
 */
export function identifyOrphanedCollections(collectionNames: string[]): string[] {
  return collectionNames.filter(name => !name.startsWith(COLLECTION_PREFIX));
}

/**
 * Identify embedding document IDs to prune based on a retention cap.
 * Groups documents by source item (sqlite_id + doc_type), sorts by age,
 * and returns all document IDs belonging to items beyond the cap.
 *
 * @param metadatas - Array of {docId, sqlite_id, doc_type, created_at_epoch}
 * @param maxItems  - Maximum source items to retain. 0 = unlimited.
 * @returns Array of document IDs to delete from the vector store
 */
export function identifyDocumentsToPrune(
  metadatas: Array<{ docId: string; sqlite_id: number; doc_type: string; created_at_epoch: number }>,
  maxItems: number
): string[] {
  if (maxItems <= 0 || metadatas.length === 0) return [];

  // Group documents by source item (sqlite_id + doc_type)
  const sourceItems = new Map<string, { epoch: number; docIds: string[] }>();

  for (const meta of metadatas) {
    const key = `${meta.doc_type}:${meta.sqlite_id}`;
    const existing = sourceItems.get(key);
    if (existing) {
      existing.docIds.push(meta.docId);
    } else {
      sourceItems.set(key, { epoch: meta.created_at_epoch, docIds: [meta.docId] });
    }
  }

  if (sourceItems.size <= maxItems) return [];

  // Sort source items by epoch descending (newest first), keep the top maxItems
  const sorted = Array.from(sourceItems.values()).sort((a, b) => b.epoch - a.epoch);
  const toPrune = sorted.slice(maxItems);

  return toPrune.flatMap(item => item.docIds);
}
