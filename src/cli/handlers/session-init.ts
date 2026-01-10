/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

/**
 * Detect if a prompt is a compaction/continuation summary from Claude Code context overflow.
 * These summaries contain narrative descriptions of previous work and can cause the SDK
 * agent to misinterpret them as instructions to execute, leading to autonomous behavior.
 */
const COMPACTION_PATTERN = /^This session is being continued from a previous conversation/;

/**
 * Detect if a prompt is an SDK agent warmup/exploration request.
 * The SDK agent sometimes autonomously initiates repository exploration on session start,
 * which can trigger infinite API call loops when passed back through the hook system.
 */
const WARMUP_PATTERN = /^I will start by exploring the repository to understand/;

function isCompactionSummary(prompt: string): boolean {
  return COMPACTION_PATTERN.test(prompt.trim());
}

function isWarmupExploration(prompt: string): boolean {
  return WARMUP_PATTERN.test(prompt.trim());
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    await ensureWorkerRunning();

    const { sessionId, cwd, prompt } = input;

    if (!prompt) {
      throw new Error('sessionInitHandler requires prompt');
    }

    const project = getProjectName(cwd);
    const port = getWorkerPort();

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!initResponse.ok) {
      throw new Error(`Session initialization failed: ${initResponse.status}`);
    }

    const initResult = await initResponse.json() as {
      sessionDbId: number;
      promptNumber: number;
      skipped?: boolean;
      reason?: string;
    };
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped });

    // Debug-level alignment log for detailed tracing
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Check if prompt is a compaction/continuation summary from context overflow
    // These contain narrative descriptions that can trigger autonomous SDK behavior
    // Skip SDK processing entirely - the summary describes work, not a request to observe
    if (isCompactionSummary(prompt)) {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=compaction`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Check if prompt is an SDK agent warmup/exploration request
    // These are autonomously generated and cause infinite loops if passed back to SDK
    if (isWarmupExploration(prompt)) {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=warmup`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    // Cursor doesn't use the SDK agent - it only needs session/observation storage
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
      });

      if (!response.ok) {
        throw new Error(`SDK agent start failed: ${response.status}`);
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    return { continue: true, suppressOutput: true };
  }
};
