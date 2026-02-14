# Sebastian80 Claude-Mem

An independently maintained fork of [claude-mem](https://github.com/thedotmack/claude-mem), a persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Originally forked via [JillVernus/claude-mem](https://github.com/JillVernus/claude-mem). Now maintained independently — see [Why Independent?](#why-independent) below.

---

## What is Claude-Mem?

Claude-mem gives Claude Code persistent memory across sessions. It runs as a background worker that observes your Claude Code sessions via lifecycle hooks, compresses observations using an AI provider (Claude, Gemini, or any OpenAI-compatible API), and stores them in a local SQLite database with optional Chroma vector embeddings. At the start of each new session, relevant context from past work is automatically injected so Claude picks up where you left off.

**How it works:**

1. **Hooks** capture tool usage and conversation events during your Claude Code session
2. **Worker** (Express API on localhost:37777) processes events asynchronously using your chosen AI provider
3. **Storage** persists compressed observations in SQLite (`~/.claude-mem/claude-mem.db`), with optional ChromaDB vector search via shared HTTP server
4. **Context injection** retrieves relevant past observations at session start via the SessionStart hook
5. **MCP tools** let Claude search your memory database mid-session (`search`, `timeline`, `get_observations`, `save_memory`)

---

## Why Independent?

This fork went independent from upstream (thedotmack/claude-mem) and the JillVernus intermediary fork in February 2026. The reasons:

**Upstream direction divergence.** Upstream development shifted focus away from core reliability (PR triage via MAESTRO bot, Clawbot integration, $CMEM token promotion) while fundamental stability issues remained unaddressed. Critical PRs (ChromaSync subprocess leaks #993/#1065, persistent HTTP server #792) sat unmerged for months.

**Repeated merge casualties.** Each upstream merge into the JillVernus fork lost previously applied fixes. Project backfill (ser.2), orphaned message fallback (ser.4), and other patches had to be re-applied after reconciliation merges dropped them silently. This created an unsustainable maintenance burden.

**ChromaDB architectural gaps.** Upstream has no strategy for ChromaDB's unbounded memory growth (all HNSW indexes loaded into RAM, no TTL/pruning/eviction), orphaned collection accumulation from crash-unsafe `journal_mode=delete`, or WAL purge blockage (ChromaDB bug #2605). These are production reliability issues that require fork-level fixes.

**Quality signal.** Of 119 MAESTRO-triaged PRs in the JillVernus fork, the majority were documentation translations, formatting fixes, and bot-generated changes. The core stability work was built by JillVernus (stuck message recovery, context rollover, safe message processing) and extended by this fork (ChromaDB process lifecycle, subprocess leak prevention, SQL security hardening). Upstream cherry-picks were incorporated where JillVernus hadn't picked them up yet.

**Going forward**, this fork maintains its own release cadence, accepts upstream cherry-picks when they add clear value, and is free to make architectural changes (like the ChromaDB retention cap) without waiting for upstream consensus.

---

## Fork Lineage

| Layer | Repository | Role |
|-------|-----------|------|
| Original | [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | Created claude-mem, maintains upstream |
| Intermediary | [JillVernus/claude-mem](https://github.com/JillVernus/claude-mem) | Built stability patches (jv.1–jv.11), multi-provider support, settings hot-reload |
| This fork | [Sebastian80/claude-mem](https://github.com/Sebastian80/claude-mem) | Security fixes, process lifecycle hardening, ChromaDB reliability, independent maintenance |

---

## All Patches

### JillVernus Reliability Fixes (inherited)

These fixes were developed by [JillVernus](https://github.com/JillVernus/claude-mem) and are included in this fork:

| Patch | Problem | Fix |
|-------|---------|-----|
| **Safe Message Processing** | Observations lost during worker restarts | Claim→process→delete pattern: messages stay in DB until observations are stored in an atomic transaction |
| **Claude Session Rollover** | Claude sessions grow until context limit crash | Decouple DB identity from SDK session; restart SDK session at 150k tokens while preserving observation continuity |
| **Context Truncation** | Gemini/OpenAI context grows unbounded (duplicate appends, no truncation) | Shared truncation utility with pinned message support, API-reported token tracking, retry-on-overflow |
| **Exponential Backoff Retry** | API errors cause instant retry floods → rate limiting | Backoff delays (3s→5s→10s→30s→60s cap) with abort-aware sleep and structured error detection |
| **Stuck Message Recovery** | Sessions orphaned with unprocessed messages after crashes | Terminal error detection, session cache refresh, periodic orphan recovery with configurable interval |
| **Pending Queue Recovery Guard** | Stale `pendingRestart` flag starves message queue after recovery | Clear stale flag during recovery/manual starts before generator boot |

### JillVernus Usability Improvements (inherited)

| Patch | Description |
|-------|-------------|
| **MCP Schema Enhancement** | Explicit property definitions so Claude can see tool parameters |
| **MCP Empty Search** | Empty queries return recent results instead of errors |
| **Custom API Endpoints** | Configurable base URLs for Gemini and OpenAI-compatible providers (proxies, local LLMs, regional gateways) |
| **Dynamic Model Selection** | Fetch available models from your API endpoint; UI dropdown |
| **Settings Hot-Reload** | Change provider/model settings without restarting the worker |
| **OpenAI-Compatible Provider** | Renamed "OpenRouter" to "OpenAI Compatible" — works with any OpenAI-compatible API |

### Sebastian80 Reliability Fixes

| Patch | Problem | Fix |
|-------|---------|-----|
| **ChromaSync Duplicate Subprocess** | Concurrent `ensureConnection()` calls each spawn their own chroma-mcp subprocess | Connection promise cache (async singleton) ensures concurrent callers share a single connection |
| **Linux Process Cleanup** | `getChildProcesses()` returned `[]` on Linux — chroma-mcp subprocesses never cleaned up | `pgrep -P` implementation + recursive descendant enumeration for grandchild processes |
| **Hardened ChromaSync Close** | `close()` had no error handling — `client.close()` failure skipped `transport.close()`, leaking subprocesses | Individual try-catch per close step with state reset in `finally` block |
| **Worker Init Failure Recovery** | Background init failure left worker half-alive (port open, services dead) | `process.exit(1)` on init failure for clean restart |
| **Graceful Process Termination** | `forceKillProcess()` sends SIGKILL immediately — risks chroma-mcp SQLite corruption (journal_mode=delete) | `gracefulKillProcess()`: SIGTERM → poll for exit → SIGKILL fallback |
| **Orphaned Collection Cleanup** | Killed chroma-mcp may create orphaned collections that block WAL purge (ChromaDB bug #2605) | Reconciliation loop in `ensureCollection()` deletes non-`cm__*` collections on every connect |
| **Embedding Retention Cap** | ChromaDB loads all HNSW indexes into RAM with no eviction — unbounded memory growth | `CLAUDE_MEM_CHROMA_MAX_ITEMS` setting (default 50K) prunes oldest embeddings; SQLite data and FTS5 search unaffected |
| **Shared HTTP Vector Store** | Per-session MCP subprocesses each consume ~550MB — N sessions = N×550MB | Shared ChromaDB HTTP server with client-side embedding via VectorStore abstraction — O(1) memory regardless of session count |

### Re-applied Patches (lost in upstream merges)

These fixes existed upstream but were accidentally dropped during JillVernus merge reconciliation:

| Patch | Original Source | Lost In |
|-------|----------------|---------|
| **Orphaned Message Fallback** | Upstream PR #937 | JillVernus v9.1.1 merge |
| **Project Backfill** | Upstream af308ea | JillVernus v9.0.17 merge |

### Upstream Cherry-Picks

Features cherry-picked from upstream that JillVernus hadn't incorporated:

| Patch | Description |
|-------|-------------|
| **`save_memory` MCP Tool** | Manual memory saving endpoint |
| **`sessions/complete` Route** | Session completion API |
| **`FOLDER_CLAUDEMD_ENABLED`** | Config flag in ResponseProcessor |

### Fixed Independently Upstream

These issues were also fixed upstream, so the fork patches are no longer the only source:

| Patch | Upstream Fix |
|-------|-------------|
| ~~Zombie Process Cleanup~~ | v9.0.8 — `ProcessRegistry` with PID tracking |
| ~~Gemini/OpenAI memorySessionId~~ | v9.1.1 — synthetic IDs for stateless providers |
| ~~Folder CLAUDE.md Optimization~~ | v9.1.1 — `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` + exclusion controls |

### Fork Maintenance

| Patch | Description |
|-------|-------------|
| **SQL Parameterization** | Backfill exclusion queries use parameterized placeholders + `Number()` coercion with `isFinite()` validation |
| **Bun-Runner Stdin Buffer** | Buffer stdin before spawning Bun subprocess to avoid `fstat EINVAL` on inherited pipe fds |
| **Dynamic Path Resolution** | `getPackageRoot()` replaces hardcoded upstream paths across source and sync scripts |

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

Independent semver starting from v0.1.0. Previous versions followed `{upstream}-ser.{patch}` format (e.g., `9.1.1-ser.5`).

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
