#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
cd "$SCRIPT_DIR"

echo "[start-dev] Checking Docker daemon..."
if ! docker info > /dev/null 2>&1; then
	echo "[start-dev] Docker daemon not available."
	read -p "Start frontend only? (y/N) " ans
	if [[ "$ans" =~ ^[Yy]$ ]]; then
		echo "[start-dev] Starting Vite (frontend) only..."
		npm run dev
		exit 0
	else
		echo "[start-dev] Aborting. Start Docker Desktop and re-run."
		exit 1
	fi
fi

echo "[start-dev] Starting backend (docker compose)..."
if ! docker compose -f backend/docker-compose.yml up -d --build; then
	echo "[start-dev] docker compose failed."
	read -p "Proceed to start frontend only? (y/N) " ans
	if [[ "$ans" =~ ^[Yy]$ ]]; then
		echo "[start-dev] Starting Vite (frontend) only..."
		npm run dev
		exit 0
	else
		exit 1
	fi
fi

echo "[start-dev] Backend started. Starting Vite (frontend)..."
npm run dev
