# Sebastian80 Fork of Claude-Mem

A stability-focused fork of [JillVernus/claude-mem](https://github.com/JillVernus/claude-mem) (itself a fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)), a persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

**Current Version**: `9.1.1-ser.5` (based on upstream v9.1.1)

---

## What is Claude-Mem?

Claude-mem gives Claude Code persistent memory across sessions. It runs as a background worker that observes your Claude Code sessions via lifecycle hooks, compresses observations using an AI provider (Claude, Gemini, or any OpenAI-compatible API), and stores them in a local SQLite database with optional Chroma vector embeddings. At the start of each new session, relevant context from past work is automatically injected so Claude picks up where you left off.

**How it works:**

1. **Hooks** capture tool usage and conversation events during your Claude Code session
2. **Worker** (Express API on localhost:37777) processes events asynchronously using your chosen AI provider
3. **Storage** persists compressed observations in SQLite (`~/.claude-mem/claude-mem.db`), with optional Chroma vector search
4. **Context injection** retrieves relevant past observations at session start via the SessionStart hook
5. **MCP tools** let Claude search your memory database mid-session (`search`, `timeline`, `get_observations`, `save_memory`)

For full upstream documentation: **[docs.claude-mem.ai](https://docs.claude-mem.ai)** | **[upstream repo](https://github.com/thedotmack/claude-mem)**

---

## Why This Fork?

Upstream claude-mem has reliability issues in production: message loss during worker restarts, unbounded context growth crashing sessions, instant API retry floods causing rate limiting, hardcoded paths breaking non-default installations, and invisible MCP tool parameters.

[JillVernus](https://github.com/JillVernus/claude-mem) built a comprehensive set of fixes for all of the above, plus usability features like custom API endpoints, dynamic model selection, and settings hot-reload. Some of these issues have since been fixed independently upstream.

This fork builds on JillVernus's work and adds cherry-picked upstream fixes that JillVernus hadn't merged yet. See [All Fork Patches](#all-fork-patches) below for the full list.

---

## Fork History

This is a fork of [JillVernus/claude-mem](https://github.com/JillVernus/claude-mem), which is itself a fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem). All the stability and usability patches (versions `9.0.8-jv.1` through `9.1.1-jv.2`) were developed by JillVernus. JillVernus's fork continues independently.

### What Sebastian80 adds

- **[ser.5] Process cleanup and security fixes** — Linux process cleanup now works (`getChildProcesses` via `pgrep -P`), recursive descendant enumeration kills grandchildren leaf-first during shutdown, hardened `ChromaSync.close()` prevents subprocess leaks on error, `bun-runner.js` buffers stdin to prevent Bun `fstat EINVAL` crash, parameterized all SQL in ChromaSync backfill to prevent injection via Chroma metadata IDs, and worker now exits on background init failure instead of staying half-alive.
- **[ser.4] Orphaned message fallback** — Re-applied upstream PR #937 (lost in JillVernus's v9.1.1 reconciliation merge). When a Claude session is terminated, orphaned queue items now cascade through Gemini → OpenAI → mark abandoned instead of aging through 329s timeout. Adapted OpenRouterAgent → OpenAIAgent for fork architecture.
- **[ser.3] ChromaSync duplicate subprocess prevention** — Fixed race condition where concurrent sessions each spawned their own chroma-mcp subprocess via `ensureConnection()`. Added connection promise cache (async singleton pattern). Upstream PRs #993 and #1065 address the same bug but remain unmerged.
- **[ser.2] Re-applied project backfill fix** lost in JillVernus's v9.0.17 merge: sessions created by SAVE hook (empty project) now get their project field populated when UserPromptSubmit fires. Without this, sessions accumulate with empty project names in the database.
- **[ser.1] Cherry-picked upstream fixes** that JillVernus hadn't picked up yet: `save_memory` MCP tool endpoint, `sessions/complete` API route, and `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` config flag in ResponseProcessor
- **[ser.1] Marketplace path update**: Updated hardcoded marketplace paths from `jillvernus` to `sebastian80` across source files and sync scripts (required for the fork to work under its own marketplace name)
- **[ser.1] Sync script self-detection**: Enhanced `sync-marketplace.cjs` to skip self-copy when dev repo is the marketplace directory

---

## All Fork Patches

### Reliability Fixes

| Patch | Problem | Fix |
|-------|---------|-----|
| **Safe Message Processing** | Observations lost during worker restarts | Claim→process→delete pattern: messages stay in DB until observations are stored in an atomic transaction |
| **Claude Session Rollover** | Claude sessions grow until context limit crash | Decouple DB identity from SDK session; restart SDK session at 150k tokens while preserving observation continuity |
| **Context Truncation** | Gemini/OpenAI context grows unbounded (duplicate appends, no truncation) | Shared truncation utility with pinned message support, API-reported token tracking, retry-on-overflow |
| **Exponential Backoff Retry** | API errors cause instant retry floods → rate limiting | Backoff delays (3s→5s→10s→30s→60s cap) with abort-aware sleep and structured error detection |
| **Stuck Message Recovery** | Sessions orphaned with unprocessed messages after crashes | Terminal error detection, session cache refresh, periodic orphan recovery with configurable interval |
| **Pending Queue Recovery Guard** | Stale `pendingRestart` flag starves message queue after recovery | Clear stale flag during recovery/manual starts before generator boot |
| **Orphaned Message Fallback** | Terminated sessions leave orphaned queue items aging through 329s timeout cascade | Session termination detection + Gemini → OpenAI → abandon fallback chain (upstream PR #937, lost in v9.1.1 merge) |
| **Linux Process Cleanup** | `getChildProcesses()` returned `[]` on Linux — chroma-mcp subprocesses never cleaned up | `pgrep -P` implementation + recursive descendant enumeration for grandchild processes |
| **Hardened ChromaSync Close** | `close()` had no error handling — `client.close()` failure skipped `transport.close()`, leaking subprocesses | Individual try-catch per close step with state reset in `finally` block |
| **Worker Init Failure Recovery** | Background init failure left worker half-alive (port open, services dead) | `process.exit(1)` on init failure for clean restart |
| **ChromaSync SQL Parameterization** | Backfill SQL built via string interpolation of Chroma metadata IDs — SQL injection if Chroma returns non-integer values | Parameterized placeholders + `Number()` coercion with `isFinite()` validation |
| **Bun-Runner Stdin Buffer** | `stdio: 'inherit'` passes pipe fds to Bun subprocess, causing `fstat EINVAL` crash on Linux when hooks receive piped stdin | Buffer stdin before spawn, pass via pipe or ignore |
| **Dynamic Path Resolution** | Hardcoded `thedotmack` paths crash on any other installation | Dynamic path resolution via `getPackageRoot()` across all file references |

### Fixed Independently Upstream

These issues were also fixed upstream, so the fork patches are no longer needed:

| Patch | Upstream Fix |
|-------|-------------|
| ~~Zombie Process Cleanup~~ | v9.0.8 — `ProcessRegistry` with PID tracking |
| ~~Gemini/OpenAI memorySessionId~~ | v9.1.1 — synthetic IDs for stateless providers |
| ~~Folder CLAUDE.md Optimization~~ | v9.1.1 — `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` + exclusion controls |

### Usability Improvements

| Patch | Description |
|-------|-------------|
| **MCP Schema Enhancement** | Explicit property definitions so Claude can see tool parameters |
| **MCP Empty Search** | Empty queries return recent results instead of errors |
| **Custom API Endpoints** | Configurable base URLs for Gemini and OpenAI-compatible providers (proxies, local LLMs, regional gateways) |
| **Dynamic Model Selection** | Fetch available models from your API endpoint; UI dropdown |
| **Settings Hot-Reload** | Change provider/model settings without restarting the worker |
| **OpenAI-Compatible Provider** | Renamed "OpenRouter" to "OpenAI Compatible" — works with any OpenAI-compatible API |

### On Hold

| Patch | Description |
|-------|-------------|
| **Observation Batching** | Batch multiple observations into single API calls for cost reduction |
| **Autonomous Execution Prevention** | Detect and skip compaction/warmup prompts that might trigger unintended behavior |

---

## Installation

```
> /plugin marketplace add sebastian80/claude-mem

> /plugin install claude-mem
```

---

## Version Format

Fork versions follow the format `{upstream}-ser.{patch}`:
- `9.1.1-ser.2` = Based on upstream v9.1.1, fork patch version 2 (project backfill fix)
- `9.1.1-ser.1` = Based on upstream v9.1.1, fork patch version 1 (initial fork)

---

## Acknowledgments

- [Alex Newman (@thedotmack)](https://github.com/thedotmack) for creating claude-mem
- [JillVernus](https://github.com/JillVernus/claude-mem) for developing the stability and usability patches this fork is based on

---

## License

Same as upstream: **GNU Affero General Public License v3.0** (AGPL-3.0)

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

---

## Support

- **Fork Issues**: [GitHub Issues](https://github.com/Sebastian80/claude-mem/issues)
- **Upstream Documentation**: [docs.claude-mem.ai](https://docs.claude-mem.ai)
- **Upstream Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
