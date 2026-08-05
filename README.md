# DIVA Player

**Dynamic Index for Virtual Artists**

VocaDB API を活用したボカロ特化ミュージックプレイヤー SPA。YouTube・ニコニコ動画・SoundCloud・Bilibiliのボカロ楽曲を検索・再生できます。

## 技術スタック

- **React 19** + **TypeScript** (strict mode)
- **Vite** — 開発サーバー / ビルドツール
- **Tailwind CSS v4** — スタイリング
- **Zustand** — 状態管理
- **React Router v8** — クライアントサイドルーティング
- **VocaDB API** — 楽曲データソース

## 機能

- ボカロ楽曲の検索（曲／P／歌手、タグ・参加者役割、再生数、BPM、楽器、歌詞フレーズ等の詳細フィルター）
- 原曲とProducer／Circle／Bandが共通するカバーの「Self Cover」表示・検索
- YouTube・ニコニコ動画・SoundCloud・Bilibiliの埋め込み再生
- 15秒サビ候補のシークバー表示と、保存・星評価・スキップできる「サビ発掘」連続再生
- プレイリスト、星評価、表示しない曲、キューのローカル永続化と完全バックアップv6
- YouTube公開プレイリスト、ニコニコ公開マイリスト／シリーズの取り込み・リンク同期
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

非公開pipelineの音響解析は、元音源・波形・スペクトログラム・音声断片を公開APIやこのリポジトリへ保存せず、BPM、キー、低次元の数値、楽器候補、15秒サビ候補だけを派生値として扱います。歌詞本文も非公開PostgreSQLの逆引き検索だけに使い、検索・詳細・batch APIでは返しません。

- [YAMNet / TensorFlow Models](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet): Apache License 2.0
- [librosa](https://github.com/librosa/librosa/blob/main/LICENSE.md): ISC License
- [AudioSet](https://research.google.com/audioset/download.html): datasetはCC BY 4.0、ontologyはCC BY-SA 4.0
- [OpenMIC-2018 v1.0.0](https://doi.org/10.5281/zenodo.1432913): CC BY 4.0。Humphrey, Durand, McFee, “OpenMIC-2018: An Open Dataset for Multiple Instrument Recognition,” ISMIR 2018

`src/config/audioInstruments.ts`の楽器分類語彙はAudioSet ontologyを基にした日本語対応表を含み、CC BY-SA 4.0として扱います。楽器推定の正解データ評価にはOpenMIC公式train／test partitionを分離して使い、未評価labelをnegativeとして扱いません。解析対象音源の権利や取得元サービスの利用条件は、これらソフトウェア／データライセンスとは別に確認が必要です。

