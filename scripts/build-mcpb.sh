#!/bin/bash
# Build the Claude Desktop one-click bundle: dist/pawbrowse.mcpb
# Bundles the zero-dependency MCP server + manifest + icon. No duplication of
# server source in git — the server is copied from mcp/server.mjs at build time.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

mkdir -p "$BUILD/server"
cp "$ROOT/mcpb/manifest.json" "$BUILD/manifest.json"
cp "$ROOT/mcp/server.mjs"     "$BUILD/server/server.mjs"
# 512x512 icon recommended by Claude Desktop; derive from the master art
if command -v magick >/dev/null 2>&1; then
  magick "$ROOT/assets/icon.png" -resize 512x512 "$BUILD/icon.png"
else
  cp "$ROOT/extension/icons/icon-128.png" "$BUILD/icon.png"
fi

mkdir -p "$ROOT/dist"
npx -y @anthropic-ai/mcpb@latest pack "$BUILD" "$ROOT/dist/pawbrowse.mcpb"
echo "Built: $ROOT/dist/pawbrowse.mcpb"
