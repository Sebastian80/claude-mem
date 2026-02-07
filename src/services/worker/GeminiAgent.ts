/**
 * GeminiAgent: Gemini-based observation extraction
 *
 * Alternative to SDKAgent that uses Google's Gemini API directly
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Gemini REST API for observation extraction
 * - Parse XML responses (same format as Claude)
 * - Sync to database and Chroma
 */

import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildGeminiApiUrl } from '../../utils/url-utils.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getCredential } from '../../shared/EnvManager.js';
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

// Gemini API endpoint (default, can be overridden via settings)
const DEFAULT_GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini model types (known official models)
// Custom endpoints may support additional models not in this list
export type GeminiKnownModel =
  | 'gemini-2.5-flash-lite'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.0-flash-lite'
  | 'gemini-3-flash';

// Allow both known models and custom model strings for custom endpoints
export type GeminiModel = GeminiKnownModel | (string & {});

// Free tier RPM limits by model (requests per minute)
// Custom models use DEFAULT_RPM
const DEFAULT_RPM = 5;
const GEMINI_RPM_LIMITS: Record<GeminiKnownModel, number> = {
  'gemini-2.5-flash-lite': 10,
  'gemini-2.5-flash': 10,
  'gemini-2.5-pro': 5,
  'gemini-2.0-flash': 15,
  'gemini-2.0-flash-lite': 30,
  'gemini-3-flash': 5,
};

// Track last request time for rate limiting
let lastRequestTime = 0;

/**
 * Enforce RPM rate limit for Gemini free tier.
 * Waits the required time between requests based on model's RPM limit + 100ms safety buffer.
 * Skipped entirely if rate limiting is disabled (billing users with 1000+ RPM available).
 * Unknown/custom models use DEFAULT_RPM (5 requests per minute).
 */
