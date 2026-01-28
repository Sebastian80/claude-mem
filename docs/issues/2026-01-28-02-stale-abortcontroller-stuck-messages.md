# Stale AbortController Causes Stuck Pending Messages

**Date**: 2026-01-28
**Version**: 9.0.8-jv.6
**Severity**: High
**Status**: Fixed

## Problem

When a generator exits with no pending work, `session.abortController.abort()` is called (SessionRoutes.ts:412) to kill the child process. However, when new messages are later enqueued and a generator restarts, neither `startGenerator()` nor `startSessionProcessor()` creates a fresh AbortController.

The message iterator's `createIterator()` checks `while (!signal.aborted)` and immediately exits because the signal is already aborted from the previous cleanup. This causes the generator to process only the init prompt while all pending messages remain stuck.

## Root Cause Analysis

Investigation found 28 stuck messages (24 in session 5674, 4 in session 5757):

1. Session 5674 entered a "zombie" state after a Gemini API exhaustion event (503 error)
2. Every attempt to restart the session failed because the GeminiAgent's mandatory initial prompt query was being aborted immediately
3. The `AbortController` was still in aborted state from the previous generator cleanup
4. Generators log "completed" while also being "aborted" - race condition between AI response and abort signal
5. The system's abort-handling treats these as intentional user aborts, skipping crash recovery

## Affected Sessions

- Session 5674: 24 pending messages stuck for over 2 hours
- Session 5757: Blocked by 429 rate limits, highlighting Gemini API pressure

## Fix

Reset the AbortController if it's already aborted when starting a new generator.

### Changes

**1. `src/services/worker/http/routes/SessionRoutes.ts` (~line 208)**

Added check before capturing the AbortController:

```typescript
// Reset AbortController if stale (aborted by previous generator cleanup)
// This prevents message iterators from immediately exiting due to stale abort signal
if (session.abortController.signal.aborted) {
  logger.info('SESSION', `Resetting stale AbortController before generator start`, {
    sessionId: session.sessionDbId,
    generatorId
  });
  session.abortController = new AbortController();
}
```

**2. `src/services/worker-service.ts` (~line 378)**

Added same check in `startSessionProcessor()` before calling agent's `startSession()`:

```typescript
// Reset AbortController if stale (aborted by previous generator cleanup)
// This prevents message iterators from immediately exiting due to stale abort signal
if (session.abortController.signal.aborted) {
  logger.info('SYSTEM', `Resetting stale AbortController before generator start`, {
    sessionId: session.sessionDbId,
    source
  });
  session.abortController = new AbortController();
}
```

## Files Modified

- `src/services/worker/http/routes/SessionRoutes.ts`
- `src/services/worker-service.ts`

## Verification

1. Build: `npm run build`
2. Commit and push to marketplace
3. After worker restart, periodic recovery should pick up stuck sessions
4. Check logs: `grep "Resetting stale AbortController" ~/.claude-mem/logs/claude-mem-*.log`
5. Verify messages are claimed: `grep "CLAIMED.*5674" ~/.claude-mem/logs/claude-mem-*.log | tail -30`
6. Check DB: `sqlite3 ~/.claude-mem/claude-mem.db "SELECT status, COUNT(*) FROM pending_messages WHERE session_db_id = 5674 GROUP BY status"`

## Related

- Category Q: Stuck Message Recovery Bugfix (docs/FORK-CHANGES.md)
- Plan: /home/vscode/.claude/projects/-workspaces-projects-workspace-claude-mem/reactive-foraging-leaf.md
