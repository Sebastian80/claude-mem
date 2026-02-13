/**
 * ChromaHttpAdapter: VectorStore backed by ChromaDB via shared HTTP server
 *
 * Uses the chromadb npm package (HTTP client) to communicate with a shared
 * ChromaDB server managed by ChromaServerManager. Replaces per-session MCP
 * subprocess model, reducing memory from N×550MB to 1×550MB.
 *
 * Embedding is handled server-side by ChromaDB's default model (all-MiniLM-L6-v2),
 * matching the existing chroma-mcp behavior for index compatibility.
 */

import { ChromaClient } from 'chromadb';
import type { Metadata, Where } from 'chromadb';
import { VectorDocumentFormatter, type StoredObservation, type StoredSummary, type StoredUserPrompt } from './VectorDocumentFormatter.js';
import { identifyOrphanedCollections, identifyDocumentsToPrune } from './collection-utils.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { ChromaServerManager } from './ChromaServerManager.js';
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

/** Collection name prefix — all claude-mem collections use cm__<project> */
const COLLECTION_PREFIX = 'cm__';

/** Batch size for document operations */
const BATCH_SIZE = 100;

// Use a type alias for the collection since chromadb doesn't export the Collection class directly
type ChromaCollection = Awaited<ReturnType<ChromaClient['getOrCreateCollection']>>;

export class ChromaHttpAdapter implements VectorStore {
  private client: ChromaClient;
  private collection: ChromaCollection | null = null;
  private project: string;
  private collectionName: string;
  private serverManager: ChromaServerManager;

  constructor(project: string, serverManager: ChromaServerManager) {
    this.project = project;
    this.collectionName = `${COLLECTION_PREFIX}${project}`;
    this.serverManager = serverManager;

    const url = serverManager.getUrl();
    const [, host, portStr] = url.match(/http:\/\/([^:]+):(\d+)/) || [];

    this.client = new ChromaClient({
      host: host || '127.0.0.1',
      port: parseInt(portStr, 10) || 8100
    });
  }

  isAvailable(): boolean {
    return this.serverManager.isHealthy();
  }

  async syncObservation(params: SyncObservationParams): Promise<void> {
    if (!this.isAvailable()) return;

    const stored: StoredObservation = {
      id: params.observationId,
      memory_session_id: params.memorySessionId,
      project: params.project,
      text: null,
      type: params.observation.type,
      title: params.observation.title,
      subtitle: params.observation.subtitle,
      facts: JSON.stringify(params.observation.facts),
      narrative: params.observation.narrative,
      concepts: JSON.stringify(params.observation.concepts),
      files_read: JSON.stringify(params.observation.files_read),
      files_modified: JSON.stringify(params.observation.files_modified),
      prompt_number: params.promptNumber,
      discovery_tokens: params.discoveryTokens ?? 0,
      created_at: new Date(params.createdAtEpoch * 1000).toISOString(),
      created_at_epoch: params.createdAtEpoch
    };

    const documents = VectorDocumentFormatter.formatObservationDocs(stored);

    logger.info('VECTOR', 'Syncing observation', {
      observationId: params.observationId,
      documentCount: documents.length,
      project: params.project
    });

    await this.addDocuments(documents);
  }

  async syncSummary(params: SyncSummaryParams): Promise<void> {
    if (!this.isAvailable()) return;

    const stored: StoredSummary = {
      id: params.summaryId,
      memory_session_id: params.memorySessionId,
      project: params.project,
      request: params.summary.request,
      investigated: params.summary.investigated,
      learned: params.summary.learned,
      completed: params.summary.completed,
      next_steps: params.summary.next_steps,
      notes: params.summary.notes,
      prompt_number: params.promptNumber,
      discovery_tokens: params.discoveryTokens ?? 0,
      created_at: new Date(params.createdAtEpoch * 1000).toISOString(),
      created_at_epoch: params.createdAtEpoch
    };

    const documents = VectorDocumentFormatter.formatSummaryDocs(stored);

    logger.info('VECTOR', 'Syncing summary', {
      summaryId: params.summaryId,
      documentCount: documents.length,
      project: params.project
    });

    await this.addDocuments(documents);
  }

