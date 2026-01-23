# Plan 1: Gemini + OpenAI Context Truncation

- Plan ID: 2026-01-23-plan-1
- Date: 2026-01-23
- Status: Implementation Complete (Phases 1-6), Testing Pending (Phase 7)
- Related Issues:
  - `docs/issues/2026-01-22-03-runaway-context-tokens-claude-resume-gemini-history.md`

## Goal

Prevent runaway context growth for Gemini and OpenAI providers by:
1. Fixing duplicate history entries
2. Implementing message-level token truncation using actual API-reported tokens

## Background

- Both providers append assistant responses twice (agent + ResponseProcessor)
- OpenAI has truncation but uses estimated tokens (chars/4)
- Gemini has no truncation at all
- Both providers already capture actual token counts from API responses

## Codex Review (2026-01-23)

Feedback addressed in this revision:
1. **Pinned instruction messages** - Truncation must preserve instruction-bearing messages
2. **Token counting nuance** - API tokens for triggering, heuristic for deciding which to drop
3. **Large observation edge case** - Add safety margin or retry-on-context-error
4. **Mutation decision** - Truncation should mutate `session.conversationHistory` directly

## Phases

### Phase 1: Fix Duplicate History

**Problem**: Assistant responses appended twice - once in agent, once in ResponseProcessor.

**Solution**: Remove append from agents, keep centralized in ResponseProcessor.

- [x] 1.1 Remove history append from `GeminiAgent.ts:167, 230, 267`
- [x] 1.2 Remove history append from `OpenAIAgent.ts:119, 179, 216`
- [x] 1.3 Verify ResponseProcessor (`src/services/worker/agents/ResponseProcessor.ts:59-61`) handles all cases
- [ ] 1.4 Test: Confirm history grows at expected rate (no duplicates)

### Phase 2: Add Gemini Settings

**Goal**: Add truncation settings for Gemini (matching OpenAI pattern).

- [x] 2.1 Add settings to `SettingsDefaultsManager.ts`:
  - `CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES` (default: 20)
  - `CLAUDE_MEM_GEMINI_MAX_TOKENS` (default: 100000)
  - `CLAUDE_MEM_GEMINI_TRUNCATION_ENABLED` (default: true)
- [x] 2.2 Add corresponding settings to OpenAI if missing:
  - `CLAUDE_MEM_OPENAI_TRUNCATION_ENABLED` (default: true)
- [ ] 2.3 Document settings in README or settings schema

### Phase 3: Track Actual Token Usage

**Goal**: Use API-reported tokens for triggering truncation decisions.

**Logic**: After each response, store input token count. Before next request, check if stored count > threshold.

**Codex clarification**: API-reported tokens are used as the *trigger signal*. Per-message token counts are not available, so we still use heuristics (message count + char-based estimate) to decide *which* messages to drop.

- [x] 3.1 Add `lastInputTokens` field to session state (both providers) - Added to `ActiveSession` in `worker-types.ts`
- [x] 3.2 After API response, capture and store:
  - OpenAI: `data.usage?.prompt_tokens`
  - Gemini: `data.usageMetadata?.promptTokenCount`
- [x] 3.3 Before building request, check `lastInputTokens` against threshold (with safety margin, e.g., 90% of max)

### Phase 4: Implement Shared Truncation Utility

**Goal**: Extract truncation logic to shared utility for both providers.

- [x] 4.1 Create `src/services/worker/utils/HistoryTruncation.ts`
- [x] 4.2 Extract/refactor OpenAI's `truncateHistory` logic:
  ```typescript
  interface TruncationConfig {
    maxMessages: number;
    maxTokens: number;
    enabled: boolean;
    safetyMarginPercent?: number;  // Default 90% - trigger before hitting hard limit
  }

  interface TruncationOptions {
    pinnedMessageIndices?: number[];  // Messages to never drop (e.g., instruction prompt)
  }

  function truncateHistory(
    history: ConversationMessage[],
    config: TruncationConfig,
    lastInputTokens?: number,
    options?: TruncationOptions
  ): ConversationMessage[]
  ```
