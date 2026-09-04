#!/bin/bash
# ─────────────────────────────────────────────
# Keyboard Punch — One-Command Launcher
# ─────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  ⌨️  Keyboard Punch — Starting..."
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "  ❌  Python 3 not found. Install it first."
    exit 1
fi

# Install dependencies
echo "  📦  Checking dependencies..."
python3 -m pip install --quiet -r "$SCRIPT_DIR/requirements.txt" 2>/dev/null || {
    echo "  ⚠️  pip install failed, trying with --user flag..."
    python3 -m pip install --quiet --user -r "$SCRIPT_DIR/requirements.txt"
}

# Run the companion server
python3 "$SCRIPT_DIR/server.py" "$@"
