# Safe Message Processing: Claim → Process → Delete Pattern (v5 - Final)

**Created**: 2026-01-23
**Updated**: 2026-01-24 (Final version - Codex approved)
**Status**: Ready to Implement
**Version**: 9.0.6-jv.5

## Problem Summary

The current `claimAndDelete` pattern deletes messages from the database **before** they are processed. This creates two issues:

1. **Rollover/Truncation Delay**: When token threshold is exceeded, we can't stop immediately because claimed messages exist only in memory.

2. **Message Loss Risk**: If the worker crashes after claiming but before processing, messages are lost forever.

## Scope: Immediate Mode Only

**Batch mode** (fork feature, disabled by default, ON HOLD) will continue using the old `claimAndDelete` pattern via `createBatchIterator()`.

**Message iterator** (`createIterator()` / `getMessageIterator()`) will **always** use the new safe pattern, regardless of batching setting. This ensures Gemini/OpenAI agents also benefit from safe processing.

## Codex Review Feedback (v5 - Final)

| Issue | Resolution |
|-------|------------|
| SDK prefetch overwrites messageId | Add simple FIFO queue for messageIds (push on yield, shift on response) |
| Atomic store + mark still missing | Pass messageId to `processAgentResponse()`, use `storeObservationsAndMarkComplete()` |
| Code won't compile (private field) | Add `markProcessed()` method to `PendingMessageStore` |
| Claim race mishandled | Retry inside `claim()` until truly empty or successfully claimed |
| useSafeClaim gating too broad | Always use safe-claim for message iterator; only batch iterator unchanged |
| **Init/continuation FIFO misalignment** | Push `undefined` sentinel for init prompt, only mark complete when messageId is defined |
| **File path wrong** | ResponseProcessor is at `src/services/worker/agents/ResponseProcessor.ts` |
| **DB access** | Use `dbManager.getSessionStore().db` not `dbManager.db` |
| **markProcessed consistency** | Set `status='processed'` instead of DELETE to maintain history |

## Target Flow (Immediate Mode - Safe)

```
t0  Hook sends Obs #1         DB: [obs1: pending]
t1  Iterator claims obs1      DB: [obs1: PROCESSING]      Memory: obs1
t2  Build prompt
    Push messageId to FIFO    FIFO: [obs1.id]
    Yield prompt to SDK
t3  SDK API call (10 sec)     DB: [obs1: processing]      FIFO: [obs1.id]
t4  Hook sends Obs #2,#3      DB: [obs1: proc, obs2,3: pending]
t5  SDK response received
    Shift messageId from FIFO FIFO: []
    ATOMIC: Store obs + mark obs1 processed (storeObservationsAndMarkComplete)
    Tokens = 115k > threshold!
    Set pendingRestart        DB: [obs2, obs3: pending]
t6  Iterator checks pendingRestart → STOPS
    obs2,obs3 safe in DB      DB: [obs2, obs3: pending]
t7  Restart triggers
t8  New generator claims obs2 DB: [obs2: proc, obs3: pending]
```

## Implementation Plan

### Phase 1: PendingMessageStore Changes

**File**: `src/services/sqlite/PendingMessageStore.ts`

#### 1.1 Add `claim()` method - With retry loop

```typescript
/**
 * Atomically claim the next pending message.
 * Uses transaction with retry to handle race conditions.
 * Message stays in DB with status='processing' until explicitly marked complete.
 *
 * @returns Claimed message, or null if queue is truly empty
 */
claim(sessionDbId: number): PersistentPendingMessage | null {
  const now = Date.now();
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = this.db.transaction(() => {
      // Step 1: Find next pending message
      const peekStmt = this.db.prepare(`
        SELECT id FROM pending_messages
        WHERE session_db_id = ? AND status = 'pending'
        ORDER BY id ASC
        LIMIT 1
      `);
      const peek = peekStmt.get(sessionDbId) as { id: number } | null;

      if (!peek) return { found: false, msg: null };

      // Step 2: Atomically claim it (verify still pending)
      const claimStmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'processing', started_processing_at_epoch = ?
        WHERE id = ? AND status = 'pending'
      `);
      const updateResult = claimStmt.run(now, peek.id);

      // Race: another worker claimed it
      if (updateResult.changes === 0) {
        return { found: true, msg: null }; // Found row but couldn't claim - retry
      }

      // Step 3: Fetch the full message (now ours)
      const fetchStmt = this.db.prepare(`SELECT * FROM pending_messages WHERE id = ?`);
      const msg = fetchStmt.get(peek.id) as PersistentPendingMessage;

      return { found: true, msg };
    })();

    if (!result.found) {
      // Queue is truly empty
      return null;
    }

    if (result.msg) {
      // Successfully claimed
      logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionDbId} | messageId=${result.msg.id} | type=${result.msg.message_type}`, {
        sessionId: sessionDbId
      });
      return result.msg;
    }

    // Race occurred, retry
    logger.debug('QUEUE', `Claim race, retrying (attempt ${attempt + 1}/${MAX_RETRIES})`, {
      sessionId: sessionDbId
    });
  }

  // Max retries exceeded, treat as empty (will retry on next iteration)
  logger.warn('QUEUE', `Claim max retries exceeded`, { sessionId: sessionDbId });
  return null;
}
```