- [x] 4.3 **Pinned message policy**:
  - Pin the **most recent** init/continuation prompt only (not all instruction messages forever)
  - Cap pinned messages to 1-2 max
  - If pinned messages alone exceed limits, log error and proceed with pinned only (edge case)
- [x] 4.4 **Mutation behavior**: Truncation should mutate `session.conversationHistory` directly (not just a copy)
- [x] 4.5 Add logging when truncation occurs:
  - Original message count
  - Kept message count
  - Dropped message count
  - Token count (actual if available, estimated otherwise)
  - Pinned messages preserved

### Phase 5: Integrate Truncation

- [x] 5.1 Update `OpenAIAgent.ts` to use shared utility
- [x] 5.2 Add truncation to `GeminiAgent.ts` using shared utility
- [x] 5.3 Respect `*_TRUNCATION_ENABLED` setting (skip if disabled)
- [x] 5.4 Identify and mark instruction-bearing messages as pinned

### Phase 6: Error Recovery

**Goal**: Handle edge case where single large observation exceeds limit.

- [x] 6.1 Add retry-on-context-error logic:
  - Catch 400/invalid_request style failures indicating context overflow
  - **Aggressive truncation**: Keep pinned message + current user message only
  - Retry once
- [x] 6.2 If retry fails, log error and skip observation:
  - Call `processAgentResponse` with empty/error response to complete the observation cycle
  - Ensure in-flight counter is decremented (don't trigger repeated retries)
  - Don't crash worker

**Implementation details:**
- Added `isContextOverflowError()` function to `FallbackErrorHandler.ts`
- Added `CONTEXT_OVERFLOW_PATTERNS` to `types.ts` for error detection
- Added `queryWithRetry()` method to both GeminiAgent and OpenAIAgent
- Both agents now use `queryWithRetry()` for observation and summary calls

**Codex Phase 6 Review (2026-01-23):**
- Approved with suggestions implemented:
  1. Added more error patterns: `prompt is too long`, `reduce the length`, `Please reduce the length of the messages`, `Request payload size exceeds`, `payload too large`, `entity too large`, `413`
  2. Removed `max_tokens` pattern (can cause false positives for output-token issues)
  3. Added telemetry counters: `contextOverflowDetected`, `contextOverflowRetrySucceeded`, `contextOverflowSkipped`
  4. Added optional `skipReason` field to return type for debuggability
  5. Removed unused `logger` import from `FallbackErrorHandler.ts`

### Phase 7: Testing

- [ ] 7.1 Unit test: Truncation utility with various history sizes
- [ ] 7.2 Unit test: Pinned messages are preserved during truncation
- [ ] 7.3 Integration test: Gemini with large context triggers truncation
- [ ] 7.4 Integration test: OpenAI truncation still works after refactor
- [ ] 7.5 Test: Disabled truncation setting bypasses truncation
- [ ] 7.6 Test: Retry-on-context-error recovers gracefully
- [ ] 7.7 Verify logs appear when truncation happens

## Settings Summary

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES` | 20 | Max messages before truncation |
| `CLAUDE_MEM_OPENAI_MAX_TOKENS` | 100000 | Max tokens before truncation |
| `CLAUDE_MEM_OPENAI_TRUNCATION_ENABLED` | true | Enable/disable truncation |
| `CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES` | 20 | Max messages before truncation |
| `CLAUDE_MEM_GEMINI_MAX_TOKENS` | 100000 | Max tokens before truncation |
| `CLAUDE_MEM_GEMINI_TRUNCATION_ENABLED` | true | Enable/disable truncation |

## Out of Scope (Future)

- State summary on truncation (see Plan 2, later phase)
- Claude provider changes (see Plan 2)

## Acceptance Criteria

- [ ] No duplicate history entries for Gemini/OpenAI
- [ ] Gemini has truncation matching OpenAI capability
- [ ] Truncation uses actual API-reported tokens as trigger signal
- [ ] Instruction-bearing messages are never dropped (pinned)
- [ ] Truncation can be disabled via settings
- [ ] Logs indicate when truncation occurs
- [ ] Large observation edge case handled gracefully (retry or skip)
