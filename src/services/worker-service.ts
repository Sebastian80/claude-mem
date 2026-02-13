/**
 * Worker Service - Slim Orchestrator
 *
 * Refactored from 2000-line monolith to ~300-line orchestrator.
 * Delegates to specialized modules:
 * - src/services/server/ - HTTP server, middleware, error handling
 * - src/services/infrastructure/ - Process management, health monitoring, shutdown
 * - src/services/integrations/ - IDE integrations (Cursor)
 * - src/services/worker/ - Business logic, routes, agents
 */

import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getWorkerPort, getWorkerHost } from '../shared/worker-utils.js';
import { logger } from '../utils/logger.js';

// Version injected at build time by esbuild define
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

// Infrastructure imports
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  cleanupOrphanedProcesses,
  spawnDaemon,
  createSignalHandler
} from './infrastructure/ProcessManager.js';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  httpShutdown,
  checkVersionMatch
} from './infrastructure/HealthMonitor.js';
import { performGracefulShutdown } from './infrastructure/GracefulShutdown.js';

// Server imports
import { Server } from './server/Server.js';

// Integration imports
import {
  updateCursorContextForProject,
  handleCursorCommand
} from './integrations/CursorHooksInstaller.js';

// Service layer imports
import { DatabaseManager } from './worker/DatabaseManager.js';
import { SessionManager } from './worker/SessionManager.js';
import { SSEBroadcaster } from './worker/SSEBroadcaster.js';
import { SDKAgent } from './worker/SDKAgent.js';
import { GeminiAgent, isGeminiSelected, isGeminiAvailable } from './worker/GeminiAgent.js';
import { OpenAIAgent, isOpenAISelected, isOpenAIAvailable } from './worker/OpenAIAgent.js';
import { PaginationHelper } from './worker/PaginationHelper.js';
import { SettingsManager } from './worker/SettingsManager.js';
import { SearchManager } from './worker/SearchManager.js';
import { FormattingService } from './worker/FormattingService.js';
import { TimelineService } from './worker/TimelineService.js';
import { SessionEventBroadcaster } from './worker/events/SessionEventBroadcaster.js';
import { SettingsWatcher, SettingsChangeEvent, RESTART_TRIGGER_KEYS } from './worker/settings/SettingsWatcher.js';
import { USER_SETTINGS_PATH } from '../shared/paths.js';

// HTTP route handlers
import { ViewerRoutes } from './worker/http/routes/ViewerRoutes.js';
import { SessionRoutes } from './worker/http/routes/SessionRoutes.js';
import { DataRoutes } from './worker/http/routes/DataRoutes.js';
import { SearchRoutes } from './worker/http/routes/SearchRoutes.js';
import { SettingsRoutes } from './worker/http/routes/SettingsRoutes.js';
import { LogsRoutes } from './worker/http/routes/LogsRoutes.js';
import { MemoryRoutes } from './worker/http/routes/MemoryRoutes.js';

// Process management for zombie cleanup (Issue #737)
import { startOrphanReaper, reapOrphanedProcesses } from './worker/ProcessRegistry.js';

/**
 * Build JSON status output for hook framework communication.
 * This is a pure function extracted for testability.
 *
 * @param status - 'ready' for successful startup, 'error' for failures
 * @param message - Optional error message (only included when provided)
 * @returns JSON object with continue, suppressOutput, status, and optionally message
 */
export interface StatusOutput {
  continue: true;
  suppressOutput: true;
  status: 'ready' | 'error';
  message?: string;
}

export function buildStatusOutput(status: 'ready' | 'error', message?: string): StatusOutput {
  return {
    continue: true,
    suppressOutput: true,
    status,
    ...(message && { message })
  };
}

export class WorkerService {
  private server: Server;
  private startTime: number = Date.now();
  private mcpClient: Client;

  // Initialization flags
  private mcpReady: boolean = false;
  private initializationCompleteFlag: boolean = false;
  private isShuttingDown: boolean = false;

