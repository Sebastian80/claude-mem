# Plan 2: Claude Session Rollover (Issue 04 + Issue 03)

- Plan ID: 2026-01-23-plan-2
- Date: 2026-01-23
- Status: Implementation Complete, Codex Approved, Testing Pending
- Codex Review: Approved (3 rounds - initial review, fixes, final confirmation)
- Related Issues:
  - `docs/issues/2026-01-22-03-runaway-context-tokens-claude-resume-gemini-history.md`
  - `docs/issues/2026-01-22-04-decouple-db-session-id-from-provider-session.md`
- Depends On: Plan 1 (shared truncation utility, settings pattern)

## Goal

Enable Claude provider to restart SDK sessions when context grows too large, without breaking database foreign key relationships.

## Background

Current problem:
- `memory_session_id` is used for both DB foreign keys AND Claude SDK resume
- Restarting Claude session = new SDK session_id = FK error
- Context grows until model hits limit → crash

Solution:
- Decouple DB identity from provider session identity
- Generate stable UUID for DB (like Gemini/OpenAI do)
- Store Claude SDK session_id separately for resume
- When threshold reached → start fresh SDK session, keep same DB identity

## Codex Review (2026-01-23)

Feedback addressed in this revision:
1. **SDK subprocess restart** - Clearing `claude_resume_session_id` alone won't work; must actually restart the SDK subprocess
2. **Orphan cleanup** - Update any code that greps for `--resume` using `memorySessionId`
3. **Persist token count** - Consider persisting `lastInputTokens` to survive worker restarts
4. **Migration safety** - Never overwrite non-null `memory_session_id` on existing rows
5. **Call sites audit** - Explicitly list all call sites that read/write session identity

## Phases

### Phase 1: Audit Current `memory_session_id` Usage

**Goal**: Understand all places that use `memory_session_id` before making changes.

- [x] 1.1 Search codebase for all `memory_session_id` and `memorySessionId` references
- [x] 1.2 Document each usage:
  - DB schema (FK relationships)
  - Session storage/retrieval
  - Resume logic
  - API responses
  - **Orphan process cleanup** (any code that greps for `--resume`)
- [x] 1.3 Identify breaking changes and migration needs
- [x] 1.4 Create migration checklist with all call sites to update:
  - DB session record types
  - Session init logic
  - HTTP routes/payloads
  - Cleanup utilities
- [x] 1.5 Document which call sites assume `memorySessionId == Claude resume id`

#### Audit Results (2026-01-23)

**DB Schema** (`src/services/sqlite/SessionStore.ts`):
- `sdk_sessions.memory_session_id TEXT UNIQUE` - FK target for observations/summaries
- `observations.memory_session_id TEXT NOT NULL` - FK to sdk_sessions
- `session_summaries.memory_session_id TEXT NOT NULL` - FK to sdk_sessions
- Starts as NULL, captured from SDK response

**Session Identity Flow** (`src/services/worker/SDKAgent.ts`):
- `memory_session_id` captured from `message.session_id` on first SDK response
- Used for resume: `{ resume: session.memorySessionId }` (line 120)
- Used for FK when storing observations/summaries
- **Problem**: Rollover would get NEW SDK session_id, breaking FK relationship

**Orphan Cleanup** (`src/services/worker/SDKAgent.ts:killOrphanSubprocesses`):
- Uses `pgrep -f "--resume ${memorySessionId}"` to find orphan processes
- **Must update** to use `claude_resume_session_id` after refactor

**Key Call Sites to Update**:
1. `SDKAgent.ts:131-151` - Capture and store memory_session_id (split into two fields)
2. `SDKAgent.ts:120` - Resume parameter (use claude_resume_session_id)
3. `SDKAgent.ts:495-550` - killOrphanSubprocesses (use claude_resume_session_id)
4. `SessionManager.ts:142` - Load memorySessionId from DB (keep for FK)
5. `SessionManager.ts:303-310` - Orphan cleanup callback (use claude_resume_session_id)
6. `SessionStore.ts:652-658` - updateMemorySessionId (add updateClaudeResumeSessionId)
7. `worker-types.ts:23` - ActiveSession.memorySessionId (add claudeResumeSessionId)

