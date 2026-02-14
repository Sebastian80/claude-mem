/**
 * VectorStore: Abstract interface for vector database operations
 *
 * Decouples consumers from specific vector DB implementations.
 * Current backends: ChromaStdioAdapter (MCP subprocess)
 * Future: sqlite-vec (in-process, no external dependencies)
 */

import type { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';

// --- Backend configuration ---

export type VectorBackend = 'chroma-stdio' | 'sqlite-vec';

// --- Document types ---

export interface VectorDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

export interface VectorDocumentMetadata {
  sqlite_id: number;
  doc_type: 'observation' | 'session_summary' | 'user_prompt';
  memory_session_id: string;
  project: string;
  created_at_epoch: number;
  [key: string]: string | number;
}

// --- Sync parameter types ---

export interface SyncObservationParams {
  observationId: number;
  memorySessionId: string;
  project: string;
  observation: ParsedObservation;
  promptNumber: number;
  createdAtEpoch: number;
  discoveryTokens?: number;
}

export interface SyncSummaryParams {
  summaryId: number;
  memorySessionId: string;
  project: string;
  summary: ParsedSummary;
  promptNumber: number;
  createdAtEpoch: number;
  discoveryTokens?: number;
}

export interface SyncUserPromptParams {
  promptId: number;
  memorySessionId: string;
  project: string;
  promptText: string;
  promptNumber: number;
  createdAtEpoch: number;
}

// --- Query types ---

export interface VectorFilter {
  doc_type?: string;
  [key: string]: any;
}

export interface VectorQueryResult {
  ids: number[];
  distances: number[];
  metadatas: VectorDocumentMetadata[];
}

// --- Backfill types ---

export interface ExistingVectorIds {
  observations: Set<number>;
  summaries: Set<number>;
  prompts: Set<number>;
}

// --- Core interface ---

export interface VectorStore {
  /** Whether the vector store is currently operational */
  isAvailable(): boolean;

  /** Sync a single observation to the vector store */
  syncObservation(params: SyncObservationParams): Promise<void>;

  /** Sync a single summary to the vector store */
  syncSummary(params: SyncSummaryParams): Promise<void>;

  /** Sync a single user prompt to the vector store */
  syncUserPrompt(params: SyncUserPromptParams): Promise<void>;

  /** Semantic query against the vector store */
  query(text: string, limit: number, filter?: VectorFilter): Promise<VectorQueryResult>;

  /** Batch add documents (used by BackfillService) */
  addDocuments(documents: VectorDocument[]): Promise<void>;

  /** Get existing document IDs by type (used by BackfillService for delta sync) */
  getExistingIds(): Promise<ExistingVectorIds>;

  /** Run maintenance tasks (orphan cleanup, retention cap enforcement) */
  performMaintenance(): Promise<void>;

  /** Release resources */
  close(): Promise<void>;
}