  // Service layer
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private sseBroadcaster: SSEBroadcaster;
  private sdkAgent: SDKAgent;
  private geminiAgent: GeminiAgent;
  private openAIAgent: OpenAIAgent;
  private paginationHelper: PaginationHelper;
  private settingsManager: SettingsManager;
  private sessionEventBroadcaster: SessionEventBroadcaster;

  // Route handlers
  private searchRoutes: SearchRoutes | null = null;

  // Settings watcher for hot-reload
  private settingsWatcher: SettingsWatcher;

  // Initialization tracking
  private initializationComplete: Promise<void>;
  private resolveInitialization!: () => void;

  // Orphan reaper cleanup function (Issue #737)
  private stopOrphanReaper: (() => void) | null = null;

  // Periodic recovery cleanup function (Phase 4 of Stuck Message Recovery)
  private stopPeriodicRecovery: (() => void) | null = null;

  constructor() {
    // Initialize the promise that will resolve when background initialization completes
    this.initializationComplete = new Promise((resolve) => {
      this.resolveInitialization = resolve;
    });

    // Initialize service layer
    this.dbManager = new DatabaseManager();
    this.sessionManager = new SessionManager(this.dbManager);
    this.sseBroadcaster = new SSEBroadcaster();
    this.sdkAgent = new SDKAgent(this.dbManager, this.sessionManager);
    this.geminiAgent = new GeminiAgent(this.dbManager, this.sessionManager);
    this.openAIAgent = new OpenAIAgent(this.dbManager, this.sessionManager);

    this.paginationHelper = new PaginationHelper(this.dbManager);
    this.settingsManager = new SettingsManager(this.dbManager);
    this.sessionEventBroadcaster = new SessionEventBroadcaster(this.sseBroadcaster, this);

    // Set callback for when sessions are deleted
    this.sessionManager.setOnSessionDeleted(() => {
      this.broadcastProcessingStatus();
    });

    // Initialize settings watcher for hot-reload
    this.settingsWatcher = new SettingsWatcher(USER_SETTINGS_PATH);
    this.settingsWatcher.on('change', (event: SettingsChangeEvent) => {
      this.handleSettingsChange(event);
    });

    // Initialize MCP client
    // Empty capabilities object: this client only calls tools, doesn't expose any
    this.mcpClient = new Client({
      name: 'worker-search-proxy',
      version: packageVersion
    }, { capabilities: {} });

    // Initialize HTTP server with core routes
    this.server = new Server({
      getInitializationComplete: () => this.initializationCompleteFlag,
      getMcpReady: () => this.mcpReady,
      onShutdown: () => this.shutdown(),
      onRestart: () => this.shutdown()
    });

    // Register route handlers
    this.registerRoutes();

    // Register signal handlers early to ensure cleanup even if start() hasn't completed
    this.registerSignalHandlers();
  }

