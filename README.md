# DIVA Player

**Dynamic Index for Virtual Artists**

VocaDB API を活用したボカロ特化ミュージックプレイヤー SPA。YouTube・ニコニコ動画・SoundCloud・Bilibiliのボカロ楽曲を検索・再生できます。

## 技術スタック

- **React 19** + **TypeScript** (strict mode)
- **Vite** — 開発サーバー / ビルドツール
- **Tailwind CSS v4** — スタイリング
- **Zustand** — 状態管理
- **React Router v8** — クライアントサイドルーティング
- **ASP.NET Core 8** — 検索・推薦・プレイリスト同期 API
- **PostgreSQL 16 + pgvector** — 同期済みメタデータ、検索、履歴集計
- **Qdrant** — 音響／メタデータベクトル検索
- **HAProxy** — A/B 2系統の API gateway とreadinessによる切り替え
- **Cloudflare Pages + Pages Functions** — SPA配信と公開API proxy
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
- 端末内の好みを少数のseedへ圧縮し、音響近傍から未聴曲を編成する「発掘ミックス」
- 再生履歴と星評価から、YouTube／ニコニコ別に既知曲の広がりを見る「知ってる度マップ」
- 人気急上昇、同じP、音響類似、メタデータ類似
- ダークテーマ UI

## セットアップ

### フロントエンドのみ

```bash
npm ci
npm run dev
```

Viteは既定で`/backend-api`を`http://localhost:5000`へproxyします。別の開発APIを使う場合は`VITE_API_TARGET`を設定してください。APIを起動しない場合もフロントエンド自体は開けますが、検索・推薦などbackend依存機能は利用できません。

### 開発環境（フロント + backend 一括起動）

backend（PostgreSQL、Qdrant、ASP.NET Core API A/B、HAProxy gateway、Web）をDocker Composeで起動し、続けてVite開発サーバーを起動できます。新規環境では`backend/.env.example`を`backend/.env`へコピーし、必須項目をローカル専用の値で設定してください。既存の`backend/.env`がある場合は上書きせず、内容を退避・確認して不足する現行キーだけをmergeします。秘密値をcommitしたり、本番値を開発環境へ流用したりしないでください。

`DIVA_API_DB_USER`には、対象PostgreSQLへ事前作成済みのversion付きLOGIN（`diva_api_login_<version>`形式）を指定します。このLOGINは非特権の`diva_api_runtime` roleだけに所属し、`DIVA_API_DB_PASSWORD`と一致している必要があります。migration `0018_runtime_database_roles.sql`はNOLOGINの権限roleを定義しますが、LOGINやpasswordは作成しません。API LOGINへschema ownershipや管理者権限を与えないでください。

新規DBの初回bootstrapは、repository rootから次の順で実行します。role作成helperはBashを使うため、WindowsではWSLまたはGit Bashから実行してください。

1. `backend/.env`の`DIVA_API_DB_USER`を未使用の`diva_api_login_<version>`、`DIVA_API_DB_PASSWORD`を24文字以上のローカル専用secretにします。`DIVA_API_DB_PASSWORD`と同じAPI用secret、およびそれとは別のpipeline用secretを、それぞれ24文字以上としてrepository外の別々のowner-only fileへ1行で保存します。
2. PostgreSQLを起動し、migration 0018まで適用します。

   ```bash
   docker compose --env-file backend/.env -f backend/docker-compose.yml up -d --wait postgres
   docker compose --env-file backend/.env -f backend/docker-compose.yml run --rm migrate
   ```

3. API用secret fileの内容が`backend/.env`の`DIVA_API_DB_PASSWORD`と一致することを確認し、両runtime LOGINを作成します。`/absolute/path/to/postgres-*-password`はrepository外の実在する絶対pathへ置き、POSIXでは`chmod 600`にしてください。pipeline LOGINも作るのは、このhelperがAPI／pipeline両方の最小権限契約を同一transactionで検証するためです。

   ```bash
   DIVA_DB_ADMIN_USER=vocadb \
   DIVA_DB_API_LOGIN_ROLE=diva_api_login_local_v1 \
   DIVA_DB_PIPELINE_LOGIN_ROLE=diva_pipeline_login_local_v1 \
   DIVA_DB_API_PASSWORD_FILE=/absolute/path/to/postgres-api-password \
   DIVA_DB_PIPELINE_PASSWORD_FILE=/absolute/path/to/postgres-pipeline-password \
   bash scripts/provision-sbc-db-roles.sh create
   ```

`DIVA_DB_API_LOGIN_ROLE`は`backend/.env`の`DIVA_API_DB_USER`とexact一致させます。`DIVA_DB_ADMIN_USER`を`backend/.env`で変更した場合も、上の値を一致させます。role名は再利用せず、やり直す場合は新しいversion suffixを使ってください。helperは既存roleのpassword上書きを拒否します。ここまで成功したら、次の実コマンドでbackendとViteを起動できます。

```bash
docker compose --env-file backend/.env -f backend/docker-compose.yml up -d --build
npm run dev
```

下記の簡易scriptは、現状`backend/.env`を明示的に渡さないため、同じ必須値を呼出元processの環境変数へ安全に設定済みの場合だけ使用します。通常は上の`--env-file`付きコマンドを使ってください。

- Windows (PowerShell):

```powershell
npm run dev:all:ps1
```

- POSIX (Linux/macOS / WSL):

```bash
npm run dev:all:sh
```

これらは`backend/docker-compose.yml`を使ってbackendを`docker compose up -d --build`で起動し、その後`npm run dev`でViteを起動します。必須値がprocess環境にない、またはruntime LOGINが未作成の場合、backend起動は失敗します。


## ビルド

```bash
npm run build
npm run preview
```

## ディレクトリ構成

```
src/               # React SPA
├── api/           # VocaDB／backend API通信
├── components/    # 再利用可能なUIコンポーネント
├── hooks/         # カスタムフック
├── pages/         # ページコンポーネント
├── stores/        # Zustandストア
├── types/         # TypeScript型定義
└── utils/         # ユーティリティ関数
backend/           # ASP.NET Core API、PostgreSQL migration、Compose、HAProxy
functions/         # Cloudflare Pages Functions（API proxy／Tunnel同期）
scripts/           # 開発起動、検証、rolling配備、runtime監視
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

