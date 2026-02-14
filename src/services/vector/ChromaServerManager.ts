/**
 * ChromaServerManager: Manages a shared ChromaDB HTTP server process
 *
 * Replaces per-session MCP subprocess model with a single shared HTTP server.
 * Handles lifecycle (start, health monitoring, restart, stop), circuit breaker
 * for crash recovery, and SSL certificate passthrough for enterprise proxies.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, VECTOR_DB_DIR } from '../../shared/paths.js';

/** Server lifecycle states */
type ServerState = 'stopped' | 'starting' | 'running' | 'unhealthy';

/** Circuit breaker configuration */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL_MS = 10_000;
const INITIAL_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export class ChromaServerManager {
  private process: ChildProcess | null = null;
  private state: ServerState = 'stopped';
  private healthy = false;
  private port: number;
  private dataDir: string;

  /** Promise-based mutex to prevent concurrent start() calls */
  private startPromise: Promise<void> | null = null;

  /** Health check interval timer */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Circuit breaker: consecutive restart failures */
  private consecutiveFailures = 0;
  private circuitOpen = false;

  /** Exponential backoff delay for restarts */
  private restartDelay = INITIAL_RESTART_DELAY_MS;

  constructor(port?: number, dataDir?: string) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.port = port ?? (parseInt(settings.CLAUDE_MEM_CHROMA_PORT, 10) || 8100);
    this.dataDir = dataDir ?? VECTOR_DB_DIR;

    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /** Whether the server is currently healthy and accepting requests */
  isHealthy(): boolean {
    return this.healthy && this.state === 'running';
  }

  /** Get the HTTP URL for the server */
  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Get the port number */
  getPort(): number {
    return this.port;
  }

  /**
   * Start the ChromaDB HTTP server.
   * Uses a promise-based mutex to prevent concurrent start attempts.
   * Reuses an already-running server if heartbeat succeeds.
   */
  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    // Check if server is already running (from this or another process)
    if (await this.heartbeat()) {
      logger.info('VECTOR', 'Reusing existing ChromaDB server', { port: this.port });
      this.state = 'running';
      this.healthy = true;
      this.consecutiveFailures = 0;
      this.restartDelay = INITIAL_RESTART_DELAY_MS;
      this.startHealthMonitor();
      return;
    }

    if (this.circuitOpen) {
      logger.warn('VECTOR', 'Circuit breaker open — ChromaDB server not started', {
        consecutiveFailures: this.consecutiveFailures,
        port: this.port
      });
      return;
    }

    this.state = 'starting';
    logger.info('VECTOR', 'Starting ChromaDB HTTP server', {
      port: this.port,
      dataDir: this.dataDir
    });

    try {
      await this.spawnServer();
      await this.waitForStartup();

      this.state = 'running';
      this.healthy = true;
      this.consecutiveFailures = 0;
      this.restartDelay = INITIAL_RESTART_DELAY_MS;

      logger.info('VECTOR', 'ChromaDB HTTP server started', { port: this.port });
      this.startHealthMonitor();
    } catch (error) {
      this.state = 'unhealthy';
      this.healthy = false;
      this.consecutiveFailures++;

      if (this.consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
        this.circuitOpen = true;
        logger.error('VECTOR', 'Circuit breaker opened — ChromaDB disabled after repeated failures', {
          consecutiveFailures: this.consecutiveFailures,
          port: this.port
        }, error as Error);
      } else {
        logger.error('VECTOR', 'ChromaDB server failed to start', {
          consecutiveFailures: this.consecutiveFailures,
          port: this.port
        }, error as Error);
      }

      // Clean up any spawned process
      this.killProcess();
    }
  }

  /**
   * Spawn the ChromaDB server subprocess
   */
  private async spawnServer(): Promise<void> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const pythonVersion = settings.CLAUDE_MEM_PYTHON_VERSION;

    // Build environment with SSL cert passthrough for enterprise proxies
    const env = { ...process.env };
    const combinedCertPath = this.getCombinedCertPath();
    if (combinedCertPath) {
      env.SSL_CERT_FILE = combinedCertPath;
      env.REQUESTS_CA_BUNDLE = combinedCertPath;
      env.CURL_CA_BUNDLE = combinedCertPath;
      logger.info('VECTOR', 'Using combined SSL certificates for Zscaler compatibility', {
        certPath: combinedCertPath
      });
    }

    this.process = spawn('uvx', [
      '--python', pythonVersion,
      '--from', 'chromadb',
      'chroma', 'run',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--path', this.dataDir
    ], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    // Log server output for debugging
    this.process.stdout?.on('data', (data: Buffer) => {
      logger.debug('VECTOR', `ChromaDB stdout: ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      // Filter out Python startup noise
      if (msg && !msg.includes('UserWarning') && !msg.includes('FutureWarning')) {
        logger.debug('VECTOR', `ChromaDB stderr: ${msg}`);
      }
    });

    // Handle unexpected process exit
    this.process.on('exit', (code, signal) => {
      if (this.state === 'running') {
        logger.warn('VECTOR', 'ChromaDB server exited unexpectedly', {
          code,
          signal,
          port: this.port
        });
        this.state = 'unhealthy';
        this.healthy = false;
        this.scheduleRestart();
      }
    });

    this.process.on('error', (error) => {
      logger.error('VECTOR', 'ChromaDB process error', { port: this.port }, error);
    });
  }

  /**
   * Wait for the server to become healthy after spawning
   */
  private async waitForStartup(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const pollInterval = 500;

    while (Date.now() < deadline) {
      if (await this.heartbeat()) {
        return;
      }

      // Check if process exited during startup
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`ChromaDB process exited during startup with code ${this.process.exitCode}`);
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error(`ChromaDB server did not respond within ${STARTUP_TIMEOUT_MS}ms`);
  }

  /**
   * Send heartbeat to check server health
   */
  async heartbeat(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://127.0.0.1:${this.port}/api/v2/heartbeat`, {
        signal: controller.signal
      });

      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitor(): void {
    this.stopHealthMonitor();

    this.healthCheckTimer = setInterval(async () => {
      const wasHealthy = this.healthy;
      this.healthy = await this.heartbeat();

      if (wasHealthy && !this.healthy) {
        logger.warn('VECTOR', 'ChromaDB health check failed', { port: this.port });
        this.state = 'unhealthy';
        this.scheduleRestart();
      } else if (!wasHealthy && this.healthy) {
        logger.info('VECTOR', 'ChromaDB health restored', { port: this.port });
        this.state = 'running';
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitor(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Schedule a restart with exponential backoff
   */
  private scheduleRestart(): void {
    if (this.circuitOpen) {
      logger.warn('VECTOR', 'Circuit breaker open — skipping restart', {
        consecutiveFailures: this.consecutiveFailures
      });
      return;
    }

    this.stopHealthMonitor();

    logger.info('VECTOR', 'Scheduling ChromaDB restart', {
      delayMs: this.restartDelay,
      consecutiveFailures: this.consecutiveFailures
    });

    setTimeout(async () => {
      this.killProcess();
      try {
        await this.start();
      } catch (error) {
        logger.error('VECTOR', 'ChromaDB restart failed', {}, error as Error);
      }
    }, this.restartDelay);

    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  /**
   * Stop the ChromaDB server gracefully
   * SIGTERM first, then SIGKILL after timeout
   */
  async stop(): Promise<void> {
    this.stopHealthMonitor();

    if (!this.process || this.process.exitCode !== null) {
      this.state = 'stopped';
      this.healthy = false;
      this.process = null;
      return;
    }

    logger.info('VECTOR', 'Stopping ChromaDB server', { port: this.port, pid: this.process.pid });

    // SIGTERM first (allows graceful SQLite flush)
    this.process.kill('SIGTERM');

    // Wait for exit with timeout
    const exited = await this.waitForExit(SHUTDOWN_TIMEOUT_MS);

    if (!exited) {
      logger.warn('VECTOR', 'ChromaDB did not exit gracefully, sending SIGKILL', {
        pid: this.process?.pid
      });
      this.process?.kill('SIGKILL');
      await this.waitForExit(2000);
    }

    this.process = null;
    this.state = 'stopped';
    this.healthy = false;

    logger.info('VECTOR', 'ChromaDB server stopped');
  }

  /**
   * Wait for the process to exit
   */
  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.process || this.process.exitCode !== null) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMs);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  /**
   * Forcefully kill the process without waiting
   */
  private killProcess(): void {
    if (this.process && this.process.exitCode === null) {
      try {
        this.process.kill('SIGKILL');
      } catch {
        // Process already dead
      }
    }
    this.process = null;
  }

  /**
   * Get or create combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * Reused from ChromaStdioAdapter implementation.
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

    // If combined certs already exist and are recent (less than 24 hours old), use them
    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    // Only create on macOS (Zscaler certificate extraction uses macOS security command)
    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch {
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch {
        return undefined;
      }

      if (!zscalerCert ||
          !zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);
      logger.info('VECTOR', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('VECTOR', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }
}
