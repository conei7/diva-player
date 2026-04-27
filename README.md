# DIVA Player

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

- ボカロ楽曲の検索（キーワード / フィルター）
- YouTube・ニコニコ動画の埋め込み再生
- プレイリスト作成・管理（LocalStorage 永続化）
- ダークテーマ UI

## セットアップ

```bash
npm install
npm run dev
```

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

詳細な開発規約は [docs/GUIDELINE.md](docs/GUIDELINE.md) を参照してください。