**Types to Update**:
- `src/types/database.ts:SDKSessionRow` - add claude_resume_session_id, last_input_tokens
- `src/services/worker-types.ts:ActiveSession` - add claudeResumeSessionId
- `src/services/sqlite/sessions/types.ts` - add new fields to session types

**No Changes Needed** (use stable memory_session_id):
- All observation/summary storage (FK relationships)
- All search/query operations
- Chroma sync (uses memory_session_id for document IDs)
- Context generation

### Phase 2: Schema Migration

**Goal**: Add separate column for Claude resume session ID.

- [x] 2.1 Add new columns to `sdk_sessions` table:
  - `claude_resume_session_id` (TEXT, nullable)
  - `last_input_tokens` (INTEGER, nullable) - persist for worker restart survival
- [x] 2.2 Create migration script in `src/services/sqlite/` (migration 21)
- [x] 2.3 Update `SessionStore.ts` to handle new columns:
  - `updateClaudeResumeSessionId()`
  - `updateLastInputTokens()`
  - `getClaudeRolloverState()`
- [x] 2.4 **Migration safety**: Only generate new UUID for `memory_session_id` when NULL; never overwrite existing non-null values (would orphan observations)
- [ ] 2.5 Test: Migration runs without data loss

**Migration strategy**: Fresh start - existing sessions won't resume but data preserved. New sessions will use the decoupled model.

### Phase 3: Refactor Claude Session Identity

**Goal**: Generate stable UUID for `memory_session_id`, store SDK session_id separately.

- [x] 3.1 Update `SDKAgent.ts` session initialization:
  - Generate random UUID for `memory_session_id` (like Gemini does)
  - Store SDK's `message.session_id` in `claude_resume_session_id`
- [x] 3.2 **Resume ID capture**: Update `claude_resume_session_id` whenever SDK returns a (new) `message.session_id` (not only first time - SDK may return new IDs)
- [x] 3.3 Update resume logic:
  - Use `claude_resume_session_id` for SDK resume (not `memory_session_id`)
- [x] 3.4 Update session lookup:
  - Find session by stable `memory_session_id`
  - Resume using `claude_resume_session_id` if present
- [x] 3.5 **Update all call sites identified in Phase 1.4**:
  - DB session record types (SdkSessionRecord)
  - Session init logic (SessionManager.initializeSession)
  - ActiveSession type (worker-types.ts)
- [x] 3.6 **Update orphan cleanup**: Any code that greps for `--resume` must use `claude_resume_session_id`, not `memory_session_id`
- [ ] 3.7 Test: New sessions work with decoupled IDs
- [ ] 3.8 Test: Observations stored correctly under stable UUID

### Phase 4: Add Claude Token Tracking

**Goal**: Track input tokens from Claude SDK responses.

- [x] 4.1 Verify Claude SDK returns input token count (should be in `usage.input_tokens`)
- [x] 4.2 Add `lastInputTokens` field to Claude session state (in-memory) - already in ActiveSession
- [x] 4.3 After SDK response, capture and store input tokens
- [x] 4.4 **Persist to DB**: Save `last_input_tokens` to `sdk_sessions` table for worker restart survival
- [x] 4.5 Add settings:
  - `CLAUDE_MEM_CLAUDE_MAX_TOKENS` (default: 150000 - Claude has larger context)
  - `CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED` (default: true)

### Phase 5: Implement Rollover Logic

**Goal**: When input tokens exceed threshold, restart SDK subprocess with fresh session.

**Critical**: Rollover requires actually restarting the Claude SDK subprocess, not just clearing a flag. The `resume` parameter is only checked when starting a new process.

**Rollover wiring**: Use existing `pendingRestart` + `tryRestartGeneratorAsync` flow in `SessionManager.ts` (safe idle/in-flight gating).

- [x] 5.1 **Pre-check at generator start**: Before starting generator, check if `last_input_tokens` is already over threshold → start without resume immediately
- [x] 5.2 Before SDK call, check `lastInputTokens` against threshold (90% safety margin)
- [x] 5.3 If threshold exceeded:
  - Log rollover event (old session_id, token count, reason)
  - Clear `claude_resume_session_id` in DB
  - Start fresh (no resume parameter)
