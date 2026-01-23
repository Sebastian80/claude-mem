# Settings Hot-Reload Implementation Plan

**Issue**: `docs/issues/2026-01-22-01-settings-hot-reload-requires-worker-restart.md`
**Date**: 2026-01-23
**Status**: ✅ Complete - Released in v9.0.6-jv.4

## Codex Review History

| Date | Review | Status |
|------|--------|--------|
| 2026-01-23 | Initial review | Feedback incorporated |
| 2026-01-23 | Re-review | **Approved for Phase 1** |

## Bug Fixes (v9.0.6-jv.4)

### Infinite Rollover Loop Fix

**Problem**: After Claude rollover, the first API call returned similar token count (conversation history still large), which immediately triggered another rollover - causing an infinite restart loop.

**Root Cause**: `lastInputTokens` was not reset after rollover execution. The rollover check `lastInputTokens > threshold` remained true even after fresh session start.

**Fix** (commit `f484a0b7`):
- Reset `session.lastInputTokens` to `undefined` after clearing `claudeResumeSessionId`
- Persist `null` to database via `updateLastInputTokens(sessionDbId, null)`
- Updated `SessionStore.updateLastInputTokens()` to accept `null` type

**Files Changed**:
- `src/services/worker/http/routes/SessionRoutes.ts:165-169` - Reset lastInputTokens after rollover
- `src/services/sqlite/SessionStore.ts:710-711` - Accept null parameter

### Review #1 Feedback (2026-01-23)

**Issues Identified:**
1. Generator lifecycle race: old `.finally()` can clobber new generator's state
2. `pendingRestart` cleared before restart confirmed → lost if restart fails
3. `waitForMessage()` hangs if `signal.aborted` already true when entering
4. Need generator instance identity (`generatorId`) to prevent state clobbering

**Fixes Applied:**
- Added `generatorId` tracking to ActiveSession and `.finally()` guards
- Made restart async: abort → await settle → start new
- Only clear `pendingRestart` after restart successfully starts
- Fixed `waitForMessage()` to check `signal.aborted` at entry
- Added debounce and JSON validation to SettingsWatcher

### Review #2 Feedback (2026-01-23)

**Approved for Phase 1** with additional tweaks:

1. **Use `SettingsDefaultsManager` for parsing** - Raw `JSON.parse` won't handle legacy `{ env: ... }` shape and OpenRouter→OpenAI migration logic
2. **Watch provider-availability keys too** - Add API keys and base URLs to watched keys

**Phase 3 design risk** (to address before implementing):
- Add `inFlight` counter to track claimed-but-unprocessed work (SDK prefetch concern)
- Require `inFlight === 0` for `isGeneratorSafeToRestart`

**Minor nits fixed:**
- Event-flow text updated to use `tryRestartGeneratorAsync()`
- Fixed duplicated "3.3" section numbering
- Fixed accessor in `isGeneratorSafeToRestart`

## Problem Summary

Changing `~/.claude-mem/settings.json` (model/provider) doesn't apply until worker restart because:
1. Generators are long-lived and block waiting for queue events
2. Provider/model are bound at generator start, not per-message
3. The claim-and-delete queue pattern makes mid-processing restarts unsafe

## Solution: Safe Hot-Reload at Idle Boundaries

Restart generators **only when safe**: queue empty AND generator idle.

## Key Constraints

### Queue Safety
- Messages are **deleted from SQLite on claim**, held in-memory only
- Claude SDK may **prefetch** multiple messages from generator
- Batch mode drains **all pending** at once
- **Safe restart window**: queue empty + generator waiting for new messages

### Detection Requirements
- Detect settings file changes (mtime or content hash)
- Track generator idle state (waiting in `waitForMessage()`)
- Verify queue is truly empty before restart

---

## Phase 1: Settings Change Detection ✅ COMPLETE

### 1.1 Add Settings Watcher ✅

**File**: `src/services/worker/settings/SettingsWatcher.ts` (new)

