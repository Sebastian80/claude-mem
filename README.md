# JillVernus Fork of Claude-Mem

This is a fork of [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) - a persistent memory compression system for Claude Code.

For full documentation, features, and installation instructions, please visit the **[upstream repository](https://github.com/thedotmack/claude-mem)**.

---

## Why This Fork?

This fork addresses specific stability and usability issues encountered in our environment. All patches are maintained separately to allow easy merging of upstream updates.

**Current Version**: `9.1.1-jv.1` (based on upstream v9.1.1)

## Fork Patches

### Critical Stability Fixes

| Patch | Description |
|-------|-------------|
| **Safe Message Processing** | Claim→process→delete pattern prevents message loss during worker restarts or session rollover. Messages remain in database until observations are successfully stored. |
| **Claude Session Rollover** | Restart SDK sessions when context grows too large (default: 150k tokens). Decouples DB identity from provider session to prevent orphaned observations. |
| **Context Truncation** | Prevents runaway context growth for Gemini/OpenAI providers. Removes duplicate history appends, adds shared truncation utility with pinned message support. |
| **Exponential Backoff Retry** | API errors use exponential backoff (3s→5s→10s→30s→60s cap) instead of instant retry, preventing rate-limit blocks. |
| **Stuck Message Recovery** | Terminal error handling, session cache refresh, provider selection fix, periodic orphan recovery. |
| **Pending Queue Recovery Guard** | Clears stale `pendingRestart` during recovery/manual starts so generators do not stop before claiming queued messages. |
| ~~**Zombie Process Cleanup**~~ | *(Upstreamed in v9.0.8)* SDK child processes were not properly terminated when sessions ended. Upstream now includes native `ProcessRegistry` for subprocess lifecycle management. |
| **Dynamic Path Resolution** | Replaced hardcoded marketplace paths with dynamic resolution to prevent crashes on different installations. |
| ~~**Gemini/OpenAI memorySessionId**~~ | *(Upstreamed in v9.1.1)* Upstream now generates synthetic IDs for stateless providers. Fork keeps OpenAI-compatible provider mapping and compatibility migration. |

### Upstream Features Adopted (v9.0.12-v9.1.1)

| Feature | Description |
|---------|-------------|
| **Observer Session Isolation** | Observer sessions use dedicated `cwd` to prevent polluting `claude --resume` list. |
| **Path Format Matching** | New `path-utils.ts` module for robust folder CLAUDE.md path matching (absolute vs relative). |
| **Empty CLAUDE.md Prevention** | Upstream now skips creating CLAUDE.md files when there's no activity (fork toggle still available). |
| **Zombie Observer Prevention** | Upstream added queue idle timeout so observer generators self-terminate after inactivity. |
| **In-Process Hook Worker** | Upstream hook architecture can host worker in-process to reduce spawn/startup fragility. |
| **Isolated Credentials** | Upstream reads credentials from `~/.claude-mem/.env` to avoid project env credential hijacking. |
| **Startup Health Check Fix** | Upstream switched startup checks to `/api/health` liveness endpoint. |
| **Bun Runner Detection** | Upstream added bun-runner fallback for fresh installs where Bun is not in PATH. |
| **Stateless memorySessionId Generation** | Upstream now generates synthetic memory IDs for Gemini/OpenRouter on startup. |
| **Folder CLAUDE.md Exclusions** | Upstream added project and folder exclusion settings for folder CLAUDE.md generation. |

### Usability Improvements

| Patch | Description |
|-------|-------------|
| **MCP Empty Search** | Empty search queries now return recent results instead of throwing errors. Useful for browsing recent activity. |
| **MCP Schema Enhancement** | Added explicit property definitions to MCP tool schemas so parameters are visible to Claude. |
| **Custom API Endpoints** | Configure custom base URLs for Gemini and OpenAI-compatible providers (proxies, self-hosted, regional endpoints). |
| **Dynamic Model Selection** | Fetch available models from your configured API endpoint. UI shows dropdown of available models. |
| **Settings Hot-Reload** | Change provider/model settings without restarting the worker. Settings apply automatically when the generator becomes idle. |
| ~~**Folder CLAUDE.md Optimization**~~ | *(Upstreamed in v9.1.1)* Upstream now ships `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` plus project/folder exclusion controls. |

### Optional Features (On Hold)

| Patch | Description |
|-------|-------------|
| **Observation Batching** | Batch multiple observations into single API calls for cost reduction. Disabled by default. |
| **Autonomous Execution Prevention** | Detect and skip compaction/warmup prompts that might trigger unintended behavior. |

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
> /plugin marketplace add jillvernus/claude-mem

> /plugin install claude-mem
```

---

## Version Format

Fork versions follow the format `{upstream}-jv.{patch}`:
- `9.1.1-jv.1` = Based on upstream v9.1.1, fork patch version 1

---

## Acknowledgments

Thanks to [Alex Newman (@thedotmack)](https://github.com/thedotmack) for creating claude-mem.

---

## License

Same as upstream: **GNU Affero General Public License v3.0** (AGPL-3.0)

Copyright (C) 2025 Alex Newman (@thedotmack). All rights reserved.

See the [LICENSE](LICENSE) file for full details.

---

## Support

- **Fork Issues**: [GitHub Issues](https://github.com/JillVernus/claude-mem/issues)
- **Upstream Documentation**: [docs.claude-mem.ai](https://docs.claude-mem.ai)
- **Upstream Issues**: [GitHub Issues](https://github.com/thedotmack/claude-mem/issues)

---

**Built with Claude Agent SDK** | **Powered by Claude Code** | **Made with TypeScript**
