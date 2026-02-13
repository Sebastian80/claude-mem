import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../../src/utils/logger.js';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  parseElapsedTime,
  getChildProcesses,
  getDescendantProcesses,
  gracefulKillProcess,
  type PidInfo
} from '../../src/services/infrastructure/index.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

describe('ProcessManager', () => {
  // Store original PID file content if it exists
  let originalPidContent: string | null = null;

  beforeEach(() => {
    // Backup existing PID file if present
    if (existsSync(PID_FILE)) {
      originalPidContent = readFileSync(PID_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original PID file or remove test one
    if (originalPidContent !== null) {
      const { writeFileSync } = require('fs');
      writeFileSync(PID_FILE, originalPidContent);
      originalPidContent = null;
    } else {
      removePidFile();
    }
  });

  describe('writePidFile', () => {
    it('should create file with PID info', () => {
      const testInfo: PidInfo = {
        pid: 12345,
        port: 37777,
        startedAt: new Date().toISOString()
      };

      writePidFile(testInfo);

      expect(existsSync(PID_FILE)).toBe(true);
      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(12345);
      expect(content.port).toBe(37777);
      expect(content.startedAt).toBe(testInfo.startedAt);
    });

    it('should overwrite existing PID file', () => {
      const firstInfo: PidInfo = {
        pid: 11111,
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      const secondInfo: PidInfo = {
        pid: 22222,
        port: 37888,
        startedAt: '2024-01-02T00:00:00.000Z'
      };

      writePidFile(firstInfo);
      writePidFile(secondInfo);

      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(22222);
      expect(content.port).toBe(37888);
    });
  });

  describe('readPidFile', () => {
    it('should return PidInfo object for valid file', () => {
      const testInfo: PidInfo = {
        pid: 54321,
        port: 37999,
        startedAt: '2024-06-15T12:00:00.000Z'
      };
      writePidFile(testInfo);

      const result = readPidFile();

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(54321);
      expect(result!.port).toBe(37999);
      expect(result!.startedAt).toBe('2024-06-15T12:00:00.000Z');
    });

    it('should return null for missing file', () => {
      // Ensure file doesn't exist
      removePidFile();

      const result = readPidFile();

      expect(result).toBeNull();
    });

    it('should return null for corrupted JSON', () => {
      const { writeFileSync } = require('fs');
      writeFileSync(PID_FILE, 'not valid json {{{');

      const result = readPidFile();

      expect(result).toBeNull();
    });
  });

  describe('removePidFile', () => {
    it('should delete existing file', () => {
      const testInfo: PidInfo = {
        pid: 99999,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(testInfo);
      expect(existsSync(PID_FILE)).toBe(true);

      removePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should not throw for missing file', () => {
      // Ensure file doesn't exist
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      // Should not throw
      expect(() => removePidFile()).not.toThrow();
    });
  });

  describe('parseElapsedTime', () => {
    it('should parse MM:SS format', () => {
      expect(parseElapsedTime('05:30')).toBe(5);
      expect(parseElapsedTime('00:45')).toBe(0);
      expect(parseElapsedTime('59:59')).toBe(59);
    });

    it('should parse HH:MM:SS format', () => {
      expect(parseElapsedTime('01:30:00')).toBe(90);
      expect(parseElapsedTime('02:15:30')).toBe(135);
      expect(parseElapsedTime('00:05:00')).toBe(5);
    });

    it('should parse DD-HH:MM:SS format', () => {
      expect(parseElapsedTime('1-00:00:00')).toBe(1440);  // 1 day
      expect(parseElapsedTime('2-12:30:00')).toBe(3630);  // 2 days + 12.5 hours
      expect(parseElapsedTime('0-01:00:00')).toBe(60);    // 1 hour
    });

    it('should return -1 for empty or invalid input', () => {
      expect(parseElapsedTime('')).toBe(-1);
      expect(parseElapsedTime('   ')).toBe(-1);
      expect(parseElapsedTime('invalid')).toBe(-1);
    });
  });

  describe('getChildProcesses', () => {
    it('should return child PIDs on Linux', async () => {
      // Spawn a real child process that sleeps
      const child = spawn('sleep', ['60'], { detached: false });
      const childPid = child.pid!;

      try {
        const children = await getChildProcesses(process.pid);

        // Must find our spawned child
        expect(children).toContain(childPid);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('should return empty array for process with no children', async () => {
      // PID 1 (init) has children, but a random high PID likely doesn't
      // Use a PID we know exists but has no children: the sleep process itself
      const child = spawn('sleep', ['60'], { detached: false });
      const childPid = child.pid!;

      try {
        const grandchildren = await getChildProcesses(childPid);
        expect(grandchildren).toEqual([]);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('should return empty array for invalid PID', async () => {
      expect(await getChildProcesses(-1)).toEqual([]);
      expect(await getChildProcesses(0)).toEqual([]);
      expect(await getChildProcesses(1.5)).toEqual([]);
    });

    it('should return empty array for non-existent PID', async () => {
      // Use a very high PID unlikely to exist
      const result = await getChildProcesses(999999999);
      expect(result).toEqual([]);
    });
  });

  describe('getPlatformTimeout', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true
      });
    });

    it('should return same value on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(1000);
    });

    it('should return doubled value on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(2000);
    });

    it('should apply 2.0x multiplier consistently on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getPlatformTimeout(500)).toBe(1000);
      expect(getPlatformTimeout(5000)).toBe(10000);
      expect(getPlatformTimeout(100)).toBe(200);
    });

    it('should round Windows timeout values', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      // 2.0x of 333 = 666 (rounds to 666)
      const result = getPlatformTimeout(333);

      expect(result).toBe(666);
    });
  });

  describe('getDescendantProcesses', () => {
    it('should return child and grandchild PIDs', async () => {
      // sh -c spawns a shell (child) which spawns sleep (grandchild)
      const child = spawn('sh', ['-c', 'sleep 60 & sleep 60 & wait'], { detached: false });
      const shellPid = child.pid!;

      // Give the shell time to spawn its children
      await new Promise(r => setTimeout(r, 200));

      try {
        const descendants = await getDescendantProcesses(process.pid);

        // Must contain the shell and both sleep processes
        expect(descendants).toContain(shellPid);
        // Should have at least 3 descendants from this spawn (sh + 2 sleeps)
        const directChildren = await getChildProcesses(shellPid);
        for (const grandchild of directChildren) {
          expect(descendants).toContain(grandchild);
        }
      } finally {
        child.kill('SIGKILL');
        // Clean up grandchildren
        const grandchildren = await getChildProcesses(shellPid);
        for (const gc of grandchildren) {
          try { process.kill(gc, 'SIGKILL'); } catch {}
        }
      }
    });

    it('should return PIDs in leaf-first order', async () => {
      // sh -c creates a 2-level tree: sh → sleep
      const child = spawn('sh', ['-c', 'sleep 60'], { detached: false });
      const shellPid = child.pid!;

      await new Promise(r => setTimeout(r, 200));

      try {
        const descendants = await getDescendantProcesses(shellPid);
        const grandchildren = await getChildProcesses(shellPid);

        // Grandchildren (sleep) must appear before the shell itself would
        // in a full tree enumeration from process.pid
        const allDescendants = await getDescendantProcesses(process.pid);
        if (grandchildren.length > 0 && allDescendants.includes(shellPid)) {
          const shellIndex = allDescendants.indexOf(shellPid);
          for (const gc of grandchildren) {
            const gcIndex = allDescendants.indexOf(gc);
            expect(gcIndex).toBeLessThan(shellIndex);
          }
        }
      } finally {
        child.kill('SIGKILL');
        const grandchildren = await getChildProcesses(shellPid);
        for (const gc of grandchildren) {
          try { process.kill(gc, 'SIGKILL'); } catch {}
        }
      }
    });

    it('should handle single-level children (same as getChildProcesses)', async () => {
      // sleep has no children of its own
      const child = spawn('sleep', ['60'], { detached: false });
      const childPid = child.pid!;

      try {
        const descendants = await getDescendantProcesses(process.pid);
        expect(descendants).toContain(childPid);
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('should return empty for non-existent PID', async () => {
      const result = await getDescendantProcesses(999999999);
      expect(result).toEqual([]);
    });
  });

  describe('gracefulKillProcess', () => {
    // Skip on Windows — SIGTERM behavior is Unix-specific
    const isWindows = process.platform === 'win32';

    // Suppress logger output during these tests
    let logSpies: ReturnType<typeof spyOn>[] = [];

    beforeEach(() => {
      logSpies = [
        spyOn(logger, 'info').mockImplementation(() => {}),
        spyOn(logger, 'debug').mockImplementation(() => {}),
        spyOn(logger, 'warn').mockImplementation(() => {}),
        spyOn(logger, 'error').mockImplementation(() => {}),
      ];
    });

    afterEach(() => {
      logSpies.forEach(spy => spy.mockRestore());
    });

    it('should send SIGTERM and wait for process to exit gracefully', async () => {
      if (isWindows) return;

      // Spawn a subprocess that traps SIGTERM and exits cleanly
      const child = spawn('bash', ['-c', 'trap "exit 0" TERM; while true; do sleep 0.1; done'], {
        stdio: 'ignore',
        detached: false
      });

      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      // Verify process is alive
      expect(() => process.kill(pid, 0)).not.toThrow();

      // Gracefully kill — should exit via SIGTERM without needing SIGKILL
      await gracefulKillProcess(pid, 3000);

      // Process should be dead
      expect(() => process.kill(pid, 0)).toThrow();
    });

    it('should fall back to SIGKILL when process ignores SIGTERM', async () => {
      if (isWindows) return;

      // Spawn a subprocess that IGNORES SIGTERM
      const child = spawn('bash', ['-c', 'trap "" TERM; while true; do sleep 0.1; done'], {
        stdio: 'ignore',
        detached: false
      });

      expect(child.pid).toBeDefined();
      const pid = child.pid!;

      // Verify process is alive
      expect(() => process.kill(pid, 0)).not.toThrow();

      // Gracefully kill with short timeout — SIGTERM will be ignored, should SIGKILL
      await gracefulKillProcess(pid, 500);

      // Process must be dead even though it ignored SIGTERM
      // Give a tiny window for SIGKILL to take effect
      await new Promise(r => setTimeout(r, 100));
      expect(() => process.kill(pid, 0)).toThrow();
    });

    it('should handle already-exited process without throwing', async () => {
      if (isWindows) return;

      // Spawn a process that exits immediately
      const child = spawn('bash', ['-c', 'exit 0'], {
        stdio: 'ignore',
        detached: false
      });

      // Wait for it to exit
      await new Promise<void>((resolve) => {
        child.on('exit', () => resolve());
      });

      const pid = child.pid!;

      // Should not throw when process is already dead
      await expect(gracefulKillProcess(pid, 1000)).resolves.toBeUndefined();
    });

    it('should reject invalid PIDs', async () => {
      // Invalid PIDs should return without error (same as forceKillProcess)
      await expect(gracefulKillProcess(-1, 1000)).resolves.toBeUndefined();
      await expect(gracefulKillProcess(0, 1000)).resolves.toBeUndefined();
      await expect(gracefulKillProcess(1.5, 1000)).resolves.toBeUndefined();
    });
  });
});