```typescript
/**
 * Watches settings.json for changes and emits events
 * Uses mtime polling (simpler than fs.watch, works across platforms)
 *
 * Features:
 * - Debounces rapid changes (waits 500ms after last change)
 * - Validates JSON before emitting (ignores partial writes)
 * - Only emits when relevant keys change
 */
export class SettingsWatcher extends EventEmitter {
  private lastMtime: number = 0;
  private lastHash: string = '';
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private debounceMs: number = 500;

  constructor(private settingsPath: string, private pollMs: number = 2000) {}

  start(): void {
    // Initial read to establish baseline
    this.readAndHashSettings();

    this.pollInterval = setInterval(() => {
      this.checkForChanges();
    }, this.pollMs);
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  private checkForChanges(): void {
    try {
      const stats = fs.statSync(this.settingsPath);
      if (stats.mtimeMs === this.lastMtime) return;

      this.lastMtime = stats.mtimeMs;

      // Debounce: wait for writes to settle
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() =&gt; {
        this.emitIfChanged();
      }, this.debounceMs);
    } catch {
      // File doesn't exist or can't be read - ignore
    }
  }

  private emitIfChanged(): void {
    try {
      const content = fs.readFileSync(this.settingsPath, 'utf8');

      // Validate JSON via SettingsDefaultsManager (handles legacy shapes + migrations)
      let newSettings: Record<string, unknown>;
      try {
        newSettings = SettingsDefaultsManager.loadFromFile(this.settingsPath);
      } catch {
        logger.debug('SETTINGS', 'Ignoring invalid settings file');
        return;
      }

      const newHash = crypto.createHash('md5').update(content).digest('hex');
      if (newHash === this.lastHash) return;

      const oldSettings = this.lastSettings;
      this.lastHash = newHash;
      this.lastSettings = newSettings;

      // Determine which keys changed
      const changedKeys = this.findChangedKeys(oldSettings, newSettings);
      if (changedKeys.length === 0) return;

      this.emit('change', { oldSettings, newSettings, changedKeys });
    } catch (error) {
      logger.debug('SETTINGS', 'Error reading settings file', {}, error as Error);
    }
  }

  // Emits: 'change' with { oldSettings, newSettings, changedKeys }
}
```

**Key settings to watch** (triggers generator restart):
- `CLAUDE_MEM_PROVIDER` - provider selection
- `CLAUDE_MEM_MODEL` - Claude SDK model
- `CLAUDE_MEM_GEMINI_MODEL` - Gemini model
- `CLAUDE_MEM_OPENAI_MODEL` - OpenAI model
- `CLAUDE_MEM_GEMINI_API_KEY` - enables Gemini provider
- `CLAUDE_MEM_OPENAI_API_KEY` - enables OpenAI provider
- `CLAUDE_MEM_GEMINI_BASE_URL` - custom Gemini endpoint
- `CLAUDE_MEM_OPENAI_BASE_URL` - custom OpenAI endpoint

### 1.2 Integrate Watcher into WorkerService ✅

**File**: `src/services/worker-service.ts`

- [x] Create `SettingsWatcher` instance on worker start
- [x] Listen for `'change'` events
- [x] On relevant change, notify `SessionManager` to schedule restarts

---

## Phase 2: Generator Idle State Tracking ✅ COMPLETE

### 2.1 Add Idle State and Generator Identity to ActiveSession ✅

**File**: `src/services/worker-types.ts`

```typescript
interface ActiveSession {
  // ... existing fields ...

  /** True when generator is waiting for new messages (safe to restart) */
  generatorIdle: boolean;

  /** Timestamp when generator became idle (for debugging) */
  idleSince: number | null;

  /** Unique ID for the current generator instance (prevents .finally() race) */
  currentGeneratorId: string | null;

  /** Pending restart request (set when settings change but generator is busy) */
  pendingRestart: { reason: string; requestedAt: number } | null;

  /** Count of claimed-but-unprocessed messages (for SDK prefetch safety) */
  inFlightCount: number;
}
```

**Why `currentGeneratorId`?** The old generator's `.finally()` block can race with a new generator started by hot-reload. By checking if `generatorId === session.currentGeneratorId`, we prevent the old `.finally()` from clobbering the new generator's state.