#### 1.2 Add `markProcessed()` method

```typescript
/**
 * Mark a message as processed (set status='processed', clear payload).
 * Called after observation has been stored via storeObservationsAndMarkComplete().
 *
 * Note: For immediate mode, prefer using storeObservationsAndMarkComplete() which
 * handles this atomically. This method is for edge cases where separate marking is needed.
 */
markProcessed(messageId: number): boolean {
  const now = Date.now();
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'processed',
        completed_at_epoch = ?,
        tool_input = NULL,
        tool_response = NULL
    WHERE id = ? AND status = 'processing'
  `);
  const result = stmt.run(now, messageId);

  if (result.changes > 0) {
    logger.debug('QUEUE', `PROCESSED | messageId=${messageId}`);
    return true;
  }
  return false;
}
```

#### 1.3 Deprecate `claimAndDelete()`

```typescript
/**
 * @deprecated Use claim() for immediate mode. Kept for batch mode only.
 * Atomically claim and DELETE the next pending message.
 */
claimAndDelete(sessionDbId: number): PersistentPendingMessage | null {
  // ... existing implementation unchanged ...
}
```

---

### Phase 2: SessionQueueProcessor Changes

**File**: `src/services/queue/SessionQueueProcessor.ts`

#### 2.1 Modify `createIterator()` - Add shouldStop, always use claim()

```typescript
/**
 * Create an async iterator that yields messages as they become available.
 * Uses safe claim pattern - messages stay in DB until explicitly marked processed.
 *
 * @param sessionDbId - Session ID
 * @param signal - Abort signal
 * @param shouldStop - Optional callback to check if iterator should stop early
 */