- [x] 5.4 After fresh session response:
  - Capture new SDK session_id
  - Store in `claude_resume_session_id`
  - Continue with same `memory_session_id`
- [x] 5.5 **Re-inject continuation prompt**: On rollover, the new session gets a fresh init/continuation prompt (this happens naturally when restarting the generator)
- [ ] 5.6 Test: Rollover triggers at threshold
- [ ] 5.7 Test: Observations continue storing after rollover
- [ ] 5.8 Test: SDK subprocess is actually restarted (not just flag cleared)

**Implementation Notes (2026-01-23)**:
- Rollover check added to `SessionRoutes.startGeneratorWithProvider()`
- Uses 90% safety margin (threshold = maxTokens * 0.9)
- Clears `claudeResumeSessionId` to null, which causes SDKAgent to start fresh
- `memorySessionId` remains stable (FK identity preserved)
- New SDK session_id captured on first response and stored in `claudeResumeSessionId`

### Phase 6: Logging and Debugging

- [x] 6.1 Log when rollover is triggered:
  - Previous session_id
  - New session_id
  - Token count that triggered rollover
  - Threshold value
- [x] 6.2 Log session state on each request (debug level):
  - Current `memory_session_id`
  - Current `claude_resume_session_id`
  - `lastInputTokens`
- [x] 6.3 Log when token count is persisted to DB

**Implementation Notes (2026-01-23)**:
- Rollover trigger logged in `SessionRoutes.startGeneratorWithProvider()` with `CLAUDE_ROLLOVER_TRIGGERED`
- Token capture logged in `SDKAgent.startSession()` with `Token usage captured`
- Resume ID capture logged with `CLAUDE_RESUME_ID_CAPTURED`
- All logs include sessionId, token counts, and threshold values

### Phase 7: Testing

- [ ] 7.1 Unit test: Session ID decoupling
- [ ] 7.2 Integration test: Rollover triggers at threshold
- [ ] 7.3 Integration test: Observations stored correctly across rollover
- [ ] 7.4 Integration test: Multiple rollovers in one logical session
- [ ] 7.5 Test: Disabled rollover setting bypasses rollover
- [ ] 7.6 Test: Fresh start (no existing session) works correctly
- [ ] 7.7 Test: Worker restart recovers `lastInputTokens` from DB
- [ ] 7.8 Test: Orphan cleanup works with new `claude_resume_session_id`

## Settings Summary

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_CLAUDE_MAX_TOKENS` | 150000 | Token threshold for rollover |
| `CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED` | true | Enable/disable rollover |

## Future Phase (Low Priority): State Summary

**Goal**: Pass compact state summary to new session on rollover/truncation for better continuity.

Applies to all providers (Claude, Gemini, OpenAI).

- [ ] F.1 Design state summary format (what to include)
- [ ] F.2 Generate summary before rollover/truncation
- [ ] F.3 Inject summary as first message in new/truncated context
- [ ] F.4 Test: Extraction quality with state summary vs without

**Note**: Only implement after all other phases are working and if extraction quality suffers without it.

## Schema Changes

### Before (actual current schema)
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  memory_session_id TEXT UNIQUE,           -- FK target for observations
  project TEXT NOT NULL,
  -- ... other columns
);

CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,         -- References sdk_sessions.memory_session_id
  -- ... other columns
);
```

### After
```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT UNIQUE NOT NULL,
  memory_session_id TEXT UNIQUE,           -- Stable UUID (generated), FK target
  claude_resume_session_id TEXT,           -- Claude SDK session_id (for resume)
  last_input_tokens INTEGER,               -- Persisted for worker restart survival
  project TEXT NOT NULL,
  -- ... other columns
);

-- observations table unchanged (still references memory_session_id)
```

## Acceptance Criteria

- [ ] Claude sessions can be restarted without FK errors
- [ ] Observations stored correctly across session rollovers
- [ ] Rollover triggers automatically when token threshold exceeded
- [ ] SDK subprocess is actually restarted on rollover (not just flag cleared)
- [ ] Rollover can be disabled via settings
- [ ] Logs indicate when rollover occurs
- [ ] Existing data preserved (though old sessions won't resume)
- [ ] Token count survives worker restarts
- [ ] Orphan cleanup works with decoupled IDs