### 2.2 Track Idle State in Queue Processor ✅

**File**: `src/services/queue/SessionQueueProcessor.ts`

The iterator already waits in `waitForMessage()` when queue is empty. We need to:
1. Signal idle/busy state via events
2. Fix `waitForMessage()` to handle already-aborted signals

```typescript
async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
  while (!signal.aborted) {
    const persistentMessage = this.store.claimAndDelete(sessionDbId);

    if (persistentMessage) {
      // BUSY: processing a message
      this.events.emit('busy', sessionDbId);
      yield this.toPendingMessageWithId(persistentMessage);
    } else {
      // IDLE: queue empty, waiting for new messages
      this.events.emit('idle', sessionDbId);
      await this.waitForMessage(signal);
    }
  }
}

// CRITICAL FIX: Also emit idle/busy for batch iterator
async *createBatchIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId[]> {
  while (!signal.aborted) {
    const batch: PendingMessageWithId[] = [];
    let persistentMessage = this.store.claimAndDelete(sessionDbId);

    while (persistentMessage) {
      batch.push(this.toPendingMessageWithId(persistentMessage));
      persistentMessage = this.store.claimAndDelete(sessionDbId);
    }

    if (batch.length > 0) {
      // BUSY: processing a batch
      this.events.emit('busy', sessionDbId);
      yield batch;
    } else {
      // IDLE: queue empty, waiting for new messages
      this.events.emit('idle', sessionDbId);
      await this.waitForMessage(signal);
    }
  }
}

// CRITICAL FIX: Handle already-aborted signal to prevent hang
private waitForMessage(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    // If already aborted, resolve immediately (prevents hang)
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
      resolve();
    };

    const cleanup = () => {
      this.events.off('message', onMessage);
      signal.removeEventListener('abort', onAbort);
    };

    this.events.once('message', onMessage);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

### 2.3 Update SessionManager to Track Idle State ✅

**File**: `src/services/worker/SessionManager.ts`

- [x] Listen for `'idle'` and `'busy'` events from queue processor
- [x] Update `session.generatorIdle` accordingly
- [x] Track `inFlight` counter (increment on busy, decrement after response processed)
- [x] Expose method: `isGeneratorSafeToRestart(sessionDbId): boolean`

```typescript
isGeneratorSafeToRestart(sessionDbId: number): boolean {
  const session = this.getSession(sessionDbId);
  if (!session) return false;

  const pendingStore = this.getPendingMessageStore();

  // Safe if: generator exists, is idle, queue is empty, AND no in-flight work
  return session.generatorPromise !== null
    && session.generatorIdle
    && session.inFlightCount === 0  // No claimed-but-unprocessed messages
    && pendingStore.getPendingCount(sessionDbId) === 0;
}
```

---

## Phase 3: Safe Generator Restart

### 3.1 Update startGeneratorWithProvider for Generator Identity

**File**: `src/services/worker/http/routes/SessionRoutes.ts`

Add generator identity tracking to prevent `.finally()` race conditions:

```typescript
private startGeneratorWithProvider(
  session: ReturnType&lt;typeof this.sessionManager.getSession&gt;,
  provider: 'claude' | 'gemini' | 'openai',
  source: string
): void {
  if (!session) return;

  // Generate unique ID for this generator instance
  const generatorId = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Store generator ID on session for race detection
  session.currentGeneratorId = generatorId;

  // Capture the AbortController used for THIS generator (immutable reference)
  const thisAbortController = session.abortController;

  logger.info('SESSION', `Generator STARTING | id=${generatorId} | source=${source}`, {
    sessionId: session.sessionDbId,
    generatorId
  });

  session.currentProvider = provider;
  session.generatorPromise = agent.startSession(session, this.workerService)
    .catch(error =&gt; { /* ... existing error handling ... */ })
    .finally(() =&gt; {
      // CRITICAL: Only mutate session state if this generator is still current
      // This prevents hot-reload race where old .finally() clobbers new generator
      if (session.currentGeneratorId !== generatorId) {
        logger.debug('SESSION', `Generator ${generatorId} .finally() skipped - superseded by ${session.currentGeneratorId}`, {
          sessionId: session.sessionDbId
        });
        return;
      }

      const wasAborted = thisAbortController.signal.aborted;

      logger.info('SESSION', `Generator ENDED | id=${generatorId} | wasAborted=${wasAborted}`, {
        sessionId: session.sessionDbId,
        generatorId
      });

      session.generatorPromise = null;
      session.currentProvider = null;
      session.currentGeneratorId = null;

      // ... rest of existing .finally() logic (crash recovery, etc.) ...
    });
}
```

### 3.2 Add Async Restart Logic

**File**: `src/services/worker/http/routes/SessionRoutes.ts`

Add method to handle settings-triggered restarts with proper sequencing:

```typescript
/**
 * Restart generator for a session if safe (idle + queue empty)
 * Uses async flow: abort → await settle → start new
 *
 * @returns Promise&lt;boolean&gt; - true if restart was initiated, false if not safe
 */