async *createIterator(
  sessionDbId: number,
  signal: AbortSignal,
  shouldStop?: () => boolean
): AsyncIterableIterator<PendingMessageWithId> {
  while (!signal.aborted) {
    try {
      // CHECK BEFORE CLAIMING - allows clean stop without message loss
      if (shouldStop && shouldStop()) {
        logger.info('QUEUE', `Iterator stopping due to shouldStop()`, { sessionId: sessionDbId });
        // Emit idle so restart logic can trigger
        this.events.emit('idle', sessionDbId);
        return;
      }

      // Always use safe claim (message stays in DB as 'processing')
      const persistentMessage = this.store.claim(sessionDbId);

      if (persistentMessage) {
        this.events.emit('busy', sessionDbId, 1);
        yield this.toPendingMessageWithId(persistentMessage);
      } else {
        this.events.emit('idle', sessionDbId);
        await this.waitForMessage(signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
```

#### 2.2 Keep `createBatchIterator()` unchanged

Batch iterator continues using `claimAndDelete` - no changes needed.

---

### Phase 3: SessionManager Changes

**File**: `src/services/worker/SessionManager.ts`

#### 3.1 Update `getMessageIterator()` - Pass shouldStop (no useSafeClaim flag)

```typescript
async *getMessageIterator(sessionDbId: number): AsyncIterableIterator<PendingMessageWithId> {
  let session = this.sessions.get(sessionDbId);
  if (!session) {
    session = this.initializeSession(sessionDbId);
  }

  const emitter = this.sessionQueues.get(sessionDbId);
  if (!emitter) {
    throw new Error(`No emitter for session ${sessionDbId}`);
  }

  // ... existing idle/busy listener setup ...

  const processor = new SessionQueueProcessor(this.getPendingStore(), emitter);

  // Stop condition: check if pendingRestart is set
  const shouldStop = () => !!session?.pendingRestart;

  try {
    for await (const message of processor.createIterator(
      sessionDbId,
      session.abortController.signal,
      shouldStop
    )) {
      // ... existing timestamp tracking ...
      yield message;
    }
  } finally {
    // ... existing cleanup ...
  }
}
```

#### 3.2 Update `isGeneratorSafeToRestart()` - Remove pendingCount requirement

```typescript
isGeneratorSafeToRestart(sessionDbId: number): boolean {
  const session = this.sessions.get(sessionDbId);
  if (!session) return false;

  const inFlightCount = session.inFlightCount || 0;

  // Safe if generator is idle and no in-flight prompts
  // Don't require queue empty - processing messages will be reset on restart
  const isSafe = session.generatorPromise !== null
    && session.generatorIdle === true
    && inFlightCount === 0;

  logger.debug('SETTINGS', `isGeneratorSafeToRestart check`, {
    sessionId: sessionDbId,
    hasGenerator: !!session.generatorPromise,
    generatorIdle: session.generatorIdle,
    inFlightCount,
    isSafe
  });

  return isSafe;
}
```

#### 3.3 Reset processing messages on intentional restart

In `tryRestartGeneratorAsync()` or the restart path in SessionRoutes:

```typescript
// When pendingRestart triggers restart, reset processing → pending
if (session.pendingRestart) {
  const resetCount = this.getPendingStore().resetProcessingToPending(sessionDbId);
  if (resetCount > 0) {
    logger.info('RESTART', `Reset ${resetCount} processing messages to pending`, {
      sessionId: sessionDbId,
      reason: session.pendingRestart.reason
    });
  }
}
```

---

### Phase 4: Types Changes

**File**: `src/services/worker-types.ts`

```typescript
export interface ActiveSession {
  // ... existing fields ...

  /**
   * FIFO queue of message IDs being processed.
   * Push when yielding prompt, shift when processing response.
   * Handles SDK prefetch where multiple prompts may be in-flight.
   *
   * IMPORTANT: Push `undefined` for init/continuation prompts (no messageId).
   * Only observation/summarize prompts have real messageIds.
   */
  processingMessageIdQueue: (number | undefined)[];
}
```

---

### Phase 5: Agent Changes (SDKAgent)

**File**: `src/services/worker/SDKAgent.ts`

#### 5.1 Initialize FIFO queue

In `startSession()`:

```typescript
async startSession(session: ActiveSession, worker: any): Promise<void> {
  // Initialize processing message ID queue
  session.processingMessageIdQueue = [];

  // ... rest of existing setup ...
}
```

#### 5.2 Push sentinel for init prompt, messageId for observations

In `createMessageGenerator()`:

```typescript
// Initial prompt (INIT or CONTINUATION) - push undefined sentinel
session.processingMessageIdQueue.push(undefined);
yield initPrompt;

// IMMEDIATE MODE: Consume individual messages
for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
  // ... existing prompt building ...

  // Push message ID to FIFO BEFORE yielding
  // This handles SDK prefetch - multiple prompts can be in-flight
  session.processingMessageIdQueue.push(message._persistentId);

  yield prompt;
}
```

#### 5.3 Shift messageId and use atomic store (processAgentResponse integration)

In `startSession()`, where responses are processed:

```typescript
// Handle assistant messages
if (message.type === 'assistant') {
  // ... existing response processing ...

  // Get the message ID for this response (FIFO order)
  const messageId = session.processingMessageIdQueue.shift();

  // Parse and process response using shared ResponseProcessor
  // Pass messageId for atomic store+mark-complete
  await processAgentResponse(
    textContent,
    session,
    this.dbManager,
    this.sessionManager,
    worker,
    discoveryTokens,
    originalTimestamp,
    'SDK',
    cwdTracker.lastCwd,
    messageId  // NEW PARAMETER
  );
}
```

#### 5.4 Update ResponseProcessor to use atomic transaction

**File**: `src/services/worker/agents/ResponseProcessor.ts`

```typescript
export async function processAgentResponse(
  textContent: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: any,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentType: string,
  cwd: string | undefined,
  messageId?: number  // NEW: optional message ID for atomic completion
): Promise<void> {
  // ... existing parsing logic ...

  // Store observations
  if (observations.length > 0 || summary) {
    if (messageId) {
      // ATOMIC: Store observations AND mark message processed in one transaction
      storeObservationsAndMarkComplete(
        dbManager.getSessionStore().db,  // Correct DB access
        session.memorySessionId,
        session.project,
        observations,
        summary,
        messageId,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp || undefined
      );
    } else {
      // Init prompt, batch mode, or no messageId - use regular store
      storeObservations(
        dbManager.getSessionStore().db,
        session.memorySessionId,
        session.project,
        observations,
        summary,
        session.lastPromptNumber,
        discoveryTokens,
        originalTimestamp || undefined
      );
    }
  } else if (messageId) {
    // No observations but have messageId - still need to mark complete
    const pendingStore = sessionManager.getPendingMessageStore();
    pendingStore.markProcessed(messageId);
  }

  // ... rest of existing logic ...
}
```

#### 5.5 GeminiAgent and OpenAIAgent: Same changes

Apply the same pattern:
1. Initialize `processingMessageIdQueue = []`
2. Push messageId before yield in message generator
3. Shift messageId when processing response
4. Pass messageId to `processAgentResponse()`

---

### Phase 6: Recovery Logic

#### 6.1 Startup: Keep existing 5-minute threshold

No changes needed - existing `resetStuckMessages(5 * 60 * 1000)` handles this.

#### 6.2 Intentional restart: Targeted reset

Already covered in Phase 3.3 - reset only this session's processing messages.

---

## Implementation Checklist

### Phase 1: PendingMessageStore
- [x] Add `claim()` method with retry loop on race
- [x] Add `markProcessed()` method
- [x] Add deprecation comment to `claimAndDelete()`

### Phase 2: SessionQueueProcessor
- [x] Update `createIterator()` to use `claim()` (always, no flag)
- [x] Add `shouldStop` parameter
- [x] Emit 'idle' when stopping due to shouldStop
- [x] Keep `createBatchIterator()` unchanged

### Phase 3: SessionManager
- [x] Update `getMessageIterator()` to pass `shouldStop`
- [x] Update `isGeneratorSafeToRestart()` - remove pendingCount requirement
- [x] Add reset of processing messages on intentional restart

### Phase 4: Types
- [x] Add `processingMessageIdQueue` to ActiveSession

### Phase 5: Agents
- [x] SDKAgent: Initialize queue, push on yield, shift on response
- [x] SDKAgent: Pass messageId to processAgentResponse
- [x] GeminiAgent: Same changes
- [x] OpenAIAgent: Same changes
- [x] ResponseProcessor: Use storeObservationsAndMarkComplete when messageId provided

### Phase 6: Recovery
- [x] Verify existing 5-min threshold reset on startup
- [x] Verify targeted reset on intentional restart

### Phase 7: Testing
- [ ] Test immediate mode: messages processed and deleted atomically
- [ ] Test rollover: stops at threshold, pending messages preserved
- [ ] Test provider switch: clean handoff, no message loss
- [ ] Test SDK prefetch: FIFO correctly tracks multiple in-flight prompts
- [ ] Test batch mode: still works with old claimAndDelete pattern
- [ ] Test crash recovery: processing messages reset after 5 min
- [ ] Test claim race: retry loop handles correctly

### Phase 8: Release
- [ ] Update version to 9.0.6-jv.5
- [ ] Update FORK-CHANGES.md
- [ ] Create commit with clear description

---

## Files to Modify

| File | Changes | Lines |
|------|---------|-------|
| `src/services/sqlite/PendingMessageStore.ts` | Add `claim()` with retry, `markProcessed()` | ~60 |
| `src/services/queue/SessionQueueProcessor.ts` | Update `createIterator()` | ~20 |
| `src/services/worker/SessionManager.ts` | Update iterator, restart logic | ~40 |
| `src/services/worker-types.ts` | Add `processingMessageIdQueue` | ~5 |
| `src/services/worker/SDKAgent.ts` | FIFO queue, pass messageId | ~25 |
| `src/services/worker/GeminiAgent.ts` | FIFO queue, pass messageId | ~25 |
| `src/services/worker/OpenAIAgent.ts` | FIFO queue, pass messageId | ~25 |
| `src/services/worker/agents/ResponseProcessor.ts` | Use atomic store when messageId provided | ~20 |
| **Total** | | **~220** |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claim race condition | Low | Retry loop with max 3 attempts |
| SDK prefetch mismatch | Low | FIFO queue ensures correct ordering |
| Stuck processing messages | Medium | 5-min threshold reset on startup |
| Batch mode regression | Low | Unchanged - still uses claimAndDelete |
| Crash between store and mark | None | Atomic transaction handles both |

---

## Expected Outcome

After implementation:
- **Rollover triggers immediately** when threshold exceeded (1 API response delay max)
- **Provider switch is instant** when generator is idle (no queue drain required)
- **Zero message loss** during rollover/restart
- **Zero duplicate observations** on crash recovery (atomic transaction)
- **SDK prefetch handled correctly** via FIFO queue
- **Batch mode unchanged** - continues working with old pattern
- **Crash recovery** properly restores interrupted work (5-min threshold)