  /**
   * Register signal handlers for graceful shutdown
   */
  private registerSignalHandlers(): void {
    const shutdownRef = { value: this.isShuttingDown };
    const handler = createSignalHandler(() => this.shutdown(), shutdownRef);

    process.on('SIGTERM', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGTERM');
    });
    process.on('SIGINT', () => {
      this.isShuttingDown = shutdownRef.value;
      handler('SIGINT');
    });
  }

  /**
   * Register all route handlers with the server
   */
  private registerRoutes(): void {
    // Standard routes
    this.server.registerRoutes(new ViewerRoutes(this.sseBroadcaster, this.dbManager, this.sessionManager));
    this.server.registerRoutes(new SessionRoutes(this.sessionManager, this.dbManager, this.sdkAgent, this.geminiAgent, this.openAIAgent, this.sessionEventBroadcaster, this));
    this.server.registerRoutes(new DataRoutes(this.paginationHelper, this.dbManager, this.sessionManager, this.sseBroadcaster, this, this.startTime));
    this.server.registerRoutes(new SettingsRoutes(this.settingsManager));
    this.server.registerRoutes(new LogsRoutes());
    this.server.registerRoutes(new MemoryRoutes(this.dbManager, 'claude-mem'));

    // Early handler for /api/context/inject to avoid 404 during startup
    this.server.app.get('/api/context/inject', async (req, res, next) => {
      const timeoutMs = 300000; // 5 minute timeout for slow systems
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialization timeout')), timeoutMs)
      );

      await Promise.race([this.initializationComplete, timeoutPromise]);

      if (!this.searchRoutes) {
        res.status(503).json({ error: 'Search routes not initialized' });
        return;
      }

      next(); // Delegate to SearchRoutes handler
    });
  }

  /**
   * Start the worker service
   */
  async start(): Promise<void> {
    const port = getWorkerPort();
    const host = getWorkerHost();

    // Start HTTP server FIRST - make port available immediately
    await this.server.listen(port, host);

    // Worker writes its own PID - reliable on all platforms
    // This happens after listen() succeeds, ensuring the worker is actually ready
    // On Windows, the spawner's PID is cmd.exe (useless), so worker must write its own
    writePidFile({
      pid: process.pid,
      port,
      startedAt: new Date().toISOString()
    });

    logger.info('SYSTEM', 'Worker started', { host, port, pid: process.pid });

    // Do slow initialization in background (non-blocking)
    // On failure, exit the process so the hook system can restart a clean worker.
    // Without this, the HTTP server stays up but can't serve real requests (half-alive).
    this.initializeBackground().catch((error) => {
      logger.error('SYSTEM', 'Background initialization failed, shutting down', {}, error as Error);
      process.exit(1);
    });
  }

  /**
   * Background initialization - runs after HTTP server is listening
   */
  private async initializeBackground(): Promise<void> {
    try {
      await cleanupOrphanedProcesses();

      // Load mode configuration
      const { ModeManager } = await import('./domain/ModeManager.js');
      const { SettingsDefaultsManager } = await import('../shared/SettingsDefaultsManager.js');
      const { USER_SETTINGS_PATH } = await import('../shared/paths.js');

      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const modeId = settings.CLAUDE_MEM_MODE;
      ModeManager.getInstance().loadMode(modeId);
      logger.info('SYSTEM', `Mode loaded: ${modeId}`);

      await this.dbManager.initialize();

      // Recover stuck messages from previous crashes
      const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
      const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
      const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
      const resetCount = pendingStore.resetStuckMessages(STUCK_THRESHOLD_MS);
      if (resetCount > 0) {
        logger.info('SYSTEM', `Recovered ${resetCount} stuck messages from previous session`, { thresholdMinutes: 5 });
      }

      // Initialize search services
      const formattingService = new FormattingService();
      const timelineService = new TimelineService();
      const vectorStore = this.dbManager.getVectorStore();
      const searchManager = new SearchManager(
        this.dbManager.getSessionSearch(),
        this.dbManager.getSessionStore(),
        vectorStore,
        formattingService,
        timelineService
      );
      this.searchRoutes = new SearchRoutes(searchManager);
      this.server.registerRoutes(this.searchRoutes);
      logger.info('WORKER', 'SearchManager initialized and search routes registered');

      // Connect to MCP server
      const mcpServerPath = path.join(__dirname, 'mcp-server.cjs');
      const transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env: process.env
      });

      const MCP_INIT_TIMEOUT_MS = 300000;
      const mcpConnectionPromise = this.mcpClient.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP connection timeout after 5 minutes')), MCP_INIT_TIMEOUT_MS)
      );

      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.mcpReady = true;
      logger.success('WORKER', 'Connected to MCP server');

      this.initializationCompleteFlag = true;
      this.resolveInitialization();
      logger.info('SYSTEM', 'Background initialization complete');

      // Start settings watcher for hot-reload
      this.settingsWatcher.start();

      // Start orphan reaper to clean up zombie processes (Issue #737)
      this.stopOrphanReaper = startOrphanReaper(() => {
        const activeIds = new Set<number>();
        for (const [id] of this.sessionManager['sessions']) {
          activeIds.add(id);
        }
        return activeIds;
      });
      logger.info('SYSTEM', 'Started orphan reaper (runs every 5 minutes)');

      // Start periodic recovery to recover orphaned sessions (Phase 4 of Stuck Message Recovery)
      this.stopPeriodicRecovery = this.startPeriodicRecovery();

      // Auto-recover orphaned queues (fire-and-forget with error logging)
      this.processPendingQueues(50).then(result => {
        if (result.sessionsStarted > 0) {
          logger.info('SYSTEM', `Auto-recovered ${result.sessionsStarted} sessions with pending work`, {
            totalPending: result.totalPendingSessions,
            started: result.sessionsStarted,
            sessionIds: result.startedSessionIds
          });
        }
      }).catch(error => {
        logger.error('SYSTEM', 'Auto-recovery of pending queues failed', {}, error as Error);
      });
    } catch (error) {
      logger.error('SYSTEM', 'Background initialization failed', {}, error as Error);
      throw error;
    }
  }

  /**
   * Get the currently selected provider name based on settings
   */
  private getSelectedProvider(): 'claude' | 'gemini' | 'openai' {
    if (isOpenAISelected() && isOpenAIAvailable()) {
      return 'openai';
    }
    return (isGeminiSelected() && isGeminiAvailable()) ? 'gemini' : 'claude';
  }

  /**
   * Start a session processor with the specified provider
   */
  private startSessionProcessor(
    session: ReturnType<typeof this.sessionManager.getSession>,
    source: string,
    provider?: 'claude' | 'gemini' | 'openai'
  ): void {
    if (!session) return;

    // Recovery/manual starts should clear stale pendingRestart flags.
    // Otherwise SessionManager's iterator stop-check can immediately exit
    // before claiming queued messages, leaving work stuck in "pending".
    if (session.pendingRestart) {
      logger.info('SYSTEM', 'Clearing stale pendingRestart before generator start', {
        sessionId: session.sessionDbId,
        source,
        reason: session.pendingRestart.reason,
        waitedMs: Date.now() - session.pendingRestart.requestedAt
      });
      session.pendingRestart = null;
    }

    // Reset AbortController if stale (aborted by previous generator cleanup)
    // This prevents message iterators from immediately exiting due to stale abort signal
    if (session.abortController.signal.aborted) {
      logger.info('SYSTEM', `Resetting stale AbortController before generator start`, {
        sessionId: session.sessionDbId,
        source
      });
      session.abortController = new AbortController();
    }

    // Use provided provider or detect from settings
    const selectedProvider = provider ?? this.getSelectedProvider();
    const sid = session.sessionDbId;
    logger.info('SYSTEM', `Starting generator (${source}) with provider=${selectedProvider}`, { sessionId: sid });

    // Select the appropriate agent based on provider
    let agentPromise: Promise<void>;
    switch (selectedProvider) {
      case 'gemini':
        agentPromise = this.geminiAgent.startSession(session, this);
        break;
      case 'openai':
        agentPromise = this.openAIAgent.startSession(session, this);
        break;
      case 'claude':
      default:
        agentPromise = this.sdkAgent.startSession(session, this);
        break;
    }

    session.generatorPromise = agentPromise
      .catch(async (error: unknown) => {
        if (this.isSessionTerminatedError(error)) {
          logger.warn('SDK', 'Session terminated, falling back to standalone processing', {
            sessionId: session.sessionDbId,
            project: session.project,
            provider: selectedProvider,
            reason: error instanceof Error ? error.message : String(error)
          });
          return this.runFallbackForTerminatedSession(session, error);
        }
        logger.error('SDK', 'Session generator failed', {
          sessionId: session.sessionDbId,
          project: session.project,
          provider: selectedProvider
        }, error as Error);
      })
      .finally(() => {
        session.generatorPromise = null;
        this.broadcastProcessingStatus();
      });
  }

  /**
   * Match errors that indicate the Claude Code process/session is gone (resume impossible).
   * Used to trigger graceful fallback instead of leaving pending messages stuck forever.
   * Adapted from upstream PR #937 by @jayvenn21.
   */
  private isSessionTerminatedError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const normalized = msg.toLowerCase();
    return (
      normalized.includes('process aborted by user') ||
      normalized.includes('processtransport') ||
      normalized.includes('not ready for writing') ||
      normalized.includes('session generator failed') ||
      normalized.includes('claude code process')
    );
  }

  /**
   * When a session processor fails due to terminated session: try Gemini then OpenAI to drain
   * pending messages; if no fallback available, mark messages abandoned and remove session.
   * Adapted from upstream PR #937 by @jayvenn21 (OpenRouter → OpenAI for this fork).
   */
  private async runFallbackForTerminatedSession(
    session: ReturnType<typeof this.sessionManager.getSession>,
    _originalError: unknown
  ): Promise<void> {
    if (!session) return;

    const sessionDbId = session.sessionDbId;

    // Fallback agents need memorySessionId for storeObservations
    if (!session.memorySessionId) {
      const syntheticId = `fallback-${sessionDbId}-${Date.now()}`;
      session.memorySessionId = syntheticId;
      this.dbManager.getSessionStore().updateMemorySessionId(sessionDbId, syntheticId);
    }

    if (isGeminiAvailable()) {
      try {
        await this.geminiAgent.startSession(session, this);
        return;
      } catch (e) {
        logger.warn('SDK', 'Fallback Gemini failed, trying OpenAI', {
          sessionId: sessionDbId,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }

    if (isOpenAIAvailable()) {
      try {
        await this.openAIAgent.startSession(session, this);
        return;
      } catch (e) {
        logger.warn('SDK', 'Fallback OpenAI failed', {
          sessionId: sessionDbId,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }

    // No fallback or both failed: mark messages abandoned and remove session so queue doesn't grow
    const pendingStore = this.sessionManager.getPendingMessageStore();
    const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
    if (abandoned > 0) {
      logger.warn('SDK', 'No fallback available; marked pending messages abandoned', {
        sessionId: sessionDbId,
        abandoned
      });
    }
    this.sessionManager.removeSessionImmediate(sessionDbId);
    this.sessionEventBroadcaster.broadcastSessionCompleted(sessionDbId);
  }

  /**
   * Process pending session queues
   * @param sessionLimit - Maximum number of sessions to start
   * @param source - Source identifier for logging (e.g., 'startup-recovery', 'periodic-recovery', 'manual-api')
   */
  async processPendingQueues(sessionLimit: number = 10, source: string = 'startup-recovery'): Promise<{
    totalPendingSessions: number;
    sessionsStarted: number;
    sessionsSkipped: number;
    startedSessionIds: number[];
  }> {
    const { PendingMessageStore } = await import('./sqlite/PendingMessageStore.js');
    const pendingStore = new PendingMessageStore(this.dbManager.getSessionStore().db, 3);
    const orphanedSessionIds = pendingStore.getSessionsWithPendingMessages();

    const result = {
      totalPendingSessions: orphanedSessionIds.length,
      sessionsStarted: 0,
      sessionsSkipped: 0,
      startedSessionIds: [] as number[]
    };

    if (orphanedSessionIds.length === 0) return result;

    logger.info('SYSTEM', `Processing up to ${sessionLimit} of ${orphanedSessionIds.length} pending session queues`);

    for (const sessionDbId of orphanedSessionIds) {
      if (result.sessionsStarted >= sessionLimit) break;

      try {
        const existingSession = this.sessionManager.getSession(sessionDbId);
        // Skip if generator is already running OR recovery is in progress (Phase 3 flag)
        if (existingSession?.generatorPromise || existingSession?.recoveryInProgress) {
          result.sessionsSkipped++;
          continue;
        }

        const session = this.sessionManager.initializeSession(sessionDbId);
        logger.info('SYSTEM', `Starting processor for session ${sessionDbId}`, {
          project: session.project,
          pendingCount: pendingStore.getPendingCount(sessionDbId),
          source
        });

        this.startSessionProcessor(session, source);
        result.sessionsStarted++;
        result.startedSessionIds.push(sessionDbId);

        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error('SYSTEM', `Failed to process session ${sessionDbId}`, {}, error as Error);
        result.sessionsSkipped++;
      }
    }

    return result;
  }

  /**
   * Start periodic recovery for orphaned sessions with pending messages.
   * Runs at configurable interval (default: 5 minutes) with jitter to prevent thundering herd.
   *
   * This is Phase 4 of the Stuck Message Recovery bugfix (v9.0.8-jv.3).
   *
   * Key behaviors:
   * - Uses `processPendingQueues()` which checks both `generatorPromise` and `recoveryInProgress` flag
   * - Does NOT call `resetStuckMessages()` - that's handled by a separate timeout
   * - Jitter (0-20% additive) prevents multiple workers from recovering simultaneously
   */
  private startPeriodicRecovery(): (() => void) | null {
    const { SettingsDefaultsManager } = require('../shared/SettingsDefaultsManager.js');
    const { USER_SETTINGS_PATH } = require('../shared/paths.js');

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    // Check if periodic recovery is enabled
    const enabled = settings.CLAUDE_MEM_PERIODIC_RECOVERY_ENABLED?.toLowerCase() !== 'false';
    if (!enabled) {
      logger.info('SYSTEM', 'Periodic recovery disabled by setting');
      return null;
    }

    // Get interval (default: 5 minutes)
    const parsedInterval = parseInt(settings.CLAUDE_MEM_PERIODIC_RECOVERY_INTERVAL || '300000', 10);
    const baseInterval = isNaN(parsedInterval) ? 300000 : parsedInterval;
    if (baseInterval < 60000) {
      logger.warn('SYSTEM', 'Periodic recovery interval too low, using minimum 60s', {
        configured: settings.CLAUDE_MEM_PERIODIC_RECOVERY_INTERVAL
      });
    }
    const interval = Math.max(60000, baseInterval); // Minimum 1 minute

    // Add jitter: 0-20% of interval to prevent thundering herd
    const getJitteredInterval = () => {
      const jitter = Math.random() * 0.2 * interval;
      return interval + jitter;
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const runRecovery = async () => {
      if (stopped) return;

      try {
        // Check for sessions with pending messages that have no running generator
        const result = await this.processPendingQueues(10, 'periodic-recovery');

        if (result.sessionsStarted > 0) {
          logger.info('SYSTEM', `Periodic recovery: started ${result.sessionsStarted} sessions`, {
            totalPending: result.totalPendingSessions,
            started: result.sessionsStarted,
            skipped: result.sessionsSkipped,
            sessionIds: result.startedSessionIds
          });
        } else if (result.totalPendingSessions > 0) {
          // Sessions exist but were skipped (already have generators)
          logger.debug('SYSTEM', 'Periodic recovery: sessions have pending work but generators are running', {
            totalPending: result.totalPendingSessions,
            skipped: result.sessionsSkipped
          });
        }
      } catch (error) {
        logger.error('SYSTEM', 'Periodic recovery failed', {}, error as Error);
      }

      // Schedule next run with jitter
      if (!stopped) {
        const nextInterval = getJitteredInterval();
        timeoutId = setTimeout(runRecovery, nextInterval);
      }
    };

    // Start first run after initial jitter delay
    const initialDelay = getJitteredInterval();
    logger.info('SYSTEM', `Started periodic recovery (interval: ${Math.round(interval / 1000)}s, first run in ${Math.round(initialDelay / 1000)}s)`);
    timeoutId = setTimeout(runRecovery, initialDelay);

    // Return cleanup function
    return () => {
      stopped = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
  }

  /**
   * Shutdown the worker service
   */
  async shutdown(): Promise<void> {
    // Stop settings watcher to prevent process leak
    this.settingsWatcher.stop();

    // Stop periodic recovery before shutdown (Phase 4 of Stuck Message Recovery)
    if (this.stopPeriodicRecovery) {
      this.stopPeriodicRecovery();
      this.stopPeriodicRecovery = null;
    }

    // Stop orphan reaper before shutdown (Issue #737)
    if (this.stopOrphanReaper) {
      this.stopOrphanReaper();
      this.stopOrphanReaper = null;
    }

    await performGracefulShutdown({
      server: this.server.getHttpServer(),
      sessionManager: this.sessionManager,
      mcpClient: this.mcpClient,
      dbManager: this.dbManager
    });
  }

  /**
   * Broadcast processing status change to SSE clients
   */
  broadcastProcessingStatus(): void {
    const isProcessing = this.sessionManager.isAnySessionProcessing();
    const queueDepth = this.sessionManager.getTotalActiveWork();
    const activeSessions = this.sessionManager.getActiveSessionCount();

    logger.info('WORKER', 'Broadcasting processing status', {
      isProcessing,
      queueDepth,
      activeSessions
    });

    this.sseBroadcaster.broadcast({
      type: 'processing_status',
      isProcessing,
      queueDepth
    });
  }

  /**
   * Handle settings file changes (hot-reload)
   * Schedules generator restarts for active sessions when provider/model changes
   */
  private handleSettingsChange(event: SettingsChangeEvent): void {
    if (!event.restartRequired) {
      logger.debug('SETTINGS', 'Settings changed but no restart required', {
        changedKeys: event.changedKeys
      });
      return;
    }

    // Find restart-trigger keys that changed
    const restartKeys = event.changedKeys.filter(key =>
      RESTART_TRIGGER_KEYS.includes(key)
    );

    logger.info('SETTINGS', 'Settings changed - scheduling generator restarts', {
      restartKeys,
      activeSessions: this.sessionManager.getActiveSessionCount()
    });

    // Mark all active sessions for restart
    this.sessionManager.scheduleRestartsForSettingsChange(restartKeys.join(','));

    // Broadcast settings change to UI
    this.sseBroadcaster.broadcast({
      type: 'settings_changed',
      changedKeys: event.changedKeys,
      restartRequired: true
    });
  }
}

// ============================================================================
// Reusable Worker Startup Logic
// ============================================================================

/**
 * Ensures the worker is started and healthy.
 * This function can be called by both 'start' and 'hook' commands.
 *
 * @param port - The port the worker should run on
 * @returns true if worker is healthy (existing or newly started), false on failure
 */
async function ensureWorkerStarted(port: number): Promise<boolean> {
  // Check if worker is already running and healthy
  if (await waitForHealth(port, 1000)) {
    const versionCheck = await checkVersionMatch(port);
    if (!versionCheck.matches) {
      logger.info('SYSTEM', 'Worker version mismatch detected - auto-restarting', {
        pluginVersion: versionCheck.pluginVersion,
        workerVersion: versionCheck.workerVersion
      });

      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown for version mismatch restart', { port });
        return false;
      }
      removePidFile();
    } else {
      logger.info('SYSTEM', 'Worker already running and healthy');
      return true;
    }
  }

  // Check if port is in use by something else
  const portInUse = await isPortInUse(port);
  if (portInUse) {
    logger.info('SYSTEM', 'Port in use, waiting for worker to become healthy');
    const healthy = await waitForHealth(port, getPlatformTimeout(15000));
    if (healthy) {
      logger.info('SYSTEM', 'Worker is now healthy');
      return true;
    }
    logger.error('SYSTEM', 'Port in use but worker not responding to health checks');
    return false;
  }

  // Spawn new worker daemon
  logger.info('SYSTEM', 'Starting worker daemon');
  const pid = spawnDaemon(__filename, port);
  if (pid === undefined) {
    logger.error('SYSTEM', 'Failed to spawn worker daemon');
    return false;
  }

  // PID file is written by the worker itself after listen() succeeds
  // This is race-free and works correctly on Windows where cmd.exe PID is useless

  const healthy = await waitForHealth(port, getPlatformTimeout(30000));
  if (!healthy) {
    removePidFile();
    logger.error('SYSTEM', 'Worker failed to start (health check timeout)');
    return false;
  }

  logger.info('SYSTEM', 'Worker started successfully');
  return true;
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const command = process.argv[2];
  const port = getWorkerPort();

  // Helper for JSON status output in 'start' command
  // Exit code 0 ensures Windows Terminal doesn't keep tabs open
  function exitWithStatus(status: 'ready' | 'error', message?: string): never {
    const output = buildStatusOutput(status, message);
    console.log(JSON.stringify(output));
    process.exit(0);
  }

  switch (command) {
    case 'start': {
      const success = await ensureWorkerStarted(port);
      if (success) {
        exitWithStatus('ready');
      } else {
        exitWithStatus('error', 'Failed to start worker');
      }
    }

    case 'stop': {
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.warn('SYSTEM', 'Port did not free up after shutdown', { port });
      }
      removePidFile();
      logger.info('SYSTEM', 'Worker stopped successfully');
      process.exit(0);
    }

    case 'restart': {
      logger.info('SYSTEM', 'Restarting worker');
      await httpShutdown(port);
      const freed = await waitForPortFree(port, getPlatformTimeout(15000));
      if (!freed) {
        logger.error('SYSTEM', 'Port did not free up after shutdown, aborting restart', { port });
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }
      removePidFile();

      const pid = spawnDaemon(__filename, port);
      if (pid === undefined) {
        logger.error('SYSTEM', 'Failed to spawn worker daemon during restart');
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }

      // PID file is written by the worker itself after listen() succeeds
      // This is race-free and works correctly on Windows where cmd.exe PID is useless

      const healthy = await waitForHealth(port, getPlatformTimeout(30000));
      if (!healthy) {
        removePidFile();
        logger.error('SYSTEM', 'Worker failed to restart');
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      }

      logger.info('SYSTEM', 'Worker restarted successfully');
      process.exit(0);
    }

    case 'status': {
      const running = await isPortInUse(port);
      const pidInfo = readPidFile();
      if (running && pidInfo) {
        console.log('Worker is running');
        console.log(`  PID: ${pidInfo.pid}`);
        console.log(`  Port: ${pidInfo.port}`);
        console.log(`  Started: ${pidInfo.startedAt}`);
      } else {
        console.log('Worker is not running');
      }
      process.exit(0);
    }

    case 'cursor': {
      const subcommand = process.argv[3];
      const cursorResult = await handleCursorCommand(subcommand, process.argv.slice(4));
      process.exit(cursorResult);
    }

    case 'hook': {
      // Auto-start worker if not running
      const workerReady = await ensureWorkerStarted(port);
      if (!workerReady) {
        logger.warn('SYSTEM', 'Worker failed to start before hook, handler will retry');
      }

      // Existing logic unchanged
      const platform = process.argv[3];
      const event = process.argv[4];
      if (!platform || !event) {
        console.error('Usage: claude-mem hook <platform> <event>');
        console.error('Platforms: claude-code, cursor, raw');
        console.error('Events: context, session-init, observation, summarize, session-complete');
        process.exit(1);
      }

      // Check if worker is already running on port
      const portInUse = await isPortInUse(port);
      let startedWorkerInProcess = false;

      if (!portInUse) {
        // Port free - start worker IN THIS PROCESS (no spawn!)
        // This process becomes the worker and stays alive
        try {
          logger.info('SYSTEM', 'Starting worker in-process for hook', { event });
          const worker = new WorkerService();
          await worker.start();
          startedWorkerInProcess = true;
          // Worker is now running in this process on the port
        } catch (error) {
          logger.failure('SYSTEM', 'Worker failed to start in hook', {}, error as Error);
          removePidFile();
          process.exit(0);
        }
      }
      // If port in use, we'll use HTTP to the existing worker

      const { hookCommand } = await import('../cli/hook-command.js');
      // If we started the worker in this process, skip process.exit() so we stay alive as the worker
      await hookCommand(platform, event, { skipExit: startedWorkerInProcess });
      // Note: if we started worker in-process, this process stays alive as the worker
      // The break allows the event loop to continue serving requests
      break;
    }

    case '--daemon':
    default: {
      const worker = new WorkerService();
      worker.start().catch((error) => {
        logger.failure('SYSTEM', 'Worker failed to start', {}, error as Error);
        removePidFile();
        // Exit gracefully: Windows Terminal won't keep tab open on exit 0
        // The wrapper/plugin will handle restart logic if needed
        process.exit(0);
      });
    }
  }
}

// Check if running as main module in both ESM and CommonJS
const isMainModule = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module || !module.parent
  : import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('worker-service');

if (isMainModule) {
  main();
}
