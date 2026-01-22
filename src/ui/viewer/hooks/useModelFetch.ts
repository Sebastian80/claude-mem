import { useState, useCallback } from 'react';
import { API_ENDPOINTS } from '../constants/api';

/**
 * Cache for fetched models
 * Keyed by provider:baseUrl:keyHash to handle key changes
 */
const CACHE_KEY = 'claude-mem-models-cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  models: string[];
  timestamp: number;
  keyHash: string;
}

interface ModelsCache {
  [cacheKey: string]: CacheEntry;
}

/**
 * Simple hash function for cache invalidation (not security-sensitive)
 * Uses a basic string hash since crypto.subtle may not be available in all contexts
 */
function hashKey(key: string): string {
  if (!key) return '';
  // Simple hash: take first 8 chars of base64-encoded string
  try {
    return btoa(key).slice(0, 8);
  } catch {
    // Fallback for non-ASCII keys
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36).slice(0, 8);
  }
}

/**
 * Read cache from localStorage
 */
function readCache(): ModelsCache {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch {
    return {};
  }
}

/**
 * Write cache to localStorage
 */
function writeCache(cache: ModelsCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage may be full or disabled
  }
}

export type Provider = 'gemini' | 'openai';

interface UseModelFetchResult {
  models: string[];
  isFetching: boolean;
  error: string | null;
  fetchModels: () => Promise<void>;
  clearCache: () => void;
}

/**
 * Hook for fetching available models from custom API endpoints
 *
 * Features:
 * - Fetches from worker endpoint to avoid CORS issues
 * - Caches results in localStorage with 24h TTL
 * - Invalidates cache when API key changes
 * - Handles errors gracefully
 *
 * @param provider - The provider to fetch models for ('gemini' or 'openai')
 * @param baseUrl - The custom base URL (used for cache key)
 * @param apiKey - The API key (hashed for cache invalidation)
 */
export function useModelFetch(
  provider: Provider,
  baseUrl: string,
  apiKey: string
): UseModelFetchResult {
  const [models, setModels] = useState<string[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheKey = `${provider}:${baseUrl}`;
  const keyHash = hashKey(apiKey);

  const fetchModels = useCallback(async () => {
    // Check cache first
    const cache = readCache();
    const cached = cache[cacheKey];

    if (
      cached &&
      cached.keyHash === keyHash &&
      Date.now() - cached.timestamp < CACHE_TTL
    ) {
      setModels(cached.models);
      setError(null);
      return;
    }

    setIsFetching(true);
    setError(null);

    try {
      const response = await fetch(`${API_ENDPOINTS.MODELS}?provider=${provider}`);
      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setModels([]);
      } else {
        const fetchedModels = data.models || [];
        setModels(fetchedModels);
        setError(null);

        // Update cache
        cache[cacheKey] = {
          models: fetchedModels,
          timestamp: Date.now(),
          keyHash,
        };
        writeCache(cache);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch models');
      setModels([]);
    } finally {
      setIsFetching(false);
    }
  }, [provider, cacheKey, keyHash]);

  const clearCache = useCallback(() => {
    const cache = readCache();
    delete cache[cacheKey];
    writeCache(cache);
    setModels([]);
    setError(null);
  }, [cacheKey]);

  return { models, isFetching, error, fetchModels, clearCache };
}