private async tryRestartGeneratorAsync(sessionDbId: number, reason: string): Promise&lt;boolean&gt; {
  const session = this.sessionManager.getSession(sessionDbId);
  if (!session) return false;

  // Check if safe to restart
  if (!this.sessionManager.isGeneratorSafeToRestart(sessionDbId)) {
    logger.debug('SESSION', `Restart deferred - not safe`, {
      sessionId: sessionDbId,
      reason,
      generatorIdle: session.generatorIdle,
      pendingCount: this.sessionManager.getPendingMessageStore().getPendingCount(sessionDbId)
    });
    return false;
  }

  const oldGeneratorId = session.currentGeneratorId;
  const oldProvider = session.currentProvider;

  logger.info('SESSION', `Generator RESTARTING | reason=${reason}`, {
    sessionId: sessionDbId,
    oldGeneratorId,
    oldProvider,
    newProvider: this.getSelectedProvider()
  });

  // Step 1: Abort current generator
  const oldController = session.abortController;
  session.abortController = new AbortController();
  oldController.abort();

  // Step 2: Wait for old generator to settle (with timeout)
  if (session.generatorPromise) {
    try {
      await Promise.race([
        session.generatorPromise,
        new Promise(resolve =&gt; setTimeout(resolve, 5000)) // 5s timeout
      ]);
    } catch {
      // Ignore errors, we just want it to settle
    }
  }

  // Step 3: Double-check session still exists and no new generator started
  const currentSession = this.sessionManager.getSession(sessionDbId);
  if (!currentSession || currentSession.generatorPromise) {
    logger.warn('SESSION', `Restart aborted - session state changed`, {
      sessionId: sessionDbId,
      reason
    });
    return false;
  }

  // Step 4: Start new generator with updated settings
  this.startGeneratorWithProvider(currentSession, this.getSelectedProvider(), reason);

  return true;
}
```

### 3.3 Fix pendingRestart Handling

**File**: `src/services/worker/SessionManager.ts`

Only clear `pendingRestart` after restart successfully starts:

```typescript
/**
 * Mark session for restart when it becomes safe
 * Called when settings change but generator is busy
 */
markForRestart(sessionDbId: number, reason: string): void {
  const session = this.getSession(sessionDbId);
  if (session) {
    session.pendingRestart = { reason, requestedAt: Date.now() };
  }
}

/**
 * Check if session has pending restart and attempt it
 * Called when generator becomes idle
 *
 * @returns true if restart was triggered, false otherwise
 */
