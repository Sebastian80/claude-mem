# Stuck Message Recovery Implementation Plan

**Issue**: Messages stuck in "processing" status after SDK/Claude CLI crash
**Date**: 2026-01-26
**Status**: ✅ Implemented (v9.0.6-jv.7)

## Codex Review History

| Date | Review | Status |
|------|--------|--------|
| 2026-01-26 | Initial review | Critical issue found - SDK prefetch creates legitimate "processing" messages |
| 2026-01-26 | Final review | Approved with minor fixes |

### Review #2 Feedback (2026-01-26)

**Status:** ✅ Approved for implementation

**Minor Fixes Required:**
1. **NULL timestamp handling**: Query `started_processing_at_epoch < storeInitEpoch` returns false for NULL. Fix: `(started_processing_at_epoch IS NULL OR started_processing_at_epoch < ?)`
2. **Loop instead of recursion**: Use iterative loop instead of `return this.claim(sessionDbId)` to avoid potential stack overflow
3. **Single-worker assumption**: Add comment clarifying this design assumes single processor per session (which is true for claude-mem architecture)

---

### Review #1 Feedback (2026-01-26)

**Critical Issue Found:** The original plan would return ANY "processing" message, but the SDK can prefetch multiple messages (multiple legitimately in-flight). Returning any "processing" message would cause duplicate prompts.

**Solution:** Track `storeInitEpoch` (worker start time) and only reclaim "processing" messages where `started_processing_at_epoch < storeInitEpoch`. This distinguishes:
- **Orphaned**: From previous worker (crashed) - `started_processing_at_epoch < storeInitEpoch`
- **In-flight**: From current worker (active) - `started_processing_at_epoch >= storeInitEpoch`

**Additional Safeguards Required:**
1. Increment `retry_count` on each re-claim
2. Mark as 'failed' after 3 attempts (prevent poison message infinite loop)
3. Update `started_processing_at_epoch` on re-claim

---

## Problem Summary

When batching is disabled, the safe `claim()` pattern (introduced in v9.0.6-jv.5) marks messages as "processing" before yielding them. If the SDK/Claude CLI crashes after claiming but before completing, messages stay stuck in "processing" status indefinitely.

**Current behavior:**
1. `claim()` finds message with status='pending'
2. Updates status to 'processing', sets `started_processing_at_epoch = now`
3. Returns message for SDK to process
4. SDK crashes before calling `markProcessed()`
5. Message stays in 'processing' forever
6. New `claim()` calls skip it (only looks for 'pending')

**Complication - SDK Prefetch:**
The SDK can have multiple messages in-flight simultaneously (prefetch). Multiple messages can legitimately be in "processing" status at the same time. We cannot simply return any "processing" message - we must distinguish orphaned (from crash) vs in-flight (active).

**Evidence of prefetch in code:**
```typescript
// Push message ID to FIFO BEFORE yielding
// This handles SDK prefetch - multiple prompts can be in-flight
session.processingMessageIdQueue?.push(message._persistentId);
```

---

## Solution: storeInitEpoch-Based Orphan Detection

Track when this worker instance started (`storeInitEpoch`). Only reclaim "processing" messages from BEFORE this worker started (orphaned from previous crash).

**New behavior:**
1. `claim()` first checks for orphaned messages: `status='processing' AND started_processing_at_epoch < storeInitEpoch`
2. If found, increment `retry_count`, update `started_processing_at_epoch`, return for re-processing
3. If `retry_count >= 3`, mark as 'failed' and try next message
4. Only if no orphans, claim a new 'pending' message

