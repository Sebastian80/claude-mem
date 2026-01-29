#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental rsync overwrite when installed plugin is on beta branch.
 * If on beta, the user should use the UI to update instead.
 */

const { execSync } = require('child_process');
const { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } = require('fs');
const path = require('path');
const os = require('os');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'jillvernus');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'jillvernus', 'claude-mem');

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

const branch = getCurrentBranch();
const isForce = process.argv.includes('--force');

if (branch && branch !== 'main' && !isForce) {
  console.log('');
  console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
  console.log('\x1b[33m%s\x1b[0m', 'Running rsync would overwrite beta code.');
  console.log('');
  console.log('Options:');
  console.log('  1. Use UI at http://localhost:37777 to update beta');
  console.log('  2. Switch to stable in UI first, then run sync');
  console.log('  3. Force rsync: npm run sync-marketplace:force');
  console.log('');
  process.exit(1);
}

// Get version from plugin.json
function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

// Normal sync for main branch or fresh install (using cp for portability)
console.log('Syncing to marketplace...');
try {
  // Check if installed plugin is full repo (has src/ folder) vs plugin-only
  const isFullRepoInstall = existsSync(path.join(INSTALLED_PATH, 'src'));

  // Use cp with trailing dot to include hidden files (like .mcp.json)
  // The /. syntax copies directory contents including dotfiles
  execSync(
    'cp -r plugin/. ~/.claude/plugins/marketplaces/jillvernus/',
    { stdio: 'inherit' }
  );

  // For full repo installs, the root .mcp.json needs plugin/ prefix in paths
  // because Claude Code reads from repo root, not plugin/ subfolder
  // Note: We keep .mcp.json.disabled in source to avoid project-level MCP errors
  if (isFullRepoInstall) {
    const rootMcpJson = path.join(__dirname, '..', '.mcp.json.disabled');
    if (existsSync(rootMcpJson)) {
      execSync(
        `cp "${rootMcpJson}" "${INSTALLED_PATH}/.mcp.json"`,
        { stdio: 'inherit' }
      );
      console.log('Updated root .mcp.json for full repo install (paths prefixed with plugin/)');
    }

    // For full repo installs, also sync the root .claude-plugin/marketplace.json
    const rootMarketplaceJson = path.join(__dirname, '..', '.claude-plugin', 'marketplace.json');
    if (existsSync(rootMarketplaceJson)) {
      execSync(
        `cp "${rootMarketplaceJson}" "${INSTALLED_PATH}/.claude-plugin/marketplace.json"`,
        { stdio: 'inherit' }
      );
      console.log('Updated root .claude-plugin/marketplace.json for full repo install');
    }
  }

  console.log('Running npm install in marketplace...');
  execSync(
    'cd ~/.claude/plugins/marketplaces/jillvernus/ && npm install',
    { stdio: 'inherit' }
  );

  // Sync to cache folder with version
  const version = getPluginVersion();
  const CACHE_VERSION_PATH = path.join(CACHE_BASE_PATH, version);

  // Clean old cache versions to prevent Claude Code from using stale versions
  if (existsSync(CACHE_BASE_PATH)) {
    try {
      const cacheEntries = readdirSync(CACHE_BASE_PATH);
      for (const entry of cacheEntries) {
        if (entry !== version) {
          const oldPath = path.join(CACHE_BASE_PATH, entry);
          rmSync(oldPath, { recursive: true, force: true });
          console.log(`Removed old cache version: ${entry}`);
        }
      }
    } catch (e) {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Could not clean old cache versions: ${e.message}`);
    }
  }

  console.log(`Syncing to cache folder (version ${version})...`);
  execSync(
    `mkdir -p "${CACHE_VERSION_PATH}" && cp -r plugin/. "${CACHE_VERSION_PATH}/"`,
    { stdio: 'inherit' }
  );

  // Update installed_plugins.json to point to new version
  const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (existsSync(installedPluginsPath)) {
    try {
      const installedPlugins = JSON.parse(readFileSync(installedPluginsPath, 'utf-8'));
      const claudeMemEntry = installedPlugins.plugins?.['claude-mem@jillvernus'];
      if (claudeMemEntry && claudeMemEntry.length > 0) {
        claudeMemEntry[0].version = version;
        claudeMemEntry[0].installPath = CACHE_VERSION_PATH;
        claudeMemEntry[0].lastUpdated = new Date().toISOString();
        writeFileSync(installedPluginsPath, JSON.stringify(installedPlugins, null, 2) + '\n');
        console.log(`Updated installed_plugins.json to version ${version}`);
      }
    } catch (e) {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Could not update installed_plugins.json: ${e.message}`);
    }
  }

  console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');

  // Trigger worker restart after file sync
  console.log('\n🔄 Triggering worker restart...');
  const http = require('http');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '✓ Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart returned status ${res.statusCode}`);
    }
  });
  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out');
  });
  req.end();

} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
  process.exit(1);
}