async checkPendingRestart(sessionDbId: number, restartFn: (id: number, reason: string) =&gt; Promise&lt;boolean&gt;): Promise&lt;boolean&gt; {
  const session = this.getSession(sessionDbId);
  if (!session?.pendingRestart) return false;

  const { reason } = session.pendingRestart;

  // Attempt restart - only clear pendingRestart if successful
  const success = await restartFn(sessionDbId, reason);

  if (success) {
    session.pendingRestart = null;
  } else {
    // Restart failed (e.g., new message arrived), keep pendingRestart for next idle
    logger.debug('SESSION', `Pending restart kept - restart failed`, {
      sessionId: sessionDbId,
      reason
    });
  }

  return success;
}
```

### 3.4 Wire Up the Event Flow

1. `SettingsWatcher` detects change → emits `'change'`
2. `WorkerService` receives change → calls `SessionManager.scheduleRestarts(changedKeys)`
3. `SessionManager` iterates sessions:
   - Safe → emit `'restart-now'`
   - Not safe → `markForRestart()`
4. `SessionRoutes` listens for `'restart-now'` → calls `tryRestartGeneratorAsync()`
5. When generator becomes idle → `SessionManager.checkPendingRestart()` → emit `'restart-now'`

---

## Phase 4: UI Feedback (Optional Enhancement)

### 4.1 Add Settings Status to API

**File**: `src/services/worker/http/routes/SettingsRoutes.ts`

Add endpoint to show pending restarts:

```typescript
// GET /api/settings/status
{
  "settingsPath": "~/.claude-mem/settings.json",
  "lastModified": 1737612345678,
  "pendingRestarts": [
    { "sessionDbId": 1, "reason": "provider_changed", "waitingSince": 1737612345000 }
  ]
}
```

### 4.2 SSE Event for Settings Changes

Broadcast to UI when settings change and restarts are pending:

```typescript
eventBroadcaster.broadcastSettingsChanged({
  changedKeys: ['CLAUDE_MEM_PROVIDER'],
  pendingRestarts: 1,
  appliedImmediately: 0
});
```

---

## Phase 5: Testing & Documentation

### 5.1 Test Scenarios

- [ ] Change provider while generator is idle → immediate restart
- [ ] Change provider while generator is processing → deferred restart
- [ ] Change model (same provider) → restart with new model
- [ ] Change unrelated setting → no restart
- [ ] Multiple rapid changes → coalesce into single restart
- [ ] Worker restart recovery → pending restarts cleared

### 5.2 Documentation Updates

- [ ] Update `docs/issues/2026-01-22-01-settings-hot-reload-requires-worker-restart.md` with resolution
- [ ] Add settings hot-reload behavior to main README or docs
- [ ] Document which settings require restart vs apply immediately

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `src/services/worker/settings/SettingsWatcher.ts` | New | Settings file watcher |
| `src/services/worker-types.ts` | Modify | Add `generatorIdle`, `pendingRestart` to ActiveSession |
| `src/services/queue/SessionQueueProcessor.ts` | Modify | Emit `idle`/`busy` events |
| `src/services/worker/SessionManager.ts` | Modify | Track idle state, pending restarts |
| `src/services/worker/http/routes/SessionRoutes.ts` | Modify | Add `tryRestartGenerator()` |
| `src/services/worker-service.ts` | Modify | Initialize SettingsWatcher, wire events |
| `src/services/worker/http/routes/SettingsRoutes.ts` | Modify | Add status endpoint (optional) |

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Race condition: message arrives during restart | Double-check queue empty in `tryRestartGeneratorAsync()` |
| SDK prefetch: messages claimed but not yielded | Only restart when generator is in `waitForMessage()` |
| Batch mode: entire batch in-flight | Batch iterator also emits idle when waiting |
| Rapid settings changes | Debounce watcher (500ms), coalesce restarts |
| Generator lifecycle race (.finally() clobbers new state) | `currentGeneratorId` check prevents old .finally() from mutating |
| Pending restart lost on failed attempt | Only clear `pendingRestart` after successful restart |
| waitForMessage() hangs on abort | Check `signal.aborted` at entry, resolve immediately |
| Partial JSON writes | Validate JSON before emitting change event |

---

## Acceptance Criteria

- [ ] Changing `CLAUDE_MEM_PROVIDER` applies to next observation without worker restart
- [ ] Changing `CLAUDE_MEM_MODEL` applies to next observation (or after current processing completes)
- [ ] No observations are lost during settings-triggered restart
- [ ] Manual file edits and UI edits behave consistently
- [ ] Pending restart is visible in UI (optional)

---

## Version Plan

Released in **v9.0.6-jv.4** with infinite rollover loop fix.
