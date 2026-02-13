#!/usr/bin/env node
/**
 * Bun Runner - Finds and executes Bun even when not in PATH
 *
 * This script solves the fresh install problem where:
 * 1. smart-install.js installs Bun to ~/.bun/bin/bun
 * 2. But Bun isn't in PATH until terminal restart
 * 3. Subsequent hooks fail because they can't find `bun`
 *
 * Usage: node bun-runner.js <script> [args...]
 *
 * Stdin handling: Claude Code pipes JSON to PostToolUse hooks via stdin.
 * Bun's libuv fstat() crashes on inherited pipe file descriptors, so we
 * buffer stdin first and re-pipe it to the child process.
 *
 * Fixes #818: Worker fails to start on fresh install
 */
import { spawnSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Find Bun executable - checks PATH first, then common install locations
 */
function findBun() {
  // Try PATH first
  const pathCheck = spawnSync(IS_WINDOWS ? 'where' : 'which', ['bun'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS
  });

  if (pathCheck.status === 0 && pathCheck.stdout.trim()) {
    return 'bun'; // Found in PATH
  }

  // Check common installation paths (handles fresh installs before PATH reload)
  // Windows: Bun installs to ~/.bun/bin/bun.exe (same as smart-install.js)
  // Unix: Check default location plus common package manager paths
  const bunPaths = IS_WINDOWS
    ? [join(homedir(), '.bun', 'bin', 'bun.exe')]
    : [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
        '/home/linuxbrew/.linuxbrew/bin/bun'
      ];

  for (const bunPath of bunPaths) {
    if (existsSync(bunPath)) {
      return bunPath;
    }
  }

  return null;
}

/**
 * Buffer all stdin data when running as a pipe (non-TTY).
 * Returns the buffered data, or null if stdin is a TTY.
 */
function collectStdin() {
  if (process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve) => {
    const chunks = [];
    const STDIN_TIMEOUT_MS = 5000;

    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    }, STDIN_TIMEOUT_MS);

    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });

    process.stdin.resume();
  });
}

// Get args: node bun-runner.js <script> [args...]
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node bun-runner.js <script> [args...]');
  process.exit(1);
}

const bunPath = findBun();

if (!bunPath) {
  console.error('Error: Bun not found. Please install Bun: https://bun.sh');
  console.error('After installation, restart your terminal.');
  process.exit(1);
}

// Buffer stdin before spawning to prevent Bun's libuv fstat() crash on pipes
const stdinData = await collectStdin();

// Spawn Bun with the provided script and args
// Use spawn (not spawnSync) to properly handle stdio
// Note: Don't use shell mode on Windows - it breaks paths with spaces in usernames
// Use windowsHide to prevent a visible console window from spawning on Windows
const child = spawn(bunPath, args, {
  stdio: [stdinData ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  windowsHide: true,
  env: process.env
});

// Pipe buffered stdin to child process
if (stdinData && child.stdin) {
  child.stdin.write(stdinData);
  child.stdin.end();
}

child.on('error', (err) => {
  console.error(`Failed to start Bun: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code || 0);
});