async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  // Skip rate limiting if disabled (billing users with 1000+ RPM)
  if (!rateLimitingEnabled) {
    return;
  }

  // Use known model RPM or default for custom models
  const rpm = GEMINI_RPM_LIMITS[model as GeminiKnownModel] || DEFAULT_RPM;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; // (60s / RPM) + 100ms safety buffer

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Gemini content message format
 * role: "user" or "model" (Gemini uses "model" not "assistant")
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Gemini API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Gemini agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Initialize FIFO queue for tracking message IDs (handles prefetch)
      session.processingMessageIdQueue = [];

      // Get Gemini configuration
      const { apiKey, model, rateLimitingEnabled, truncationConfig } = this.getGeminiConfig();

      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }

      // CRITICAL: Ensure memorySessionId is set for non-Claude providers
      // Claude SDK captures this from its response, but Gemini/OpenRouter need to generate it
      if (!session.memorySessionId) {
        const generatedId = crypto.randomUUID();
        session.memorySessionId = generatedId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, generatedId);
        logger.info('SDK', `Generated memorySessionId for Gemini session | sessionDbId=${session.sessionDbId} | memorySessionId=${generatedId}`, {
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

      // Add to conversation history and query Gemini with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

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
          'Gemini'
        );
      } else {
        logger.error('SDK', 'Empty Gemini init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Process pending messages
      // Track cwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // Capture cwd from each message for worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        // This ensures backlog messages get their original timestamps, not current time
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

          // Add to conversation history and query Gemini with retry-on-context-error
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryWithRetry(session, apiKey, model, rateLimitingEnabled);

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
            'Gemini',
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

          // Add to conversation history and query Gemini with retry-on-context-error
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryWithRetry(session, apiKey, model, rateLimitingEnabled);

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
            'Gemini',
            lastCwd,
            message._persistentId
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Gemini agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Check if we should fall back to Claude
      if (shouldFallbackToClaude(error) && this.fallbackAgent) {
        logger.warn('SDK', 'Gemini API failed, falling back to Claude SDK', {
          sessionDbId: session.sessionDbId,
          error: error instanceof Error ? error.message : String(error),
          historyLength: session.conversationHistory.length
        });

        // Fall back to Claude - it will use the same session with shared conversationHistory
        // Note: With claim-and-delete queue pattern, messages are already deleted on claim
        return this.fallbackAgent.startSession(session, worker);
      }

      logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to Gemini's contents format
   * Maps 'assistant' role to 'model' for Gemini API compatibility
   */
  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  /**
   * Query Gemini with retry-on-context-error.
   * If the first attempt fails with a context overflow error, aggressively truncate and retry once.
   *
   * @param session - Active session (history will be mutated on aggressive truncation)
   * @param apiKey - Gemini API key
   * @param model - Gemini model to use
   * @param rateLimitingEnabled - Whether rate limiting is enabled
   * @returns Response content and token usage, or empty content if both attempts fail
   */
  private async queryWithRetry(
    session: ActiveSession,
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number; skipped?: boolean; skipReason?: string }> {
    let retryCount = 0;
    let lastError: unknown = null;

    // Capture abort signal at start to avoid race with controller replacement
    const abortSignal = session.abortController?.signal;

    while (retryCount <= MAX_RETRY_ATTEMPTS) {
      try {
        return await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);
      } catch (error) {
        lastError = error;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Handle context overflow errors with aggressive truncation (single retry)
        if (isContextOverflowError(error)) {
          // Telemetry: context overflow detected
          logger.info('TELEMETRY', 'contextOverflowDetected', {
            sessionId: session.sessionDbId,
            provider: 'Gemini',
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
            const result = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

            // Telemetry: retry succeeded
            logger.info('TELEMETRY', 'contextOverflowRetrySucceeded', {
              sessionId: session.sessionDbId,
              provider: 'Gemini',
              newHistoryLength: session.conversationHistory.length
            });

            return result;
          } catch (retryError) {
            const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);

            // Telemetry: retry failed, skipping request
            logger.info('TELEMETRY', 'contextOverflowSkipped', {
              sessionId: session.sessionDbId,
              provider: 'Gemini',
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

          logger.warn('SDK', `Gemini API error (retryable), attempt ${retryCount + 1}/${MAX_RETRY_ATTEMPTS + 1}, retrying in ${formatBackoffDelay(backoffDelay)}`, {
            sessionId: session.sessionDbId,
            retryCount,
            backoffDelayMs: backoffDelay,
            error: errorMessage
          });

          retryCount++;

          if (retryCount > MAX_RETRY_ATTEMPTS) {
            logger.error('SDK', `Gemini API failed after ${MAX_RETRY_ATTEMPTS + 1} attempts`, {
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
            logger.debug('SDK', 'Gemini retry sleep interrupted by abort', {
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
   * Get Gemini base URL from settings or environment.
   * Returns the raw URL; normalization is handled by buildGeminiApiUrl.
   */
  private getGeminiBaseUrl(): string {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Priority: settings > env var > default
    return settings.CLAUDE_MEM_GEMINI_BASE_URL
      || (process.env.GEMINI_BASE_URL || '').trim()
      || DEFAULT_GEMINI_API_URL;
  }

  /**
   * Query Gemini via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number; inputTokens?: number }> {
    const contents = this.conversationToGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    // Use the URL normalization helper to handle different base URL formats
    const baseUrl = this.getGeminiBaseUrl();
    const url = buildGeminiApiUrl(baseUrl, model, 'generateContent', apiKey);

    // Enforce RPM rate limit for free tier (skipped if rate limiting disabled)
    await enforceRateLimitForModel(model, rateLimitingEnabled);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.3,  // Lower temperature for structured extraction
          maxOutputTokens: 4096,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as GeminiResponse;

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      logger.error('SDK', 'Empty response from Gemini');
      return { content: '' };
    }

    const content = data.candidates[0].content.parts[0].text;
    const tokensUsed = data.usageMetadata?.totalTokenCount;
    const inputTokens = data.usageMetadata?.promptTokenCount;

    return { content, tokensUsed, inputTokens };
  }

  /**
   * Get Gemini configuration from settings or environment
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getGeminiConfig(): {
    apiKey: string;
    model: GeminiModel;
    rateLimitingEnabled: boolean;
    truncationConfig: TruncationConfig;
  } {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // API key: check settings first, then centralized claude-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    // Model: from settings or default
    const defaultModel: GeminiKnownModel = 'gemini-2.5-flash';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;

    // Check if using a custom base URL (allows custom models)
    const hasCustomBaseUrl = !!(settings.CLAUDE_MEM_GEMINI_BASE_URL || process.env.GEMINI_BASE_URL);

    // Known official models for validation
    const knownModels: GeminiKnownModel[] = [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-3-flash',
    ];

    let model: GeminiModel;
    if (knownModels.includes(configuredModel as GeminiKnownModel)) {
      // Known model - use as-is
      model = configuredModel as GeminiKnownModel;
    } else if (hasCustomBaseUrl) {
      // Custom model with custom endpoint - allow it
      logger.debug('SDK', `Using custom model "${configuredModel}" with custom endpoint`, {
        configured: configuredModel,
        hasCustomBaseUrl,
      });
      model = configuredModel;
    } else {
      // Unknown model without custom endpoint - fall back to default
      logger.warn('SDK', `Unknown Gemini model "${configuredModel}" without custom endpoint, falling back to ${defaultModel}`, {
        configured: configuredModel,
        knownModels,
      });
      model = defaultModel;
    }

    // Rate limiting: enabled by default for free tier users
    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    // Truncation configuration
    const truncationConfig: TruncationConfig = {
      maxMessages: parseInt(settings.CLAUDE_MEM_GEMINI_MAX_CONTEXT_MESSAGES) || 20,
      maxTokens: parseInt(settings.CLAUDE_MEM_GEMINI_MAX_TOKENS) || 100000,
      enabled: settings.CLAUDE_MEM_GEMINI_TRUNCATION_ENABLED !== 'false',
    };

    return { apiKey, model, rateLimitingEnabled, truncationConfig };
  }
}

/**
 * Check if Gemini is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isGeminiAvailable(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

/**
 * Check if Gemini is the selected provider
 */
export function isGeminiSelected(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
