# Issue: Autonomous SDK Execution on Compaction Summary

**Date**: 2026-01-09
**Status**: ✅ Fixed
**Severity**: High (causes unnecessary token consumption)

## Summary

When Claude Code runs out of context and generates a compaction summary, the memory worker's SDK subprocess interprets the summary as work instructions and begins autonomous execution, making repeated API calls and consuming tokens.

## Root Cause Analysis

### Problem Flow

```
Claude Code (context overflow)
    ↓ generates compaction summary containing "I will implement X..."
User continues session
    ↓ UserPromptSubmit hook fires
new-hook.ts
    ↓ POST /api/sessions/init with full compaction as "prompt"
SessionRoutes.ts
    ↓ stores in ActiveSession.userPrompt
SDKAgent.ts
    ↓ buildContinuationPrompt() wraps it in <observed_from_primary_session>
SDK subprocess (observer model)
    ↓ sees "Continue with the last task..." + "I will implement Option C..."
    ↓ misinterprets as instruction to EXECUTE, not OBSERVE
EnterPlanMode → TaskOutput → Skill → (loop)
```

### Evidence

Request samples captured in `docs/request_samples/01-04`:

| File | Time | Action | Result |
|------|------|--------|--------|
| 01 | 11:58:26 | Received compaction summary | Called `EnterPlanMode` |
| 02 | 11:58:35 | Plan mode active | Called `TaskOutput` × 2 → Failed |
| 03 | 11:58:42 | Got errors | Retried `TaskOutput` → Failed again |
| 04 | 11:58:48 | Got errors again | Tried `Skill` tool |

### Key Findings

1. **Compaction summaries contain action items**: Text like "I will proceed with implementing..." triggers the model to take action
2. **Observer role not understood**: Despite prompts saying "You are NOT the one doing the work", the model executed tools
3. **Missing tool restrictions**: `EnterPlanMode`, `TaskOutput`, `Skill`, `ExitPlanMode`, `KillShell` were not in `disallowedTools`

## Fix Implementation

### Fix 1: Compaction Detection (Primary) ✅

**File**: `src/hooks/new-hook.ts`

Detect messages starting with "This session is being continued from a previous conversation" and skip SDK processing entirely.

```typescript
const COMPACTION_PATTERN = /^This session is being continued from a previous conversation/;

function isCompactionSummary(prompt: string): boolean {
  return COMPACTION_PATTERN.test(prompt.trim());
}

// In newHook():
if (isCompactionSummary(prompt)) {
  logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=compaction`);
  console.log(STANDARD_HOOK_RESPONSE);
  return;
}
```

#### Design Decision: Why Skip SDK Entirely?

**Question**: Does skipping SDK processing lose information?

**Answer**: No, because:

1. **Observations already captured**: The compaction describes PREVIOUS work that was already observed via PostToolUse hooks when it originally happened
2. **Compaction is a user prompt, not tool data**: The memory system captures observations from tool use, not from prompt text
3. **Database session still initialized**: Line 43-56 runs before the skip, so new work in this session will be tracked
4. **Future hooks still work**: PostToolUse and Stop hooks continue to capture new tool use and summaries

**Alternative considered but rejected**:
- Sanitizing the prompt before SDK processing - adds complexity and risk of partial interpretation
- Recording compaction as metadata - unnecessary since original observations exist

### Fix 2: Block Missing Tools (Defense in Depth) ✅

**File**: `src/services/worker/SDKAgent.ts`

Added missing tools to `disallowedTools` array:

```typescript
const disallowedTools = [
  // Existing tools...
  'Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'Task', 'NotebookEdit',
  'AskUserQuestion', 'TodoWrite',
  // NEW: Block planning and task management tools (2026-01-09)
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskOutput',
  'Skill',
  'KillShell',
  'LSP',
];
```

### Fix 3: Idle Timeout (Safety Net) - Planned

See: `docs/reports/issue-603-worker-daemon-leaks-child-processes.md`

Kill subprocess after 5 minutes of inactivity to limit damage from any future autonomous behavior.

## Verification

After implementation:
1. Start a new Claude Code session
2. Work until context compaction occurs
3. Verify worker logs show `skipped=true | reason=compaction`
4. Verify no autonomous tool calls in SDK subprocess
5. Monitor API request count during idle periods

## Related Issues

- Issue #603: Worker Daemon Leaks Child Processes (subprocess cleanup)
- `CLAUDE_MEM_SKIP_TOOLS` setting (observation filtering, not subprocess tool access)

## Completion Checklist

- [x] Compaction detection implemented (`src/hooks/new-hook.ts`)
- [x] Missing tools added to disallowedTools (`src/services/worker/SDKAgent.ts`)
- [x] Documentation updated
- [ ] Worker rebuilt
- [ ] Version bumped
- [ ] Changes committed and pushed
- [ ] Tested with plugin update

## Files Modified

1. `src/hooks/new-hook.ts` - Added `isCompactionSummary()` detection and early return
2. `src/services/worker/SDKAgent.ts` - Added 6 tools to `disallowedTools` array
3. `docs/reports/2026-01-09-autonomous-sdk-execution.md` - This report