**Benefits:**
- Correctly distinguishes orphaned vs in-flight messages
- No interference with SDK prefetch
- Poison messages eventually fail (don't block queue forever)
- Messages processed in correct order (FIFO within orphans, then pending)
- Minimal code change

---

## Phase 1: Modify PendingMessageStore

### 1.1 Add storeInitEpoch Property

**File**: `src/services/sqlite/PendingMessageStore.ts`

```typescript
export class PendingMessageStore {
  private db: Database;
  private maxRetries: number;
  private storeInitEpoch: number;  // NEW: Track when this store instance was created

  constructor(db: Database, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
    this.storeInitEpoch = Date.now();  // NEW: Capture init time
  }
  // ...
}
```

### 1.2 Update claim() Method

**Current implementation:**
```typescript
claim(sessionDbId: number): PersistentPendingMessage | null {
  // Only looks for 'pending' messages
  const peekStmt = this.db.prepare(`
    SELECT id FROM pending_messages
    WHERE session_db_id = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `);
  // ... claims and updates to 'processing'
}
```

**New implementation:**
```typescript
claim(sessionDbId: number): PersistentPendingMessage | null {
  // STEP 1: Check for orphaned processing messages (from previous worker crash)
  // Only reclaim messages with started_processing_at_epoch BEFORE this worker started
  const orphanedMessage = this.reclaimOrphanedMessage(sessionDbId);
  if (orphanedMessage) {
    return orphanedMessage;
  }

  // STEP 2: No orphans, claim a new pending message (existing logic)
  const peekStmt = this.db.prepare(`
    SELECT id FROM pending_messages
    WHERE session_db_id = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `);

  const peek = peekStmt.get(sessionDbId) as { id: number } | undefined;
  if (!peek) return null;

  // Atomic claim: set status and timestamp
  const claimStmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'processing', started_processing_at_epoch = ?
    WHERE id = ? AND status = 'pending'
  `);

  const result = claimStmt.run(Date.now(), peek.id);
  if (result.changes === 0) return null; // Race condition, retry

  // Fetch and return the claimed message
  const fetchStmt = this.db.prepare(`SELECT * FROM pending_messages WHERE id = ?`);
  const message = fetchStmt.get(peek.id) as PersistentPendingMessage;

  logger.info('QUEUE', `CLAIM | messageId=${message.id} | sessionDbId=${sessionDbId}`, {
    sessionId: sessionDbId
  });

  return message;
}
```

### 1.3 Add reclaimOrphanedMessage() Method

```typescript
/**
 * Reclaim an orphaned "processing" message from a previous worker crash.
 * Only reclaims messages where started_processing_at_epoch < storeInitEpoch OR IS NULL.
 * Increments retry_count and marks as 'failed' after maxRetries.
 *
 * Design note: This assumes single processor per session, which is true for
 * claude-mem architecture. Each session has exactly one generator processing its queue.
 */
