# DIVA Player 作業ルール

このファイルは、このリポジトリで作業するAIエージェント向けの常設指示です。

## 対象と正本

- アプリ、API、Web配備設定はこの`diva-player`リポジトリで管理する。
- pipeline、定期処理、非公開の正規文書は隣接する`../diva-data-pipeline`で管理する。
- 作業前に両リポジトリの`git status`を確認し、ユーザーの未commit変更を上書き・破棄・無断でstageしない。

## 実装依頼の進め方

- ユーザーが実装・修正を依頼した場合は、調査や計画だけで止めず、実装、妥当なテスト、lint、production buildまで進める。
- 通常の可逆な判断は既存仕様とコードから補い、重大な仕様選択、データ破壊、広い権限変更だけユーザーへ確認する。
- 難しい変更や広範囲な変更へ入る前は、完了済みの作業をcommit・pushし、戻れる地点を作る。
- 既存の共通コンポーネント、型、store、utilityを優先して再利用する。
- ユーザーがローカル作業だけを指定しない限り、検証成功後は変更をcommit・pushする。

## 配備と確認

- Web変更はmainへpush後、`../diva-data-pipeline/docs/diva-player/ACTIVE/OPERATIONS.md`の手順でSBC Webへ反映する。
- API変更は必要なAPIコンテナだけ、pipeline変更は対象の定期処理だけを更新し、無関係なサービスを再起動しない。
- SBC反映後は対象commit、WebのHTTP応答、`/api/health`のPostgreSQL / Qdrant状態を確認する。
- Cloudflare Pagesはmain pushによる自動配備対象だが、workflowを確認していない場合は成功したと断定しない。

## 文書更新

- 実装後、コードと既存文書を照合し、未記載の仕様、運用変更、完了項目、既知の制約があれば同じ作業内で反映する。
- 新しい仕様書、実装計画、検証ログ用Markdownは増やさない。
- 現状・検証結果・次の作業は`CURRENT_STATUS.md`、恒久仕様は`SYSTEM_OVERVIEW.md`、運用手順は`OPERATIONS.md`、機能案と完了印は`IDEAS.md`へ統合する。
- 軽微なリファクタリングだけで利用者向け挙動や運用が変わらない場合は、文書更新を無理に増やさない。

## 完了報告

- 最後に、実装した内容、未実装・既知の制約、テスト結果、commit・push・配備状況を簡潔に報告する。
- ユーザー側の確認操作が必要なら、画面名と操作手順を具体的に書く。不要なら「ユーザー側の作業は不要」と明記する。
- 次に追加できる機能を、既存の`CURRENT_STATUS.md`と`IDEAS.md`に基づいて優先順で示す。
