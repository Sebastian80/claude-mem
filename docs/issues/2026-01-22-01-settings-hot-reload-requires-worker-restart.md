# Settings Changes Do Not Apply Until Worker Restart

- Issue ID: 2026-01-22-01
- Date: 2026-01-22
- Status: Open
- Area: Worker runtime config (provider/model), session generator lifecycle

## Summary
Changing `~/.claude-mem/settings.json` (for example `CLAUDE_MEM_MODEL` or `CLAUDE_MEM_PROVIDER`) does not reliably affect a currently-running observation processor. In practice, the new setting only takes effect after the worker (service-worker) is restarted.

## Expected Behavior
- Edit `~/.claude-mem/settings.json`.
- The next observation uses the new model/provider.

## Actual Behavior
- Existing processing continues using the old model/provider.
- The new setting only takes effect after killing/restarting the worker.

## Impact
- Confusing UX: users think settings are live, but behavior is “sticky”.
- Cost risk: the old model may continue to be used after a change.
- Provider switching (Claude ↔ Gemini/OpenAI) is unreliable during an active session.

## Root Cause (Why This Happens)
### 1) The worker starts a long-lived per-session generator and keeps it alive
Once a session starts processing, the worker creates an agent loop that waits for queued observations and processes them.

That loop does not exit when idle; it blocks waiting for new queue events until it is aborted or crashes.

Evidence:
- The queue iterator waits for wake-up events forever: `src/services/queue/SessionQueueProcessor.ts:18`.

### 2) Provider/model are effectively chosen “at generator start”, not per message
- Provider switching logic detects changes but does not force a restart of the running generator.
- For Claude, the model is read at the start of `SDKAgent.startSession()` and passed into the SDK query options once.

Evidence:
- Provider change is only logged (no forced switch): `src/services/worker/http/routes/SessionRoutes.ts:90`.
- Model is read once when starting the Claude SDK agent: `src/services/worker/SDKAgent.ts:41` and `src/services/worker/SDKAgent.ts:50`.
- Model is bound into the SDK query options: `src/services/worker/SDKAgent.ts:113`.

### 3) Extra footgun: worker host/port values are cached
`getWorkerPort()` / `getWorkerHost()` cache values. Cache clearing happens when settings are updated via the Settings HTTP API, not when the file is edited manually.

Evidence:
- Cache implementation: `src/shared/worker-utils.ts:8`.
- Cache clear on UI settings update: `src/services/worker/http/routes/SettingsRoutes.ts:140`.

This caching is separate from model/provider selection, but it further contributes to the “settings don’t apply” feeling.

## Related Symptom (Observed): Restarting The Worker Can Make “Queued” Observations Disappear
This matters directly for Option B (hot-reload by restarting the generator), because “restart the generator” is very similar to “restart the worker” from the queue’s perspective.

### Working Hypothesis (Not Yet Confirmed In Your Environment)
Even though observations are first written into SQLite, they may get removed from the SQLite queue *before* they are truly finished.

In that case, the “queue” you see in the UI can be a mix of:
- work still in SQLite (safe, recoverable after restart), and
- work already *claimed* and now only “in-flight” inside the running worker / provider process (not recoverable if the worker is killed).

