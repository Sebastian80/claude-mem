#!/usr/bin/env node

/**
 * Postinstall script for claude-mem plugin dependencies.
 *
 * Prunes non-current-platform onnxruntime-node binaries to reduce disk usage.
 * The full package ships darwin + linux + win32 (~537MB total); this keeps only
 * the current platform (~65-400MB depending on platform).
 */

import { readdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ONNX_BIN_DIR = join(ROOT, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');

if (!existsSync(ONNX_BIN_DIR)) {
  // onnxruntime-node not installed (e.g., optional dep or different backend)
  process.exit(0);
}

const currentPlatform = process.platform; // 'darwin', 'linux', 'win32'
const entries = readdirSync(ONNX_BIN_DIR, { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (entry.name === currentPlatform) continue;

  const dirPath = join(ONNX_BIN_DIR, entry.name);
  try {
    rmSync(dirPath, { recursive: true, force: true });
    console.error(`[claude-mem] Pruned onnxruntime-node binaries for ${entry.name}`);
  } catch (err) {
    // Non-fatal — extra disk usage but functional
    console.error(`[claude-mem] Warning: could not prune ${entry.name}: ${err.message}`);
  }
}
