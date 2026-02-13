/**
 * Vector store module barrel exports
 */

// Core interface and types
export type {
  VectorStore,
  VectorBackend,
  ChromaDocument,
  VectorDocumentMetadata,
  SyncObservationParams,
  SyncSummaryParams,
  SyncUserPromptParams,
  VectorQueryResult,
  VectorFilter,
  ExistingVectorIds
} from './VectorStore.js';

// Factory
export { VectorStoreFactory } from './VectorStoreFactory.js';

// Adapters
export { ChromaStdioAdapter } from './ChromaStdioAdapter.js';

// Shared utilities
export { ChromaDocumentFormatter } from './ChromaDocumentFormatter.js';
export type { StoredObservation, StoredSummary, StoredUserPrompt } from './ChromaDocumentFormatter.js';
export { identifyOrphanedCollections, identifyDocumentsToPrune } from './collection-utils.js';
export { BackfillService } from './BackfillService.js';
