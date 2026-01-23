/**
 * HistoryTruncation: Shared context window management for Gemini and OpenAI providers
 *
 * Provides message-level truncation to prevent runaway context growth.
 * Uses actual API-reported tokens as trigger signal, heuristics for deciding which messages to drop.
 *
 * Key features:
 * - Pinned message support (never drop instruction prompts)
 * - Message-level only (never cuts mid-message)
 * - Mutates session.conversationHistory directly
 * - Logs truncation events for debugging
 */

import { logger } from '../../../utils/logger.js';
import type { ConversationMessage } from '../../worker-types.js';

// Conservative estimate: 1 token ≈ 4 characters
const CHARS_PER_TOKEN_ESTIMATE = 4;

// Default safety margin: trigger truncation at 90% of max
const DEFAULT_SAFETY_MARGIN_PERCENT = 90;

/**
 * Configuration for truncation behavior
 */
export interface TruncationConfig {
  maxMessages: number;           // Maximum messages to keep
  maxTokens: number;             // Maximum estimated tokens
  enabled: boolean;              // Whether truncation is enabled
  safetyMarginPercent?: number;  // Trigger at this % of max (default: 90)
}

/**
 * Options for truncation operation
 */
export interface TruncationOptions {
  /**
   * Index of the most recent init/continuation prompt to pin.
   * This message will never be dropped during truncation.
   * Should be recomputed before each truncation (indices shift after mutation).
   */
  pinnedMessageIndex?: number;
}

/**
 * Result of truncation operation
 */
export interface TruncationResult {
  truncated: boolean;            // Whether truncation occurred
  originalCount: number;         // Original message count
  keptCount: number;             // Messages kept after truncation
  droppedCount: number;          // Messages dropped
  estimatedTokens: number;       // Estimated tokens after truncation
  pinnedPreserved: boolean;      // Whether pinned message was preserved
}

/**
 * Estimate token count from text (conservative estimate)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Estimate total tokens for a conversation history
 */
export function estimateHistoryTokens(history: ConversationMessage[]): number {
  return history.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * Check if truncation should be triggered based on any of:
 * - Last known input tokens (actual API-reported)
 * - Message count exceeding limit
 * - Estimated tokens exceeding threshold
 *
 * Returns true if ANY trigger fires, ensuring truncation runs when needed
 * even if one metric is stale (e.g., lastInputTokens from previous call).
 *
 * @param lastInputTokens - Actual token count from last API response (may be undefined)
 * @param config - Truncation configuration
 * @param history - Current conversation history
 * @returns true if truncation should be triggered
 */
export function shouldTruncate(
  lastInputTokens: number | undefined,
  config: TruncationConfig,
  history?: ConversationMessage[]
): boolean {
  if (!config.enabled) {
    return false;
  }

  const safetyMargin = config.safetyMarginPercent ?? DEFAULT_SAFETY_MARGIN_PERCENT;
  const tokenThreshold = Math.floor(config.maxTokens * safetyMargin / 100);

  // Check actual API-reported tokens if available
  if (lastInputTokens !== undefined && lastInputTokens >= tokenThreshold) {
    return true;
  }

  // Also check heuristics - history may have grown since lastInputTokens was captured
  // (e.g., assistant message added after the API call)
  if (history) {
    // Check message count
    if (history.length > config.maxMessages) {
      return true;
    }
    // Check estimated tokens
    const estimatedTokens = estimateHistoryTokens(history);
    if (estimatedTokens >= tokenThreshold) {
      return true;
    }
  }

  return false;
}

/**
 * Find the index of the most recent init/continuation prompt in history.
 * These are user messages that contain the instruction prompt.
 *
 * Detection: Init/continuation prompts contain `<user_request>` and `<requested_at>`
 * inside `<observed_from_primary_session>`, while observation prompts contain
 * `<what_happened>` instead. See src/sdk/prompts.ts for the templates.
 *
 * We also add a negative check for `<what_happened>` to avoid false positives
 * if a tool output happens to contain the literal string `<user_request>`.
 *
 * @param history - Conversation history
 * @returns Index of the most recent instruction-bearing message, or undefined
 */
export function findPinnedMessageIndex(history: ConversationMessage[]): number | undefined {
  // Search from end to find most recent instruction prompt
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'user') {
      // Init/continuation prompts have <user_request> and <requested_at> inside <observed_from_primary_session>
      // Observation prompts have <what_happened> instead
      // Negative check for <what_happened> prevents false positives from tool outputs
      if (
        msg.content.includes('<user_request>') &&
        msg.content.includes('<requested_at>') &&
        msg.content.includes('<observed_from_primary_session>') &&
        !msg.content.includes('<what_happened>')
      ) {
        return i;
      }
    }
  }

  // Fallback: pin the first user message (likely the init prompt)
  const firstUserIndex = history.findIndex(m => m.role === 'user');
  return firstUserIndex >= 0 ? firstUserIndex : undefined;
}

