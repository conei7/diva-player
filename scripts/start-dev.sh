#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
cd "$SCRIPT_DIR"

echo "[start-dev] Starting backend (docker compose)..."
docker compose -f backend/docker-compose.yml up -d --build

echo "[start-dev] Backend started. Starting Vite (frontend)..."
npm run dev
