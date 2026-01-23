# Runaway Context Size (Tokens) During Observation Processing

- Issue ID: 2026-01-22-03
- Date: 2026-01-22
- Status: Open
- Area: Observation processing (Claude SDK + Gemini multi-turn)

## Summary
While processing observations, the input context keeps growing over time. Eventually:
- Claude provider hits the model’s context limit and processing stops.
- Gemini provider becomes very slow and may time out due to huge request payloads.

## Expected Behavior
Context size should remain bounded (truncate/compact) so long-running sessions do not break.

## Actual Behavior
Context grows continuously until failure (Claude) or severe slowdown/timeouts (Gemini).

## Root Cause (Claude Provider)
The Claude provider uses the Agent SDK with `resume`, so it continues one long-lived model session. This naturally grows the session context.

Evidence:
- `resume` is passed to the SDK query options: `src/services/worker/SDKAgent.ts:120`.

Notes:
- Caching may reduce cost sometimes, but it does not prevent the model from eventually exceeding its max context window.

## Root Cause (Gemini Provider)
The Gemini provider simulates a multi-turn session by sending the full `conversationHistory` on every request.

Evidence:
- The entire history is converted and sent each call: `src/services/worker/GeminiAgent.ts:355` and `src/services/worker/GeminiAgent.ts:370`.

## Contributing Factor: Conversation history may be duplicated (Gemini/OpenAI)
`processAgentResponse()` appends assistant text into `session.conversationHistory`.

Evidence:
- ResponseProcessor pushes assistant response into history: `src/services/worker/agents/ResponseProcessor.ts:58`.

But GeminiAgent and OpenAIAgent also push assistant responses themselves before calling `processAgentResponse()`. This can cause the same assistant message to be appended twice, making history grow faster than necessary.

Evidence:
- GeminiAgent pushes assistant response before processing: `src/services/worker/GeminiAgent.ts:167`.
- OpenAIAgent does the same pattern (init path shown): `src/services/worker/OpenAIAgent.ts:98`.

## Comparison: OpenAI-Compatible Agent Has Truncation, Gemini Does Not
The OpenAI-compatible provider includes a sliding window truncation (by message count and estimated tokens).

Evidence:
- Truncation logic: `src/services/worker/OpenAIAgent.ts:283`.

Gemini currently lacks equivalent truncation.

## Proposed Solutions
### 1) Add truncation to Gemini (high impact, moderate effort)
- Apply the same strategy as the OpenAI-compatible agent: keep last N messages and/or stay under a token budget.
- This prevents huge request payloads and reduces timeout risk.

### 2) Reduce history growth rate (fix duplication)
- Ensure assistant responses are appended exactly once (either by agents or by ResponseProcessor, not both).

### 3) Stop treating observation extraction as an unbounded chat
Observation extraction usually only needs:
- stable instructions
- the current tool observation
- optionally, a small “state summary”

This can bound input size and cost.

### 4) Implement Claude session rollover (compaction / restart strategy)
- When input tokens approach a threshold, create a compact state summary and start a fresh Claude session.
- This avoids hard failure at max context.

Note: for Claude, rollover is constrained by how `memory_session_id` is used in the DB (see next issue).

### 5) Use batching as a cost/time mitigation (does not solve context growth by itself)
Batching reduces the number of AI calls, which slows the rate of growth and reduces overhead.

Evidence:
- Batching feature flags exist: `CLAUDE_MEM_BATCHING_ENABLED`, `CLAUDE_MEM_BATCH_MAX_SIZE` in `src/shared/SettingsDefaultsManager.ts`.

## Workarounds
- Restart worker periodically (manual).
- Switch provider to one with truncation (OpenAI-compatible path), if acceptable.
- Reduce tool output size where possible.

## Related
- `docs/issues/2026-01-22-04-decouple-db-session-id-from-provider-session.md` (why “restart session” is difficult for Claude)
- `docs/issues/2026-01-22-01-settings-hot-reload-requires-worker-restart.md`
