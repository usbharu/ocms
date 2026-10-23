# OCMS リポジトリ作業ガイド

## 作業前に確認する資料

このガイドは、OCMSの実装・検証・文書更新を行うエージェント向けの指示です。

- `media-storage-spec-v2.md`：設計の基準。§3のサービス責務と§14の受け入れ基準（AC-01〜AC-18）を確認する。
- `README.md`：必要環境、起動・更新・検証の手順。コマンドの詳細やキャッシュ制限時の代替手順はここを参照する。
- `docs/implementation-status.md`：検証済みの範囲、未実装項目、既知の制約。仕様に書かれている機能を実装済みと判断しない。

最初に `git status --short` で既存の変更を確認し、今回の依頼に関係しない変更を上書きしない。仕様と実装の差異を見つけた場合は、設計変更なのか未実装なのかを確認し、差異を隠すために仕様だけを書き換えない。

## ディレクトリとサービスの責務

React SPA、Goの5サービス、PostgreSQL、S3互換ストレージ、独立したPython推論Runtimeで構成する。仕様§3の責務分離を保つ。

| パス | 役割・守る境界 |
|---|---|
| `cmd/ocms/` | サービス起動とTransferの保守コマンド |
| `internal/bff/` | OIDC、セッション、CSRF、APIプロキシ。内部の主体ヘッダーはセッションから設定する |
| `internal/catalog/` | Asset、所有者・ACL、Upload Session、Outbox。認可の最終判断を担う |
| `internal/transfer/` | 暗号化・復号、S3 I/O、Range、重複排除、鍵の再ラップ・孤立オブジェクト回収 |
| `internal/cryptostore/` | YAML鍵設定と暗号処理。鍵を扱うサービスはTransferに限定する |
| `internal/search/` | 全文・知覚類似・音声指紋・ベクトル検索と結果統合。応答前にCatalogで認可する |
| `internal/media/` | Outbox受信、Jobのリース・再試行、メディア処理、索引生成。鍵・S3資格情報は持たない |
| `internal/contracts/` | Job、Passage、Rendition、Embeddingなどの内部契約 |
| `internal/platform/` | 内部HTTP認証、API応答、OTel、相関付き構造化ログ |
| `web/` | TypeScript / React SPA |
| `runtime/` | EmbeddingGemma 2とWhisperのPython推論サービス |
| `infra/` | 開発用PostgreSQL、Hydra・Collector・Grafanaなどの検証設定 |
| `migrations/` | 番号順に適用するSQL。CatalogとTransferは別ロール・別スキーマ |
| `scripts/` | 初期化、結合試験、障害復旧・OIDC・OTLPの検証 |

Blobを共有しても、AssetごとのACL・ファイル名・タグは独立させる。検索結果の件数やスニペットにも未認可情報を含めない。Workerへ復号データを渡す際は、Job・対象Blob・リース・期限を照合する。

## 開発環境を起動する

必要環境はDocker Engine、Docker Compose v2以降、Python 3.9以降。ホストでGoを検証する場合はGo 1.26以降、SPAをビルドする場合はNode.js 24以降を使う。以下はリポジトリルートで実行する。

```sh
python3 scripts/dev-init.py
docker compose build
docker compose up -d --wait
```

開発用SPAは `http://localhost:8080`。初期化は既存の `.env` と `secrets/crypto.yaml` を上書きしない。鍵ファイルは保存済みデータの復号に必要なので、環境の作り直しを理由に削除しない。

実推論にはモデルの初回ダウンロードと数GBの空き領域が必要。ローカル検証の実績は4 CPU・12 GiBメモリで、6 GiBでは実PDFの推論時にOOMが発生した。これは全入力に対する必要量の保証ではない。

## 変更内容に応じて検証する

文書だけの変更では参照先・コマンド・差分を確認する。実装変更では該当する回帰テストを追加・更新し、次の表から影響範囲に合う検証を選ぶ。Go標準テストとPython標準ライブラリによる結合試験を使い、カバレッジ閾値は設けていない。

| 変更・確認対象 | コマンド・前提 |
|---|---|
| Go | `go test -race ./...` と `go vet ./...` |
| React SPA | `web/` で `npm ci`、続いて `npm run check` と `npm run build`（TypeScript strictチェックを含む） |
| 保存・配信・ACL・重複排除 | 開発スタック起動後に `python3 scripts/integration.py` |
| メディア処理・検索（AC-09〜14） | `python3 scripts/media-integration.py`。実コーデック・OCR・ASR・モデルを使う |
| Job認可・リース・再試行 | メディア検証後に `python3 scripts/job-recovery.py`。Searchを一時停止する |
| S3/DB障害・再送・鍵更新 | `python3 scripts/recovery.py`。依存サービスの停止とテスト鍵の更新を伴うため、共有環境では実行しない |
| 実PDFの復旧 | `python3 scripts/verify-pdf-recovery.py <blob-id> ...`。本文・ファイル名・検索語を結果へ出さない |

