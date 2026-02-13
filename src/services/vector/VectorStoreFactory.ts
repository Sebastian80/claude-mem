/**
 * VectorStoreFactory: Creates the appropriate VectorStore backend
 *
 * Reads CLAUDE_MEM_VECTOR_BACKEND from settings and instantiates the correct adapter.
 * Unimplemented backends fall back to chroma-stdio with a warning.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { ChromaStdioAdapter } from './ChromaStdioAdapter.js';
import { logger } from '../../utils/logger.js';
import type { VectorStore, VectorBackend } from './VectorStore.js';

export class VectorStoreFactory {
  /**
   * Create a VectorStore instance based on current settings.
   *
   * @param project - Project name for collection scoping
   * @returns Configured VectorStore implementation
   */
  static create(project: string): VectorStore {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const backend = settings.CLAUDE_MEM_VECTOR_BACKEND as VectorBackend;

    logger.info('VECTOR', `Creating vector store: ${backend}`, { project, backend });

    switch (backend) {
      case 'chroma-http':
        logger.warn('VECTOR', 'chroma-http not yet implemented, falling back to chroma-stdio', { project });
        return new ChromaStdioAdapter(project);

      case 'sqlite-vec':
        logger.warn('VECTOR', 'sqlite-vec not yet implemented, falling back to chroma-stdio', { project });
        return new ChromaStdioAdapter(project);

      case 'chroma-stdio':
      default:
        return new ChromaStdioAdapter(project);
    }
  }
}
