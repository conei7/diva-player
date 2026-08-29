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

ローカルのAPI build／testには.NET 8 SDKが必要です。repositoryの`global.json`は8.0系の最新feature bandを選び、同居する.NET 9へ暗黙に切り替えません。`dotnet --version`が8.0系を返すことを確認してください。

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

### Database migrationの整合性

`backend/database/migrations/migration-manifest.tsv`は、migration ID、実行mode、改行をLFへ正規化したSQL本文のSHA-256を固定します。適用済みSQLを編集せず、migrationを追加するときは連番の新しいSQLとmanifest entryを同じcommitへ含め、`npm run test:migration-runner`を実行してください。manifestにないSQL、checksum変更、古いcheckoutから見えない適用済みmigration、同時runnerはすべてDB変更前に拒否されます。

runnerは全体をPostgreSQL advisory lockで直列化します。transaction互換migrationはSQLと`schema_migrations`記録を同一transactionでcommitし、`CREATE INDEX CONCURRENTLY`などの非transactional migrationは`schema_migration_attempts`へ開始証跡を永続化してから実行します。非transactional実行が中断した場合、次回実行は自動retryしません。partial objectとattempt IDを保ったまま運用手順に従って調査し、確認済みattemptを`abandoned`として終了させてから再実行します。


## ビルド

```bash
npm run build
npm run test:api
npm run preview
```

## Cloudflare Pagesリリース

`main`のGitHub Actionsは最初にCloudflare projectをread-onlyでinspectし、preview／productionに実際に保存されているcompatibility date／flagsとbinding metadataを検証します。通常のtest／E2Eに成功した後でCloudflare用の`dist`を1回だけbuildし、`functions`もその実測compatibility設定を明示してWranglerで再現可能なminify済み`dist/_worker.js`へ1回だけcompileします。その配備可能な`dist`全体をSHA-256 file manifest付きの単一release artifactへ固定します。配備jobはこのartifactを再build／再bundleせず、download後とproduction upload直前にcommit、compatibility設定、全file hashを検証します。

releaseは次の順序で進みます。

1. upload前の`release-candidate` preview deployment ID群を取得してbaselineへ封印し、non-production branchへ固定artifactをdirect uploadします。Cloudflare APIから、baselineに存在しないrun固有のimmutable deployment URLを解決し、commit／artifact hash／GitHub run ID／run attemptを含む完全一致metadataを照合します。同じcommitとpayloadのworkflow rerunでも過去previewを選びません。branch aliasは毎回同じものを更新し、runごとのaliasを増やしません。
2. preview URLの`/`、`/backend-api/api/ready`、`/backend-api/api/health`、origin headers、およびNico autoplay smokeを確認します。
3. 現在のproduction deployment IDを取得し、production URLでも同じhealth／smokeを通過したことと、確認中にdeployment IDが変化していないことを確認してlast-known-goodとして封印します。
4. previewと同じmanifest検証済みpayloadを`main`へdirect uploadし、Cloudflare deployment metadata、公開health／smokeを再確認します。production検証に失敗した場合だけ、Cloudflare公式rollback APIを1回だけ呼び、封印済みproduction deploymentへ戻ったことと公開health／smokeを再確認したうえでworkflow自体は失敗として残します。

Cloudflare Pagesはpreview deploymentそのものをproductionへ昇格できず、previewはrollback先にもできません。そのためこのworkflowの「同じartifact」は、同一のmanifest検証済みupload payloadをpreviewとproductionへ再uploadすることを意味します。未検証のbranch buildや、APIに存在しないpromotion操作は使いません。

このrelease gateには、Cloudflare／GitHub側で次の設定が必要です。workflowは設定差異を検出するとproduction変更前に停止します。

- GitHub repository secretsの`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`。tokenには対象projectのPages Write権限が必要です。
- Pages project `diva-player`のproduction branchは`main`とし、Git連携のautomatic production branch deploymentsを無効化します。productionを更新する経路をこのGitHub Actionsだけに限定するためです。
- Pagesのpreview／productionで「常に最新のcompatibility date」を無効化し、compatibility dateとcompatibility flagsを両環境で同一にします。日付はrepositoryに固定せず、各releaseのpreflightでCloudflareの実設定を読み取り、その値をworker build provenanceへ封印します。同じ`TUNNEL_CONFIG` KV namespaceを両環境へbindし、env varの名前集合、型、plain text値も両環境で完全一致させます。previewだけのenv varによる挙動差は許可しません。`PAGES_PROXY_KEY`、`TUNNEL_SYNC_TOKEN`、`TUNNEL_ORIGIN_PROOF_KEY`は常に両環境でencrypted `secret_text`必須です。`CF_ACCESS_CLIENT_SECRET`はnamed origin利用時、またはどちらかの環境で設定済みの場合だけ、両環境でencrypted `secret_text`必須です。named originではさらに`CF_ACCESS_CLIENT_ID`と`DIVA_NAMED_TUNNEL_ORIGIN`を両環境へ同じplain text値で設定します。違反時はpreview upload前に停止します。

初回だけ、Cloudflare dashboardのWorkers & Pages > `diva-player` > Settings > Variables and Secrets／Bindingsでpreview環境を設定します。`TUNNEL_CONFIG`にはproductionと同じKV namespace IDを選び、常時必須の3 secretはそれぞれ正規の保管元からpreviewへ直接encrypted secretとして入力してください。quick modeだけを使う現構成ではCloudflare Access 3項目は不要です。named originを有効化する場合だけ、`CF_ACCESS_CLIENT_SECRET`をencrypted secret、`CF_ACCESS_CLIENT_ID`と`DIVA_NAMED_TUNNEL_ORIGIN`を一致するplain textとして両環境へ追加します。Cloudflare APIから既存のproduction secret値を安全に読み戻せないため、workflowはsecret値のcopyや表示を行いません。正規値を取得できない場合は、対応するorigin／client、Pages production、Pages previewを同じ新しい値へ計画的にrotateする必要があります。これは新しいGitHub secretを必要とせず、設定が揃うまでworkflowはpreview uploadより前に安全停止します。

設定metadataだけを手元で確認する場合は、既存の`CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID`をprocess環境に読み込んだ状態で次を実行します。このcommandはprojectをGETして日付、flags、binding名／型／ID、canonical deploymentだけを検査し、secret値を出力しません。

```bash
node scripts/cloudflare-pages-release.mjs inspect-project --project diva-player
```

release artifactはGitHub Actionsに30日保存され、manifestの`gitCommit`、compatibility date／flags、compiled worker SHA-256、file別SHA-256、payload SHA-256、およびCloudflare deploymentのartifact hash／GitHub run ID／attempt metadataで追跡できます。

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

