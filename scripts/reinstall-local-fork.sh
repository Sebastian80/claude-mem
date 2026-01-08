#!/bin/bash
#
# reinstall-local-fork.sh
#
# Reinstalls the local fork of claude-mem (claude-mem@thedotmack) after it gets
# reset to the official old version by Claude Code's plugin system.
#
# IMPORTANT: Before running this script:
#   1. In Claude Code, run: /plugin uninstall claude-mem@thedotmack
#   2. Restart Claude Code
#   3. Then run this script
#   4. Restart Claude Code again
#
# Usage: ./scripts/reinstall-local-fork.sh
#
# This script:
# 1. Kills stale worker processes
# 2. Removes old cached plugin versions
# 3. Builds fresh from workspace
# 4. Syncs to marketplace directory
# 5. Registers plugin in Claude Code config
# 6. Starts the worker
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CLAUDE_DIR="$HOME/.claude"
PLUGIN_DIR="$CLAUDE_DIR/plugins"
MARKETPLACE_DIR="$PLUGIN_DIR/marketplaces/thedotmack"
CACHE_DIR="$PLUGIN_DIR/cache/thedotmack"
INSTALLED_PLUGINS="$PLUGIN_DIR/installed_plugins.json"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
FORCE=false
for arg in "$@"; do
    case $arg in
        --force|-f)
            FORCE=true
            shift
            ;;
    esac
done

echo -e "${GREEN}=== Claude-Mem Local Fork Reinstaller ===${NC}"
echo ""

# Pre-flight check: Remind user about /plugin uninstall
if [ "$FORCE" = false ]; then
    echo -e "${YELLOW}PRE-REQUISITE CHECK:${NC}"
    echo "Before running this script, you should have:"
    echo "  1. Run '/plugin uninstall claude-mem@thedotmack' in Claude Code"
    echo "  2. Restarted Claude Code"
    echo ""
    read -p "Have you completed these steps? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}Please complete the pre-requisite steps first:${NC}"
        echo "  1. In Claude Code, run: /plugin uninstall claude-mem@thedotmack"
        echo "  2. Restart Claude Code"
        echo "  3. Run this script again"
        exit 1
    fi
    echo ""
else
    echo -e "${YELLOW}Running in force mode (--force), skipping pre-requisite check${NC}"
    echo ""
fi

# Step 1: Kill stale processes
echo -e "${YELLOW}Step 1: Killing stale worker processes...${NC}"
pkill -f "worker-service" 2>/dev/null || true
sleep 1
REMAINING=$(ps aux | grep -E "worker-service" | grep -v grep | wc -l)
if [ "$REMAINING" -gt 0 ]; then
    echo -e "${RED}Warning: Some processes still running. Force killing...${NC}"
    pkill -9 -f "worker-service" 2>/dev/null || true
fi
echo -e "${GREEN}✓ Stale processes cleared${NC}"

# Step 2: Remove old plugin files
echo ""
echo -e "${YELLOW}Step 2: Removing old plugin files...${NC}"
if [ -d "$MARKETPLACE_DIR" ]; then
    rm -rf "$MARKETPLACE_DIR"
    echo "  Removed: $MARKETPLACE_DIR"
fi
if [ -d "$CACHE_DIR" ]; then
    rm -rf "$CACHE_DIR"
    echo "  Removed: $CACHE_DIR"
fi
echo -e "${GREEN}✓ Old plugin files removed${NC}"

# Step 3: Build fresh
echo ""
echo -e "${YELLOW}Step 3: Building from workspace...${NC}"
cd "$PROJECT_ROOT"
npm run build
echo -e "${GREEN}✓ Build complete${NC}"

# Step 4: Sync to marketplace
echo ""
echo -e "${YELLOW}Step 4: Syncing to marketplace directory...${NC}"
mkdir -p "$MARKETPLACE_DIR"
cp -r "$PROJECT_ROOT"/* "$MARKETPLACE_DIR/"
# Get version from package.json
VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version")
echo "  Version: $VERSION"
echo -e "${GREEN}✓ Synced to $MARKETPLACE_DIR${NC}"

# Step 5: Register plugin in config files
echo ""
echo -e "${YELLOW}Step 5: Registering plugin in Claude Code config...${NC}"

# Create installed_plugins.json if it doesn't exist
if [ ! -f "$INSTALLED_PLUGINS" ]; then
    echo "{}" > "$INSTALLED_PLUGINS"
fi

# Use node to safely update JSON
node -e "
const fs = require('fs');
const path = '$INSTALLED_PLUGINS';
const version = '$VERSION';
const installPath = '$MARKETPLACE_DIR/plugin';

let data = {};
try {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {
    data = {};
}

data['claude-mem@thedotmack'] = [{
    scope: 'user',
    installPath: installPath,
    version: version,
    isLocal: true
}];

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('  Updated: installed_plugins.json');
"

# Update settings.json
if [ -f "$SETTINGS_FILE" ]; then
    node -e "
const fs = require('fs');
const path = '$SETTINGS_FILE';

let data = {};
try {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
} catch (e) {
    data = {};
}

if (!data.enabledPlugins) {
    data.enabledPlugins = {};
}
data.enabledPlugins['claude-mem@thedotmack'] = true;

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('  Updated: settings.json');
"
else
    echo '{"enabledPlugins":{"claude-mem@thedotmack":true}}' > "$SETTINGS_FILE"
    echo "  Created: settings.json"
fi

echo -e "${GREEN}✓ Plugin registered${NC}"

# Step 6: Start worker
echo ""
echo -e "${YELLOW}Step 6: Starting worker service...${NC}"
cd "$PROJECT_ROOT"
npm run worker:restart

# Step 7: Verify
echo ""
echo -e "${YELLOW}Step 7: Verifying installation...${NC}"
sleep 2
HEALTH=$(curl -s http://localhost:37777/health 2>/dev/null || echo "FAILED")
if echo "$HEALTH" | grep -q "ok"; then
    echo -e "${GREEN}✓ Worker health check passed${NC}"
    echo "  Response: $HEALTH"
else
    echo -e "${RED}✗ Worker health check failed${NC}"
    echo "  Response: $HEALTH"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Reinstallation Complete ===${NC}"
echo ""
echo "Installed version: $VERSION"
echo "Marketplace path:  $MARKETPLACE_DIR"
echo ""
echo -e "${YELLOW}IMPORTANT: Restart Claude Code for plugin settings to take effect.${NC}"
echo ""
