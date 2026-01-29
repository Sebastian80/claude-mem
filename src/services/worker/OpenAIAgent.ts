/**
 * OpenAIAgent: OpenAI-compatible observation extraction
 *
 * Alternative to SDKAgent that uses OpenAI-compatible APIs
 * for accessing models from OpenRouter, local LLMs, and other providers.
 *
 * Responsibility:
 * - Call OpenAI-compatible REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  shouldFallbackToClaude,
  isAbortError,
  isContextOverflowError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';
import {
  truncateHistory,
  truncateAggressively,
  shouldTruncate,
  type TruncationConfig
} from './utils/HistoryTruncation.js';
import {
  getBackoffDelay,
  formatBackoffDelay,
  sleep,
  isRetryableError,
  isAbortError as isBackoffAbortError,
  MAX_RETRY_ATTEMPTS,
} from './utils/ExponentialBackoff.js';

// Default API endpoint (OpenRouter, can be overridden via settings)
const DEFAULT_OPENAI_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class OpenAIAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when OpenAI-compatible API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start OpenAI-compatible agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Initialize FIFO queue for tracking message IDs (handles prefetch)
      session.processingMessageIdQueue = [];

      // Get OpenAI-compatible configuration
      const { apiKey, model, siteUrl, appName, truncationConfig } = this.getOpenAIConfig();

      if (!apiKey) {
        throw new Error('OpenAI-compatible API key not configured. Set CLAUDE_MEM_OPENAI_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }

      // CRITICAL: Ensure memorySessionId is set for non-Claude providers
      // Claude SDK captures this from its response, but Gemini/OpenAI need to generate it
      if (!session.memorySessionId) {
        const generatedId = crypto.randomUUID();
        session.memorySessionId = generatedId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
        logger.info('SDK', `Generated memorySessionId for OpenAI session | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedId}`, {
          sessionId: session.sessionDbId
        });
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Truncate before init call if history is already large (e.g., provider switch)
      if (shouldTruncate(session.lastInputTokens, truncationConfig, session.conversationHistory)) {
        truncateHistory(session.conversationHistory, truncationConfig, session.lastInputTokens);
      }

      // Add to conversation history and query OpenAI-compatible API with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

      if (initResponse.content) {
        // Note: Response is added to conversation history by ResponseProcessor (centralized)

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Track actual input tokens for truncation trigger
        if (initResponse.inputTokens !== undefined) {
          session.lastInputTokens = initResponse.inputTokens;
        }

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'OpenAI',
          undefined  // No lastCwd yet - before message processing
        );
      } else {
        logger.error('SDK', 'Empty OpenAI init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from messages for proper worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Check if truncation is needed before adding new message
          if (shouldTruncate(session.lastInputTokens, truncationConfig, session.conversationHistory)) {
            truncateHistory(session.conversationHistory, truncationConfig, session.lastInputTokens);
          }

          // Add to conversation history and query OpenAI with retry-on-context-error
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryWithRetry(session, apiKey, model, siteUrl, appName);

          let tokensUsed = 0;
          if (obsResponse.content) {
            // Note: Response is added to conversation history by ResponseProcessor (centralized)

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

            // Track actual input tokens for truncation trigger
            if (obsResponse.inputTokens !== undefined) {
              session.lastInputTokens = obsResponse.inputTokens;
            }
          } else if (obsResponse.skipped) {
            // Observation was skipped due to unrecoverable context overflow
            // Still call processAgentResponse to complete the cycle (decrement in-flight counter)
            logger.warn('SDK', 'Observation skipped due to context overflow', {
              sessionId: session.sessionDbId,
              toolName: message.tool_name
            });
          }

          // Process response using shared ResponseProcessor
          // Pass messageId for atomic store+mark-complete
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI',
            lastCwd,
            message._persistentId
          );

        } else if (message.type === 'summarize') {
          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Check if truncation is needed before adding new message
          if (shouldTruncate(session.lastInputTokens, truncationConfig, session.conversationHistory)) {
            truncateHistory(session.conversationHistory, truncationConfig, session.lastInputTokens);
          }

          // Add to conversation history and query OpenAI with retry-on-context-error
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryWithRetry(session, apiKey, model, siteUrl, appName);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Note: Response is added to conversation history by ResponseProcessor (centralized)

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

            // Track actual input tokens for truncation trigger
            if (summaryResponse.inputTokens !== undefined) {
              session.lastInputTokens = summaryResponse.inputTokens;
            }
          } else if (summaryResponse.skipped) {
            // Summary was skipped due to unrecoverable context overflow
            logger.warn('SDK', 'Summary skipped due to context overflow', {
              sessionId: session.sessionDbId
            });
          }

          // Process response using shared ResponseProcessor
          // Pass messageId for atomic store+mark-complete
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenAI',
            lastCwd,
            message._persistentId
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenAI agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        model
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenAI agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'OpenAI API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to Claude - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'OpenAI agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query OpenAI with retry-on-context-error and exponential backoff for transient errors.
   * If the first attempt fails with a context overflow error, aggressively truncate and retry once.
   * For transient API errors (429, 500, etc.), retry with exponential backoff.
   *
   * @param session - Active session (history will be mutated on aggressive truncation)
   * @param apiKey - OpenAI API key
   * @param model - Model to use
   * @param siteUrl - Optional site URL for analytics
   * @param appName - Optional app name for analytics
   * @returns Response content and token usage, or empty content if both attempts fail
   */
  private async queryWithRetry(
    session: ActiveSession,
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number; skipped?: boolean; skipReason?: string }> {
    let retryCount = 0;
    let lastError: unknown = null;

    // Capture abort signal at start to avoid race with controller replacement
    const abortSignal = session.abortController?.signal;

    while (retryCount <= MAX_RETRY_ATTEMPTS) {
      try {
        return await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);
      } catch (error) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Handle context overflow errors with aggressive truncation (single retry)
        if (isContextOverflowError(error)) {
          // Telemetry: context overflow detected
          logger.info('TELEMETRY', 'contextOverflowDetected', {
            sessionId: session.sessionDbId,
            provider: 'OpenAI',
            historyLength: session.conversationHistory.length,
            error: errorMessage
          });

          logger.warn('TRUNCATION', 'Context overflow error, attempting aggressive truncation and retry', {
            sessionId: session.sessionDbId,
            error: errorMessage,
            historyLength: session.conversationHistory.length
          });

          // Aggressive truncation: keep only pinned + current user message
          truncateAggressively(session.conversationHistory);

          try {
            const result = await this.queryOpenAIMultiTurn(session.conversationHistory, apiKey, model, siteUrl, appName);

            // Telemetry: retry succeeded
            logger.info('TELEMETRY', 'contextOverflowRetrySucceeded', {
              sessionId: session.sessionDbId,
              provider: 'OpenAI',
              newHistoryLength: session.conversationHistory.length
            });

            return result;
          } catch (retryError) {
            const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);

            // Telemetry: retry failed, skipping request
            logger.info('TELEMETRY', 'contextOverflowSkipped', {
              sessionId: session.sessionDbId,
              provider: 'OpenAI',
              error: retryErrorMessage
            });

            logger.error('TRUNCATION', 'Retry after aggressive truncation failed, skipping request', {
              sessionId: session.sessionDbId,
              error: retryErrorMessage
            });
            // Return empty content with skipped flag and reason - caller will handle gracefully
            return { content: '', skipped: true, skipReason: retryErrorMessage };
          }
        }

        // Handle transient API errors with exponential backoff
        if (isRetryableError(error)) {
          const backoffDelay = getBackoffDelay(retryCount);

          logger.warn('SDK', `OpenAI API error (retryable), attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS + 1}, retrying in ${formatBackoffDelay(backoffDelay)}`, {
            sessionId: session.sessionDbId,
            retryCount,
            backoffDelayMs: backoffDelay,
            error: errorMessage
          });

          retryCount++;

          if (retryCount > MAX_RETRY_ATTEMPTS) {
            logger.error('SDK', `OpenAI API failed after ${MAX_RETRY_ATTEMPTS + 1} attempts`, {
              sessionId: session.sessionDbId,
              totalAttempts: MAX_RETRY_ATTEMPTS + 1,
              error: errorMessage
            });
            // Re-throw to trigger fallback to Claude
            throw error;
          }

          // Wait with exponential backoff before retrying
          // Use captured signal to allow early exit during shutdown
          try {
            await sleep(backoffDelay, abortSignal);
          } catch (sleepError) {
            // Aborted during sleep - re-throw as abort error for clean shutdown
            // This ensures abort is handled properly instead of triggering fallback
            logger.debug('SDK', 'OpenAI retry sleep interrupted by abort', {
              sessionId: session.sessionDbId,
              retryCount
            });
            if (isBackoffAbortError(sleepError)) {
              throw sleepError;  // Throw abort error for clean handling
            }
            throw error;  // Fallback to original error if not abort
          }

          // Continue to next retry attempt
          continue;
        }

        // Non-retryable, non-context-overflow error - re-throw immediately
        throw error;
      }
    }

    // Should not reach here, but re-throw last error just in case
    throw lastError;
  }

  /**
   * Get OpenAI-compatible base URL from settings or environment
   */
  private getOpenAIBaseUrl(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Priority: settings > env var > default
    return settings.CLAUDE_MEM_OPENAI_BASE_URL
      || (process.env.OPENAI_BASE_URL || '').trim()
      || DEFAULT_OPENAI_API_URL;
  }

  /**
   * Query OpenAI-compatible API via REST with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   * Note: Truncation is handled by caller before invoking this method
   */
  private async queryOpenAIMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number }> {
    const messages = this.conversationToOpenAIMessages(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying OpenAI multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const url = this.getOpenAIBaseUrl();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': siteUrl || 'https://github.com/jillvernus/claude-mem',
        'X-Title': appName || 'claude-mem',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenAIResponse;

    // Check for API error in response body
    if (data.error) {
      throw new Error(`OpenAI API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenAI API');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;
    const inputTokens = data.usage?.prompt_tokens;

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const outputTokens = data.usage?.completion_tokens || 0;
      // Token usage (cost varies by model and provider)
      const estimatedCost = ((inputTokens || 0) / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenAI API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: history.length
      });

      // Warn if costs are getting high
      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed, inputTokens };
  }

  /**
   * Get OpenAI-compatible configuration from settings or environment
   */
  private getOpenAIConfig(): {
    apiKey: string;
    model: string;
    siteUrl?: string;
    appName?: string;
    truncationConfig: TruncationConfig;
  } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then environment variable
    const apiKey = settings.CLAUDE_MEM_OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || '';

    // Model: from settings or default
    const model = settings.CLAUDE_MEM_OPENAI_MODEL || 'xiaomi/mimo-v2-flash:free';

    // Optional analytics headers
    const siteUrl = settings.CLAUDE_MEM_OPENAI_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENAI_APP_NAME || 'claude-mem';

    // Truncation configuration
    const truncationConfig: TruncationConfig = {
      maxMessages: parseInt(settings.CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES) || 20,
      maxTokens: parseInt(settings.CLAUDE_MEM_OPENAI_MAX_TOKENS) || 100000,
      enabled: settings.CLAUDE_MEM_OPENAI_TRUNCATION_ENABLED !== 'false',
    };

    return { apiKey, model, siteUrl, appName, truncationConfig };
  }
}

/**
 * Check if OpenAI-compatible provider is available (has API key configured)
 */
export function isOpenAIAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENAI_API_KEY || process.env.OPENROUTER_API_KEY);
}

/**
 * Check if OpenAI-compatible provider is the selected provider
 */
export function isOpenAISelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  // Accept both 'openai' and legacy 'openrouter' for backwards compatibility
  return settings.CLAUDE_MEM_PROVIDER === 'openai' || settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}
