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
const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  shouldStop?: () => boolean;
  onIdleTimeout?: () => void;
}
export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses safe claim pattern - messages stay in DB until explicitly marked processed.
   * Waits for 'message' event when queue is empty.
   *
   * Emits 'idle' when waiting for messages, 'busy' when yielding a message.
   *
   * @param sessionDbId - Session ID
   * @param signal - Abort signal
   * @param shouldStop - Optional callback to check if iterator should stop early (e.g., for restart)
   */
  async *createIterator(
    sessionDbIdOrOptions: number | CreateIteratorOptions,
    signal?: AbortSignal,
    shouldStop?: () => boolean,
    onIdleTimeout?: () => void
  ): AsyncIterableIterator<PendingMessageWithId> {
    const options: CreateIteratorOptions = typeof sessionDbIdOrOptions === 'object'
      ? sessionDbIdOrOptions
      : {
          sessionDbId: sessionDbIdOrOptions,
          signal: signal as AbortSignal,
          shouldStop,
          onIdleTimeout,
        };

    if (!options.signal) {
      throw new Error('createIterator requires an AbortSignal');
    }

    const sessionDbId = options.sessionDbId;
    const signalRef = options.signal;
    const shouldStopRef = options.shouldStop;
    const onIdleTimeoutRef = options.onIdleTimeout;

    let lastActivityTime = Date.now();
    while (!signalRef.aborted) {
      try {
        // CHECK BEFORE CLAIMING - allows clean stop without message loss
        if (shouldStopRef && shouldStopRef()) {
          logger.info('QUEUE', `Iterator stopping due to shouldStop()`, { sessionId: sessionDbId });
          // Emit idle so restart logic can trigger
          this.events.emit('idle', sessionDbId);
          return;
        }

        // Safe claim: message stays in DB with status='processing'
        // Message will be marked 'processed' after observation is stored
        const claimFn = (this.store as any).claim || (this.store as any).claimAndDelete;
        const persistentMessage = claimFn ? claimFn.call(this.store, sessionDbId) : null;

        if (persistentMessage) {
          // BUSY: about to yield a message for processing
          // Single iterator always yields 1 prompt per message
          this.events.emit('busy', sessionDbId, 1);
          // Reset activity time when we successfully yield a message
          lastActivityTime = Date.now();
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // IDLE: queue empty, waiting for new messages
          this.events.emit('idle', sessionDbId);
          const receivedMessage = await this.waitForMessage(signalRef, IDLE_TIMEOUT_MS);

          if (!receivedMessage && !signalRef.aborted) {
            // Timeout occurred - check if we've been idle too long
            const idleDuration = Date.now() - lastActivityTime;
            if (idleDuration >= IDLE_TIMEOUT_MS) {
              logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
                sessionDbId,
                idleDurationMs: idleDuration,
                thresholdMs: IDLE_TIMEOUT_MS
              });
              onIdleTimeoutRef?.();
              return;
            }
            // Reset timer on spurious wakeup - queue is empty but duration check failed
            lastActivityTime = Date.now();
          }
        }
      } catch (error) {
        if (signalRef.aborted) return;
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
   * Wait for a message event or timeout.
   * @param signal - AbortSignal to cancel waiting
   * @param timeoutMs - Maximum time to wait before returning
   * @returns true if a message was received, false if timeout occurred
   */
  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true); // Message received
      };

      const onAbort = () => {
        cleanup();
        resolve(false); // Aborted, let loop check signal.aborted
      };

      const onTimeout = () => {
        cleanup();
        resolve(false); // Timeout occurred
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }
}