結合試験は生成データをDBとS3に残すため、初期設定の開発用環境で実行する。非整列Range、並列重複排除、ACL分離、鍵更新、Job再試行、S3/DB障害からの復旧を優先する。メディア試験はCPU推論で数分以上かかる場合がある。

キャッシュの書き込みが制限される場合は、READMEの `GOPATH`・`GOMODCACHE`・`GOCACHE`・`BUILDX_CONFIG` の指定例を使う。Pythonは必要に応じて `PYTHONPYCACHEPREFIX="$PWD/.cache/pycache"` を付ける。

## OIDC・OTLPの検証環境を引き渡す

```sh
python3 scripts/dev-init.py
python3 scripts/verify-init.py
docker compose -f compose.yaml -f compose.verify.yaml up -d --build --wait
```

人が直接使える状態を維持する。手動ログイン・アップロード・検索・Grafanaの確認に、自動試験の事前実行は不要。

| URL | 用途 |
|---|---|
| `http://localhost:4446` | 検証ガイドと各画面への入口 |
| `http://localhost:8081` | Hydraを使うOIDCログインとSPA |
| `http://localhost:3000/d/ocms-verification` | Grafanaの検証ダッシュボード |

自動検査を行う場合は、先に `scripts/media-integration.py` で生成メディアを用意し、以下を順に実行する。

```sh
python3 scripts/verify-oidc.py
python3 scripts/verify-otel-workload.py
python3 scripts/verify-otel.py
```

Hydraでの成功をPocket ID固有の接続検証済みと扱わない。利用者へ引き渡す際は、停止を依頼されない限り検証サービスを起動したままにする。起動や試験に失敗した場合は、利用できる入口と未解決事項を伝える。

## DB・メディア処理を変更する際の注意

マイグレーション001〜004は空のDBへの初回起動時に適用される。既存DBへの自動適用や適用履歴の管理は未実装。SQLを追加・変更する場合は、既存DBへの適用手順もREADMEに記載する。推論チェックポイントを使う既存メディアDBには `004_embedding_checkpoints.sql` を一度適用する。実行手順はREADMEの「メディア処理と検索」を参照する。

WorkerとTransferは `MEDIA_MAX_PDF_PAGES`（既定500）を共有する。WorkerのJob期限は `MEDIA_JOB_TIMEOUT_SECONDS`（既定7200秒）。制限やチェックポイントを変更するときは、両サービスの整合性、境界値、再試行時の結果再利用を確認する。WorkerとRuntimeの作業平文はtmpfsで扱い、処理後に削除する。

## コード・文書・ログの規約

- Goは `gofmt` と慣用的な命名を使い、テストは `*_test.go` に置く。
- TypeScriptは2スペース、シングルクォート、セミコロン。コンポーネントはPascalCase、変数・関数はcamelCase。整形・lintは `web/` のBiomeを使う。関数と関数の間は空行を1行入れる（Biomeによる強制はない）。
- `asset_id`、`blob_id`、`/api/v1/assets` など既存の契約名に合わせる。APIやDBの変更では、関連する内部契約・DDL・API例・図も更新する。
- 仕様書は日本語、番号付きの節、表、コードブロックを維持する。実行モジュールを追加したら、必要環境とビルド・起動・テストの正確なコマンドを同じ変更で文書化する。
- 実装範囲や検証結果が変わったら `docs/implementation-status.md` も更新する。未検証の項目を検証済みにしない。

実際の鍵、資格情報、トークン、私的なメディアをコミットしない。設定例にはプレースホルダーを使う。`.env`、`secrets/crypto.yaml`、`.cache/*-sensitive.json` の内容を作業出力へ表示しない。ログ・Trace・テスト結果には鍵、セッション、Cookie、本文、検索語などの機密情報を含めず、HTTP計測は許可した属性だけを出力する。

## 差分を確認して報告する

完了前に `git diff --check` と `git status --short` を実行し、変更したファイルの差分を読む。仕様変更を含む場合は `git diff -- media-storage-spec-v2.md` も確認する。

各作業が完了し、必要な検証を終えたら、その作業の変更をコミットする。独立した作業は別々のコミットに分け、同じ目的の実装・テスト・文書更新はまとめる。今回の作業に関係しない既存の変更を含めない。ユーザーからコミットしないよう指示された場合は、その指示を優先する。

コミット件名は既存の `docs:`・`feat:`・`test:` などに合わせ、変更内容を簡潔に表す（例：`docs: clarify upload retry behavior`）。PRには解決する問題、関係する仕様節・AC、実行した検証と結果、未実行の検証と理由、未解決事項を記載する。関連Issueがあればリンクし、UI変更にはスクリーンショットを添える。