Why we think this can happen (based on code):
- The queue implementation uses **claim-and-delete**: when the worker takes a message to process, it immediately deletes it from `pending_messages`. If the worker dies after that, SQLite no longer has a record to re-run. Evidence: `src/services/sqlite/PendingMessageStore.ts` (`claimAndDelete()` deletes immediately) and `src/services/queue/SessionQueueProcessor.ts` (iterator calls `claimAndDelete()` in a loop).
- For the **Claude SDK provider**, the SDK reads from the prompt generator and writes to the Claude CLI stdin in a way that can “prefetch” many messages quickly:
  - The Agent SDK calls `queryInstance.streamInput(prompt)` without awaiting it (input pumping happens concurrently). Evidence: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (`query()`).
  - The SDK’s transport `write()` does not apply backpressure (it ignores “buffer full” and does not await drain). Evidence: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` (`ProcessTransport.write()`).
  - Net effect: the SDK may rapidly pull many queued observations from the generator, which causes `claimAndDelete()` to delete many rows from SQLite early. If the worker is killed, those “in-flight” items are lost, so after restart the UI shows no queue and no further processing happens.

Important nuance:
- For the **Gemini provider**, the agent loop awaits each API call before pulling the next queued item, so it *tends* to claim items one-by-one. Killing the worker mid-call should (in theory) lose at most the currently-claimed item, while the remaining queued items stay in SQLite and should be recoverable on restart.

### How To Confirm (Quick Tests You Can Run Later)
The goal is to answer: “Are my queued observations still in SQLite, or are they being drained into memory/in-flight?”

1) Build a backlog (e.g., generate ~20 observations quickly so you can see a queue bubble in the UI).
2) While processing is happening, check the DB queue size in another terminal:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "select count(*) as cnt from pending_messages where status in ('pending','processing');"
sqlite3 ~/.claude-mem/claude-mem.db "select id, session_db_id, status, message_type, created_at_epoch from pending_messages order by id desc limit 30;"
```
3) Watch worker logs for a burst of `QUEUE CLAIMED` lines (that would indicate fast draining/claiming).
4) Kill the worker while it is still “processing” and immediately re-check the DB counts.
5) Restart the worker and observe:
   - If `pending_messages` is near 0 and processing does not resume, it strongly suggests the queue was drained (claimed/deleted) into in-flight memory before completion.
   - If `pending_messages` is still >0 and processing resumes, it suggests the queue remains durable and restart-safe (or at least partially).
6) Repeat the same test with `CLAUDE_MEM_PROVIDER=gemini` vs `claude` to see if behavior differs.

## Reproduction
1. Start the worker.
2. Trigger at least one tool so a generator starts for the session.
3. Edit `~/.claude-mem/settings.json` and change `CLAUDE_MEM_MODEL` or `CLAUDE_MEM_PROVIDER`.
4. Trigger another tool.
5. Observe: behavior still uses the old model/provider.
6. Restart the worker.
7. Trigger another tool.
8. Observe: now the new model/provider is used.

## Proposed Fix Options
### Option A (Low Risk): Document + provide a one-click restart
- Update docs/UI copy to clarify which settings are “live” and which require a worker/generator restart.
- Provide an explicit “Restart worker” button/action.

### Option B (Recommended): Safe hot-reload by restarting generators when settings change
Key idea: detect settings changes and restart the session generator only when safe.

- Detect changes (file watcher or periodic mtime/hash check).
- If provider/model changed and the generator is idle (no in-flight request, queue empty):
  - abort the generator
  - start a new generator with the updated settings

Notes:
- **Today, the queue is “claim-and-delete”.** That makes restarts risky:
  - If work is already claimed/deleted and only in-flight, killing/restarting can make queued items disappear.
  - For Claude SDK, the SDK can prefetch/drain the generator quickly, which increases the “in-flight but not durable” window.
- For Option B to be truly safe, we likely need at least one of these design changes:
  1) **ACK-based queue (durable processing state):** claim → mark `processing` (do not delete) → on success mark `processed` (or delete) → on crash/restart, move old `processing` items back to `pending`.
  2) **Backpressure / no prefetch:** ensure only one observation is claimed when the provider is truly ready to process it (especially for Claude SDK). Practical approaches include “push” input (send next message only after a result) or enforcing a strict in-flight limit.
  3) **Restart only at hard safe boundaries:** after an observation is fully processed and persisted, and after confirming there is no provider-side buffered input that was already sent.

### Option C: Apply config per observation
For non-Claude providers, re-read settings per request and keep the generator generic.

For Claude, model selection is currently bound when the SDK query starts, so “true immediate” model changes still require restarting the SDK query loop.

## Suggested Acceptance Criteria
- Changing `CLAUDE_MEM_PROVIDER` applies to the next observation without requiring a worker restart.
- Changing `CLAUDE_MEM_MODEL` applies to the next observation (or after a short, documented delay).
- Manual file edits and UI edits behave consistently.

## Related
- See `docs/issues/2026-01-22-03-runaway-context-tokens-claude-resume-gemini-history.md` for why long-running generators also contribute to runaway context size.
