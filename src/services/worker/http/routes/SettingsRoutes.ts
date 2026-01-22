/**
 * Settings Routes
 *
 * Handles settings management, MCP toggle, and branch switching.
 * Settings are stored in USER_SETTINGS_PATH (respects CLAUDE_MEM_DATA_DIR)
 */

import express, { Request, Response } from 'express';
import path from 'path';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { getPackageRoot, USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { logger } from '../../../../utils/logger.js';
import { SettingsManager } from '../../SettingsManager.js';
import { getBranchInfo, switchBranch, pullUpdates } from '../../BranchManager.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { clearPortCache } from '../../../../shared/worker-utils.js';
import { requireLocalhost } from '../middleware.js';
import { normalizeBaseUrl, buildOpenAIApiUrl } from '../../../../utils/url-utils.js';

// Known Gemini models for validation (custom endpoints can use any model)
const KNOWN_GEMINI_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-3-flash',
];

// Timeout for model fetching (5 seconds)
const MODEL_FETCH_TIMEOUT_MS = 5000;

export class SettingsRoutes extends BaseRouteHandler {
  constructor(
    private settingsManager: SettingsManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Settings endpoints (localhost-only to protect API keys)
    app.get('/api/settings', requireLocalhost, this.handleGetSettings.bind(this));
    app.post('/api/settings', requireLocalhost, this.handleUpdateSettings.bind(this));

    // Dynamic model fetching (localhost-only, fetches from custom endpoints)
    app.get('/api/models', requireLocalhost, this.handleGetModels.bind(this));

    // MCP toggle endpoints
    app.get('/api/mcp/status', this.handleGetMcpStatus.bind(this));
    app.post('/api/mcp/toggle', requireLocalhost, this.handleToggleMcp.bind(this));

    // Branch switching endpoints
    app.get('/api/branch/status', this.handleGetBranchStatus.bind(this));
    app.post('/api/branch/switch', requireLocalhost, this.handleSwitchBranch.bind(this));
    app.post('/api/branch/update', requireLocalhost, this.handleUpdateBranch.bind(this));
  }

  /**
   * Get environment settings (from USER_SETTINGS_PATH)
   */
  private handleGetSettings = this.wrapHandler((req: Request, res: Response): void => {
    this.ensureSettingsFile(USER_SETTINGS_PATH);
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    res.json(settings);
  });

