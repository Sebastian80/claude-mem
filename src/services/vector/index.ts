/**
 * Vector store module barrel exports
 */

// Core interface and types
export type {
  VectorStore,
  VectorBackend,
  VectorDocument,
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
export { ChromaHttpAdapter } from './ChromaHttpAdapter.js';

// Server management
export { ChromaServerManager } from './ChromaServerManager.js';

// Shared utilities
export { VectorDocumentFormatter } from './VectorDocumentFormatter.js';
export type { StoredObservation, StoredSummary, StoredUserPrompt } from './VectorDocumentFormatter.js';
export { identifyOrphanedCollections, identifyDocumentsToPrune } from './collection-utils.js';
export { BackfillService } from './BackfillService.js';
