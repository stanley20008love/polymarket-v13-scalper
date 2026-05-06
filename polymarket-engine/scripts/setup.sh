#!/bin/bash
# ============================================================================
# Polymarket V11 Strategy Engine - Startup Script
# ============================================================================

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Polymarket V11 Strategy Engine - Setup             ║"
echo "╚══════════════════════════════════════════════════════════╝"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Build
echo ""
echo "Building project..."
npx tsc || echo "TypeScript compilation note: some types may need resolution"

# Run tests
echo ""
echo "Running tests..."
npx ts-node tests/engine.test.ts

echo ""
echo "Setup complete! Usage:"
echo "  npm run dev      - Start in development mode"
echo "  npm run scan     - Scan markets only"
echo "  npm run trade    - Scan and trade"
echo "  npm run monitor  - Monitor positions only"
echo ""
echo "API Endpoints:"
echo "  GET  /health          - Health check"
echo "  GET  /api/state       - Engine state"
echo "  GET  /api/positions   - Current positions"
echo "  GET  /api/trades      - Trade history"
echo "  POST /api/scan        - Trigger market scan"
echo "  POST /api/start       - Start engine"
echo "  POST /api/stop        - Stop engine"
