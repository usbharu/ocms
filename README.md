# OCMS

仕様書 `media-storage-spec-v2.md` に沿って、暗号化保存・配信とAC-09〜14のメディア処理・検索を実装しています。React SPA、Go BFF / Catalog / Transfer / Search / Media Worker、PostgreSQL、S3互換ストレージ、独立した推論RuntimeをDocker Composeで起動します。仕様全体の実装は完了していません。

## 起動

必要環境は Docker Engine + Docker Compose v2以降、Python 3.9以降です。検証環境はDockerに4 CPU・12GBメモリを割り当てています。推論RuntimeとGrafanaを同時に動かすため、VM全体のメモリ上限にも注意してください。今回のColima環境は6GBで実PDFの推論時にOOMが発生したため、32GBのホスト上で12GBへ増やしました。初回推論では公開モデルのダウンロードが発生するため、ネット接続と数GBの空き領域が必要です。GoとNode.jsはコンテナ内でビルドするため、起動時にはホストへのインストールは不要です。

Colimaを使う場合の割り当て例は `colima start --memory 12 --cpus 4` です。起動中のVMの割り当てを変更する場合は、コンテナを停止してから `colima stop` → `colima start --memory 12 --cpus 4` を実行し、Composeを再起動します。今回の環境には反映済みです。

```sh
python3 scripts/dev-init.py
docker compose build
docker compose up -d --wait
```