/**
 * Truncate conversation history to stay within limits.
 *
 * Algorithm:
 * 1. If pinned message specified, always keep it
 * 2. Keep most recent messages within limits
 * 3. Drop oldest messages first (except pinned)
 *
 * IMPORTANT: This function mutates the history array directly.
 *
 * @param history - Conversation history (will be mutated)
 * @param config - Truncation configuration
 * @param lastInputTokens - Actual token count from last API response (for logging)
 * @param options - Truncation options (pinned messages, etc.)
 * @returns Truncation result with statistics
 */
export function truncateHistory(
  history: ConversationMessage[],
  config: TruncationConfig,
  lastInputTokens?: number,
  options?: TruncationOptions
): TruncationResult {
  const originalCount = history.length;

  // Check if truncation is needed
  if (!config.enabled) {
    return {
      truncated: false,
      originalCount,
      keptCount: originalCount,
      droppedCount: 0,
      estimatedTokens: estimateHistoryTokens(history),
      pinnedPreserved: true
    };
  }

  // Apply safety margin to get effective limits
  // This ensures we truncate to below the trigger threshold, not just below the hard limit
  const safetyMargin = config.safetyMarginPercent ?? DEFAULT_SAFETY_MARGIN_PERCENT;
  const effectiveMaxTokens = Math.floor(config.maxTokens * safetyMargin / 100);

  // Check message count and token estimate against effective limits
  const estimatedTokens = estimateHistoryTokens(history);
  if (history.length <= config.maxMessages && estimatedTokens <= effectiveMaxTokens) {
    return {
      truncated: false,
      originalCount,
      keptCount: originalCount,
      droppedCount: 0,
      estimatedTokens,
      pinnedPreserved: true
    };
  }

  // Find pinned message (recompute each time as indices may have shifted)
  const pinnedIndex = options?.pinnedMessageIndex ?? findPinnedMessageIndex(history);
  const pinnedMessage = pinnedIndex !== undefined ? history[pinnedIndex] : undefined;

  // Check if pinned message alone exceeds limits (edge case)
  if (pinnedMessage) {
    const pinnedTokens = estimateTokens(pinnedMessage.content);
    if (pinnedTokens > effectiveMaxTokens) {
      logger.warn('TRUNCATION', 'Pinned message alone exceeds token limit, keeping only pinned', {
        pinnedTokens,
        effectiveMaxTokens,
        maxTokens: config.maxTokens
      });
      // Keep only pinned message
      history.length = 0;
      history.push(pinnedMessage);
      return {
        truncated: true,
        originalCount,
        keptCount: 1,
        droppedCount: originalCount - 1,
        estimatedTokens: pinnedTokens,
        pinnedPreserved: true
      };
    }
  }

  // Build new history: keep most recent messages within effective limits
  const kept: ConversationMessage[] = [];
  let tokenCount = 0;

  // If we have a pinned message, reserve space for it
  if (pinnedMessage) {
    const pinnedTokens = estimateTokens(pinnedMessage.content);
    tokenCount += pinnedTokens;
  }

  // Process messages in reverse (most recent first), skipping pinned
  for (let i = history.length - 1; i >= 0; i--) {
    if (i === pinnedIndex) {
      continue; // Skip pinned, we'll add it at the right position later
    }

    const msg = history[i];
    const msgTokens = estimateTokens(msg.content);

    // Check if adding this message would exceed effective limits
    // Reserve 1 slot for pinned message if we have one
    const maxMessagesForNonPinned = pinnedMessage ? config.maxMessages - 1 : config.maxMessages;

    if (kept.length >= maxMessagesForNonPinned || tokenCount + msgTokens > effectiveMaxTokens) {
      break;
    }

    kept.unshift(msg); // Add to beginning (we're iterating in reverse)
    tokenCount += msgTokens;
  }

  // Insert pinned message at its original position (preserve chronology)
  // If pinned was before all kept messages, insert at beginning
  // Otherwise, find the right position based on original indices
  if (pinnedMessage) {
    // Since we're keeping most recent messages and pinned is typically early,
    // insert at beginning to preserve chronological order
    kept.unshift(pinnedMessage);
  }

  const droppedCount = originalCount - kept.length;
  const finalTokens = estimateHistoryTokens(kept);

  // Log truncation event
  if (droppedCount > 0) {
    logger.warn('TRUNCATION', 'Context window truncated to prevent overflow', {
      originalMessages: originalCount,
      keptMessages: kept.length,
      droppedMessages: droppedCount,
      estimatedTokensBefore: estimatedTokens,
      estimatedTokensAfter: finalTokens,
      actualTokensBefore: lastInputTokens,
      effectiveTokenLimit: effectiveMaxTokens,
      hardTokenLimit: config.maxTokens,
      messageLimit: config.maxMessages,
      pinnedPreserved: !!pinnedMessage
    });
  }

  // Mutate the original array
  history.length = 0;
  history.push(...kept);

  return {
    truncated: droppedCount > 0,
    originalCount,
    keptCount: kept.length,
    droppedCount,
    estimatedTokens: finalTokens,
    pinnedPreserved: !!pinnedMessage
  };
}

