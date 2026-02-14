/**
 * VectorStoreFactory: Creates the appropriate VectorStore backend
 *
 * Reads CLAUDE_MEM_VECTOR_BACKEND from settings and instantiates the correct adapter.
 * For chroma-http, requires a ChromaServerManager instance (managed by worker-service).
 * Unimplemented backends fall back to chroma-stdio with a warning.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ChromaStdioAdapter } from './ChromaStdioAdapter.js';
import { ChromaHttpAdapter } from './ChromaHttpAdapter.js';
import { logger } from '../../utils/logger.js';
import type { ChromaServerManager } from './ChromaServerManager.js';
import type { VectorStore, VectorBackend } from './VectorStore.js';

export class VectorStoreFactory {
  /**
   * Create a VectorStore instance based on current settings.
   *
   * @param project - Project name for collection scoping
   * @param serverManager - Optional ChromaServerManager for chroma-http backend
   * @returns Configured VectorStore implementation
   */
  static create(project: string, serverManager?: ChromaServerManager): VectorStore {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const backend = settings.CLAUDE_MEM_VECTOR_BACKEND as VectorBackend;

    logger.info('VECTOR', `Creating vector store: ${backend}`, { project, backend });

    switch (backend) {
      case 'chroma-http':
        if (!serverManager) {
          logger.warn('VECTOR', 'chroma-http requires ChromaServerManager, falling back to chroma-stdio', { project });
          return new ChromaStdioAdapter(project);
        }
        return new ChromaHttpAdapter(project, serverManager);

      case 'sqlite-vec':
        logger.warn('VECTOR', 'sqlite-vec not yet implemented, falling back to chroma-stdio', { project });
        return new ChromaStdioAdapter(project);

      case 'chroma-stdio':
      default:
        return new ChromaStdioAdapter(project);
    }
  }
}