  async syncUserPrompt(params: SyncUserPromptParams): Promise<void> {
    if (!this.isAvailable()) return;

    const stored: StoredUserPrompt = {
      id: params.promptId,
      content_session_id: '',
      prompt_number: params.promptNumber,
      prompt_text: params.promptText,
      created_at: new Date(params.createdAtEpoch * 1000).toISOString(),
      created_at_epoch: params.createdAtEpoch,
      memory_session_id: params.memorySessionId,
      project: params.project
    };

    const document = VectorDocumentFormatter.formatUserPromptDoc(stored);

    logger.info('VECTOR', 'Syncing user prompt', {
      promptId: params.promptId,
      project: params.project
    });

    await this.addDocuments([document]);
  }

  /**
   * Semantic query against the vector store.
   * Deduplicates results by sqlite_id (one observation may produce multiple vector documents).
   */
  async query(text: string, limit: number, filter?: VectorFilter): Promise<VectorQueryResult> {
    if (!this.isAvailable()) {
      return { ids: [], distances: [], metadatas: [] };
    }

    const collection = await this.ensureCollection();

    try {
      const queryArgs: {
        queryTexts: string[];
        nResults: number;
        include: ('documents' | 'metadatas' | 'distances')[];
        where?: Where;
      } = {
        queryTexts: [text],
        nResults: limit,
        include: ['documents', 'metadatas', 'distances']
      };

      if (filter) {
        queryArgs.where = filter as Where;
      }

      const result = await collection.query(queryArgs);

      // Extract unique sqlite IDs from document IDs (same dedup logic as ChromaSync.queryChroma)
      const ids: number[] = [];
      const docIds = result.ids[0] || [];
      for (const docId of docIds) {
        const obsMatch = docId.match(/obs_(\d+)_/);
        const summaryMatch = docId.match(/summary_(\d+)_/);
        const promptMatch = docId.match(/prompt_(\d+)/);

        let sqliteId: number | null = null;
        if (obsMatch) {
          sqliteId = parseInt(obsMatch[1], 10);
        } else if (summaryMatch) {
          sqliteId = parseInt(summaryMatch[1], 10);
        } else if (promptMatch) {
          sqliteId = parseInt(promptMatch[1], 10);
        }

        if (sqliteId !== null && !ids.includes(sqliteId)) {
          ids.push(sqliteId);
        }
      }

      const distances = result.distances?.[0]?.filter((d): d is number => d !== null) || [];
      const metadatas = (result.metadatas?.[0] || []).filter((m): m is Metadata => m !== null);

      return { ids, distances, metadatas: metadatas as any[] };
    } catch (error) {
      logger.error('VECTOR', 'ChromaDB query failed', {
        project: this.project,
        query: text
      }, error as Error);
      return { ids: [], distances: [], metadatas: [] };
    }
  }

  /**
   * Batch add documents to the collection.
   * Uses upsert to handle re-syncing existing documents.
   */
  async addDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;

    const collection = await this.ensureCollection();

    // Process in batches
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      const batch = documents.slice(i, i + BATCH_SIZE);