/**
 * Aggressive truncation for error recovery.
 * Keeps only pinned message + current user message.
 *
 * @param history - Conversation history (will be mutated)
 * @returns Truncation result
 */
export function truncateAggressively(history: ConversationMessage[]): TruncationResult {
  const originalCount = history.length;

  // Find pinned message
  const pinnedIndex = findPinnedMessageIndex(history);
  const pinnedMessage = pinnedIndex !== undefined ? history[pinnedIndex] : undefined;

  // Find the most recent user message (current observation)
  let currentUserMessage: ConversationMessage | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user' && i !== pinnedIndex) {
      currentUserMessage = history[i];
      break;
    }
  }

  // Build minimal history
  const kept: ConversationMessage[] = [];
  if (pinnedMessage) {
    kept.push(pinnedMessage);
  }
  if (currentUserMessage) {
    kept.push(currentUserMessage);
  }

  const droppedCount = originalCount - kept.length;
  const finalTokens = estimateHistoryTokens(kept);

  logger.warn('TRUNCATION', 'Aggressive truncation for error recovery', {
    originalMessages: originalCount,
    keptMessages: kept.length,
    droppedMessages: droppedCount,
    estimatedTokensAfter: finalTokens,
    hasPinned: !!pinnedMessage,
    hasCurrentUser: !!currentUserMessage
  });

  // Mutate the original array
  history.length = 0;
  history.push(...kept);

  return {
    truncated: droppedCount > 0,
    originalCount,
    keptCount: kept.length,
    droppedCount,
    estimatedTokens: finalTokens,
    pinnedPreserved: !!pinnedMessage
  };
}
