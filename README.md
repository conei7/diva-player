# DIVA Player

**Dynamic Index for Virtual Artists**

VocaDB API を活用したボカロ特化ミュージックプレイヤー SPA。YouTube・ニコニコ動画・SoundCloud・Bilibiliのボカロ楽曲を検索・再生できます。

## 技術スタック

- **React 19** + **TypeScript** (strict mode)
- **Vite** — 開発サーバー / ビルドツール
- **Tailwind CSS v4** — スタイリング
- **Zustand** — 状態管理
- **React Router v7** — クライアントサイドルーティング
- **VocaDB API** — 楽曲データソース

## 機能

- ボカロ楽曲の検索（モード切替 / 候補 / 詳細フィルター）
- YouTube・ニコニコ動画・SoundCloud・Bilibiliの埋め込み再生
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

セットアップと公開仕様はこのREADMEを参照してください。稼働状況、内部仕様、運用手順、ロードマップは、privateの
`diva-data-pipeline/docs/diva-player/ACTIVE`を正本とします。このリポジトリには重複する`docs/`を置きません。

## 音響解析と第三者ライセンス

非公開pipelineの音響解析は、元音源・波形・スペクトログラム・音声断片を公開APIやこのリポジトリへ保存せず、BPM、キー、低次元の数値、楽器候補だけを派生値として扱います。

- [YAMNet / TensorFlow Models](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet): Apache License 2.0
- [librosa](https://github.com/librosa/librosa/blob/main/LICENSE.md): ISC License
- [AudioSet](https://research.google.com/audioset/download.html): datasetはCC BY 4.0、ontologyはCC BY-SA 4.0

`src/config/audioInstruments.ts`の楽器分類語彙はAudioSet ontologyを基にした日本語対応表を含み、CC BY-SA 4.0として扱います。解析対象音源の権利や取得元サービスの利用条件は、これらソフトウェア／データライセンスとは別に確認が必要です。

