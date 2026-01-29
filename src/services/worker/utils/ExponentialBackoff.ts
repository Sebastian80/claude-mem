/**
 * ExponentialBackoff: Shared utility for retry delay calculations
 *
 * Backoff schedule (in milliseconds):
 * - 1st retry: 3 seconds
 * - 2nd retry: 5 seconds
 * - 3rd retry: 10 seconds
 * - 4th retry: 30 seconds
 * - 5th+ retry: 60 seconds (cap)
 */

/** Backoff delays in milliseconds */
export const BACKOFF_SCHEDULE_MS = [3000, 5000, 10000, 30000, 60000] as const;

/** Maximum retry attempts before giving up */
export const MAX_RETRY_ATTEMPTS = 10;

/**
 * Get the backoff delay for a given retry attempt
 * @param retryCount - Zero-based retry count (0 = first retry)
 * @returns Delay in milliseconds
 */
export function getBackoffDelay(retryCount: number): number {
  const index = Math.min(retryCount, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[index];
}

/**
 * Format backoff delay for logging
 * @param delayMs - Delay in milliseconds
 * @returns Human-readable string (e.g., "3s", "60s")
 */
export function formatBackoffDelay(delayMs: number): string {
  return `${delayMs / 1000}s`;
}

/**
 * Sleep for a specified duration
 * @param ms - Duration in milliseconds
 * @param signal - Optional AbortSignal to cancel sleep early
 * @returns Promise that resolves after delay or rejects on abort
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    let abortHandler: (() => void) | undefined;

    const cleanup = () => {
      if (abortHandler && signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    if (signal) {
      abortHandler = () => {
        clearTimeout(timeoutId);
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

/**
 * Check if an error is an AbortError (user-initiated cancellation)
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    const msg = error.message.toLowerCase();
    if (msg.includes('aborted') || msg.includes('abort')) return true;
  }
  return false;
}

/**
 * Check if an error is retryable (transient API errors)
 * Checks both error message strings and structured error properties
 */
export function isRetryableError(error: unknown): boolean {
  // First check if it's an abort error - these should NOT be retried
  if (isAbortError(error)) {
    return false;
  }

  // Check structured error properties (status codes, error codes)
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

    // Check status/statusCode properties
    const status = err.status || err.statusCode;
    if (typeof status === 'number') {
      if ([429, 500, 502, 503, 504].includes(status)) {
        return true;
      }
    }

    // Check Node.js error codes
    const code = err.code || (err.cause as Record<string, unknown>)?.code;
    if (typeof code === 'string') {
      const retryableCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'];
      if (retryableCodes.includes(code)) {
        return true;
      }
    }
  }

  // Fall back to message string matching
  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  const retryablePatterns = [
    '429',           // Rate limit
    '500',           // Internal server error
    '502',           // Bad gateway
    '503',           // Service unavailable
    '504',           // Gateway timeout
    'econnrefused',  // Connection refused
    'etimedout',     // Timeout
    'econnreset',    // Connection reset
    'enotfound',     // DNS lookup failed
    'eai_again',     // DNS lookup timeout
    'fetch failed',  // Network failure
    'network error', // Generic network error
    'service unavailable',
    'internal server error',
    'bad gateway',
    'gateway timeout',
  ];

  return retryablePatterns.some(pattern => lowerMessage.includes(pattern));
}
