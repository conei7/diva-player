# DIVA Player

文書の入口は[ドキュメント案内](docs/README.md)です。構成、機能、保存データ、開発、
SBC、Cloudflare、パイプライン、障害対応を含む全体像は
[統合マニュアル](docs/PROJECT_MANUAL.md)を参照してください。

**Dynamic Index for Virtual Artists**

VocaDB API を活用したボカロ特化ミュージックプレイヤー SPA。YouTube・ニコニコ動画のボカロ楽曲をシームレスに検索・再生できます。

## 技術スタック

- **React 19** + **TypeScript** (strict mode)
- **Vite** — 開発サーバー / ビルドツール
- **Tailwind CSS v4** — スタイリング
- **Zustand** — 状態管理
- **React Router v7** — クライアントサイドルーティング
- **VocaDB API** — 楽曲データソース

## 機能

- ボカロ楽曲の検索（モード切替 / 候補 / 詳細フィルター）
- YouTube・ニコニコ動画の埋め込み再生
- プレイリスト、星評価、キューのローカル永続化
- IndexedDBによる軽量な長期視聴履歴
- Qdrant/PostgreSQLとローカル嗜好を組み合わせた推薦、自動キュー、関連曲
- 人気急上昇、同じP、音響類似、メタデータ類似
- ダークテーマ UI

## セットアップ

```bash
npm ci
npm run dev
```

### 開発環境（フロント + backend 一括起動）

backend（Postgres, Qdrant, C# recommender API）を Docker Compose で起動し、同時に Vite 開発サーバーを起動する簡易スクリプトを用意しています。

- Windows (PowerShell):

```powershell
npm run dev:all:ps1
```

- POSIX (Linux/macOS / WSL):

```bash
npm run dev:all:sh
```

これらは `backend/docker-compose.yml` を使ってバックエンドを `docker compose up -d --build` で起動し、その後 `npm run dev` で Vite を起動します。


## ビルド

```bash
npm run build
npm run preview
```

## ディレクトリ構成

```
src/
├── api/           # VocaDB API 通信
├── components/    # 再利用可能な UI コンポーネント
│   ├── layout/    # ヘッダー、レイアウト、プレイヤーバー
│   ├── player/    # 埋め込みプレイヤー
│   ├── search/    # 検索バー、フィルター、曲カード
│   └── playlist/  # プレイリスト系
├── hooks/         # カスタムフック
├── pages/         # ページコンポーネント
├── stores/        # Zustand ストア
├── types/         # TypeScript 型定義
└── utils/         # ユーティリティ関数
```

## ドキュメント

- [ドキュメント案内](docs/README.md): 文書の用途と優先順位
- [統合マニュアル](docs/PROJECT_MANUAL.md): 現行システムの正本
- [開発ガイドライン](docs/GUIDELINE.md): コーディング規約
- [推薦・履歴の技術メモ](docs/WEB_STATUS_AND_RECOMMENDATION_NOTES.md): 実装詳細
- [SBC運用メモ](docs/SBC_OPERATIONS.md): 接続とデプロイの短縮版
- [整備実装プラン](docs/MAINTENANCE_PLAN.md): 文書整理、品質確認、DB監査、未解決課題の実行順序

