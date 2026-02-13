/**
 * ChromaStdioAdapter: VectorStore backed by ChromaDB via MCP stdio subprocess
 *
 * Thin wrapper delegating to the existing ChromaSync class.
 * This is the known-working fallback if the HTTP adapter has issues.
 * Preserves all existing behavior while conforming to the VectorStore interface.
 */

import { ChromaSync } from '../sync/ChromaSync.js';
import type {
  VectorStore,
  SyncObservationParams,
  SyncSummaryParams,
  SyncUserPromptParams,
  VectorQueryResult,
  VectorFilter,
  ExistingVectorIds,
  VectorDocument
} from './VectorStore.js';

export class ChromaStdioAdapter implements VectorStore {
  private chromaSync: ChromaSync;

  constructor(project: string) {
    this.chromaSync = new ChromaSync(project);
  }

  isAvailable(): boolean {
    return !this.chromaSync.isDisabled();
  }

  async syncObservation(params: SyncObservationParams): Promise<void> {
    return this.chromaSync.syncObservation(
      params.observationId,
      params.memorySessionId,
      params.project,
      params.observation,
      params.promptNumber,
      params.createdAtEpoch,
      params.discoveryTokens ?? 0
    );
  }

  async syncSummary(params: SyncSummaryParams): Promise<void> {
    return this.chromaSync.syncSummary(
      params.summaryId,
      params.memorySessionId,
      params.project,
      params.summary,
      params.promptNumber,
      params.createdAtEpoch,
      params.discoveryTokens ?? 0
    );
  }

  async syncUserPrompt(params: SyncUserPromptParams): Promise<void> {
    return this.chromaSync.syncUserPrompt(
      params.promptId,
      params.memorySessionId,
      params.project,
      params.promptText,
      params.promptNumber,
      params.createdAtEpoch
    );
  }

  async query(text: string, limit: number, filter?: VectorFilter): Promise<VectorQueryResult> {
    const result = await this.chromaSync.queryChroma(text, limit, filter);
    return {
      ids: result.ids,
      distances: result.distances,
      metadatas: result.metadatas
    };
  }

  async addDocuments(documents: VectorDocument[]): Promise<void> {
    return this.chromaSync.addDocuments(documents);
  }

  async getExistingIds(): Promise<ExistingVectorIds> {
    return this.chromaSync.getExistingChromaIds();
  }

  async performMaintenance(): Promise<void> {
    // Maintenance (orphan cleanup, retention cap) is handled inside
    // ChromaSync.ensureCollection() which runs on every sync call.
  }

  async close(): Promise<void> {
    return this.chromaSync.close();
  }
}
