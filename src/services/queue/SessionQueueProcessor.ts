import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/**
 * Events emitted by SessionQueueProcessor for idle state tracking:
 * - 'idle': Emitted when queue is empty and processor is waiting for new messages
 * - 'busy': Emitted when processor claims a message and is about to yield it
 *   - For single iterator: emitted with (sessionDbId, 1)
 *   - For batch iterator: emitted with (sessionDbId, expectedPromptCount)
 */
export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses atomic claim-and-delete to prevent duplicates.
   * The queue is a pure buffer: claim it, delete it, process in memory.
   * Waits for 'message' event when queue is empty.
   *
   * Emits 'idle' when waiting for messages, 'busy' when yielding a message.
   */
  async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
    while (!signal.aborted) {
      try {
        // Atomically claim AND DELETE next message from DB
        // Message is now in memory only - no "processing" state tracking needed
        const persistentMessage = this.store.claimAndDelete(sessionDbId);

        if (persistentMessage) {
          // BUSY: about to yield a message for processing
          // Single iterator always yields 1 prompt per message
          this.events.emit('busy', sessionDbId, 1);
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // IDLE: queue empty, waiting for new messages
          this.events.emit('idle', sessionDbId);
          await this.waitForMessage(signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Create an async iterator that yields BATCHES of messages.
   * After wake-up, drains all available messages and yields them as a single batch.
   * This enables batch prompt construction for cost reduction.
   *
   * Emits 'idle' when waiting for messages, 'busy' when yielding a batch.
   */
  async *createBatchIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId[]> {
    while (!signal.aborted) {
      try {
        // Drain all available messages from queue
        const batch: PendingMessageWithId[] = [];
        let persistentMessage = this.store.claimAndDelete(sessionDbId);

        while (persistentMessage) {
          batch.push(this.toPendingMessageWithId(persistentMessage));
          persistentMessage = this.store.claimAndDelete(sessionDbId);
        }

        if (batch.length > 0) {
          // BUSY: about to yield a batch for processing
          // Calculate expected prompt count: 1 for observations (if any) + 1 per summarize
          const obsCount = batch.filter(m => m.type === 'observation').length;
          const summarizeCount = batch.filter(m => m.type === 'summarize').length;
          const expectedPrompts = (obsCount > 0 ? 1 : 0) + summarizeCount;

          this.events.emit('busy', sessionDbId, expectedPrompts);
          logger.info('BATCH', `BATCH_YIELD | sessionDbId=${sessionDbId} | count=${batch.length} | expectedPrompts=${expectedPrompts}`, {
            sessionId: sessionDbId
          });
          yield batch;
        } else {
          // IDLE: queue empty, waiting for new messages (flush signal)
          this.events.emit('idle', sessionDbId);
          await this.waitForMessage(signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in batch processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  /**
   * Wait for a 'message' event or abort signal.
   * CRITICAL: Resolves immediately if signal is already aborted (prevents hang).
   */
  private waitForMessage(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      // CRITICAL: If already aborted, resolve immediately to prevent hang
      if (signal.aborted) {
        resolve();
        return;
      }

      const onMessage = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        resolve(); // Resolve to let the loop check signal.aborted and exit
      };

      const cleanup = () => {
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
