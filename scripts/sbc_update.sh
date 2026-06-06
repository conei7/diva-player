#!/bin/bash

echo "=============================================="
echo "🌟 DIVA Player SBC 自動更新スクリプト 🌟"
echo "=============================================="

# 1. diva-player の更新
echo "[1/3] diva-player (Web/API) の更新を確認中..."
cd ~/diva-player || exit
git pull

# 2. diva-data-pipeline の更新
echo "[2/3] diva-data-pipeline (AI/データ) の更新を確認中..."
cd ~/diva-data-pipeline || exit
git pull

# 3. Docker コンテナの再ビルドと起動 (diva-player)
echo "[3/3] Docker コンテナを最新の状態で再起動します..."
cd ~/diva-player/backend || exit

# ダウンタイムを最小にするために、まずbuildして、それから up -d する
docker compose build
docker compose up -d

echo "=============================================="
echo "🎉 すべての更新が完了しました！"
echo "=============================================="
