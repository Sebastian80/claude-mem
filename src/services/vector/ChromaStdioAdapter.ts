/**
 * ChromaStdioAdapter: VectorStore backed by ChromaDB via MCP stdio subprocess
 *
 * Manages a chroma-mcp subprocess via MCP SDK's StdioClientTransport.
 * Each adapter instance owns one subprocess connection. The subprocess
 * handles embedding (all-MiniLM-L6-v2) and persistent storage.
 *
 * Disabled on Windows to prevent console popup windows from subprocess spawning.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VectorDocumentFormatter } from './VectorDocumentFormatter.js';
import { identifyOrphanedCollections, identifyDocumentsToPrune } from './collection-utils.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';
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
import type { StoredObservation, StoredSummary, StoredUserPrompt } from './VectorDocumentFormatter.js';

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

export class ChromaStdioAdapter implements VectorStore {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private project: string;
  private collectionName: string;
  private readonly VECTOR_DB_DIR: string;
  private readonly BATCH_SIZE = 100;
  private connectionPromise: Promise<void> | null = null;

  // Windows: Chroma disabled due to MCP SDK spawning console popups
  // See: https://github.com/anthropics/claude-mem/issues/675
  // Will be re-enabled when we migrate to persistent HTTP server
  private readonly disabled: boolean;

  constructor(project: string) {
    this.project = project;
    this.collectionName = `cm__${project}`;
    this.VECTOR_DB_DIR = path.join(os.homedir(), '.claude-mem', 'vector-db');

    // Disable on Windows to prevent console popups from MCP subprocess spawning
    this.disabled = process.platform === 'win32';
    if (this.disabled) {
      logger.warn('VECTOR', 'Vector search disabled on Windows (prevents console popups)', {
        project: this.project,
        reason: 'MCP SDK subprocess spawning causes visible console windows'
      });
    }
  }

  // --- VectorStore interface ---

  isAvailable(): boolean {
    return !this.disabled;
  }

  async syncObservation(params: SyncObservationParams): Promise<void> {
    if (this.disabled) return;

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
    if (this.disabled) return;

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
    if (this.disabled) return;

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

  async query(text: string, limit: number, filter?: VectorFilter): Promise<VectorQueryResult> {
    if (this.disabled) {
      return { ids: [], distances: [], metadatas: [] };
    }

    await this.ensureConnection();

    if (!this.client) {
      throw new Error(`MCP client not initialized. Project: ${this.project}`);
    }

    const whereStringified = filter ? JSON.stringify(filter) : undefined;

    const arguments_obj = {
      collection_name: this.collectionName,
      query_texts: [text],
      n_results: limit,
      include: ['documents', 'metadatas', 'distances'],
      where: whereStringified
    };

    let result;
    try {
      result = await this.client.callTool({
        name: 'chroma_query_documents',
        arguments: arguments_obj
      });
    } catch (error) {
      if (this.isConnectionError(error)) {
        await this.resetConnection();
        logger.error('VECTOR', 'Connection lost during query',
          { project: this.project, query: text }, error as Error);
        throw new Error(`Query failed - connection lost: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }

    const resultText = result.content[0]?.text || (() => {
      logger.error('VECTOR', 'Missing text in MCP chroma_query_documents result', {
        project: this.project,
        query_text: text
      });
      return '';
    })();

    let parsed: any;
    try {
      parsed = JSON.parse(resultText);
    } catch (error) {
      logger.error('VECTOR', 'Failed to parse query response', { project: this.project }, error as Error);
      return { ids: [], distances: [], metadatas: [] };
    }

    // Extract unique sqlite IDs from document IDs
    const ids: number[] = [];
    const docIds = parsed.ids?.[0] || [];
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

    const distances = parsed.distances?.[0] || [];
    const metadatas = parsed.metadatas?.[0] || [];

    return { ids, distances, metadatas };
  }

  async addDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;

    await this.ensureCollection();

    if (!this.client) {
      throw new Error(`MCP client not initialized. Project: ${this.project}`);
    }

    try {
      await this.client.callTool({
        name: 'chroma_add_documents',
        arguments: {
          collection_name: this.collectionName,
          documents: documents.map(d => d.document),
          ids: documents.map(d => d.id),
          metadatas: documents.map(d => d.metadata)
        }
      });

      logger.debug('VECTOR', 'Documents added', {
        collection: this.collectionName,
        count: documents.length
      });
    } catch (error) {
      logger.error('VECTOR', 'Failed to add documents', {
        collection: this.collectionName,
        count: documents.length
      }, error as Error);
      throw new Error(`Document add failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getExistingIds(): Promise<ExistingVectorIds> {
    await this.ensureConnection();

    if (!this.client) {
      throw new Error(`MCP client not initialized. Project: ${this.project}`);
    }

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();

    let offset = 0;
    const limit = 1000;

    logger.info('VECTOR', 'Fetching existing document IDs...', { project: this.project });

    while (true) {
      try {
        const result = await this.client.callTool({
          name: 'chroma_get_documents',
          arguments: {
            collection_name: this.collectionName,
            limit,
            offset,
            where: { project: this.project },
            include: ['metadatas']
          }
        });

        const data = result.content[0];
        if (data.type !== 'text') {
          throw new Error('Unexpected response type from chroma_get_documents');
        }

        const parsed = JSON.parse(data.text);
        const metadatas = parsed.metadatas || [];

        if (metadatas.length === 0) break;

        for (const meta of metadatas) {
          if (meta.sqlite_id) {
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
        }

        offset += limit;

        logger.debug('VECTOR', 'Fetched batch of existing IDs', {
          project: this.project,
          offset,
          batchSize: metadatas.length
        });
      } catch (error) {
        logger.error('VECTOR', 'Failed to fetch existing IDs', { project: this.project }, error as Error);
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

  async performMaintenance(): Promise<void> {
    // Maintenance (orphan cleanup, retention cap) is handled inside
    // ensureCollection() which runs on every sync call.
  }

  async close(): Promise<void> {
    if (!this.connected && !this.client && !this.transport) {
      return;
    }

    try {
      if (this.client) {
        try {
          await this.client.close();
        } catch (e) {
          logger.debug('VECTOR', 'Client close error (expected if already dead)', {}, e as Error);
        }
      }

      if (this.transport) {
        try {
          await this.transport.close();
        } catch (e) {
          logger.debug('VECTOR', 'Transport close error (expected if already dead)', {}, e as Error);
        }
      }

      logger.info('VECTOR', 'MCP client and subprocess closed', { project: this.project });
    } finally {
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.connectionPromise = null;
    }
  }

  // --- MCP transport internals ---

  /**
   * Ensure MCP client is connected to Chroma server.
   * Uses a connection promise cache so concurrent callers share a single
   * connection attempt instead of each spawning their own subprocess.
   */
  private async ensureConnection(): Promise<void> {
    if (this.connected && this.client) return;
    if (this.connectionPromise) return this.connectionPromise;

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  /**
   * Spawn chroma-mcp subprocess and establish MCP connection.
   */
  private async doConnect(): Promise<void> {
    logger.info('VECTOR', 'Connecting to Chroma MCP server...', { project: this.project });

    try {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const pythonVersion = settings.CLAUDE_MEM_PYTHON_VERSION;
      const isWindows = process.platform === 'win32';

      const combinedCertPath = this.getCombinedCertPath();

      const transportOptions: any = {
        command: 'uvx',
        args: [
          '--python', pythonVersion,
          '--with', 'chromadb<1',
          'chroma-mcp',
          '--client-type', 'persistent',
          '--data-dir', this.VECTOR_DB_DIR
        ],
        stderr: 'ignore'
      };

      if (combinedCertPath) {
        transportOptions.env = {
          ...process.env,
          SSL_CERT_FILE: combinedCertPath,
          REQUESTS_CA_BUNDLE: combinedCertPath,
          CURL_CA_BUNDLE: combinedCertPath
        };
        logger.info('VECTOR', 'Using combined SSL certificates for Zscaler compatibility', {
          certPath: combinedCertPath
        });
      }

      if (isWindows) {
        transportOptions.windowsHide = true;
        logger.debug('VECTOR', 'Windows detected, attempting to hide console window', { project: this.project });
      }

      this.transport = new StdioClientTransport(transportOptions);

      this.client = new Client({
        name: 'claude-mem-chroma-sync',
        version: packageVersion
      }, {
        capabilities: {}
      });

      await this.client.connect(this.transport);
      this.connected = true;

      logger.info('VECTOR', 'Connected to Chroma MCP server', { project: this.project });
    } catch (error) {
      logger.error('VECTOR', 'Failed to connect to Chroma MCP server', { project: this.project }, error as Error);
      throw new Error(`Chroma connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure collection exists, create if needed.
   * Also runs orphan cleanup and retention cap enforcement.
   */
  private async ensureCollection(): Promise<void> {
    await this.ensureConnection();

    if (!this.client) {
      throw new Error(`MCP client not initialized. Project: ${this.project}`);
    }

    try {
      await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: { collection_name: this.collectionName }
      });

      logger.debug('VECTOR', 'Collection exists', { collection: this.collectionName });

      await this.cleanOrphanedCollections();
      await this.enforceRetentionCap();
    } catch (error) {
      if (this.isConnectionError(error)) {
        await this.resetConnection();
        logger.error('VECTOR', 'Connection lost during collection check',
          { collection: this.collectionName }, error as Error);
        throw new Error(`Connection lost: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Collection not found — attempt creation
      logger.error('VECTOR', 'Collection check failed, attempting to create', { collection: this.collectionName }, error as Error);
      logger.info('VECTOR', 'Creating collection', { collection: this.collectionName });

      try {
        await this.client.callTool({
          name: 'chroma_create_collection',
          arguments: {
            collection_name: this.collectionName,
            embedding_function_name: 'default'
          }
        });

        logger.info('VECTOR', 'Collection created', { collection: this.collectionName });
      } catch (createError) {
        logger.error('VECTOR', 'Failed to create collection', { collection: this.collectionName }, createError as Error);
        throw new Error(`Collection creation failed: ${createError instanceof Error ? createError.message : String(createError)}`);
      }
    }
  }

  /**
   * Delete any collections that don't match the cm__* naming convention.
   * Non-critical: logs errors but never throws.
   */
  private async cleanOrphanedCollections(): Promise<void> {
    if (!this.client) return;

    try {
      const result = await this.client.callTool({
        name: 'chroma_list_collections',
        arguments: {}
      });

      const data = result.content[0];
      if (data.type !== 'text') return;

      const parsed = JSON.parse(data.text);
      const collectionNames: string[] = Array.isArray(parsed)
        ? parsed.map((c: any) => typeof c === 'string' ? c : c.name).filter(Boolean)
        : [];

      const orphans = identifyOrphanedCollections(collectionNames);

      for (const orphanName of orphans) {
        try {
          await this.client.callTool({
            name: 'chroma_delete_collection',
            arguments: { collection_name: orphanName }
          });
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
   * Non-critical: logs errors but never throws.
   */
  private async enforceRetentionCap(): Promise<void> {
    if (!this.client) return;

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const maxItems = parseInt(settings.CLAUDE_MEM_CHROMA_MAX_ITEMS, 10);
    if (!maxItems || maxItems <= 0) return;

    try {
      const allMetas: Array<{ docId: string; sqlite_id: number; doc_type: string; created_at_epoch: number }> = [];
      let offset = 0;
      const limit = 1000;

      while (true) {
        const result = await this.client.callTool({
          name: 'chroma_get_documents',
          arguments: {
            collection_name: this.collectionName,
            limit,
            offset,
            include: ['metadatas']
          }
        });

        const data = result.content[0];
        if (data.type !== 'text') break;

        const parsed = JSON.parse(data.text);
        const ids = parsed.ids || [];
        const metadatas = parsed.metadatas || [];

        if (ids.length === 0) break;

        for (let i = 0; i < ids.length; i++) {
          const meta = metadatas[i];
          if (meta?.sqlite_id && meta?.doc_type && meta?.created_at_epoch) {
            allMetas.push({
              docId: ids[i],
              sqlite_id: Number(meta.sqlite_id),
              doc_type: meta.doc_type,
              created_at_epoch: Number(meta.created_at_epoch)
            });
          }
        }

        offset += limit;
      }

      const toPrune = identifyDocumentsToPrune(allMetas, maxItems);

      if (toPrune.length === 0) return;

      const batchSize = 500;
      for (let i = 0; i < toPrune.length; i += batchSize) {
        const batch = toPrune.slice(i, i + batchSize);
        await this.client.callTool({
          name: 'chroma_delete_documents',
          arguments: {
            collection_name: this.collectionName,
            ids: batch
          }
        });
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

  // --- Connection error handling ---

  private isConnectionError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('Not connected') ||
           msg.includes('Connection closed') ||
           msg.includes('MCP error -32000');
  }

  private async resetConnection(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch (closeErr) {
        logger.debug('VECTOR', 'Transport close error (expected if already dead)', {}, closeErr as Error);
      }
    }
    this.connected = false;
    this.client = null;
    this.transport = null;
    this.connectionPromise = null;
  }

  // --- SSL certificate handling ---

  /**
   * Get or create combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * Combines standard certifi certificates with enterprise security certificates.
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    // Only create on macOS (Zscaler certificate extraction uses macOS security command)
    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch {
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch {
        return undefined;
      }

      if (!zscalerCert ||
          !zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);
      logger.info('VECTOR', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('VECTOR', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }
}
