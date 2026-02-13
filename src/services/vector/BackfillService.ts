/**
 * BackfillService: Delta sync from SQLite to VectorStore
 *
 * Extracted from ChromaSync.ensureBackfilled(). Reads SQLite via SessionStore,
 * writes via VectorStore interface. Not called from production hot path —
 * available for manual/maintenance use.
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { ChromaDocumentFormatter } from './ChromaDocumentFormatter.js';
import type { StoredObservation, StoredSummary, StoredUserPrompt } from './ChromaDocumentFormatter.js';
import type { VectorStore, ChromaDocument } from './VectorStore.js';
import { logger } from '../../utils/logger.js';

const BATCH_SIZE = 100;

export class BackfillService {
  constructor(
    private vectorStore: VectorStore,
    private project: string
  ) {}

  /**
   * Sync all observations, summaries, and prompts missing from the vector store.
   * Reads from SQLite and syncs in batches. Throws on failure.
   */
  async ensureBackfilled(): Promise<void> {
    if (!this.vectorStore.isAvailable()) return;

    logger.info('BACKFILL', 'Starting smart backfill', { project: this.project });

    const existing = await this.vectorStore.getExistingIds();
    const db = new SessionStore();

    try {
      await this.backfillObservations(db, existing.observations);
      await this.backfillSummaries(db, existing.summaries);
      await this.backfillPrompts(db, existing.prompts);

      logger.info('BACKFILL', 'Smart backfill complete', { project: this.project });
    } catch (error) {
      logger.error('BACKFILL', 'Backfill failed', { project: this.project }, error as Error);
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  }

  private async backfillObservations(db: SessionStore, existingIds: Set<number>): Promise<void> {
    const existingObsIds = Array.from(existingIds);
    const obsExclusionClause = existingObsIds.length > 0
      ? `AND id NOT IN (${existingObsIds.map(() => '?').join(',')})`
      : '';

    const observations = db.db.prepare(`
      SELECT * FROM observations
      WHERE project = ? ${obsExclusionClause}
      ORDER BY id ASC
    `).all(this.project, ...existingObsIds) as StoredObservation[];

    const totalObsCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE project = ?
    `).get(this.project) as { count: number };

    logger.info('BACKFILL', 'Backfilling observations', {
      project: this.project,
      missing: observations.length,
      existing: existingIds.size,
      total: totalObsCount.count
    });

    const allDocs: ChromaDocument[] = [];
    for (const obs of observations) {
      allDocs.push(...ChromaDocumentFormatter.formatObservationDocs(obs));
    }

    await this.syncInBatches(allDocs, 'observations');
  }

  private async backfillSummaries(db: SessionStore, existingIds: Set<number>): Promise<void> {
    const existingSummaryIds = Array.from(existingIds);
    const summaryExclusionClause = existingSummaryIds.length > 0
      ? `AND id NOT IN (${existingSummaryIds.map(() => '?').join(',')})`
      : '';

    const summaries = db.db.prepare(`
      SELECT * FROM session_summaries
      WHERE project = ? ${summaryExclusionClause}
      ORDER BY id ASC
    `).all(this.project, ...existingSummaryIds) as StoredSummary[];

    const totalSummaryCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
    `).get(this.project) as { count: number };

    logger.info('BACKFILL', 'Backfilling summaries', {
      project: this.project,
      missing: summaries.length,
      existing: existingIds.size,
      total: totalSummaryCount.count
    });

    const summaryDocs: ChromaDocument[] = [];
    for (const summary of summaries) {
      summaryDocs.push(...ChromaDocumentFormatter.formatSummaryDocs(summary));
    }

    await this.syncInBatches(summaryDocs, 'summaries');
  }

  private async backfillPrompts(db: SessionStore, existingIds: Set<number>): Promise<void> {
    const existingPromptIds = Array.from(existingIds);
    const promptExclusionClause = existingPromptIds.length > 0
      ? `AND up.id NOT IN (${existingPromptIds.map(() => '?').join(',')})`
      : '';

    const prompts = db.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ? ${promptExclusionClause}
      ORDER BY up.id ASC
    `).all(this.project, ...existingPromptIds) as StoredUserPrompt[];

    const totalPromptCount = db.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE s.project = ?
    `).get(this.project) as { count: number };

    logger.info('BACKFILL', 'Backfilling user prompts', {
      project: this.project,
      missing: prompts.length,
      existing: existingIds.size,
      total: totalPromptCount.count
    });

    const promptDocs: ChromaDocument[] = [];
    for (const prompt of prompts) {
      promptDocs.push(ChromaDocumentFormatter.formatUserPromptDoc(prompt));
    }

    await this.syncInBatches(promptDocs, 'prompts');
  }

  private async syncInBatches(docs: ChromaDocument[], label: string): Promise<void> {
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = docs.slice(i, i + BATCH_SIZE);
      await this.vectorStore.addDocuments(batch);

      logger.debug('BACKFILL', 'Backfill progress', {
        project: this.project,
        label,
        progress: `${Math.min(i + BATCH_SIZE, docs.length)}/${docs.length}`
      });
    }
  }
}
