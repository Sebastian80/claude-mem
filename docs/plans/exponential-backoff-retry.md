# Exponential Backoff Retry Implementation Plan

## Problem Statement

When remote API servers return errors, claude-mem generators immediately retry without any delay. This causes rapid-fire retry attempts (20-30 within seconds) that result in users being rate-limited or blocked by the API provider.

## Root Cause Analysis

Current retry behavior at each level:

### 1. Agent-Level (`GeminiAgent.ts`, `OpenAIAgent.ts`)
- `queryWithRetry()` only handles context overflow errors with single retry
- Other API errors (429, 500, 502, 503, timeout, etc.) throw immediately
- No delay between retries

### 2. Session-Level (`SessionRoutes.ts`)
- Generator `.finally()` block triggers crash recovery with `setTimeout(() => {...})` (0ms delay)
- Inner retry loop uses fixed 500ms delay
- Max 3 attempts (initial + 2 retries)

### 3. Result
When API errors occur: Generator throws → 0ms restart → Immediate throw → 0ms restart → ... (rapid loop)

## Proposed Solution

Implement exponential backoff with the following delays:
- 1st retry: 3 seconds
- 2nd retry: 5 seconds
- 3rd retry: 10 seconds
- 4th retry: 30 seconds
- 5th retry: 60 seconds
- 6th+ retry: 60 seconds (cap)

Max retry attempts: Configurable, default 10 (or until session ends)

## Implementation Plan

### Phase 1: Create Shared Backoff Utility
- [x] Create `src/services/worker/utils/ExponentialBackoff.ts`
- [x] Define backoff schedule: [3000, 5000, 10000, 30000, 60000] ms
- [x] Implement `getBackoffDelay(retryCount: number): number`
- [x] Implement `sleep(ms: number): Promise<void>` with abort signal support
- [x] Add max retry attempts constant (10)
- [x] Add `isRetryableError()` for transient error detection
- [x] Add `formatBackoffDelay()` for logging

### Phase 2: Update Session-Level Recovery (SessionRoutes.ts)
- [x] Replace fixed 500ms delay with exponential backoff
- [x] Replace 0ms initial restart delay with first backoff delay (3s)
- [x] Log backoff delays for observability
- [x] Reset retry count on successful generator start
- [x] Support abort signal to cancel sleep during shutdown
- [x] Increase max retries from 3 to 10

### Phase 3: Update Agent-Level Retry (GeminiAgent.ts, OpenAIAgent.ts)
- [x] Add retry with backoff for transient API errors (429, 500, 502, 503, timeout)
- [x] Use same backoff utility for consistency
- [x] Keep context overflow single-retry as-is (different purpose)
- [x] Add telemetry for retry attempts
- [x] Support abort signal to cancel sleep during shutdown

### Phase 4: Update SDK Agent (SDKAgent.ts)
- [x] Reviewed - SDK handles retries internally via Claude SDK
- [x] Session-level retry in SessionRoutes handles errors that bubble up
- [x] No additional changes needed - SDKAgent correctly re-throws for session-level retry

### Phase 5: Testing & Validation
- [x] Build succeeded without errors
- [ ] Test with simulated API errors (manual testing required)
- [ ] Verify backoff delays in logs
- [ ] Ensure recovery still works when API comes back
- [ ] Verify no regression for normal operations

## Files to Modify

1. **New**: `src/services/worker/utils/ExponentialBackoff.ts`
2. `src/services/worker/http/routes/SessionRoutes.ts`
3. `src/services/worker/GeminiAgent.ts`
4. `src/services/worker/OpenAIAgent.ts`
5. `src/services/worker/SDKAgent.ts` (if needed)

## Backoff Configuration

```typescript
// Default backoff schedule in milliseconds
const BACKOFF_SCHEDULE = [3000, 5000, 10000, 30000, 60000];
const MAX_RETRY_ATTEMPTS = 10;

function getBackoffDelay(retryCount: number): number {
  const index = Math.min(retryCount, BACKOFF_SCHEDULE.length - 1);
  return BACKOFF_SCHEDULE[index];
}
```

## Error Types to Retry

Using existing `FALLBACK_ERROR_PATTERNS` from `types.ts`:
- `429` - Rate limit
- `500` - Internal server error
- `502` - Bad gateway
- `503` - Service unavailable
- `504` - Gateway timeout (added per Codex review)
- `ECONNREFUSED` - Connection refused
- `ETIMEDOUT` - Timeout
- `fetch failed` - Network failure

## Success Criteria

1. API errors trigger exponential backoff delays
2. Logs show backoff delays for debugging
3. No more than 1 request per 3 seconds during error conditions
4. Normal operations unaffected
5. Recovery works when API becomes available

## Codex Review Fixes (2026-01-29)

Codex review identified several issues that were fixed:

### 1. Backoff Schedule Duplication (Fixed)
- **Issue**: Crash recovery applied first backoff (3s) twice: initial delay + first retry
- **Fix**: Start `retryCount` at 1 after initial delay, giving correct sequence: 3s, 5s, 10s...

### 2. `sleep()` Listener Leak (Fixed)
- **Issue**: Abort listener was never removed on normal resolve
- **Fix**: Added cleanup function that removes listener on both resolve and abort

### 3. Abort Error Misclassification (Fixed)
- **Issue**: Sleep abort would re-throw original API error, triggering fallback
- **Fix**: Re-throw abort error for clean shutdown handling

### 4. `isRetryableError()` Improvements (Fixed)
- **Issue**: Missing 504, no structured error checks
- **Fix**: Added 504, check `status`/`statusCode`/`code` properties, exclude AbortError

### 5. AbortController Replacement Race (Fixed)
- **Issue**: Retry loop captured signal that could be replaced during restart
- **Fix**: Capture abort signal at start of method/recovery before controller replacement

### Remaining Suggestions (Not Implemented)
- Add jitter to avoid synchronized retries across sessions
- Extract/propagate real HTTP status and `Retry-After` headers
- Add unit tests for backoff utility functions