[http://localhost:8080](http://localhost:8080) を開き、`alice` または `bob` でログインします。これはローカル開発専用の認証です。アップロード、一覧、タグ編集、全文・意味・ハイブリッド検索、完全一致・知覚類似検索、派生メディアの表示、Job状態の確認、論理削除を利用できます。一覧は画像・動画・音声・PDFなどの種類で絞り込めます。更新ボタンの右隣にある「表示方法」で、サムネイル付きリスト、サムネイルのみの正方形グリッド、タイトル付きの詳細グリッドを切り替えられます。詳細グリッドは画像全体が収まるように縦横比を保って表示します。アップロードはライブラリを開いた状態で、ヘッダー右側から実行します。検索方式は検索欄の「キーワード」を開いて変更でき、選択中の方式を表示します。完全一致・類似検索は、ファイル詳細のプレビュー下から実行します。名前変更は詳細の「名前を変更」を開き、Enterまたはフォーカス移動で保存します。処理状況と変換ファイルは詳細内の折りたたみで確認できます。検索結果には該当ページ・時刻を表示し、動画・音声はその時刻から再生します。PDFはページプレビューと元ファイルへのリンクを提供します。

初期化スクリプトは `.env` と `secrets/crypto.yaml` にランダムな開発用認証情報を生成します。既存ファイルは上書きしません。両方ともGitとDockerのビルドコンテキストから除外しています。鍵ファイルを削除すると保存済みデータを復号できなくなるため、DB・S3のデータとともに保持してください。

公開するポートはBFFの `127.0.0.1:8080` のみです。ポート変更時は `.env` の `OCMS_PORT` と `PUBLIC_URL` を両方設定します。最大ファイルサイズは `MAX_UPLOAD_BYTES`（初期値1 GiB）、HTTP転送時間上限は10分です。複数ファイルを選択でき、最大10ファイルを並列に送信します。実際の同時通信数はブラウザや接続方式の制限を受けます。完了・失敗した枠から次のファイルを開始します。8 MiBを超えるファイルは自動で分割し、各ファイル内の部分は順番に送信します。通信失敗時は部分を最大3回送信します。失敗しても後続ファイルを処理し、「再試行」で受信済み部分から再開します。再試行は同じ画面を開いている間に利用でき、再読み込み後の自動復元には対応しません。分割データは暗号化して一時保存し、完了後または25時間経過後に回収します。初期値は負荷試験済みの推奨値ではありません。

Dockerがホームディレクトリへのキャッシュ書き込みを拒否する環境では、次を使います。

```sh
mkdir -p .cache/buildx
BUILDX_CONFIG="$PWD/.cache/buildx" docker compose build
```

S3互換ストレージにはSeaweedFS 4.48の `mini` を使います（[公式の起動手順](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)）。アプリケーション側はMinIO Go SDKでS3 APIを利用し、特定ストレージ製品への依存はTransfer内に限定します。

ヘッダー内の「ライブラリ」「タグ」で画面を切り替えます。「タグ」ではタグ名の検索と一覧・ワードクラウド・グラフの切り替えを利用できます。被リンク数は閲覧できるファイルのうち、そのタグが付いた件数です。多いほどクラウドの文字とグラフの円が大きくなり、線は同じファイルに付いたタグ同士を結びます。タグを選ぶと対応するファイル一覧へ移動します（グラフでは選択後に「ファイルを表示」）。キーボードでは「タグを選択」と「ファイルを表示」も利用できます。一覧・クラウドは上位200タグ、グラフは上位60タグを表示し、検索で絞り込めます。

ワードクラウドの配置は [d3-cloud](https://github.com/jasondavies/d3-cloud)、グラフの配置・描画・ドラッグ・ズームは [Cytoscape.js](https://js.cytoscape.org/) を利用します。どちらもnpm依存に含め、タグの可視化を開くときに遅延読み込みします。クラウドで領域内に配置できないタグがある場合は、一覧から確認できる旨を表示します。

グラフは [cytoscape-cola](https://github.com/cytoscape/cytoscape.js-cola) の重なり回避と継続シミュレーションを使います。タグが付いたファイル数に応じてノードを大きくし、ラベルを含めた間隔を確保します。ドラッグすると周囲も追従し、選択したタグへ表示が寄ります。「再配置」で配置をやり直し、「動きを停止」「動きを再開」で動きを切り替えられます。画面外ではシミュレーションを停止します。OSの動きを減らす設定では静止状態から始めます。

## PWAとして使う

本番ビルドのSPAは、対応ブラウザの「アプリをインストール」や「ホーム画面に追加」からインストールできます。通常の `npm run build` とDockerイメージのビルドに、マニフェスト・アイコン・Service Workerの生成を含みます。追加のパッケージや起動コマンドは不要です。

Service WorkerとインストールにはHTTPSが必要です。ローカル確認には `http://localhost:8080` も使えます。別端末からLAN内のHTTPアドレスへアクセスする場合は、HTTPSを用意してください。ブラウザごとの要件は [MDNのインストールガイド](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) を参照してください。

一度オンラインで開いた後、通信できない状態でホームや既知の画面URLを開くと「オフラインです」と再読み込みのリンクを表示します。オフラインでのファイル閲覧・検索・アップロードは提供しません。Service WorkerのCache Storageには公開のオフライン案内HTMLとCSSだけを保存し、API応答、認証情報、検索結果、メディアを保存しません。通信中のHTTPエラーは元の応答を維持します。

オフライン画面かWorkerの更新でキャッシュ名が変わり、新しいWorkerの有効化時に古いOCMS用キャッシュを削除します。更新は既存のタブやアプリをすべて閉じてから開き直すと反映されます。Vite開発サーバーとStorybookはWorkerを登録しません。

回帰検証は `web/` で `npm run build` の後に `npx playwright test tests/pwa.spec.ts` を実行します。

## 画面のURL

SPAの画面は `/library`（ライブラリ）、`/series`（通常シリーズ）、`/tags`（タグ）、`/characters`（キャラクター）、`/favorites`（お気に入り）、`/recommendations`（個人向けおすすめ）で開けます。`/` は `/library` へ移動します。BFFはこれらのパスへSPAを配信するため、URLの直接入力や再読み込みにも対応します。

ファイル詳細は `/assets/{asset_id}`、全画面閲覧は `/assets/{asset_id}/view` です。`from=favorites` または `from=recommendations` で元の一覧を指定でき、省略時はライブラリを表示します。検索条件は `q`・`mode`・`tag`・`character`・`kind`・`ratings`・`page`、比較元は `source` に保持します。例：`/assets/{asset_id}?from=favorites&page=2`。既定値は省略し、レーティングをすべて外した場合は `ratings=none` になります。タグ・キャラクター画面は `q` と `view=list|graph`（省略時はワードクラウド）を使います。

ブラウザの戻る・進むで条件と選択を復元します。個人向けおすすめは同じタブの履歴では推薦セッションを再利用し、新しいタブや再読み込みでは先頭ページから再取得します。ファイルの直接URLでは、選択を保持したまま背景のおすすめ一覧を先頭ページへ戻します。推薦セッションはURLに含めません。未送信の入力やアップロードの処理状態はURLへ保存せず、一覧の表示方法は既存のブラウザ設定を使います。

未認証の場合は同じURLでログイン画面を表示し、ログイン後に元の画面を開きます。OIDCの `/auth/login?return_to=...` は既知のアプリ内パスだけを受け付けます。アプリのログ・TraceへURLのクエリや復帰先は出力しません。

## 意味検索の無効化

`.env` に `SEMANTIC_SEARCH_ENABLED=false` を設定すると、意味検索とハイブリッド検索、WorkerのEmbedding生成を停止します。未設定時は `true`（有効）です。変更後はSearchとWorkerを再作成してください。初回導入時は、先に `docker compose build` でアプリイメージを更新します。

```sh
docker compose up -d --force-recreate search worker
```

無効化中の `semantic`・`hybrid` 検索はHTTP 503と `SEMANTIC_SEARCH_DISABLED` を返します。全文・知覚類似・完全一致検索、関連コンテンツ、OCR・ASR、自動タグは継続します。SPAの検索方式の選択肢は引き続き表示されるため、キーワード検索を選んでください。

Embedding Jobは新規分も含めてDBに保持し、取得・再試行・期限切れによる失敗確定を停止します。Embedding以外のJobが完了すればAssetは `ready` になり、停止中のEmbedding Jobの失敗もAsset状態に反映しません。既存の検索ベクトルとチェックポイントは削除しません。`true` に戻して同じコマンドを実行すると、待機中・再試行待ち・試行上限未満の期限切れJobを再開し、Asset状態にも再び反映します。既に失敗確定したJobは、通常の再実行操作が必要です。

RuntimeはASRや自動タグにも使うため、停止しません。フラグはSearchとWorkerの起動時に読み込みます。Compose以外で起動する場合も両プロセスへ同じ値を渡してください。DBマイグレーションは不要です。

## シリーズ

ヘッダーの「シリーズ」から通常シリーズの一覧と作成画面を開けます。通常シリーズは独立した作品を順番付きでまとめます。一体型シリーズは、漫画などを1枚ずつアップロードした画像を1作品としてまとめます。OCMSがPDFから生成したページ画像は対象外です。ライブラリの種類「シリーズ」では両方を表示します。

作成画面で種類・名前・作品を選び、上下ボタンで順番を決めて保存します。自分が所有する、同じ公開範囲の作品だけを追加できます。Asset詳細の「シリーズを作成」では、その作品を選択済みで開き、画像の見た目とタイトルが近い候補を優先します。候補は自動追加されません。

一体型は検索・おすすめ・お気に入り・タグ／キャラクター集計でも1件として扱います。タグとキャラクターは構成画像の和集合、レーティングは最大値です。元画像の編集はシリーズ編集画面から行います。一体型のお気に入り操作は全構成画像に適用し、通常シリーズのお気に入りはシリーズ自身に保存します。

「順番に見る」で連続閲覧します。通常シリーズ内の一体型もページ順に展開し、動画・音声は終了時に次へ進みます。ブラウザーが自動再生を止めた場合は再生ボタンを使ってください。画像・PDFは手動で送ります。画像を削除して一体型が残り1枚以下になった場合は自動解除し、残存画像は個別表示へ戻ります。シリーズだけの解除では元のファイルを削除しません。

移行011の適用が必要です。通常の「DBマイグレーションと更新」の手順で更新してください。シリーズAPIと集約規則は仕様書§4.6・§10.5・§12.3、受け入れ基準はAC-25を参照してください。

シリーズの結合試験は使い捨てDBで実行し、起動中の開発環境を変更しません。DockerとGo 1.26以降、`ocms-postgres:local` イメージが必要です。

```sh
docker compose build postgres
python3 scripts/series-integration.py
```

画面の回帰試験は `web/` で次を実行します。

```sh
npm ci
npm run check
npm run build
npx playwright install chromium
npx playwright test tests/series.spec.ts
```

PC・モバイルの画面例は [1440px](docs/series-editor-1440.png)・[390px](docs/series-editor-390.png) を参照してください。仕様の結合試験は合成した索引・推論応答を使い、実モデルによる再推論は行いません。

## 関連コンテンツ

ファイル詳細の「関連コンテンツ」で、選んだファイルに関連するコンテンツを評価順に表示します。評価は共通キャラクター50％・共通タグ30％・見た目や音20％の合算です。キャラクターとタグは集合のJaccard係数、見た目はpHash、音は既存の音響フィンガープリントを使います。解析待ちの項目は0点とし、他の項目の重みは変えません。表示値は確率ではありません。

カードで評価値と共通キャラクター・タグ、知覚類似の理由を確認できます。種類で絞り込み、200件ずつ表示します。ファイルを選んで詳細・全画面閲覧で確認し、さらに「関連コンテンツ」を開いて探索を続けられます。「戻る」で前の比較元・ページ・選択へ戻り、最後は元のライブラリ条件を復元します。

比較元自身・同一内容の別ファイル・未許可・削除済みファイルは推薦しません。メタデータ候補は上位1,000 Asset、知覚類似候補は上位1,000 Blobに制限し、認可後の最大200件を返します。種類フィルターもこの200件以内に適用します。全ライブラリの厳密な順位、意味検索、好みの学習は対象外です。追加のマイグレーションや再推論は不要です。API・評価式は仕様書§10.3を参照してください。

開発スタック起動後に、生成したDB行と実APIを使う結合試験を実行できます。試験用のAsset・ハッシュは終了時に削除し、既存メディアは変更しません。初期設定のローカル開発環境だけで実行してください。

```sh
python3 scripts/recommendations-integration.py
```

実コーデック・モデルによる知覚類似の回帰は、別途 `python3 scripts/media-integration.py` で確認します。
その生成メディアを推薦APIでも確認する場合は、続いて `python3 scripts/recommendations-integration.py --media` を実行します。

## おすすめ

ヘッダーの「おすすめ」は、自分のお気に入りのタグ・キャラクターから好みに近いコンテンツを表示します。関連度に加えてタグ・キャラクターの多様性と直近3回の表示を考慮し、開き直すたび・更新時に内容を選び直します。ページ送りや詳細・関連コンテンツから戻る間は並びを維持します。種類・レーティング変更時は選び直します。

特徴付きのお気に入りがなければ「情報が足りません」と表示します。特徴付き1件から推薦でき、学習成立後に候補がなければ「おすすめがありません」と表示します。登録済みのAssetと同じBlobのAsset、削除済み・未許可のAssetは推薦しません。スコアは確率ではありません。

専用の `recommender` はPython Runtimeのイメージを共用する独立コンテナです。TF-IDFを実行し、Embedding・ASR・WD14のモデルを読み込まず、DB・S3資格情報も持ちません。モデルのダウンロードは不要です。Searchは計算済み候補を24時間、推薦セッションを30分、直近3回の表示履歴を24時間の範囲でPostgreSQLへ保存します。変更指紋が同じなら学習を省き、抽選だけを実行します。入力変更や権限変更、期限切れ時は更新を案内します。

009のマイグレーションが必要です。既存環境の更新は「DBマイグレーションと更新」に従い、履歴のないDBは適用済み番号を確認してbaselineしてください。新規環境は通常の起動手順で009まで適用します。

```sh
python3 scripts/dev-init.py
docker compose build
docker compose up -d --wait
```

APIは `GET /api/v1/recommendations` です。`kind`・`ratings` に対応し、返された `session_id` と同じ条件に `page` を付けると200件単位で取得できます（推薦結果は最大200件）。セッション省略時は新しく生成します。入力変更・期限切れは409、サービス障害・計算競合・30秒の要求期限超過は503です。正の類似度上位1,000件から最大200件を選びます。全ライブラリの厳密な順位・大規模環境の性能・実利用の推薦品質は未評価です。詳細は仕様§10.4・§12.2を参照してください。

画面例：[PC](docs/personal-recommendations-1440.png)、[モバイル](docs/personal-recommendations-375.png)、[320px幅](docs/personal-recommendations-320.png)。

単体・UI検証は既存のGo・Runtime・SPA検証コマンドに含まれます。推薦サービスだけの起動は `docker compose up -d --build --wait recommender`、Python単体テストは次のとおりです。

```sh
docker compose run --rm --no-deps -v "$PWD/runtime:/test:ro" -w /test recommender \
  python -m unittest discover -s /test -p 'test_*.py'
```

実DBの回帰テストは、全マイグレーションを適用した**使い捨てDB**を `OCMS_TEST_DATABASE_URL` に指定して実行します。テスト自身が `catalog_app`・`search_app` に切り替えて権限分離を確認するため、接続はテスト用の管理ロールが必要です。`OCMS_TEST_RECOMMENDATION_URL` を実推薦サービスのURLに指定すると実scikit-learnを呼び、同じ `INTERNAL_TOKEN` を使います。省略時はエンジン応答のスタブを使います。実行中のサービスや既存メディアのあるDBは指定しないでください。

```sh
go test -race ./internal/search -run TestPersonalRecommendationsDatabase -v
python3 scripts/migration-integration.py
```

## CIとReleaseイメージ

GitHub Actionsの `CI` は、ブランチへのpushとPull Requestで次を実行します。

- Go：`go test -race ./...`、`go vet ./...`（Goのバージョンは `go.mod` に従う）。
- DB移行：実PostgreSQLの使い捨てコンテナで `scripts/migration-integration.py` を実行し、適用・排他・復旧・Composeの起動抑止を確認します。
- SPA：Node.js 24で `npm ci`、`npm run check`、`npm run build`、`npm run build-storybook`、Chromiumで `npm run test:ui` と `npm run test:storybook`。レイアウトの座標検査はLinux用の基準値で実行します。任意のスクリーンショット出力（`UI_SCREENSHOTS`）は有効にしません。
- Runtime：Python 3.12（Ubuntu 24.04標準）、NumPyとPillowで `python -m unittest discover -s runtime -p 'test_*.py'`。モデルのダウンロードは不要です。
- Docker：アプリ・CPU版Runtime・CUDA版Runtime・PostgreSQLの4イメージを `linux/amd64` 向けにビルドします。Runtimeは依存整合性・CPU/CUDAの取り違え・アプリの読み込みも検査します。通常のCIではpushしません。

GitHub Releaseを公開すると（`release: published`）、`Release images` がReleaseのタグのコードでGo・SPA・Runtimeの検証を再実行し、すべて成功した後に4イメージをビルドしてGHCRへpushします。Runtimeは公開前にもイメージ内で検査し、失敗した版はpushしません。ドラフト保存やGitタグのpushだけでは公開しません。プレリリースも対象です。[GitHub公式の公開手順](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)に沿って、認証には自動発行される `GITHUB_TOKEN` を使い、公開ジョブだけに `packages: write` を付与しています。追加のPATやSecret登録は不要です。

| Dockerfile | 公開先（`owner/repository` はGitHubリポジトリ名の小文字） | 内容 |
|---|---|---|
| `Dockerfile` | `ghcr.io/owner/repository` | SPAとGoの5サービス共通イメージ。`SERVICE` で役割を選択 |
| `runtime/Dockerfile`（CPU） | `ghcr.io/owner/repository-runtime:v1.2.3-cpu` | CUDA依存を除いたRuntime。CPUサーバー向け |
| `runtime/Dockerfile`（CUDA） | `ghcr.io/owner/repository-runtime:v1.2.3-cuda` | CUDA 12・cuDNN 9版ONNX Runtimeを含む互換イメージ |
| `infra/postgres/Dockerfile` | `ghcr.io/owner/repository-postgres` | PGroonga・pgvector入りPostgreSQL |

アプリとPostgreSQLはReleaseタグ（例：`v1.2.3`）をそのまま使います。Runtimeは同じリポジトリに`v1.2.3-cpu`・`v1.2.3-cuda`を公開します。通常Releaseには`latest-cpu`・`latest-cuda`も付けます。既存利用者向けの`v1.2.3`・`latest`は従来どおりCUDA版の別名にします。Dockerのタグとして有効な名前（英数字・`_` で始まり、英数字・`_`・`.`・`-` の128文字以内。Runtimeは`-cuda`を含む）を使ってください。通常のReleaseには `latest` も付け、プレリリースでは更新しません。`latest` は最後に公開処理が成功した通常Releaseを指し、過去バージョンの再実行でも更新されます。バージョンを固定する場合はReleaseタグまたはdigestを指定してください。

GitHubリポジトリのActionsを有効にし、組織のポリシーでもPackage作成・書き込みを許可してください。同名Packageが既に存在する場合は、そのPackageのActionsアクセス設定でリポジトリに書き込みを許可する必要があります。Packageの公開範囲はGHCRの設定に従います。匿名pullが必要な場合はPackageをPublicに設定してください。

```sh
docker pull ghcr.io/owner/repository:v1.2.3
docker pull ghcr.io/owner/repository-runtime:v1.2.3-cpu
# CUDAライブラリ同梱版を選ぶ場合
docker pull ghcr.io/owner/repository-runtime:v1.2.3-cuda
docker pull ghcr.io/owner/repository-postgres:v1.2.3
```

Runtimeをローカルでビルドする場合、既定はCPU版です。CUDA版はビルド引数で選択します。

```sh
docker build --build-arg RUNTIME_VARIANT=cpu -f runtime/Dockerfile -t ocms-runtime:cpu .
docker build --build-arg RUNTIME_VARIANT=cuda -f runtime/Dockerfile -t ocms-runtime:cuda .
docker run --rm --entrypoint python ocms-runtime:cpu /app/check-runtime-image.py cpu
```

推論エンジンはEmbedding・Whisper・WD14ともONNX Runtime 1.23.2です。CPU版は`onnxruntime`、CUDA版は`onnxruntime-gpu[cuda,cudnn]`を導入します。PyTorch・CTranslate2・SentenceTransformers・PyAVは含めません。画像・音声の前処理にはTransformersのNumPy/Pillow実装を使い、FFmpegはWorkerだけに置きます。モデルは初回の推論時に取得するため、モデル保存領域は別途必要です。

現在のEmbedding・Whisper・WD14の推論はCPU固定です。CUDA版の選択だけではGPU推論は有効になりません。GPUへの処理振り分けとGPU実機での検証は未対応です。CPUサーバーでは`-cpu`を選んでください。既に公開された`v0.1.1`のタグは変更せず、この変更を含む新しいReleaseから版を分けます。

既存の `compose.yaml` はローカルビルド用です。公開イメージを使う環境では、各サービスの `image` に上記の同じReleaseタグを指定し、ローカル用の `pull_policy: never` を解除してください。SQLはアプリ共通イメージの `/app/migrations` に同梱します。`migrate` サービスにも各Goサービスと同じReleaseタグを指定してください。DB初期化用スクリプトやホスト側SQLのマウントは不要です。

ブラウザテストの失敗時は、生成データによる `web/test-results/` をArtifactとして7日間保存します。レイアウトの基準値は `web/tests/library.spec.ts-snapshots/` のOS別ファイルで管理し、更新は対象OSで意図した変更を確認したうえで行います。CIでは自動更新しません。

実DB・S3・モデルを使う結合試験、障害復旧、OIDC・OTLP検証はこのCIの対象外です。仕様§14の受け入れ基準すべてを保証するものではなく、必要な検証は以下の手順で別途実行します。

### ONNX Runtimeを単独で検証する

単体テストはモデルを取得しません。Python 3.12以降で実行します。

```sh
python3 -m venv .cache/venv-runtime
.cache/venv-runtime/bin/pip install -r runtime/requirements.txt onnxruntime==1.23.2
.cache/venv-runtime/bin/python -m unittest discover -s runtime -p 'test_*.py'
```

実モデルの互換性検証はモデルをダウンロードします。参照ベクトルは旧PyTorch版で生成した人工画像・波形・テキストだけを含みます。

```sh
HF_HOME="$PWD/.cache/onnx-hf" PYTHONPATH=runtime .cache/venv-runtime/bin/python scripts/verify-onnx-runtime.py
```

音声認識の回帰検証には、次の生成音声を使います。認識した本文は出力せず、期待語の一致・時刻の範囲・30秒境界・無音を検査します。

```sh
docker compose exec -T worker espeak-ng -v en-us -w /tmp/onnx-speech.wav \
  'The quick brown fox jumps over the lazy dog. This is a test of speech recognition.'
docker compose exec -T worker ffmpeg -v error -y -i /tmp/onnx-speech.wav -ar 16000 -ac 1 /tmp/onnx-speech16.wav
docker compose exec -T worker cat /tmp/onnx-speech16.wav > .cache/onnx-speech.wav
HF_HOME="$PWD/.cache/onnx-hf" PYTHONPATH=runtime .cache/venv-runtime/bin/python scripts/verify-onnx-runtime.py --speech-wav .cache/onnx-speech.wav
```

## 検証

タグ画面の実API・DB検証は `python3 scripts/tags-integration.py` で実行します。初期設定の開発スタックで、生成したDB行を使ってタグ件数・共起・ACL・完全一致フィルター・編集・削除・表示上限を確認し、生成行は終了時に削除します。タグAPI追加に伴うDBマイグレーションはありません。既存環境への反映も「DBマイグレーションと更新」の手順に従い、起動前に未適用のSQLがないことを確認します。

起動後に実API・DB・S3を通して検証します。テストは生成データをDBとS3に残します。初期設定の開発用環境で実行してください。

```sh
python3 scripts/integration.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/media-integration.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/job-recovery.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/recovery.py
```

`integration.py` はセッション・CSRF、S3暗号文、非整列Range / HEAD / If-Range / 416、8並列重複排除、冪等性、ACL、タグ検索、論理削除、DBロール分離を検証します。

`media-integration.py` はテスト用の画像・文字PDF・スキャンPDF・音声・動画を生成し、AC-09〜14を実際のコーデック・OCR・ASR・指紋・モデル・DB・S3を使って検証します。画像OCRも検証する場合は、先に`MEDIA_IMAGE_OCR_ENABLED=true docker compose up -d --wait worker`でWorkerを更新してください。ダミーベクトルや固定の文字起こし結果は使いません。再開時は `--resume` で生成済みの `.cache/media-uploads.json` を使えます。CPU推論は数分かかる場合があります。

`job-recovery.py` はメディア検証後に実行します。JobとBlobの一致・リース期限、Workerへの鍵/資格情報の非配布、read Grantでの変換要求拒否を確認し、Searchを一時停止してJobの再試行と完了を検証します。

`recovery.py` は通常の結合テストに加え、Catalogの完了トランザクションを意図的に失敗させて再試行し、S3とPostgreSQLを一時停止・再開します。また、孤立書き込み記録の回収、実DEK再ラップと復号、S3暗号文の不変性、アプリログへの生成済み秘密情報の非出力を検証します。鍵更新成功時は元の鍵世代へ戻します。途中で失敗した場合は復号に必要な追加キーを残します。共有環境で実行しないでください。

Go 1.26以降がある環境では次を実行できます。

```sh
go test -race ./...
go vet ./...
```

キャッシュ書き込みを作業ディレクトリ内に限定する場合：

```sh
GOPATH="$PWD/.cache/go" GOMODCACHE="$PWD/.cache/go-mod" GOCACHE="$PWD/.cache/go-build" go test -race ./...
GOPATH="$PWD/.cache/go" GOMODCACHE="$PWD/.cache/go-mod" GOCACHE="$PWD/.cache/go-build" go vet ./...
```

フロントエンドだけをビルドする場合はNode.js 24以降を使います。

```sh
cd web
npm ci
npm run check
npm run build
```

整形・lintは `web/biome.json` のBiome設定を使います。`web/` で次を実行します。

| コマンド | 用途 |
|---|---|
| `npm run format` | フォーマットを適用 |
| `npm run format:check` | フォーマットを確認（書き込みなし） |
| `npm run lint` | lintを実行（警告も失敗として扱う） |
| `npm run check` | 整形・lint・import順を一括確認（警告も失敗として扱う） |
| `npm run check:fix` | 整形・import順・安全なlint修正を適用 |
| `npm run check:staged` | ステージ済みのフロントエンドファイルを自動修正・再ステージ |

ソース、テスト、設定ファイルを対象とし、依存パッケージ・ビルド成果物・Playwrightの出力・自動生成の `package-lock.json` は除外します。npmキャッシュに書き込めない環境では `npm ci --cache ../.cache/npm` を使えます。

`web/` の `npm ci`（または `npm install`）でHuskyのコミット前フックを登録します。以後はリポジトリのルートやサブディレクトリからの `git commit` 時に、lint-stagedがステージ済みのフロントエンドファイルへ `biome check --write` を実行し、修正をコミット対象に反映します。自動修正できないエラー・警告が残る場合はコミットを止めます。同じファイルの未ステージ部分は退避・復元されます。フックの再登録は `web/` で `npm run prepare` を実行します。Git管理外のDockerビルドではフックを登録しません。

UI部品は [shadcn/ui](https://ui.shadcn.com/) を使い、ソースを `web/src/components/ui/` に配置しています。Button・Input・Label・Native Select・Progressを導入し、Radix UI、Tailwind CSS 4、CVAと `cn()` で構成しています。`web/components.json` は今後の部品追加用設定です。配色は `web/src/style.css` 冒頭のCSS変数で管理します。既存のワイヤーフレームを保つため、Tailwind Preflightは読み込まず、部品の寸法は既存CSSで調整しています。Native Selectは標準の矢印と単一のselect要素を使う形へ調整しています。部品の更新時は画面の配置・余白・表示切り替えを維持し、以下の回帰テストで確認してください。

### Storybookでコンポーネントを確認する

Node.js 24以降を使い、`web/` で実行します。開発スタックやログインは不要です。

```sh
npm ci
npm run storybook
```

[Storybook](http://127.0.0.1:6006) の `Auth`、`Library`、`UI` から部品を選びます。Controlsでpropsを変更でき、Viewportで1440px・390px・320px幅を確認できます。一覧の3表示、選択、ページ操作、空一覧、検索中、PDF一致ページ、処理失敗、アップロード進捗など68のStoryを用意しています。検索フォーム・種類フィルター・一覧選択はStory内で状態を持ち、入力やクリックの結果を表示します。保存・比較・再処理などのコールバックはActionsで確認できます。

```sh
npm run build-storybook
npx playwright install chromium
npm run test:storybook
```

静的ビルドは `web/storybook-static/` に出力します。`test:storybook` はVitestのブラウザモードとChromiumで全Storyの描画と `play` の操作テストを実行します。Storybookサーバーの事前起動は不要です。Storyと設定も `npm run build` のTypeScript strictチェック対象です。Accessibilityパネルの指摘は確認用（`test: 'todo'`）で、自動テストを失敗させません。既存のファイルボタンでは、ファイル名だけのアクセシブル名と、種類・タグ・状態などを含む可視テキストの不一致が指摘されます。アクセシビリティ適合を検証済みとは扱いません。

`web/src/App.tsx` が認証・API通信・ポーリング・更新を担当し、`web/src/components/library/` の部品へ表示データとコールバックを渡します。型と表示用の関数は `web/src/lib/assets.ts`、Storyは各部品の隣に配置しています。本番と同じ `style.css` とVite設定を使います。生成データとMSWの設定はStorybookだけで読み込み、メディア取得をモックし、それ以外の `/api/` 通信を遮断します。動画・音声Storyはプレイヤーの表示確認用で、実メディアの再生・Range・実APIや認証の検証には使いません。MSW更新時は `web/` で `npx msw init .storybook/public --save` を実行してworkerも更新します。

![生成データを表示したStorybook](docs/storybook-components.png)

### SPAの画面回帰テスト

ルーティング・推薦の主要シナリオをChromium・Firefox・WebKitと、Android／iPhone相当のブラウザ構成で検証する場合は、次を `web/` で実行します。モバイル構成は実機ではなくブラウザのエミュレーションです。

```sh
npx playwright install chromium firefox webkit
npm run test:routing
# 同じシナリオを各構成で2回検証する場合
npm run test:routing -- --repeat-each=2
```

実BFF・Catalog・Transfer・Hydraを使うブラウザ試験は、通常のモックAPI試験と分けています。「Hydra OIDC・OTLPの実接続検証」に従って開発・OIDC検証スタックを最新イメージで起動し、`scripts/media-integration.py` で `.cache/fixtures/car.png` を生成してから、`web/` で `npm run test:live` を実行してください。`localhost:8080` と `localhost:8081` を使い、開発ログイン、OIDCのユーザー選択・同意、元URLへの復帰、プレビュー配信、検索条件、別ユーザーのACLを確認します。合成画像のAssetを作成するため、専用の開発環境で実行してください。生成データはDBとS3に残ります。


画面の回帰テストはPlaywrightとChromiumを使います。上記のビルド後、`web/` で実行します。

```sh
npx playwright install chromium
npm run test:ui
```

テストがローカルのプレビューサーバー（`127.0.0.1:4173`）を起動し、生成データのAPI応答で検索・比較・タグ編集・アップロード・削除確認・認証方式の表示・レスポンシブ表示を検証します。DBやS3には接続しません。実サービスとの接続やRangeは上記の結合試験で、動画の再生・シークは実サービスに接続したブラウザで別途確認します。`UI_SCREENSHOTS=1 npm run test:ui` で生成データのPC・モバイル画面を `docs/library-ia.png` と `docs/library-ia-mobile.png` に保存できます。グリッド2種類も `docs/library-grid.png`、`docs/library-detailed-grid.png` と、それぞれの `-mobile.png` に保存します。

詳細パネルの「ファイル名」はEnterまたはフォーカス移動で自動保存し、Escapeで編集前の名前に戻します。日本語変換中のEnterでは保存しません。タグはチップで表示し、入力欄からEnterまたは「追加」で1件ずつ追加、チップの×で削除します。タグ名・キャラクター名をクリックすると、それぞれに完全一致するファイルを表示します。検索語・種類・比較条件を解除して先頭ページへ戻り、詳細パネルを閉じます。タグ名・キャラクター名はTabで選択し、EnterまたはSpaceでも検索できます。画面例は [タグからの検索](docs/library-tag-search.png)、[キャラクターからの検索](docs/library-character-search.png) を参照してください。カンマを含む入力も1件のタグとして扱います。保存中は編集操作を無効化し、失敗時は入力を保持して「保存を再試行」を表示します。ファイル名は1024バイト、タグは1件256バイト・合計512件が上限です。画面例は [PC](docs/library-ia.png)、[モバイル](docs/library-ia-mobile.png)、[長いタグ・320px幅](docs/library-metadata-320.png) を参照してください。

詳細のプレビューをクリックするか、一覧のファイルをダブルクリック・選択後に再選択すると、暗い背景の全画面閲覧画面を開きます。左右スワイプ・左右キー・前後ボタンで一覧順に移動でき、一覧のページ境界も越えます。動画・音声はプレイヤーを表示し、画像は元画像、PDFはPDF.jsで描画します。画像・PDFは拡大縮小ボタンとピンチ、拡大後のドラッグに対応します。PDF内のページは専用の前後ボタンで移動します。Escapeまたは閉じるボタンで一覧に戻ります。未対応形式や読み込み失敗時にも、元ファイルへのリンクと前後移動を利用できます。PDF.jsのWorker・フォント・CMap・画像デコーダーはビルドに同梱し、外部CDNは使いません。

`UI_SCREENSHOTS=1 npm run test:ui` は閲覧画面を `docs/library-viewer-mobile.png` と `docs/library-viewer-pdf.png` にも保存します。

通常一覧は1ページ200件で取得します。`GET /api/v1/assets` は `limit`（1〜200、既定200）、`offset`（0以上）、`kind`（`image` / `video` / `audio` / `document`）に対応し、ACLとフィルター適用後の `total` を返します。検索・比較は既存APIが返した結果を200件ずつ表示し、APIの結果上限は維持します。右側の詳細は画面に追従し、長い内容はパネル内でスクロールできます。幅800px以下では一覧の上に表示します。

一覧APIの結合検証は、開発スタックを更新・起動した後に実行します。

```sh
python3 scripts/pagination-integration.py
```

217件の生成データで200件を超えるページ移動、同時刻の並び順、種類フィルター、ACLを適用した件数、不正なパラメーターを確認します。実メディアやS3は使わず、試験用のDB行は終了時に削除します。`UI_SCREENSHOTS=1 npm run test:ui` はスクロール中の詳細とページ操作を `docs/library-pagination.png` に保存します。

## Hydra OIDC・OTLPの実接続検証

人がブラウザからOIDCログイン・アップロード・検索を操作し、同じ操作のTrace / Metric / LogをGrafanaで確認するための構成です。事前の自動試験やメディア生成は不要です。

```sh
python3 scripts/dev-init.py
python3 scripts/verify-init.py
docker compose -f compose.yaml -f compose.verify.yaml up -d --build --wait
```

| URL | 用途 |
|---|---|
| [localhost:4446](http://localhost:4446/) | 手動検証の案内・各画面への入口 |
| [localhost:8081](http://localhost:8081/) | OIDC版OCMS。SSOからAlice/Bobを選び、同意してログイン |
| [localhost:3000/d/ocms-verification](http://localhost:3000/d/ocms-verification) | OCMS用Grafanaダッシュボード。実際の通信量・処理時間・Job・Trace一覧・相関ログ |
| [localhost:8080](http://localhost:8080/) | 従来の開発ログイン版OCMS |

1. OIDC版OCMSで「SSOでログイン」→「Aliceでログイン」→「同意してOCMSへ進む」と進みます。Hydraのクライアント登録は起動時に自動実行されます。
2. 画像・音声・動画・PDFをアップロードし、派生ファイル・検索・ダウンロードを試します。
3. GrafanaのOCMSダッシュボードで実データの変化を確認します。初回の収集・表示には数秒かかります。実行していない処理のグラフはNo dataになります。
4. Trace一覧のTrace IDをクリックし、「Open trace tree」からサービス間の親子関係を確認します。詳しく調べる場合は左メニューのExploreからTempoを選び、`{ resource.service.name = "bff" }` などで検索します。Lokiでは `{service_name="worker"}` などでJobログを開き、行を展開してtrace_id/span_idを確認できます。Prometheusでは `media_upload_bytes_total` などを検索できます。
5. OCMSでログアウトしてBobへ切り替え、Aliceの非公開ファイルが一覧・検索・配信で見えないことを確認します。

Grafanaはローカル検証用として、ログインせずにダッシュボードを開けます。管理ログインが必要な場合の初期値は`admin` / `admin`です。すべての公開ポートは127.0.0.1に限定しています。Hydraの管理API、OTLP受信ポート、DB、S3はホストへ公開しません。IdPは生成ユーザーを選ぶ検証用画面で、実際の本人確認は省略しています。本番では使わないでください。

HydraとOIDC用BFFはネットワーク名前空間を共有します。これによりブラウザとBFFの両方から同じissuer `http://localhost:4444` に到達し、署名・issuer・audienceの検証を無効化せずに動作します。追加のhosts設定は不要です。Grafana LGTM 0.37.0（Tempo / Loki / Prometheusなど）へCollectorが三信号を送り、同時にJSON証跡も保存します。Grafanaのデータは`verify-telemetry`ボリュームへ保持します。

自動の回帰検査も実行する場合は、先に `scripts/media-integration.py` で生成メディアを用意してから次を実行します。

```sh
python3 scripts/verify-oidc.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/verify-otel-workload.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/verify-otel.py
```

OIDC試験はHydraのDiscovery・署名鍵・トークンエンドポイントを使ってCode Flowを完了します。PKCE S256、state/nonceの改変拒否、コールバック再利用拒否、セッション、CSRF、別OIDCユーザーのACL分離、ログアウトを検証します。Pocket ID固有の接続・画面操作は別途検証が必要です。

OTel試験は実際のOCR・ASR・Embedding Job、重複アップロード、非整列Range配信、検索を実行し、Collectorが受信したOTLP JSONを検査します。Go全5サービスと推論RuntimeでTrace / Metric / Logの出力、標準リソース属性、仕様§11の主要Span 12種・Metric 10種、HTTPの親子関係、DBへ保存した非同期Trace Context、LogのtraceId/spanId相関、Metricの属性を照合します。監査イベント9種も出力し、成功した処理の主体・結果・Trace相関を検査します。Grant変更は内部Catalog APIで実行します。無効メディアのJob失敗とRuntimeの入力検証エラーも発生させます。Cookie、OAuthコード/state/nonce、CSRF、生成資格情報・KEK、本文・検索語・ヘッダーの検査用文字列がOTLPとアプリ標準出力にないことも確認します。これは生成入力による検査であり、全入力・依存ライブラリ・運用基盤の保証ではありません。

証跡はGit対象外の `.cache/otel/*.jsonl`、結果は `.cache/oidc-results.json` と `.cache/otel-results.json` に残ります。機密情報照合用ファイルは `.cache/*-sensitive.json` に0600で保存し、内容を表示しません。この観測構成はローカル検証用であり、本番向けの認証・TLS・保持運用は別途必要です。

検証後に追加コンテナを停止し、通常構成へ戻すには：

```sh
docker compose -f compose.yaml -f compose.verify.yaml stop bff-oidc oidc-login hydra collector lgtm
docker compose -f compose.yaml -f compose.verify.yaml rm -f bff-oidc oidc-login oidc-setup hydra collector lgtm
docker compose up -d --wait
```

アプリ側は `OTEL_EXPORTER_OTLP_ENDPOINT` が設定されていればOTLP/HTTPでTrace / Metric / Logを送信します。GoはOTel SDKとslogブリッジ、RuntimeはPython SDKを使います。URL・クエリ・Cookie・リクエスト本文・生の例外メッセージを属性へ渡さず、HTTP計測は許可した属性だけを出力します。既定では外部Exporterを使わず、構造化ログを標準出力へ書きます。

## お気に入り

ヘッダーの「お気に入り」から、自分が登録したファイルを確認できます。一覧の各行・カードの星、詳細パネル、閲覧画面から登録・解除できます。同じBlobを参照する別Assetや、共有相手のお気に入りには影響しません。閲覧権限のある共有ファイルも登録できます。

お気に入り一覧は登録が新しい順です。キーワード・意味・ハイブリッド検索、種類フィルター、表示切り替え、ページ送りを利用でき、検索結果は関連度順になります。検索解除・更新・類似比較・完全一致比較でもお気に入りの範囲を維持します。削除済み・閲覧権限を失ったファイルは件数と結果に含めません。権限が戻ると、保存済みのお気に入りが再表示されます。

007は `007_favorites.up.sql` としてgolang-migrateで適用します。既存環境は「DBマイグレーションと更新」に従い、履歴がなければ適用済み番号を一度だけbaselineへ登録してください。006まで適用済みなら `baseline 6` の後に `up` を実行します。旧方式で007を手動適用済みなら `baseline 7` で引き継ぎ、007を再実行しません。更新後は `python3 scripts/favorites-integration.py` で検証します。

登録は `PUT /api/v1/assets/{assetId}/favorite`、解除は同じURLへの `DELETE`（いずれも204）です。`GET /api/v1/assets?favorites=true` で自分のお気に入りに限定し、検索では `POST /api/v1/search` のJSONへ `"favorites": true` を追加します。Asset応答の `is_favorite` は要求ユーザー自身の状態を返します。

## DBマイグレーションと更新

[golang-migrate](https://github.com/golang-migrate/migrate/tree/v4.19.1) v4.19.1をGoライブラリとして利用します。`migrate` サービスが `ocms migrate up` を実行し、`public.schema_migrations` にバージョンとdirty状態を管理します。番号順の実行、DBロック、適用済みの判定、dirty状態はgolang-migrateが担当します。アプリ側のコードは環境変数・既存DBの初回登録・ログの秘匿処理を接続します。管理接続にはロール・拡張の作成と、接続単位のログ設定を変更できる権限が必要です。

空のDBでは `docker compose up -d --wait` が全SQLを適用してからCatalogを起動します。Transfer・Search・Worker・BFFはCatalogを経由して待ち、検証用OIDC BFFも `migrate` の正常終了を待ちます。移行に失敗すると新しいアプリは起動しません。DBの管理資格情報は `migrate` とPostgreSQLだけに渡し、通常サービスのDBロール分離は維持します。

既に起動しているサービスは依存条件では停止しません。更新時はアプリを停止し、移行の成功後に再起動します。`.env` と暗号鍵、既存ボリュームは保持してください。

```sh
docker compose build
docker compose stop bff worker search transfer catalog
docker compose up -d --wait postgres
docker compose run --rm migrate
docker compose up -d --wait
```

OIDC・OTLP環境では、すべてのコマンドで `docker compose -f compose.yaml -f compose.verify.yaml` を使い、停止対象に `bff-oidc` も含めます。失敗時はサービスを停止したまま、以下の状態確認・復旧手順を実行します。

### 履歴のない既存DBを引き継ぐ

旧版でSQLを手動適用したDBには履歴がないため、通常の `up` は `MIGRATION_BASELINE_REQUIRED` で停止します。最後まで適用済みの番号を確認し、一度だけ `baseline` で登録してください。これはSQLを実行せず、宣言したバージョンをgolang-migrateの履歴へ設定する操作です。スキーマや過去のデータ更新を自動判定・検証するものではありません。

例えば006まで適用済みなら、アプリを停止して上の更新手順の `run --rm migrate` の前に次を実行します。

```sh
docker compose run --rm migrate migrate baseline 6
docker compose run --rm migrate
```

004までのDBなら `baseline 4`、002までなら `baseline 2` を指定し、それより後のSQLだけを適用します。履歴のあるDB、空DB、同梱SQLに存在しない番号へのbaselineは拒否します。適用済み番号を推測して指定しないでください。

### 状態確認と失敗後の復旧

```sh
docker compose run --rm migrate migrate version
```

失敗したSQLは `BEGIN` / `COMMIT` によりロールバックしますが、golang-migrateのdirty状態は残り、次の `up` を止めます。原因とDB状態を確認してから、最後に正常終了したバージョンを明示してdirty状態を解除し、再実行します。例えば007が失敗し、006までの状態へ戻っていることを確認できた場合：

```sh
docker compose run --rm migrate migrate force 6
docker compose run --rm migrate
docker compose up -d --wait
```

001自体が失敗し、スキーマ全体が未適用の状態へ戻っている場合は、golang-migrateの未適用バージョンを表す `force -1` を使います。

`force` はSQLを実行せず履歴を書き換える復旧操作です。自動実行しません。適用済みのSQLは変更せず、変更は新しい番号のSQLで追加します。golang-migrateはチェックサム履歴を持たないため、適用済みSQLの改変を自動検出しません。DBのバージョンが同梱SQLより新しいイメージでの `up` は拒否します。自動ダウングレード・`down`・`drop` は提供しません。

SQLは `migrations/NNN_name.up.sql` に追加し、ファイル全体を `BEGIN;` / `COMMIT;` で囲みます。psql専用の変数展開・メタコマンドは使いません。初期ロールのパスワードは管理接続のセッション設定を使い、SQLやプロセス引数へ資格情報を埋め込みません。PostgreSQLはPGroonga・pgvectorを組み込んだ同梱イメージを使います。

検証は既存の開発DBを使わず、一時ネットワーク・ボリュームだけを作成し、終了時に削除します。必要環境はDockerとPython 3.9以降です。

```sh
docker build -f infra/postgres/Dockerfile -t ocms-migration-postgres-test:local .
docker build -t ocms-migration-test:local .
python3 scripts/migration-integration.py --postgres-image ocms-migration-postgres-test:local
go test -race ./...
go vet ./...
```

## メディア処理と検索

保存後は `stored → processing → ready` と進みます。失敗したJobは最大4回まで再試行し、最終失敗時は `failed` を表示します。詳細画面の「変換を要求・失敗処理を再試行」から再実行できます。変換済みファイルは同じ元Blob・プロファイルで共有します。派生BlobもTransferで暗号化・重複排除します。

| 入力 | 標準出力・索引 |
|---|---|
| 画像 | WebP、共用WebPサムネイル、任意のOCR、64bit DCT pHash、ネイティブ画像Embedding |
| 動画 | H.264/AAC MP4（faststart）、PNGサムネイル、5秒間隔・最大12枚のフレームpHash、音声ASR・指紋、30秒単位のネイティブ動画Embedding |
| 音声 | Opus/Ogg、Chromaprint、60秒単位のASRとネイティブ音声Embedding |
| PDF | 全ページのPNGプレビュー・共用WebPサムネイル、テキストレイヤー一括抽出／文字のないページのOCR、ページpHash・Embedding |

WorkerはFFprobe / FFmpeg、Poppler、Tesseract（`eng+jpn`）、Chromaprintを使います。Runtimeの推論はONNX Runtimeに統一しています。ASRは多言語Whisper `tiny`のfp32モデルをCPUで実行し、beam幅3でタイムスタンプを生成します。30秒ごとに処理し、未処理の末尾を次の窓へ引き継ぎます。`ASR_MODEL`は`tiny`のみ対応します。従来の任意モデル名・パス指定は使えません。

意味検索は `google/embeddinggemma-2` のリビジョン `914f7f89142e33e77833254d9c9b90c3cef7303b`、768次元を維持します。ONNX版も同じ重み・プロンプト・正規化を使います。テキスト・画像・動画・音声の生成入力10件で、旧ベクトルとのコサイン類似度0.9999超・成分差0.002未満を検査します。この移行では既存ベクトルの再索引は不要です。検索側は引き続き、Runtimeが返す同じモデルID・リビジョンだけを検索対象にします。

ONNXモデルは次の取得元とコミットへ固定しています。モデルはイメージに含めず、名前付き`models`ボリュームへキャッシュします。Embeddingのfp32重みだけで約2.93 GBあり、Whisper・WD14のキャッシュと合わせて数GBの空き領域が必要です。イメージの小型化と推論時の必要メモリは別に確認してください。

| 用途 | 取得元 | 固定コミット |
|---|---|---|
| Embedding（全4モダリティ） | `onnx-community/embeddinggemma-2-ONNX` | `daa72c51243991dfcaf9f9137d2c573d8f7790c0` |
| ASR | `onnx-community/whisper-tiny` | `ff4177021cc41f7db950912b73ea4fdf7d01d8e7` |
| タグ・キャラクター | `SmilingWolf/wd-v1-4-convnext-tagger-v2` | `4b34d1b07bdd8e95494072648960b8a6adcbc0ff` |

精度はfloat32固定です。`INFERENCE_DTYPE=bfloat16`を設定済みの場合は`float32`へ変更してください。スレッド数は`INFERENCE_THREADS`（1〜32、既定4）で指定します。ONNXのCPU arenaとメモリパターン最適化を無効にし、glibcのarena数も制限します。推論後に不要なCPUメモリを返却して、入力サイズの違いによるメモリの蓄積を抑えます。

画像・動画・PDFにはWD14 Tagger（`SmilingWolf/wd-v1-4-convnext-tagger-v2`、リビジョン `4b34d1b07bdd8e95494072648960b8a6adcbc0ff`）による一般タグを自動追加します。キャラクター（category 4）は一般タグとは独立したメタデータとして閾値0.85で保存します。レーティング（category 9）は除外します。一般タグの閾値は0.35で、それぞれ最大256件を採用します。画像は1枚、動画は全体を等分した最大12フレーム、PDFは全ページを判定し、各タグの最大スコアで集約します。動画の短時間だけ現れる内容をすべて拾う保証はありません。[モデル提供者の実装](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)に合わせ、透過部分の白背景合成・正方形への余白追加・BGR変換を行います。推論はRuntime内のONNX Runtimeで実行し、モデルは既存の`models`ボリュームにキャッシュします。

`tags.generate` Jobはメディア解析後に作成し、失敗時は通常のJobと同じ再試行・リース管理を使います。推論結果はBlob単位で再利用し、各Assetのタグ欄へ一度だけ追加します。手動タグは保持し、追加後は自動タグも編集・削除できます。手動タグを含む合計は512件までとし、自動追加時に上限を超える場合は既存タグを優先します。削除したタグはJob再試行や状態同期で復活しません。重複アップロードにも推論結果だけをコピーし、別Assetの手動タグはコピーしません。タグは既存の一覧・全文検索で検索できます。音声はタグ付け対象外です。

コンテンツレーティングはWD14のcategory 9から `general`・`sensitive`・`questionable`・`explicit` を自動判定します。動画・PDFは判定したフレーム・ページのうち最も制限の強い段階を採用します。手動設定は右側の詳細パネルで行い、再処理でも保持します。リスト・グリッド・詳細グリッドではgeneral以外の判定済みファイルに「R-18」を表示します。判定前と音声は「未判定」です。検索条件の各段階と未判定を個別にオン・オフでき、すべてオフの場合は0件になります。既定はすべてオンです。

レーティングは `008_content_ratings.up.sql` で追加します。「DBマイグレーションと更新」の手順で未適用分を反映し、Runtime・各Goサービスを同じコードへ更新してください。完了済みタグJobを再実行するため、既存コンテンツも順次判定されます。失敗済みJobは詳細から再試行してください。

DBを使うレーティングの回帰テストは、全マイグレーションを適用した使い捨てDBに対して実行します。生成行は終了時に削除します。通常の `go test` では接続先を指定しない限りこのテストをスキップします。

```sh
OCMS_TEST_DATABASE_URL='postgres://<user>:<password>@127.0.0.1:<port>/<test-db>?sslmode=disable' go test -race ./internal/catalog -run TestContentRatingsDatabase
```

004まで適用済みのDBは「DBマイグレーションと更新」の手順で引き継ぎます。履歴がなければ `baseline 4` を一度だけ実行し、以後は `up` で未適用分を反映します。005は解析済みの画像・動画・PDFへタグ付けJobを追加するため、保存済みファイルも順次処理します。既存の失敗Jobは詳細画面から再試行してください。

キャラクターはタグとは別の `catalog.asset_characters` テーブルに保存し、推論結果も `catalog.wd14_character_results` に分離します。詳細パネルから追加・削除でき、上限はタグとは独立して512件、1件256バイトです。ヘッダーの「キャラクター」で名前検索・一覧・ワードクラウド・共起グラフを表示し、選択するとそのキャラクターが付いたファイルへ移動します。件数と共起は閲覧可能なAssetだけから集計します。通常のキーワード検索でもキャラクター名が一致するAssetを取得できます。

005まで適用済みのDBは、履歴がなければ `baseline 5` で引き継ぎます。006は完了済みのタグJobを再実行し、既存ファイルのキャラクターを判定します。一般タグの適用済み状態と手動編集は保持します。更新後の検証は `python3 scripts/characters-integration.py` です。

モデルの初回取得には追加の通信・ディスク容量が必要です。タグ推論の失敗は`TAGGING_FAILED`としてJobへ記録し、画像・タグの内容はログに出しません。生成データでの検証手順：

```sh
docker run --rm -i --entrypoint python ocms-runtime:local < runtime/test_tagger.py
python3 scripts/media-integration.py
python3 scripts/tagging-integration.py
```

Workerはマスターキー・S3資格情報を持ちません。Transferは実行中JobのID、対象Blob、リーストークン、期限をWorkerに照会してから復号データを渡します。平文作業領域はtmpfs内の0700一時ディレクトリで、処理後に削除します。Jobは既定2時間、PDFは既定500ページで、それぞれ `MEDIA_JOB_TIMEOUT_SECONDS` と `MEDIA_MAX_PDF_PAGES` で変更できます。入力/出力256 MiB、画像約1600万画素、動画10分、音声30分、Workerの既定メモリ1536 MiB・tmpfs 1536 MiBという上限も設けています。PDFは最大8ページずつ描画し、ページ画像は保存・抽出後に順次削除します。tmpfsには全ページを保持しません。

新規の画像・PDFは、一覧表示とpHash・タグ・画像EmbeddingでWebPサムネイルを共用し、解析用PNGは保存しません。解像度は長辺512pxに保ち、80,000バイト未満を目標に画質を段階的に下げます。目標は保証値ではなく、非可逆圧縮のため解析結果が変わる可能性があります。画像のOCRは既定で無効です。`MEDIA_IMAGE_OCR_ENABLED=true`をWorkerに設定した場合だけ、作業中のPNGから英語・日本語を抽出します。PDFは1600pxのPNGプレビューを保存し、テキストがないページへのOCRに使います。この処理は画像OCRの設定に関係なく実行します。先頭ページを先に描画・処理し、残りは最大8ページずつ描画して、変換・保存・OCRを既定で最大2ページ並列で実行します。結果はページ順に索引へ追加し、失敗やリース失効時には処理を中断します。PDFは一時的なPPMからPNGプレビューとWebPサムネイルを一度に生成し、画像もOCR用PNGとWebPを同時生成します。PDFのPPMは8ページで最大約61 MBです。抽出本文は全体256 MiB・1ページ2 MiBまでとし、上限超過は切り捨てずJobを失敗させます。既存コンテンツのPNGは引き続き読み取り、既存PDFに解析サムネイルがなければ保存済みプレビューを縮小します。動画は各処理の時間サンプリングを保って縮小フレームを使います。元ファイルの完全一致判定用SHA-256は変更しません。

画像OCRの既定値変更は、更新後に実行するJobへ適用します。既存のOCR索引の一括削除や完了済みJobの自動再処理は行いません。画像を再処理した場合は、その時点の設定に従って索引を更新します。DBマイグレーションは不要です。

Workerは1プロセス内で既定2件のJobを同時に実行します。並列数やリソースはComposeの環境変数で調整できます。設定値は `.env` に追記するか、Compose実行時に環境変数で渡してください。既存の `.env` の資格情報は変更しません。

| 環境変数 | 既定値 | 内容 |
|---|---:|---|
| `MEDIA_IMAGE_OCR_ENABLED` | `false` | 通常画像のOCRを有効にする。PDFのOCRには影響しない |
| `MEDIA_WORKER_CONCURRENCY` | 2 | 1 Workerで同時実行するJob数。1〜8 |
| `MEDIA_PDF_PAGE_CONCURRENCY` | 2 | 1 PDF Job内で同時処理するページ数。1〜8 |
| `INFERENCE_WORKERS` | 1 | 推論Runtimeのプロセス数（正整数）。各プロセスは推論を1件ずつ実行 |
| `INFERENCE_THREADS` | 4 | 各推論プロセスのスレッド数。1〜32 |
| `MEDIA_WORKER_CPUS` | 2 | WorkerコンテナのCPU上限 |
| `MEDIA_WORKER_MEMORY` | `1536m` | Workerコンテナのメモリ上限 |
| `MEDIA_WORKER_TMPFS_SIZE` | `1536m` | Workerの平文一時領域の上限 |

WorkerとPDFの並列数をともに増やすと、複数のOCR・変換プロセスが同時に動きます。Runtimeはプロセスごとにモデルを別々に読み込むため、`INFERENCE_WORKERS` を増やすとメモリとCPUの使用量が大きくなります。既定1プロセスの推論は引き続き直列で、Workerを増やしても推論が律速になることがあります。環境のCPU・メモリに合わせて段階的に調整し、実データで速度とメモリを確認してください。`INFERENCE_WORKERS` はCompose上でUvicornの `WEB_CONCURRENCY` に渡されます。Workerの並列数が範囲外の場合は起動に失敗します。

変更を反映する例：

```sh
MEDIA_WORKER_CONCURRENCY=2 MEDIA_PDF_PAGE_CONCURRENCY=2 INFERENCE_WORKERS=1 docker compose up -d --build --wait worker runtime
```

停止時は実行中のJobをキャンセルし、リースを解放して実行回数を消費せず再試行へ戻します。突然の停止では従来どおりリース期限後に再実行します。処理結果・リース認可・チェックポイントは既存のJob単位で管理します。

Worker・Transferを同じコードへ更新すると、新しいJobからこの経路を使います。DBマイグレーションや既存コンテンツの自動再処理はありません。完了済みの検索ベクトル・タグ・pHashは保持します。WebPへの変更による推論結果・pHashの差や、実データでの処理時間・精度は別途評価が必要です。

解析画像の回帰テストは、全マイグレーションを適用した使い捨てDBで実行できます。PDFの検証にはFFmpeg・Poppler・Tesseract（英語・日本語データ）が必要です。画像の検証ではコーデックを無効にして、保存済みサムネイルだけでタグ・Embeddingが動くことを確認します。推論APIとTransferの保存・配信はテスト用の応答を使い、実モデル・S3の結合検証は既存のメディア試験で行います。

```sh
OCMS_TEST_DATABASE_URL='postgres://<user>:<password>@127.0.0.1:<port>/<test-db>?sslmode=disable' go test -race ./internal/media -run 'Test(AnalysisRenditionAuthorizationDatabase|PDFThumbnailPipelineDatabase|ImageThumbnailJobsDatabase|PDFRenderBatches)'
```

埋め込みは推論1回ごとにベクトルと入力のSHA-256をWorkerのDBへ保存します。再起動・再試行時は同じJob・モデル・リビジョン・推論型・入力に対する結果を再利用し、検索索引全体の保存とJob完了後にチェックポイントを削除します。長い本文は全文を1000文字ずつに分けて処理します。元の本文・画像はチェックポイントへ保存しません。GrafanaのWorkerログにはページ数・ページ完了・チェックポイント保存/再利用を出し、生のツール診断や文書内容は記録しません。期限超過・作業領域不足・メモリ不足・推論サービス停止を区別し、不正入力は無駄な自動再試行をしません。

003まで適用済みのDBは、履歴がなければ `baseline 3` で引き継いでから `up` を実行し、004以降を適用します。推論チェックポイントを利用する前に更新を完了してください。

PDFの任意ページは `/api/v1/assets/{assetId}/preview?page=2` で取得できます。一覧用は `thumbnail=1` を付けるとWebPを優先し、未生成の場合はPNGへフォールバックします。再エンコード要求・一覧は `/api/v1/assets/{assetId}/renditions`、Job一覧は `/api/v1/assets/{assetId}/jobs`、個別状態は `/api/v1/jobs/{jobId}` です。派生ファイルも元Assetの最新ACLを確認して配信します。

静的ファイルは内容ハッシュ付きの `/assets/` を1年間キャッシュし、HTMLやPDF.jsの固定URLはETagで毎回再検証します。静的ビルドはBFFの起動中に書き換えず、配備時にBFFを再作成してください。元ファイル・プレビュー・派生メディアは `private, no-cache` と `Vary: Cookie` でブラウザ内のキャッシュを許可します。再利用前に認証・最新ACLを確認し、ETagが一致すれば304を返して本文の再送・S3読み出し・復号を省きます。再検証の通信は毎回必要で、共有キャッシュとエラー応答の保存は許可しません。取得済み平文がブラウザに残ることはあります。詳細は仕様§5.6を参照してください。

開発スタックで `python3 scripts/cache-integration.py` を実行すると、静的HTML・Viteの生成ファイルと、元ファイル・プレビュー・派生メディアのETag、Range、セッション・ACL失効・削除後の再検証を確認できます。生成したバイト列とDBに登録した派生レコードを使うため、コーデックや推論は検証しません。生成データをDB/S3へ残すので、初期設定の開発用環境で実行してください。

Searchはファイル名・タグに加えて抽出本文をPGroongaで検索します。意味検索はnativeの画像・動画・音声ベクトルと抽出テキストのベクトルを使います。ハイブリッド検索はRRFで順位を統合します。候補生成後にCatalogへ一括認可を問い合わせ、ファイル名やタグはAsset単位で照合します。結果上限は200件、候補上限は1000 Blobです。大規模データのページング・再現率は別途評価が必要です。

## 基盤版からの更新

001/002まで適用済みのDBは保持したまま、新しいPostgreSQLイメージへ切り替えます。「DBマイグレーションと更新」の手順で、履歴がなければ適用済み番号を `baseline` に指定し、その後のSQLを適用してください。未配送のOutboxイベントと既存Blobは引き続き処理されます。以前の保存テストで使った不完全なPNGや空ファイルは、復号配信できてもメディア解析に失敗する場合があります。

## Pocket ID接続

`.env` に次を設定し、Pocket ID側のConfidential ClientにコールバックURLを登録します。値は例です。

```dotenv
AUTH_MODE=oidc
PUBLIC_URL=https://media.example.com
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=<registered-client-id>
OIDC_CLIENT_SECRET=<registered-client-secret>
```

`docker compose up -d --force-recreate bff` で設定を反映します。Code Flow、PKCE、state、nonce、ID Tokenの署名・issuer・audience・有効期限検証を実装しています。HTTPSの公開URLではセッションCookieにSecureを付けます。公開環境には別途TLS終端が必要です。セッションと認証フローはBFFのメモリ内に保持するため、BFF再起動時は再ログインが必要です。複数BFFでのセッション共有は未対応です。Pocket IDとの実接続は未検証です。

ブラウザからの変更要求には同一Originと `/api/v1/me` の `csrf_token` を `X-CSRF-Token` で渡す必要があります。内部サービスの主体ヘッダーはBFFがセッションから再設定します。

## 鍵更新と回収

旧キーを残したまま `secrets/crypto.yaml` に新しい32バイト乱数キーを追加し、`active_key_id` を変更します。Transferを一時的に停止してから、保守用プロセスで再ラップし、起動します。鍵更新中のダウンロード失敗を避けるため、保守時間を設けてください。

```sh
docker compose stop transfer
docker compose run --rm --no-deps transfer rewrap
docker compose up -d --wait transfer
```

再ラップはBlobごとの行ロックを使い、失敗後も再実行できます。S3本体は書き換えません。古いDBバックアップの復号にも旧キーが必要になるため、旧キーは保持します。

孤立オブジェクトの回収はTransferが1分ごとに実行します。書き込み開始から1時間経過し、処理中のUploadロックがなく、確定Blobとして参照されていない書き込み記録だけが対象です。手動実行もできます。

```sh
docker compose exec transfer ocms reconcile
```

確定後にAsset参照がなくなったBlobを削除するGC、Upload期限切れAssetの清掃、DB/S3バックアップは未実装です。論理削除だけでは物理容量は解放しません。

## 構成と開発規約

- `cmd/ocms/`：サービス起動、Transferの保守コマンド
- `internal/bff/`：OIDC、開発ログイン、セッション、CSRF、APIプロキシ
- `internal/catalog/`：Asset、ACL、Upload Session、Outbox
- `internal/transfer/`：ストリーム暗号化、S3、Range、重複排除、再ラップ・回収
- `internal/cryptostore/`：YAML鍵設定とAES暗号のテスト可能な実装
- `internal/search/`：PGroonga全文検索、pHash・Chromaprint、pgvector意味検索、RRF統合とCatalogでの最終認可
- `internal/media/`：Outboxの受信、Jobリース/再試行、メディア処理と索引生成
- `internal/contracts/`：Job、Passage、Rendition、Embeddingの内部契約
- `runtime/`：EmbeddingGemma 2とWhisperの独立したPython推論サービス
- `infra/verify/`：Hydraの試験用ログイン/同意処理、OIDC試験、Collector設定
- `infra/postgres/`：PGroonga/pgvectorを含む開発用DBイメージ
- `internal/platform/`：内部HTTP認証、API応答、OTel Trace / Metric / OTLP Log、相関付き構造化ログ
- `migrations/`：初期DB定義。CatalogとTransferは別ロール・別スキーマ
- `web/`：TypeScript + React SPA
- `scripts/`：開発初期化・実環境結合テスト

Goは `gofmt` を使います。TypeScriptは2スペース、シングルクォート、セミコロン、コンポーネント名はPascalCase、変数・関数名はcamelCaseとします。`npm run build` でTypeScriptのstrictチェックを行います。整形・lintはBiomeを使います。関数と関数の間には空行を1行入れます。Biomeにはこれを強制するルールがないため、空行は手動で入れ、レビューで確認します。

マイグレーションは `migrate` サービスとgolang-migrateで管理し、既存DBにも未適用分を適用します。更新・初回引き継ぎ・復旧のコマンドは「DBマイグレーションと更新」を参照してください。SQLはアプリイメージに同梱し、適用済みファイルは変更しません。

停止は `docker compose down` です。名前付きボリュームは保持します。

## 複数ファイル・分割アップロード

既存環境は通常のDB更新手順で `009_upload_parts.up.sql` まで適用し、BFF・TransferとSPAを更新してください。分割送信中も従来のファイルサイズ上限を適用します。8 MiB以下は従来の一括送信APIを使用します。分割APIの契約は仕様§7・§10、受け入れ条件はAC-23を参照してください。

開発スタック起動後、生成データによる部分再送・結合・ACL・Range・重複排除・回収を確認できます。試験データはDBとS3へ残ります。既定のローカル開発環境で実行してください。

```sh
python3 scripts/upload-integration.py
```