private reclaimOrphanedMessage(sessionDbId: number): PersistentPendingMessage | null {
  // Use loop instead of recursion to avoid stack overflow with many orphans
  while (true) {
    // Find orphaned messages: processing AND (from before this worker started OR NULL timestamp)
    // NULL check handles edge case of crash between status update and timestamp set
    const orphanStmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ?
        AND status = 'processing'
        AND (started_processing_at_epoch IS NULL OR started_processing_at_epoch < ?)
      ORDER BY id ASC
      LIMIT 1
    `);

    const orphan = orphanStmt.get(sessionDbId, this.storeInitEpoch) as PersistentPendingMessage | undefined;
    if (!orphan) return null;

    // Check retry count - if exceeded, mark as failed and continue to next orphan
    if (orphan.retry_count >= this.maxRetries) {
      logger.error('QUEUE', `ORPHAN_FAILED | messageId=${orphan.id} | retryCount=${orphan.retry_count} | reason=max_retries_exceeded`, {
        sessionId: sessionDbId
      });
      this.markOrphanFailed(orphan.id);
      continue; // Loop to check for more orphans
    }

    // Update timestamp and increment retry count
    const updateStmt = this.db.prepare(`
      UPDATE pending_messages
      SET started_processing_at_epoch = ?, retry_count = retry_count + 1
      WHERE id = ?
    `);
    updateStmt.run(Date.now(), orphan.id);

    // Fetch updated message
    const fetchStmt = this.db.prepare(`SELECT * FROM pending_messages WHERE id = ?`);
    const updated = fetchStmt.get(orphan.id) as PersistentPendingMessage;

    logger.info('QUEUE', `RE-CLAIM | messageId=${updated.id} | retryCount=${updated.retry_count} | reason=orphan_recovery`, {
      sessionId: sessionDbId
    });

    return updated;
  }
}

/**
 * Mark orphan as permanently failed (no retry logic, just fail it)
 */
private markOrphanFailed(messageId: number): void {
  const now = Date.now();
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'failed', completed_at_epoch = ?
    WHERE id = ?
  `);
  stmt.run(now, messageId);
}
```

### 1.4 Verify markFailed() Exists

Ensure `markFailed()` method exists and works correctly:
```typescript
markFailed(messageId: number): boolean {
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'failed', failed_at_epoch = ?
    WHERE id = ? AND status IN ('pending', 'processing')
  `);
  const result = stmt.run(Date.now(), messageId);
  return result.changes > 0;
}
```

---

## Phase 2: Update Related Code

### 2.1 Verify markProcessed() is Idempotent

Ensure `markProcessed()` handles being called on already-processed messages:
```typescript
markProcessed(messageId: number): boolean {
  const stmt = this.db.prepare(`
    UPDATE pending_messages
    SET status = 'processed', completed_at_epoch = ?
    WHERE id = ? AND status = 'processing'  -- Only update if still processing
  `);
  const result = stmt.run(Date.now(), messageId);
  return result.changes > 0;  // Returns false if already processed (safe)
}
```

### 2.2 No Changes Needed

- `getPendingCount()` - Already counts 'pending' + 'processing' ✅
- `hasAnyPendingWork()` - Already checks for either status ✅
- `getSessionsWithPendingMessages()` - Already includes 'processing' ✅

---

## Phase 3: Testing

### 3.1 Manual Test Scenarios

1. **Normal flow**: Enqueue → claim → process → markProcessed ✅
2. **Crash recovery**: Enqueue → claim → kill worker → restart → verify re-claim with retry_count=1
3. **Multiple orphans**: Claim 3 messages → kill worker → restart → verify processed in order
4. **Poison message**: Create message that crashes → verify fails after 3 retries
5. **SDK prefetch safe**: Verify in-flight messages (started_processing_at_epoch >= storeInitEpoch) are NOT reclaimed
6. **Mixed state**: Some orphaned, some in-flight, some pending → verify correct order

### 3.2 Verify No Regressions

- Batch mode still works (uses `claimAndDelete()`, unaffected)
- Hot-reload restart still works
- Normal observation flow unaffected
- SDK prefetch works correctly (no duplicate prompts)

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/services/sqlite/PendingMessageStore.ts` | Modify | Add `storeInitEpoch`, update `claim()`, add `reclaimOrphanedMessage()` |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Re-processing causes duplicate observations | `markProcessed()` is idempotent; `storeObservationsAndMarkComplete` is atomic |
| Poison messages block queue | `retry_count` limit (3) then mark 'failed' |
| SDK prefetch interference | Only reclaim messages with `started_processing_at_epoch < storeInitEpoch` |
| Performance impact | Minimal - one extra SELECT that usually returns 0 rows |
| NULL timestamp edge case | Query includes `IS NULL` check for crash between status/timestamp updates |
| Stack overflow with many orphans | Uses iterative loop instead of recursion |

---

## Acceptance Criteria

- [ ] Orphaned "processing" messages (from previous crash) are reclaimed on restart
- [ ] In-flight "processing" messages (from current worker) are NOT reclaimed
- [ ] Poison messages fail after 3 retries (don't block queue forever)
- [ ] `retry_count` incremented on each re-claim
- [ ] `started_processing_at_epoch` updated on re-claim
- [ ] Logging clearly indicates re-claim vs normal claim
- [ ] Batch mode (`claimAndDelete`) unaffected
- [ ] SDK prefetch works correctly (no duplicate prompts)

---

## Version Plan

Target: **v9.0.6-jv.7**
