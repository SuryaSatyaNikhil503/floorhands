#!/usr/bin/env bash
# Puts the `floorhands` command on your PATH (a symlink in ~/.local/bin). Safe to run again.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
chmod +x "$REPO/bin/floorhands" "$REPO/scripts/fake-claude.mjs" "$REPO/claude-plugin/hooks/session-start.js"
ln -sf "$REPO/bin/floorhands" "$BIN_DIR/floorhands"
echo "Linked $BIN_DIR/floorhands -> $REPO/bin/floorhands"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: $BIN_DIR is not on your PATH; add it to your shell profile." ;; esac
echo
echo "Next, in any Claude Code session:"
echo "  claude plugin marketplace add $REPO"
echo "  claude plugin install floorhands@floorhands"
echo "Then use /floorhands, or run \`floorhands enable\` in a project to start the office automatically."
