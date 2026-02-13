/**
 * BackfillService: Delta sync from SQLite to VectorStore
 *
 * Finds records in SQLite that are missing from the vector store and
 * batch-uploads them. Not called on the production hot path —
 * used for recovery/maintenance after crashes or fresh vector store setup.
 */

import { ChromaDocumentFormatter } from './ChromaDocumentFormatter.js';
import type { StoredObservation, StoredSummary, StoredUserPrompt } from './ChromaDocumentFormatter.js';
import type { VectorStore, ChromaDocument } from './VectorStore.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';

const BATCH_SIZE = 100;

export class BackfillService {
  constructor(
    private vectorStore: VectorStore,
    private sessionStore: SessionStore,
    private project: string
  ) {}

  /**
   * Sync all observations, summaries, and prompts missing from the vector store.
   * Reads from SQLite, formats into vector documents, and uploads in batches.
   */
  async backfill(): Promise<void> {
    if (!this.vectorStore.isAvailable()) return;

    logger.info('BACKFILL', 'Starting delta sync', { project: this.project });

    const indexed = await this.vectorStore.getExistingIds();

    await this.backfillObservations(indexed.observations);
    await this.backfillSummaries(indexed.summaries);
    await this.backfillPrompts(indexed.prompts);

    logger.info('BACKFILL', 'Delta sync complete', { project: this.project });
  }

  private async backfillObservations(indexedIds: Set<number>): Promise<void> {
    const excludedIds = Array.from(indexedIds);
    const exclusionClause = excludedIds.length > 0
      ? `AND id NOT IN (${excludedIds.map(() => '?').join(',')})`
      : '';

    const missing = this.sessionStore.db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all(this.project, ...excludedIds) as StoredObservation[];

    const total = this.sessionStore.db.prepare(
      `SELECT COUNT(*) as count FROM observations WHERE project = ?`
    ).get(this.project) as { count: number };

    logger.info('BACKFILL', 'Observations', {
      project: this.project,
      missing: missing.length,
      indexed: indexedIds.size,
      total: total.count
    });

    const docs: ChromaDocument[] = [];
    for (const obs of missing) {
      docs.push(...ChromaDocumentFormatter.formatObservationDocs(obs));
    }

    await this.uploadInBatches(docs, 'observations');
  }

  private async backfillSummaries(indexedIds: Set<number>): Promise<void> {
    const excludedIds = Array.from(indexedIds);
    const exclusionClause = excludedIds.length > 0
      ? `AND id NOT IN (${excludedIds.map(() => '?').join(',')})`
      : '';

    const missing = this.sessionStore.db.prepare(`
      SELECT * FROM session_summaries
      WHERE project = ? ${exclusionClause}
      ORDER BY id ASC
    `).all(this.project, ...excludedIds) as StoredSummary[];

    const total = this.sessionStore.db.prepare(
      `SELECT COUNT(*) as count FROM session_summaries WHERE project = ?`
    ).get(this.project) as { count: number };

    logger.info('BACKFILL', 'Summaries', {
      project: this.project,
      missing: missing.length,
      indexed: indexedIds.size,
      total: total.count
    });

    const docs: ChromaDocument[] = [];
    for (const summary of missing) {
      docs.push(...ChromaDocumentFormatter.formatSummaryDocs(summary));
    }

    await this.uploadInBatches(docs, 'summaries');
  }

  private async backfillPrompts(indexedIds: Set<number>): Promise<void> {
    const excludedIds = Array.from(indexedIds);
    const exclusionClause = excludedIds.length > 0
      ? `AND up.id NOT IN (${excludedIds.map(() => '?').join(',')})`
      : '';

    const missing = this.sessionStore.db.prepare(`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ? ${exclusionClause}
      ORDER BY up.id ASC
    `).all(this.project, ...excludedIds) as StoredUserPrompt[];

    const total = this.sessionStore.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ?
    `).get(this.project) as { count: number };

    logger.info('BACKFILL', 'User prompts', {
      project: this.project,
      missing: missing.length,
      indexed: indexedIds.size,
      total: total.count
    });

    const docs: ChromaDocument[] = [];
    for (const prompt of missing) {
      docs.push(ChromaDocumentFormatter.formatUserPromptDoc(prompt));
    }

    await this.uploadInBatches(docs, 'prompts');
  }

  private async uploadInBatches(docs: ChromaDocument[], label: string): Promise<void> {
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      await this.vectorStore.addDocuments(batch);

      logger.debug('BACKFILL', `${label} progress`, {
        project: this.project,
        progress: `${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`
      });
    }
  }
}