  /**
   * Update environment settings (in USER_SETTINGS_PATH) with validation
   */
  private handleUpdateSettings = this.wrapHandler((req: Request, res: Response): void => {
    // Validate all settings
    const validation = this.validateSettings(req.body);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error
      });
      return;
    }

    // Read existing settings
    this.ensureSettingsFile(USER_SETTINGS_PATH);
    let settings: any = {};

    if (existsSync(USER_SETTINGS_PATH)) {
      const settingsData = readFileSync(USER_SETTINGS_PATH, 'utf-8');
      try {
        settings = JSON.parse(settingsData);
      } catch (parseError) {
        logger.error('SETTINGS', 'Failed to parse settings file', { settingsPath: USER_SETTINGS_PATH }, parseError as Error);
        res.status(500).json({
          success: false,
          error: 'Settings file is corrupted. Delete settings.json to reset.'
        });
        return;
      }
    }

    // Update all settings from request body
    const settingKeys = [
      'CLAUDE_MEM_MODEL',
      'CLAUDE_MEM_CONTEXT_OBSERVATIONS',
      'CLAUDE_MEM_WORKER_PORT',
      'CLAUDE_MEM_WORKER_HOST',
      // AI Provider Configuration
      'CLAUDE_MEM_PROVIDER',
      'CLAUDE_MEM_GEMINI_API_KEY',
      'CLAUDE_MEM_GEMINI_MODEL',
      'CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED',
      // OpenRouter Configuration
      'CLAUDE_MEM_OPENAI_API_KEY',
      'CLAUDE_MEM_OPENAI_MODEL',
      'CLAUDE_MEM_OPENAI_SITE_URL',
      'CLAUDE_MEM_OPENAI_APP_NAME',
      'CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES',
      'CLAUDE_MEM_OPENAI_MAX_TOKENS',
      // Custom API Endpoints
      'CLAUDE_MEM_GEMINI_BASE_URL',
      'CLAUDE_MEM_OPENAI_BASE_URL',
      // System Configuration
      'CLAUDE_MEM_DATA_DIR',
      'CLAUDE_MEM_LOG_LEVEL',
      'CLAUDE_MEM_PYTHON_VERSION',
      'CLAUDE_CODE_PATH',
      // Token Economics
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      // Observation Filtering
      'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
      'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
      // Display Configuration
      'CLAUDE_MEM_CONTEXT_FULL_COUNT',
      'CLAUDE_MEM_CONTEXT_FULL_FIELD',
      'CLAUDE_MEM_CONTEXT_SESSION_COUNT',
      // Feature Toggles
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of settingKeys) {
      if (req.body[key] !== undefined) {
        settings[key] = req.body[key];
      }
    }

    // Write back
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');

    // Clear port cache to force re-reading from updated settings
    clearPortCache();

    logger.info('WORKER', 'Settings updated');
    res.json({ success: true, message: 'Settings updated successfully' });
  });

  /**
   * GET /api/models - Fetch available models from a custom endpoint
   * Query params: provider (gemini | openai)
   * Returns: { models: string[], error?: string }
   *
   * This endpoint fetches models from custom API endpoints to avoid CORS issues
   * in the browser. Only available when a custom base URL is configured.
   */
  private handleGetModels = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const provider = req.query.provider as string;

    if (!provider || !['gemini', 'openai'].includes(provider)) {
      res.status(400).json({ models: [], error: 'Invalid provider. Must be "gemini" or "openai"' });
      return;
    }

    try {
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      let modelsUrl: string;
      const headers: Record<string, string> = {};

      if (provider === 'gemini') {
        const baseUrl = settings.CLAUDE_MEM_GEMINI_BASE_URL;
        if (!baseUrl) {
          res.json({ models: [], error: 'No custom Gemini base URL configured' });
          return;
        }

        // Validate URL scheme (security: only allow http/https)
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            res.json({ models: [], error: 'Base URL must use http:// or https://' });
            return;
          }
        } catch {
          res.json({ models: [], error: 'Invalid base URL format' });
          return;
        }

        // Use v1/models endpoint (OpenAI-compatible standard that many proxies support)
        modelsUrl = normalizeBaseUrl(baseUrl, 'v1/models');

        // Add API key if configured (as query param for Gemini-style endpoints)
        const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY;
        if (apiKey) {
          modelsUrl += `?key=${encodeURIComponent(apiKey)}`;
        }
      } else {
        // OpenAI-compatible provider
        const baseUrl = settings.CLAUDE_MEM_OPENAI_BASE_URL;
        if (!baseUrl) {
          res.json({ models: [], error: 'No OpenAI-compatible base URL configured' });
          return;
        }

        // Validate URL scheme
        try {
          const parsed = new URL(baseUrl);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            res.json({ models: [], error: 'Base URL must use http:// or https://' });
            return;
          }
        } catch {
          res.json({ models: [], error: 'Invalid base URL format' });
          return;
        }

        modelsUrl = buildOpenAIApiUrl(baseUrl, 'models');

        // Add Authorization header for OpenAI-style endpoints
        const apiKey = settings.CLAUDE_MEM_OPENAI_API_KEY;
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
      }

      // Fetch with timeout using AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(modelsUrl, {
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          // Don't leak the URL (may contain API key for Gemini)
          logger.warn('SETTINGS', 'Model fetch failed', { provider, status: response.status });
          res.json({ models: [], error: `Model fetch failed: HTTP ${response.status}` });
          return;
        }

        const data = await response.json();

        // Handle OpenAI-style response format: { data: [{ id: "model-name", ... }] }
        let models: string[] = [];
        if (Array.isArray(data?.data)) {
          models = data.data
            .map((m: any) => m.id || m.name)
            .filter((id: any): id is string => typeof id === 'string');
        } else if (Array.isArray(data?.models)) {
          // Handle both { models: ["model1", "model2"] } and { models: [{ id: "model1" }] }
          models = data.models
            .map((m: any) => typeof m === 'string' ? m : (m.id || m.name))
            .filter((id: any): id is string => typeof id === 'string');
        }

        logger.debug('SETTINGS', 'Models fetched successfully', { provider, count: models.length });
        res.json({ models });
      } catch (fetchError: any) {
        clearTimeout(timeoutId);

        if (fetchError.name === 'AbortError') {
          res.json({ models: [], error: 'Request timed out' });
        } else {
          // Sanitize error message (don't leak URL)
          logger.warn('SETTINGS', 'Model fetch error', { provider, error: fetchError.message });
          res.json({ models: [], error: 'Failed to connect to endpoint' });
        }
      }
    } catch (error: any) {
      logger.error('SETTINGS', 'Model fetch handler error', { provider }, error);
      res.json({ models: [], error: 'Internal error' });
    }
  });

  /**
   * GET /api/mcp/status - Check if MCP search server is enabled
   */
  private handleGetMcpStatus = this.wrapHandler((req: Request, res: Response): void => {
    const enabled = this.isMcpEnabled();
    res.json({ enabled });
  });

  /**
   * POST /api/mcp/toggle - Toggle MCP search server on/off
   * Body: { enabled: boolean }
   */
  private handleToggleMcp = this.wrapHandler((req: Request, res: Response): void => {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      this.badRequest(res, 'enabled must be a boolean');
      return;
    }

    this.toggleMcp(enabled);
    res.json({ success: true, enabled: this.isMcpEnabled() });
  });

  /**
   * GET /api/branch/status - Get current branch information
   */
  private handleGetBranchStatus = this.wrapHandler((req: Request, res: Response): void => {
    const info = getBranchInfo();
    res.json(info);
  });

  /**
   * POST /api/branch/switch - Switch to a different branch
   * Body: { branch: "main" | "beta/7.0" }
   */
  private handleSwitchBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { branch } = req.body;

    if (!branch) {
      res.status(400).json({ success: false, error: 'Missing branch parameter' });
      return;
    }

    // Validate branch name
    const allowedBranches = ['main', 'beta/7.0', 'feature/bun-executable'];
    if (!allowedBranches.includes(branch)) {
      res.status(400).json({
        success: false,
        error: `Invalid branch. Allowed: ${allowedBranches.join(', ')}`
      });
      return;
    }

    logger.info('WORKER', 'Branch switch requested', { branch });

    const result = await switchBranch(branch);

    if (result.success) {
      // Schedule worker restart after response is sent
      setTimeout(() => {
        logger.info('WORKER', 'Restarting worker after branch switch');
        process.exit(0); // PM2 will restart the worker
      }, 1000);
    }

    res.json(result);
  });

  /**
   * POST /api/branch/update - Pull latest updates for current branch
   */
  private handleUpdateBranch = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    logger.info('WORKER', 'Branch update requested');

    const result = await pullUpdates();

    if (result.success) {
      // Schedule worker restart after response is sent
      setTimeout(() => {
        logger.info('WORKER', 'Restarting worker after branch update');
        process.exit(0); // PM2 will restart the worker
      }, 1000);
    }

    res.json(result);
  });

  /**
   * Validate all settings from request body (single source of truth)
   */
  private validateSettings(settings: any): { valid: boolean; error?: string } {
    // Validate CLAUDE_MEM_PROVIDER
    if (settings.CLAUDE_MEM_PROVIDER) {
      // Accept 'openrouter' for backwards compatibility (migrated to 'openai')
      const validProviders = ['claude', 'gemini', 'openai', 'openrouter'];
      if (!validProviders.includes(settings.CLAUDE_MEM_PROVIDER)) {
        return { valid: false, error: 'CLAUDE_MEM_PROVIDER must be "claude", "gemini", or "openai"' };
      }
    }

    // Validate CLAUDE_MEM_GEMINI_MODEL
    // Allow any model string if a custom base URL is configured (custom endpoints may have different models)
    if (settings.CLAUDE_MEM_GEMINI_MODEL) {
      const hasCustomBaseUrl = !!settings.CLAUDE_MEM_GEMINI_BASE_URL;
      if (!hasCustomBaseUrl && !KNOWN_GEMINI_MODELS.includes(settings.CLAUDE_MEM_GEMINI_MODEL)) {
        return {
          valid: false,
          error: `CLAUDE_MEM_GEMINI_MODEL must be one of: ${KNOWN_GEMINI_MODELS.join(', ')} (or configure a custom base URL for other models)`
        };
      }
    }

    // Validate CLAUDE_MEM_CONTEXT_OBSERVATIONS
    if (settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS) {
      const obsCount = parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10);
      if (isNaN(obsCount) || obsCount < 1 || obsCount > 200) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 1 and 200' };
      }
    }

    // Validate CLAUDE_MEM_WORKER_PORT
    if (settings.CLAUDE_MEM_WORKER_PORT) {
      const port = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_PORT must be between 1024 and 65535' };
      }
    }

    // Validate CLAUDE_MEM_WORKER_HOST (IP address or 0.0.0.0)
    if (settings.CLAUDE_MEM_WORKER_HOST) {
      const host = settings.CLAUDE_MEM_WORKER_HOST;
      // Allow localhost variants and valid IP patterns
      const validHostPattern = /^(127\.0\.0\.1|0\.0\.0\.0|localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
      if (!validHostPattern.test(host)) {
        return { valid: false, error: 'CLAUDE_MEM_WORKER_HOST must be a valid IP address (e.g., 127.0.0.1, 0.0.0.0)' };
      }
    }

    // Validate CLAUDE_MEM_LOG_LEVEL
    if (settings.CLAUDE_MEM_LOG_LEVEL) {
      const validLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'SILENT'];
      if (!validLevels.includes(settings.CLAUDE_MEM_LOG_LEVEL.toUpperCase())) {
        return { valid: false, error: 'CLAUDE_MEM_LOG_LEVEL must be one of: DEBUG, INFO, WARN, ERROR, SILENT' };
      }
    }

    // Validate CLAUDE_MEM_PYTHON_VERSION (must be valid Python version format)
    if (settings.CLAUDE_MEM_PYTHON_VERSION) {
      const pythonVersionRegex = /^3\.\d{1,2}$/;
      if (!pythonVersionRegex.test(settings.CLAUDE_MEM_PYTHON_VERSION)) {
        return { valid: false, error: 'CLAUDE_MEM_PYTHON_VERSION must be in format "3.X" or "3.XX" (e.g., "3.13")' };
      }
    }

    // Validate boolean string values
    const booleanSettings = [
      'CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT',
      'CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY',
      'CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE',
    ];

    for (const key of booleanSettings) {
      if (settings[key] && !['true', 'false'].includes(settings[key])) {
        return { valid: false, error: `${key} must be "true" or "false"` };
      }
    }

    // Validate FULL_COUNT (0-20)
    if (settings.CLAUDE_MEM_CONTEXT_FULL_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10);
      if (isNaN(count) || count < 0 || count > 20) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_COUNT must be between 0 and 20' };
      }
    }

    // Validate SESSION_COUNT (1-50)
    if (settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT) {
      const count = parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10);
      if (isNaN(count) || count < 1 || count > 50) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 1 and 50' };
      }
    }

    // Validate FULL_FIELD
    if (settings.CLAUDE_MEM_CONTEXT_FULL_FIELD) {
      if (!['narrative', 'facts'].includes(settings.CLAUDE_MEM_CONTEXT_FULL_FIELD)) {
        return { valid: false, error: 'CLAUDE_MEM_CONTEXT_FULL_FIELD must be "narrative" or "facts"' };
      }
    }

    // Validate CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES
    if (settings.CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES) {
      const count = parseInt(settings.CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES, 10);
      if (isNaN(count) || count < 1 || count > 100) {
        return { valid: false, error: 'CLAUDE_MEM_OPENAI_MAX_CONTEXT_MESSAGES must be between 1 and 100' };
      }
    }

    // Validate CLAUDE_MEM_OPENAI_MAX_TOKENS
    if (settings.CLAUDE_MEM_OPENAI_MAX_TOKENS) {
      const tokens = parseInt(settings.CLAUDE_MEM_OPENAI_MAX_TOKENS, 10);
      if (isNaN(tokens) || tokens < 1000 || tokens > 1000000) {
        return { valid: false, error: 'CLAUDE_MEM_OPENAI_MAX_TOKENS must be between 1000 and 1000000' };
      }
    }

    // Validate CLAUDE_MEM_OPENAI_SITE_URL if provided
    if (settings.CLAUDE_MEM_OPENAI_SITE_URL) {
      try {
        new URL(settings.CLAUDE_MEM_OPENAI_SITE_URL);
      } catch (error) {
        // Invalid URL format
        logger.debug('SETTINGS', 'Invalid URL format', { url: settings.CLAUDE_MEM_OPENAI_SITE_URL, error: error instanceof Error ? error.message : String(error) });
        return { valid: false, error: 'CLAUDE_MEM_OPENAI_SITE_URL must be a valid URL' };
      }
    }

    // Validate CLAUDE_MEM_GEMINI_BASE_URL if provided
    if (settings.CLAUDE_MEM_GEMINI_BASE_URL) {
      // Trim whitespace
      const trimmed = settings.CLAUDE_MEM_GEMINI_BASE_URL.trim();
      if (trimmed !== settings.CLAUDE_MEM_GEMINI_BASE_URL) {
        return { valid: false, error: 'CLAUDE_MEM_GEMINI_BASE_URL contains leading/trailing whitespace' };
      }

      if (trimmed) {
        try {
          const parsed = new URL(trimmed);

          // Reject credentials in URL
          if (parsed.username || parsed.password) {
            return { valid: false, error: 'CLAUDE_MEM_GEMINI_BASE_URL must not contain credentials (username:password)' };
          }

          // Require http or https
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'CLAUDE_MEM_GEMINI_BASE_URL must use http:// or https:// protocol' };
          }

          // Warn on http (insecure)
          if (parsed.protocol === 'http:') {
            logger.warn('SETTINGS', 'Insecure http:// protocol used for CLAUDE_MEM_GEMINI_BASE_URL - API keys will be sent in plaintext', {
              url: trimmed
            });
          }
        } catch (error) {
          return { valid: false, error: 'CLAUDE_MEM_GEMINI_BASE_URL must be a valid URL' };
        }
      }
    }

    // Validate CLAUDE_MEM_OPENAI_BASE_URL if provided
    if (settings.CLAUDE_MEM_OPENAI_BASE_URL) {
      // Trim whitespace
      const trimmed = settings.CLAUDE_MEM_OPENAI_BASE_URL.trim();
      if (trimmed !== settings.CLAUDE_MEM_OPENAI_BASE_URL) {
        return { valid: false, error: 'CLAUDE_MEM_OPENAI_BASE_URL contains leading/trailing whitespace' };
      }

      if (trimmed) {
        try {
          const parsed = new URL(trimmed);

          // Reject credentials in URL
          if (parsed.username || parsed.password) {
            return { valid: false, error: 'CLAUDE_MEM_OPENAI_BASE_URL must not contain credentials (username:password)' };
          }

          // Require http or https
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'CLAUDE_MEM_OPENAI_BASE_URL must use http:// or https:// protocol' };
          }

          // Warn on http (insecure)
          if (parsed.protocol === 'http:') {
            logger.warn('SETTINGS', 'Insecure http:// protocol used for CLAUDE_MEM_OPENAI_BASE_URL - API keys will be sent in plaintext', {
              url: trimmed
            });
          }
        } catch (error) {
          return { valid: false, error: 'CLAUDE_MEM_OPENAI_BASE_URL must be a valid URL' };
        }
      }
    }

    // Skip observation types validation - any type string is valid since modes define their own types
    // The database accepts any TEXT value, and mode-specific validation happens at parse time

    // Skip observation concepts validation - any concept string is valid since modes define their own concepts
    // The database accepts any TEXT value, and mode-specific validation happens at parse time

    return { valid: true };
  }

  /**
   * Check if MCP search server is enabled
   */
  private isMcpEnabled(): boolean {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    return existsSync(mcpPath);
  }

  /**
   * Toggle MCP search server (rename .mcp.json <-> .mcp.json.disabled)
   */
  private toggleMcp(enabled: boolean): void {
    const packageRoot = getPackageRoot();
    const mcpPath = path.join(packageRoot, 'plugin', '.mcp.json');
    const mcpDisabledPath = path.join(packageRoot, 'plugin', '.mcp.json.disabled');

    if (enabled && existsSync(mcpDisabledPath)) {
      // Enable: rename .mcp.json.disabled -> .mcp.json
      renameSync(mcpDisabledPath, mcpPath);
      logger.info('WORKER', 'MCP search server enabled');
    } else if (!enabled && existsSync(mcpPath)) {
      // Disable: rename .mcp.json -> .mcp.json.disabled
      renameSync(mcpPath, mcpDisabledPath);
      logger.info('WORKER', 'MCP search server disabled');
    } else {
      logger.debug('WORKER', 'MCP toggle no-op (already in desired state)', { enabled });
    }
  }

  /**
   * Ensure settings file exists, creating with defaults if missing
   */
  private ensureSettingsFile(settingsPath: string): void {
    if (!existsSync(settingsPath)) {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      // Ensure directory exists
      const dir = path.dirname(settingsPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(settingsPath, JSON.stringify(defaults, null, 2), 'utf-8');
      logger.info('SETTINGS', 'Created settings file with defaults', { settingsPath });
    }
  }
}
