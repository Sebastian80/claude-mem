/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - VectorStore integration
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { VectorStoreFactory } from '../vector/VectorStoreFactory.js';
import { logger } from '../../utils/logger.js';
import type { VectorStore } from '../vector/VectorStore.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private vectorStore: VectorStore | null = null;

  /**
   * Initialize database connection (once, stays open).
   *
   * @param options.vectorStore - Optional pre-configured VectorStore
   *
   * If no vectorStore is provided, VectorStoreFactory creates one from settings.
   */
  async initialize(options?: {
    vectorStore?: VectorStore;
  }): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore();
    this.sessionSearch = new SessionSearch();

    // Use provided VectorStore or create from settings
    this.vectorStore = options?.vectorStore
      ?? VectorStoreFactory.create('claude-mem');

    logger.info('DB', 'Database initialized');
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close VectorStore first (terminates subprocess/HTTP connections)
    if (this.vectorStore) {
      await this.vectorStore.close();
      this.vectorStore = null;
    }

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get VectorStore instance (throws if not initialized)
   */
  getVectorStore(): VectorStore {
    if (!this.vectorStore) {
      throw new Error('VectorStore not initialized');
    }
    return this.vectorStore;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
