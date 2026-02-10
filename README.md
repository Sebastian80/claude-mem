# Sebastian80 Fork of Claude-Mem

A stability-focused fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem), a persistent memory system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

**Current Version**: `9.1.1-ser.1` (based on upstream v9.1.1)

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

Upstream claude-mem is a great idea with rough edges in production. After running it daily, we hit enough reliability issues to warrant maintaining patches:

- **Messages silently lost** during worker restarts — observations vanish because the queue doesn't survive crashes
- **Unbounded context growth** causes sessions to blow up — no truncation for Gemini/OpenAI, and Claude sessions grow until the model hits its limit
- **API errors trigger rapid-fire retries** — instant retry loops get you rate-limited or blocked by providers
- **Hardcoded paths crash non-default installations** — upstream assumes `thedotmack` marketplace paths
- **MCP tool parameters invisible to Claude** — empty schema definitions mean Claude can't see what parameters are available
- **No way to use custom API endpoints** — can't point at proxies, local LLMs, or regional gateways

This fork carries all the reliability and usability patches originally developed by [JillVernus](https://github.com/JillVernus/claude-mem), plus cherry-picked upstream fixes that hadn't been merged yet. Several JillVernus fixes have been contributed back upstream. All patches are maintained as discrete changes to allow clean merging of upstream releases.

---

## Fork History

This is a fork of [JillVernus/claude-mem](https://github.com/JillVernus/claude-mem), which is itself a fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem). All the stability and usability patches (versions `9.0.8-jv.1` through `9.1.1-jv.2`) were developed by JillVernus. JillVernus's fork continues independently.

### What Sebastian80 adds (ser.1)

- **Cherry-picked upstream fixes** that JillVernus hadn't picked up yet: `save_memory` MCP tool endpoint, `sessions/complete` API route, and `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` config flag in ResponseProcessor
- **Marketplace path fixes**: Updated hardcoded `jillvernus` marketplace paths to `sebastian80` across source files and sync scripts
- **Sync script self-detection**: Enhanced `sync-marketplace.cjs` to skip self-copy when dev repo is the marketplace directory

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
| **Dynamic Path Resolution** | Hardcoded `thedotmack` paths crash on any other installation | Dynamic path resolution via `getPackageRoot()` across all file references |

### Upstreamed Fixes (no longer fork-only)

| Patch | Upstreamed In |
|-------|---------------|
| ~~Zombie Process Cleanup~~ | v9.0.8 — upstream `ProcessRegistry` with PID tracking |
| ~~Gemini/OpenAI memorySessionId~~ | v9.1.1 — upstream generates synthetic IDs for stateless providers |
| ~~Folder CLAUDE.md Optimization~~ | v9.1.1 — upstream `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` + exclusion controls |

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

## OpenAI-Compatible Provider

The "OpenRouter" provider has been renamed to "OpenAI Compatible" to better reflect its capabilities. This provider supports any OpenAI-compatible API endpoint, including:

- **OpenRouter** (default) - Access to many models
- **Local LLMs** - Ollama, LM Studio, vLLM, etc.
- **Custom endpoints** - Any OpenAI-compatible API

### Settings Migration

Settings are automatically migrated on first run. The following keys have been renamed:

| Old Key | New Key |
|---------|---------|
| `CLAUDE_MEM_OPENROUTER_API_KEY` | `CLAUDE_MEM_OPENAI_API_KEY` |
| `CLAUDE_MEM_OPENROUTER_MODEL` | `CLAUDE_MEM_OPENAI_MODEL` |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` | `CLAUDE_MEM_OPENAI_BASE_URL` |
| `CLAUDE_MEM_PROVIDER=openrouter` | `CLAUDE_MEM_PROVIDER=openai` |

---

## Custom API Endpoints

Configure custom base URLs in `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_GEMINI_BASE_URL": "https://my-proxy.com/v1beta/models",
  "CLAUDE_MEM_OPENAI_BASE_URL": "https://my-gateway.com/v1/chat/completions"
}
```

Or via environment variables:
```bash
export GEMINI_BASE_URL="https://my-proxy.com/v1beta/models"
export OPENAI_BASE_URL="https://my-gateway.com/v1/chat/completions"
```

---

## Installation

```
> /plugin marketplace add sebastian80/claude-mem

> /plugin install claude-mem
```

---

## Version Format

Fork versions follow the format `{upstream}-ser.{patch}`:
- `9.1.1-ser.1` = Based on upstream v9.1.1, fork patch version 1

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