      try {
        await collection.upsert({
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: batch.map(d => d.metadata as Metadata)
        });

        logger.debug('VECTOR', 'Documents upserted', {
          collection: this.collectionName,
          count: batch.length,
          batchIndex: Math.floor(i / BATCH_SIZE)
        });
      } catch (error) {
        logger.error('VECTOR', 'Failed to upsert documents', {
          collection: this.collectionName,
          count: batch.length
        }, error as Error);
        throw new Error(`Document upsert failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Get existing document IDs by type for delta sync (BackfillService).
   */
  async getExistingIds(): Promise<ExistingVectorIds> {
    const collection = await this.ensureCollection();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000;

    logger.info('VECTOR', 'Fetching existing document IDs', { project: this.project });

    while (true) {
      try {
        const result = await collection.get({
          limit,
          offset,
          where: { project: this.project } as Where,
          include: ['metadatas']
        });

        const metadatas = result.metadatas || [];
        if (metadatas.length === 0) break;

        for (const meta of metadatas) {
          if (!meta?.sqlite_id) continue;
          const id = Number(meta.sqlite_id);
          if (!Number.isFinite(id)) continue;

          if (meta.doc_type === 'observation') {
            observationIds.add(id);
          } else if (meta.doc_type === 'session_summary') {
            summaryIds.add(id);
          } else if (meta.doc_type === 'user_prompt') {
            promptIds.add(id);
          }
        }

        offset += limit;

        logger.debug('VECTOR', 'Fetched batch of existing IDs', {
          project: this.project,
          offset,
          batchSize: metadatas.length
        });
      } catch (error) {
        logger.error('VECTOR', 'Failed to fetch existing IDs', {
          project: this.project
        }, error as Error);
        throw error;
      }
    }

    logger.info('VECTOR', 'Existing IDs fetched', {
      project: this.project,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds };
  }

  /**
   * Run maintenance tasks: orphan collection cleanup and retention cap enforcement.
   */
  async performMaintenance(): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      await this.cleanOrphanedCollections();
      await this.enforceRetentionCap();
    } catch (error) {
      // Maintenance is best-effort
      logger.debug('VECTOR', 'Maintenance skipped', {}, error as Error);
    }
  }

  async close(): Promise<void> {
    this.collection = null;
    // HTTP client doesn't need explicit close
    logger.info('VECTOR', 'ChromaDB HTTP adapter closed', { project: this.project });
  }

  /**
   * Ensure collection exists, creating if needed.
   * Caches the collection reference for subsequent calls.
   */
  private async ensureCollection(): Promise<ChromaCollection> {
    if (this.collection) return this.collection;

    try {
      // embeddingFunction: null → server handles embedding
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction: null
      });

      logger.debug('VECTOR', 'Collection ready', { collection: this.collectionName });

      return this.collection;
    } catch (error) {
      logger.error('VECTOR', 'Failed to get/create collection', {
        collection: this.collectionName
      }, error as Error);
      throw error;
    }
  }

  /**
   * Delete orphaned collections that don't follow the cm__* naming convention.
   */
  private async cleanOrphanedCollections(): Promise<void> {
    try {
      const collections = await this.client.listCollections();
      const collectionNames = collections.map((c: any) => c.name || c);
      const orphans = identifyOrphanedCollections(collectionNames);

      for (const orphanName of orphans) {
        try {
          await this.client.deleteCollection({ name: orphanName });
          logger.warn('VECTOR', 'Deleted orphaned collection', { collection: orphanName });
        } catch (deleteError) {
          logger.error('VECTOR', 'Failed to delete orphaned collection',
            { collection: orphanName }, deleteError as Error);
        }
      }

      if (orphans.length > 0) {
        logger.info('VECTOR', 'Orphan cleanup complete', { deleted: orphans.length });
      }
    } catch (error) {
      logger.debug('VECTOR', 'Orphan cleanup skipped', {}, error as Error);
    }
  }

  /**
   * Prune oldest embeddings when source item count exceeds CLAUDE_MEM_CHROMA_MAX_ITEMS.
   */
  private async enforceRetentionCap(): Promise<void> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxItems = parseInt(settings.CLAUDE_MEM_CHROMA_MAX_ITEMS, 10);
    if (!maxItems || maxItems <= 0) return;

    const collection = await this.ensureCollection();

    try {
      const allMetas: Array<{ docId: string; sqlite_id: number; doc_type: string; created_at_epoch: number }> = [];
      let offset = 0;
      const limit = 1000;

      while (true) {
        const result = await collection.get({
          limit,
          offset,
          include: ['metadatas']
        });

        const ids = result.ids || [];
        const metadatas = result.metadatas || [];

        if (ids.length === 0) break;

        for (let i = 0; i < ids.length; i++) {
          const meta = metadatas[i];
          if (meta?.sqlite_id && meta?.doc_type && meta?.created_at_epoch) {
            allMetas.push({
              docId: ids[i],
              sqlite_id: Number(meta.sqlite_id),
              doc_type: meta.doc_type as string,
              created_at_epoch: Number(meta.created_at_epoch)
            });
          }
        }

        offset += limit;
      }

      const toPrune = identifyDocumentsToPrune(allMetas, maxItems);

      if (toPrune.length === 0) return;

      // Delete in batches
      const batchSize = 500;
      for (let i = 0; i < toPrune.length; i += batchSize) {
        const batch = toPrune.slice(i, i + batchSize);
        await collection.delete({ ids: batch });
      }

      logger.info('VECTOR', 'Retention cap enforced', {
        maxItems,
        prunedDocuments: toPrune.length,
        collection: this.collectionName
      });
    } catch (error) {
      logger.debug('VECTOR', 'Retention enforcement skipped', {}, error as Error);
    }
  }
}
