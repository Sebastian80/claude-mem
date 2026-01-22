# Dynamic Model Selection & Universal Custom Endpoints

**Created**: 2026-01-22
**Status**: ✅ Complete (v9.0.5-jv.10) - Phase 3 cancelled
**Priority**: Medium
**Related Issues**: Settings sync bug (fixed in v9.0.5-jv.7)
**Codex Review**: 2026-01-22 (Phase 2 approved)

---

## Background

The current implementation has three AI providers:
- **Claude** (Anthropic Messages API via Agent SDK)
- **Gemini** (Google Gemini v1beta API)
- **OpenRouter** (OpenAI Chat Completions API)

Each represents an **API format**, not just a specific service. The upstream repo hardcodes base URLs, forcing users to use official endpoints only. Our fork added custom base URL support for Gemini (v9.0.5-jv.2), but:

1. The implementation is incomplete (UI doesn't reflect settings properly - fixed in jv.7)
2. Model selection is still a fixed dropdown, not dynamic
3. OpenRouter/Claude don't have the same flexibility yet

---

## Goals

### Phase 1a: URL Normalization Layer (v9.0.5-jv.10) ✅ COMPLETE
- [x] Add `normalizeBaseUrl()` helper in `src/utils/url-utils.ts`
  - Handle trailing slashes, double slashes
  - Detect if user already included path segments (e.g., `/v1beta/models`)
  - Support both old format (full path) and new format (host root)
  - Strip known suffixes before appending (per Codex feedback)
- [x] Update `GeminiAgent.ts` to use normalization helper
- [x] Widen GeminiModel type to support custom models with custom endpoints
- [x] Add DEFAULT_RPM fallback for unknown models
- [x] Ensure backwards compatibility with existing settings (tested)

### Phase 1b: Dynamic Model Fetching (v9.0.5-jv.11) ✅ COMPLETE
- [x] Add worker endpoint `GET /api/models?provider=gemini` in `SettingsRoutes.ts`
  - Use `requireLocalhost` middleware
  - Return `{ models: string[], error?: string }`
  - Handle fetch failures gracefully
  - URL scheme validation (http/https only)
  - Timeout with AbortController (5s)
  - Sanitized error messages (no URL leakage)
- [x] Add "Fetch Models" button in `ContextSettingsModal.tsx` (only visible when custom base URL is set)
- [x] Create `useModelFetch.ts` hook for UI with localStorage caching
  - Cache keyed by `baseUrl + hash(apiKey)` to handle key changes
  - 24-hour TTL
- [x] Fallback to text input if fetch fails or returns unexpected format
- [x] Toggle between dropdown (fetched models) and text input (custom)
- [x] Relax model validation in both `SettingsRoutes.ts` AND `GeminiAgent.ts` for custom endpoints

### Phase 2: Rename & Extend OpenRouter → OpenAI Compatible (v9.0.6-jv.1) ✅ COMPLETE
- [x] Add one-time migration function in settings load
  - Read old `CLAUDE_MEM_OPENROUTER_*` keys
  - Write to new `CLAUDE_MEM_OPENAI_*` keys
  - Delete old keys after successful migration
- [x] Rename settings keys:
  - `CLAUDE_MEM_OPENROUTER_*` → `CLAUDE_MEM_OPENAI_*`
- [x] Rename `OpenRouterAgent.ts` → `OpenAIAgent.ts`
- [x] Update UI labels: "OpenRouter" → "OpenAI Compatible"
- [x] Add `CLAUDE_MEM_OPENAI_BASE_URL` with default to OpenRouter
- [x] Same dynamic model fetching as Gemini (reuse `GET /api/models?provider=openai`)
- [x] Update `SessionRoutes.startGeneratorWithProvider()` for `'openai'` provider
- [x] Update `ActiveSession.currentProvider` type in `worker-types.ts`
- [x] Update README with migration notes
- [x] Clean up remaining "OpenRouter" comments in code (non-blocking polish)

### Phase 3: Claude Custom Endpoints - ❌ CANCELLED

**Decision**: Phase 3 has been cancelled. The Claude provider uses the `claude` CLI via Agent SDK, not a direct Anthropic API client. Supporting custom Claude endpoints would require:
- AWS Bedrock: IAM role authentication
- Azure OpenAI: Azure AD token authentication
- Custom base URLs: Not supported by the CLI/SDK architecture

**Conclusion**: Stick with the Claude SDK for Claude, only Gemini and OpenAI-compatible providers support custom base URLs. This is sufficient for the current use case.

---

## Technical Design

### URL Normalization Helper

```typescript
// src/utils/url-utils.ts

export function normalizeBaseUrl(url: string, pathSuffix?: string): string {
  // Remove trailing slashes
  let normalized = url.replace(/\/+$/, '');

  // Detect if user already included the path suffix
  if (pathSuffix && normalized.endsWith(pathSuffix.replace(/^\//, ''))) {
    // User included full path - use as-is
    return normalized;
  }

  // Append path suffix if provided
  if (pathSuffix) {
    const suffix = pathSuffix.startsWith('/') ? pathSuffix : `/${pathSuffix}`;
    normalized = `${normalized}${suffix}`;
  }

  return normalized;
}

// Usage in GeminiAgent.ts:
const baseUrl = normalizeBaseUrl(customBaseUrl || GEMINI_DEFAULT_BASE, 'v1beta/models');
const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
```

### Worker-Side Model Fetching

```typescript
// In SettingsRoutes.ts

router.get('/api/models', requireLocalhost, async (req, res) => {
  const { provider } = req.query;

  try {
    const settings = await getSettings();
    let modelsUrl: string;
    let headers: Record<string, string> = {};

    if (provider === 'gemini') {
      const baseUrl = settings.CLAUDE_MEM_GEMINI_BASE_URL;
      if (!baseUrl) {
        return res.json({ models: [], error: 'No custom base URL configured' });
      }
      modelsUrl = normalizeBaseUrl(baseUrl, 'v1/models');
      // Add API key if required
      if (settings.CLAUDE_MEM_GEMINI_API_KEY) {
        modelsUrl += `?key=${settings.CLAUDE_MEM_GEMINI_API_KEY}`;
      }
    } else if (provider === 'openai') {
      const baseUrl = settings.CLAUDE_MEM_OPENAI_BASE_URL;
      modelsUrl = normalizeBaseUrl(baseUrl, 'v1/models');
      headers['Authorization'] = `Bearer ${settings.CLAUDE_MEM_OPENAI_API_KEY}`;
    } else {
      return res.status(400).json({ models: [], error: 'Unknown provider' });
    }

    const response = await fetch(modelsUrl, { headers });
    if (!response.ok) {
      return res.json({ models: [], error: `Fetch failed: ${response.status}` });
    }

    const data = await response.json();
    // Handle both OpenAI format and potential variations
    const models = data.data?.map((m: any) => m.id) || [];

    return res.json({ models });
  } catch (error) {
    return res.json({ models: [], error: error.message });
  }
});
```

### UI Hook with Cache Invalidation

```typescript
// src/ui/viewer/hooks/useModelFetch.ts

const CACHE_KEY = 'claude-mem-models-cache';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  models: string[];
  timestamp: number;
  keyHash: string; // Hash of API key to detect changes
}

interface ModelsCache {
  [cacheKey: string]: CacheEntry;
}

function hashKey(key: string): string {
  // Simple hash for cache invalidation (not security-sensitive)
  return btoa(key).slice(0, 16);
}

export function useModelFetch(provider: string, baseUrl: string, apiKey: string) {
  const [models, setModels] = useState<string[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cacheKey = `${provider}:${baseUrl}`;
  const keyHash = hashKey(apiKey || '');

  const fetchModels = async () => {
    // Check cache first
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as ModelsCache;
    const cached = cache[cacheKey];

    if (cached &&
        cached.keyHash === keyHash &&
        Date.now() - cached.timestamp < CACHE_TTL) {
      setModels(cached.models);
      return;
    }

    setIsFetching(true);
    setError(null);

    try {
      const response = await fetch(`/api/models?provider=${provider}`);
      const data = await response.json();

      if (data.error) {
        setError(data.error);
        setModels([]);
      } else {
        setModels(data.models);
        // Update cache
        cache[cacheKey] = { models: data.models, timestamp: Date.now(), keyHash };
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      }
    } catch (err) {
      setError(err.message);
      setModels([]);
    } finally {
      setIsFetching(false);
    }
  };

  return { models, isFetching, error, fetchModels };
}
```

### Settings Migration (Phase 2)

```typescript
// In SettingsDefaultsManager.ts or settings load path

const MIGRATION_KEY_MAP = {
  'CLAUDE_MEM_OPENROUTER_API_KEY': 'CLAUDE_MEM_OPENAI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_MODEL': 'CLAUDE_MEM_OPENAI_MODEL',
  'CLAUDE_MEM_OPENROUTER_BASE_URL': 'CLAUDE_MEM_OPENAI_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_SITE_URL': 'CLAUDE_MEM_OPENAI_SITE_URL',
  'CLAUDE_MEM_OPENROUTER_APP_NAME': 'CLAUDE_MEM_OPENAI_APP_NAME',
};

function migrateSettings(settings: Settings): Settings {
  let migrated = false;

  for (const [oldKey, newKey] of Object.entries(MIGRATION_KEY_MAP)) {
    if (settings[oldKey] !== undefined && settings[newKey] === undefined) {
      settings[newKey] = settings[oldKey];
      delete settings[oldKey];
      migrated = true;
    }
  }

  // Also migrate provider value
  if (settings.CLAUDE_MEM_PROVIDER === 'openrouter') {
    settings.CLAUDE_MEM_PROVIDER = 'openai';
    migrated = true;
  }

  return settings;
}
```

---

## Files Changed

### Phase 1a (URL Normalization) ✅ COMPLETE

| File | Change | Status |
|------|--------|--------|
| `src/utils/url-utils.ts` | NEW - URL normalization helpers (normalizeBaseUrl, buildGeminiApiUrl, buildOpenAIApiUrl) | ✅ Done |
| `src/services/worker/GeminiAgent.ts` | Use buildGeminiApiUrl(), widen GeminiModel type, add DEFAULT_RPM | ✅ Done |

### Phase 1b (Model Fetching) ✅ COMPLETE

| File | Change | Status |
|------|--------|--------|
| `src/services/worker/http/routes/SettingsRoutes.ts` | Add GET /api/models endpoint, relax validation, import normalizeBaseUrl | ✅ Done |
| `src/ui/viewer/hooks/useModelFetch.ts` | NEW - Hook for model fetching with localStorage caching | ✅ Done |
| `src/ui/viewer/constants/api.ts` | Add MODELS endpoint constant | ✅ Done |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | Add fetch models button, dynamic dropdown/text input toggle | ✅ Done |

### Phase 2 (OpenRouter → OpenAI) ✅ COMPLETE

| File | Change | Status |
|------|--------|--------|
| `src/shared/SettingsDefaultsManager.ts` | Add migration function, rename keys | ✅ Done |
| `src/services/worker/OpenAIAgent.ts` | Renamed from OpenRouterAgent.ts, update base URL handling | ✅ Done |
| `src/services/worker/http/routes/SettingsRoutes.ts` | Update key references, provider validation | ✅ Done |
| `src/services/worker/http/routes/SessionRoutes.ts` | Update imports, agent refs, startGeneratorWithProvider | ✅ Done |
| `src/services/worker-service.ts` | Update OpenAIAgent import and instantiation | ✅ Done |
| `src/services/worker-types.ts` | Update ActiveSession.currentProvider type | ✅ Done |
| `src/ui/viewer/types.ts` | Rename type fields | ✅ Done |
| `src/ui/viewer/constants/settings.ts` | Rename constants | ✅ Done |
| `src/ui/viewer/hooks/useSettings.ts` | Rename fields | ✅ Done |
| `src/ui/viewer/hooks/useModelFetch.ts` | Update Provider type | ✅ Done |
| `src/ui/viewer/components/ContextSettingsModal.tsx` | Update labels to "OpenAI Compatible" | ✅ Done |
| `src/services/worker/agents/types.ts` | Update comments | ✅ Done |
| `README.md` | Document the rename and migration | ✅ Done |

### Phase 3 (Claude Custom Endpoints) - ❌ CANCELLED

No files changed - Phase 3 was cancelled due to SDK architecture limitations.

---

## Testing Plan

### Phase 1a
1. **Backwards compatibility**: Existing settings with full path URLs still work
2. **New format**: Host-only URLs correctly append path segments
3. **Edge cases**: Double slashes, trailing slashes handled correctly

### Phase 1b
1. **Worker endpoint**: `GET /api/models?provider=gemini` returns model list
2. **CORS-free**: Fetch works from viewer without browser security issues
3. **Fetch failure**: Graceful fallback to text input
4. **Cache**: Models cached and reused; cache invalidates on API key change
5. **Validation relaxed**: Custom models accepted by both routes and agent

### Phase 2
1. **Migration**: Old settings automatically migrated on first load
2. **Clean state**: New installs use OPENAI keys directly
3. **UI labels**: Shows "OpenAI Compatible" everywhere
4. **Runtime**: `startGeneratorWithProvider()` correctly routes to `openAIAgent`

---

## Version Plan

- **v9.0.5-jv.10**: Phases 1a + 1b + Phase 2 (Dynamic Model Selection complete)
- ~~**v9.0.6-jv.2+**: Phase 3 - Claude custom endpoints~~ (cancelled - SDK limitations)

---

## Notes

- User confirmed no backwards compatibility concerns (single user)
- Settings keys can be renamed freely
- Document changes in README
- Model validation in SettingsRoutes.ts AND GeminiAgent.ts should be relaxed for custom endpoints

## Codex Review History

### 2026-01-22 Initial Review
**Feedback incorporated:**
- ✅ Added URL normalization helper
- ✅ Moved model fetching to worker-side endpoint
- ✅ Added cache invalidation on API key change
- ✅ Split Phase 1 into 1a (normalization) and 1b (model fetching)
- ✅ Added migration shim for Phase 2
- ✅ Gated Phase 3 on feasibility spike
- ❌ Kept full rename (OPENROUTER → OPENAI) for clarity instead of internal-only change

### 2026-01-22 Phase 1b Review
**Feedback incorporated:**
- ✅ Fixed form state vs saved settings mismatch in model fetching
- ✅ Fixed cache clearing on mount (skip first effect run with useRef)

### 2026-01-22 Phase 2 Review
**Initial review identified blocking issues:**
- ✅ `startGeneratorWithProvider()` now uses `'openai'` provider and `this.openAIAgent`
- ✅ `ActiveSession.currentProvider` type updated from `'openrouter'` to `'openai'`
**Status:** Phase 2 approved for release

**Non-blocking polish recommended:**
- README migration notes (pending)
- Clean up remaining "OpenRouter" comments in OpenAIAgent.ts and useModelFetch.ts
