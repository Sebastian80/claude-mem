# Plan 2: Claude Session Rollover (Issue 04 + Issue 03)

- Plan ID: 2026-01-23-plan-2
- Date: 2026-01-23
- Status: Draft
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

- [ ] 1.1 Search codebase for all `memory_session_id` and `memorySessionId` references
- [ ] 1.2 Document each usage:
  - DB schema (FK relationships)
  - Session storage/retrieval
  - Resume logic
  - API responses
  - **Orphan process cleanup** (any code that greps for `--resume`)
- [ ] 1.3 Identify breaking changes and migration needs
- [ ] 1.4 Create migration checklist with all call sites to update:
  - DB session record types
  - Session init logic
  - HTTP routes/payloads
  - Cleanup utilities
- [ ] 1.5 Document which call sites assume `memorySessionId == Claude resume id`

### Phase 2: Schema Migration

**Goal**: Add separate column for Claude resume session ID.

- [ ] 2.1 Add new columns to `sdk_sessions` table:
  - `claude_resume_session_id` (TEXT, nullable)
  - `last_input_tokens` (INTEGER, nullable) - persist for worker restart survival
- [ ] 2.2 Create migration script in `src/services/sqlite/`
- [ ] 2.3 Update `SessionStore.ts` to handle new columns
- [ ] 2.4 **Migration safety**: Only generate new UUID for `memory_session_id` when NULL; never overwrite existing non-null values (would orphan observations)
- [ ] 2.5 Test: Migration runs without data loss

**Migration strategy**: Fresh start - existing sessions won't resume but data preserved. New sessions will use the decoupled model.

### Phase 3: Refactor Claude Session Identity

**Goal**: Generate stable UUID for `memory_session_id`, store SDK session_id separately.

- [ ] 3.1 Update `SDKAgent.ts` session initialization:
  - Generate random UUID for `memory_session_id` (like Gemini does)
  - Store SDK's `message.session_id` in `claude_resume_session_id`
- [ ] 3.2 **Resume ID capture**: Update `claude_resume_session_id` whenever SDK returns a (new) `message.session_id` (not only first time - SDK may return new IDs)
- [ ] 3.3 Update resume logic:
  - Use `claude_resume_session_id` for SDK resume (not `memory_session_id`)
- [ ] 3.4 Update session lookup:
  - Find session by stable `memory_session_id`
  - Resume using `claude_resume_session_id` if present
- [ ] 3.5 **Update all call sites identified in Phase 1.4**:
  - DB session record types
  - Session init logic
  - HTTP routes/payloads
  - Cleanup utilities
- [ ] 3.6 **Update orphan cleanup**: Any code that greps for `--resume` must use `claude_resume_session_id`, not `memory_session_id`
- [ ] 3.7 Test: New sessions work with decoupled IDs
- [ ] 3.8 Test: Observations stored correctly under stable UUID

### Phase 4: Add Claude Token Tracking

**Goal**: Track input tokens from Claude SDK responses.

- [ ] 4.1 Verify Claude SDK returns input token count (should be in `usage.input_tokens`)
- [ ] 4.2 Add `lastInputTokens` field to Claude session state (in-memory)
- [ ] 4.3 After SDK response, capture and store input tokens
- [ ] 4.4 **Persist to DB**: Save `last_input_tokens` to `sdk_sessions` table for worker restart survival
- [ ] 4.5 Add settings:
  - `CLAUDE_MEM_CLAUDE_MAX_TOKENS` (default: 150000 - Claude has larger context)
  - `CLAUDE_MEM_CLAUDE_ROLLOVER_ENABLED` (default: true)

### Phase 5: Implement Rollover Logic

**Goal**: When input tokens exceed threshold, restart SDK subprocess with fresh session.

**Critical**: Rollover requires actually restarting the Claude SDK subprocess, not just clearing a flag. The `resume` parameter is only checked when starting a new process.

**Rollover wiring**: Use existing `pendingRestart` + `tryRestartGeneratorAsync` flow in `SessionManager.ts` (safe idle/in-flight gating).

- [ ] 5.1 **Pre-check at generator start**: Before starting generator, check if `last_input_tokens` is already over threshold → start without resume immediately
- [ ] 5.2 Before SDK call, check `lastInputTokens` against threshold
- [ ] 5.3 If threshold exceeded:
  - Log rollover event (old session_id, token count, reason)
  - Set `pendingRestart` flag on session
  - Clear `claude_resume_session_id` in DB
  - Call `tryRestartGeneratorAsync` to safely restart (respects idle/in-flight gating)
- [ ] 5.4 After fresh session response:
  - Capture new SDK session_id
  - Store in `claude_resume_session_id`
  - Continue with same `memory_session_id`
- [ ] 5.5 **Re-inject continuation prompt**: On rollover, the new session gets a fresh init/continuation prompt (this happens naturally when restarting the generator)
- [ ] 5.6 Test: Rollover triggers at threshold
- [ ] 5.7 Test: Observations continue storing after rollover
- [ ] 5.8 Test: SDK subprocess is actually restarted (not just flag cleared)

### Phase 6: Logging and Debugging

- [ ] 6.1 Log when rollover is triggered:
  - Previous session_id
  - New session_id
  - Token count that triggered rollover
  - Threshold value
- [ ] 6.2 Log session state on each request (debug level):
  - Current `memory_session_id`
  - Current `claude_resume_session_id`
  - `lastInputTokens`
- [ ] 6.3 Log when token count is persisted to DB

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
