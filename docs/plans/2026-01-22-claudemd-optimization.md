# CLAUDE.md Generation Optimization Plan

**Created**: 2026-01-22
**Status**: Planning
**Priority**: Medium
**Related**: folder-context feature, context injection

---

## Problem Statement

Claude-mem generates CLAUDE.md files in almost every folder (97 files in the current project). This causes:

1. **Git pollution**: Many tracked CLAUDE.md files change frequently, creating noise in commits
2. **Performance overhead**: Every observation triggers updates to multiple folder CLAUDE.md files
3. **Unclear default behavior**: Documentation says "disabled by default" but code always runs it
4. **Confusing gitignore**: Complex pattern (`**/CLAUDE.md` with exceptions) doesn't fully work

---

## Current Implementation

### Architecture

```
Observation Saved
       ↓
ResponseProcessor.syncAndBroadcastObservations()
       ↓
Extract file paths from observation (files_modified, files_read)
       ↓
For each unique folder → updateFolderClaudeMdFiles()
       ↓
Query worker API for folder observations
       ↓
Format timeline table
       ↓
Write to <folder>/CLAUDE.md (atomic write)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/utils/claude-md-utils.ts` | Core logic for CLAUDE.md generation (lines 257-336) |
| `src/services/worker/agents/ResponseProcessor.ts` | Triggers update on each observation save (lines 216-233) |
| `scripts/regenerate-claude-md.ts` | Manual batch regeneration script |
| `docs/public/usage/folder-context.mdx` | Documentation (claims disabled by default) |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` | **Missing from defaults** | Should control feature on/off |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` | Max observations per folder |

---

## Issues Identified

### Issue 1: No Default Setting
The setting `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED` is checked in code but never defined in `SettingsDefaultsManager.ts`. This means the condition is always truthy (undefined != "false").

### Issue 2: Too Many Files
Every folder that has any file touched gets a CLAUDE.md. This includes:
- Temporary folders
- Test fixtures
- Documentation subfolders
- Build output directories

### Issue 3: Git Tracking Conflict
The gitignore pattern `**/CLAUDE.md` should ignore all folder CLAUDE.md files, but since many were tracked before this rule existed, git continues tracking them.

### Issue 4: Frequent Updates
Every observation triggers updates to all folders containing touched files. This is excessive for real-time context that changes constantly.

### Issue 5: No Project Scope Control
Files are generated based on observation file paths, with no consideration for whether the folder is inside the current project or part of external dependencies.

---

## Proposed Solutions

### Phase 1: Immediate Fixes (v9.0.5-jv.8)

#### 1.1 Add Missing Setting Default
**File**: `src/shared/SettingsDefaultsManager.ts`
```typescript
CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',  // Disabled by default as documented
```

#### 1.2 Untrack All Generated CLAUDE.md Files
```bash
# Remove all CLAUDE.md files except root from git tracking
git ls-files | grep "CLAUDE.md" | grep -v "^CLAUDE.md$" | xargs git rm --cached

# Verify gitignore pattern works
echo "**/CLAUDE.md" >> .gitignore
echo "!/CLAUDE.md" >> .gitignore
```

#### 1.3 Add Cleanup Script Enhancement
**File**: `scripts/regenerate-claude-md.ts`
- Add `--untrack` flag to remove from git and delete files
- Add `--project <path>` flag to limit scope

### Phase 2: Smart Generation (v9.0.6)

#### 2.1 Project-Scoped Generation
Only generate CLAUDE.md for folders within the current project root, not external paths.

**File**: `src/utils/claude-md-utils.ts`
```typescript
function shouldGenerateForFolder(folderPath: string, projectRoot: string): boolean {
  // Only generate for folders within project
  if (!folderPath.startsWith(projectRoot)) return false;

  // Skip common noise directories
  const skipPatterns = [
    '/node_modules/',
    '/dist/',
    '/.git/',
    '/coverage/',
    '/__pycache__/',
  ];
  return !skipPatterns.some(p => folderPath.includes(p));
}
```

#### 2.2 Throttled Updates
Don't update CLAUDE.md on every observation. Instead:
- Batch updates at session end
- Or update on explicit request (`/refresh-context`)
- Or update when folder is accessed (lazy generation)

**File**: `src/services/worker/agents/ResponseProcessor.ts`
```typescript
// Instead of immediate update
// await updateFolderClaudeMdFiles(...);

// Queue for batch update
FolderContextQueue.enqueue(folderPath);
```

#### 2.3 Configurable Depth
Allow users to control how deep the folder CLAUDE.md generation goes.

**Settings**:
```json
{
  "CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED": "true",
  "CLAUDE_MEM_FOLDER_CLAUDEMD_MAX_DEPTH": "3",
  "CLAUDE_MEM_FOLDER_CLAUDEMD_SKIP_PATTERNS": "node_modules,dist,.git"
}
```

### Phase 3: Alternative Approaches (Future)

#### 3.1 Single Context File
Instead of per-folder CLAUDE.md files, use a single `.claude-mem/context.md` file that contains all folder summaries. This:
- Eliminates git pollution entirely
- Centralizes context management
- Reduces file system writes

#### 3.2 On-Demand Context Injection
Don't pre-generate any files. Instead:
- When Claude Code reads a folder, intercept and inject context
- Use MCP hooks or IDE integration for real-time injection
- Context stays in database, never written to files

---

## Implementation Order

### v9.0.5-jv.8 (Immediate)
1. [ ] Add `CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false'` to defaults
2. [ ] Untrack all non-root CLAUDE.md files from git
3. [ ] Update .gitignore to properly ignore all folder CLAUDE.md
4. [ ] Document the setting in configuration docs

### v9.0.6 (Short-term)
1. [ ] Add project-scope checking
2. [ ] Add skip patterns configuration
3. [ ] Implement batched/throttled updates
4. [ ] Add max depth setting

### Future
1. [ ] Evaluate single context file approach
2. [ ] Explore on-demand injection via MCP

---

## Files to Modify

### Phase 1

| File | Change |
|------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Add default setting |
| `.gitignore` | Simplify CLAUDE.md patterns |
| `docs/public/configuration.mdx` | Document setting |

### Phase 2

| File | Change |
|------|--------|
| `src/utils/claude-md-utils.ts` | Add project-scope and depth checks |
| `src/services/worker/agents/ResponseProcessor.ts` | Implement throttled updates |
| `src/shared/SettingsDefaultsManager.ts` | Add new settings |

---

## Testing Plan

1. **Default disabled**: Fresh install should not generate any folder CLAUDE.md files
2. **Enable setting**: Setting to "true" should start generating files
3. **Skip patterns**: node_modules and dist folders should never get CLAUDE.md
4. **Project scope**: External paths should not trigger file creation
5. **Throttling**: Multiple rapid observations should batch into single update

---

## Notes

- Current behavior is useful for some users who want per-folder context
- Making it opt-in rather than opt-out is the right approach
- The feature should be zero-cost when disabled (no file operations at all)
