# Session Rollover Is Hard Because DB Session ID Is Coupled To Provider Session ID

- Issue ID: 2026-01-22-04
- Date: 2026-01-22
- Status: Open
- Area: Database schema + session identity model

## Summary
A practical fix for runaway context is to periodically start a fresh AI session (no `resume`).

However, claude-mem currently couples:
- the DB “session identity” used for storing observations, and
- the provider “resume/session id” (Claude SDK session_id)

This coupling makes it difficult to restart a Claude session without breaking observation storage.

This matches the reported constraint:
- “Restarting without `--resume` fails because the DB expects the same `memory_session_id`.”

## Current Design (What The Code Assumes)
- Observations and summaries are stored under `sdk_sessions.memory_session_id`.
- `observations.memory_session_id` is a foreign key referencing `sdk_sessions.memory_session_id`.
- Response storage requires `session.memorySessionId` to be present.

Evidence:
- DB schema uses `memory_session_id` as the FK target: `src/services/sqlite/SessionStore.ts:77` and `src/services/sqlite/SessionStore.ts:96`.
- Storage requires a non-null memorySessionId: `src/services/worker/agents/ResponseProcessor.ts:73`.

## Provider-Specific Details
### Claude provider
- `memorySessionId` is captured from the Claude Agent SDK’s `message.session_id`.
- That same `memorySessionId` is used as the `resume` id.

Evidence:
- Capture from SDK response: `src/services/worker/SDKAgent.ts:131`.
- Resume uses `memorySessionId`: `src/services/worker/SDKAgent.ts:120`.

Result: starting a fresh Claude session would yield a new SDK session id, but the DB link expects the existing `memory_session_id`.

### Gemini / OpenAI-compatible providers
- They generate a random UUID `memorySessionId` and store it in the DB.
- They do not have a provider-side resume session id; continuity is simulated by `conversationHistory`.

Evidence:
- Gemini memorySessionId generation: `src/services/worker/GeminiAgent.ts:146`.
- OpenAI memorySessionId generation: `src/services/worker/OpenAIAgent.ts:96`.

Result: these providers can “restart” their effective context by trimming/clearing history while keeping the same DB `memorySessionId`.

## Why This Blocks a Clean Fix
A robust “rollover” design wants two different identifiers:
1) Stable DB session id (for storage and FK integrity)
2) Provider session id (for resume/continuation behavior)

claude-mem currently uses one field (`memory_session_id`) for both (at least for Claude).

## Proposed Solutions
### Option A (Recommended): Decouple DB session identity from provider session identity
Goal: allow provider sessions to restart without breaking DB relationships.

Design ideas:
- Keep a stable “storage session id” (could be `sdk_sessions.id` or a generated stable UUID).
- Store provider resume ids separately (example columns):
  - `claude_resume_session_id`
  - `last_provider`
  - `provider_session_state` (optional)

The observation tables would foreign-key to the stable storage id, not to the provider session id.

Pros:
- Enables safe session rollover for Claude.
- Makes provider switching cleaner.

Cons:
- Requires DB migration + refactor of storage queries.

### Option B: Keep `memory_session_id` stable for DB and store Claude resume id elsewhere
- On session start, generate a stable `memory_session_id` for DB.
- Separately store Claude SDK session ids for resume.

Pros:
- Smaller DB changes than Option A.

Cons:
- Still requires schema change and careful migration.

### Option C: Avoid provider resume entirely (stateless extraction)
- Don’t use Claude `resume`.
- For each observation extraction, send:
  - stable instructions
  - current tool observation
  - optionally, a small “rolling state summary”

Pros:
- Guaranteed bounded context.

Cons:
- Behavior may change (less continuity unless the state summary is good).

## Acceptance Criteria
- It is possible to start a new Claude session (no resume) while continuing to store observations into the same logical DB session.
- Long-running sessions no longer fail due to context window overflow.

## Related
- Root symptom described in: `docs/issues/2026-01-22-03-runaway-context-tokens-claude-resume-gemini-history.md`
