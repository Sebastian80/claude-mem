# Gemini Provider Uses Direct REST Calls (Not a Gemini SDK)

- Issue ID: 2026-01-22-02
- Date: 2026-01-22
- Status: Informational (documented behavior; verify expectations)
- Area: Gemini provider integration

## Summary
When `CLAUDE_MEM_PROVIDER` is set to `gemini`, claude-mem uses a custom implementation (`GeminiAgent`) that calls the Gemini API via direct HTTP requests (`fetch`). It does not use an official Gemini SDK.

## What The Code Does
- Builds a multi-turn request payload from `session.conversationHistory`.
- Calls Gemini’s `generateContent` endpoint.
- Parses the response text and stores observations/summaries.

Evidence:
- REST request implementation: `src/services/worker/GeminiAgent.ts:349`.

## Endpoint / Request Shape
- Default base URL: `https://generativelanguage.googleapis.com/v1beta/models`.
- Final request URL is constructed as:
  - `{baseUrl}/{model}:generateContent?key={apiKey}`

Evidence:
- Default base URL constant: `src/services/worker/GeminiAgent.ts:31`.
- URL builder usage: `src/services/worker/GeminiAgent.ts:363`.

## How “Session” / Continuity Works With Gemini
Gemini API calls here are effectively stateless. claude-mem simulates a session by:
- appending each prompt/response to `session.conversationHistory`
- sending the entire history on every request

Evidence:
- Full history conversion and send: `src/services/worker/GeminiAgent.ts:355` and `src/services/worker/GeminiAgent.ts:370`.

## Rate Limiting Behavior
claude-mem enforces request-per-minute limits for Gemini (for free-tier safety) unless disabled.

Evidence:
- Rate limiter implementation: `src/services/worker/GeminiAgent.ts:67`.
- Setting toggle: `CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED`.

## Proposed Improvements (Optional)
These are not required for correctness but help reliability and performance:
- Add request timeout + retry/backoff behavior (currently, a slow request can hang until upstream/network gives up).
- Add a context truncation strategy (similar to OpenAI agent) to prevent runaway prompt size.
- Consider supporting an official Gemini SDK (if desired), but it is not necessary for basic functionality.

## Related
- The “runaway token/context growth” issue affects Gemini heavily because the entire conversation history is resent every call:
  - `docs/issues/2026-01-22-03-runaway-context-tokens-claude-resume-gemini-history.md`
