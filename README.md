# OCMS

仕様書 `media-storage-spec-v2.md` に沿って、暗号化保存・配信とAC-09〜14のメディア処理・検索を実装しています。React SPA、Go BFF / Catalog / Transfer / Search / Media Worker、PostgreSQL、S3互換ストレージ、独立した推論RuntimeをDocker Composeで起動します。仕様全体の実装は完了していません。対応状況は [docs/implementation-status.md](docs/implementation-status.md) を参照してください。

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

公開するポートはBFFの `127.0.0.1:8080` のみです。ポート変更時は `.env` の `OCMS_PORT` と `PUBLIC_URL` を両方設定します。最大ファイルサイズは `MAX_UPLOAD_BYTES`（初期値1 GiB）、HTTP転送時間上限は10分です。初期値は負荷試験済みの推奨値ではありません。

Dockerがホームディレクトリへのキャッシュ書き込みを拒否する環境では、次を使います。

```sh
mkdir -p .cache/buildx
BUILDX_CONFIG="$PWD/.cache/buildx" docker compose build
```

S3互換ストレージにはSeaweedFS 4.48の `mini` を使います（[公式の起動手順](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini)）。アプリケーション側はMinIO Go SDKでS3 APIを利用し、特定ストレージ製品への依存はTransfer内に限定します。

ヘッダー内の「ライブラリ」「タグ」で画面を切り替えます。「タグ」ではタグ名の検索と一覧・ワードクラウド・グラフの切り替えを利用できます。被リンク数は閲覧できるファイルのうち、そのタグが付いた件数です。多いほどクラウドの文字とグラフの円が大きくなり、線は同じファイルに付いたタグ同士を結びます。タグを選ぶと対応するファイル一覧へ移動します（グラフでは選択後に「ファイルを表示」）。キーボードでは「タグを選択」と「ファイルを表示」も利用できます。一覧・クラウドは上位200タグ、グラフは上位60タグを表示し、検索で絞り込めます。

ワードクラウドの配置は [d3-cloud](https://github.com/jasondavies/d3-cloud)、グラフの配置・描画・ドラッグ・ズームは [Cytoscape.js](https://js.cytoscape.org/) を利用します。どちらもnpm依存に含め、タグの可視化を開くときに遅延読み込みします。クラウドで領域内に配置できないタグがある場合は、一覧から確認できる旨を表示します。

グラフは [cytoscape-cola](https://github.com/cytoscape/cytoscape.js-cola) の重なり回避と継続シミュレーションを使います。タグが付いたファイル数に応じてノードを大きくし、ラベルを含めた間隔を確保します。ドラッグすると周囲も追従し、選択したタグへ表示が寄ります。「再配置」で配置をやり直し、「動きを停止」「動きを再開」で動きを切り替えられます。画面外ではシミュレーションを停止します。OSの動きを減らす設定では静止状態から始めます。

## 検証

タグ画面の実API・DB検証は `python3 scripts/tags-integration.py` で実行します。初期設定の開発スタックで、生成したDB行を使ってタグ件数・共起・ACL・完全一致フィルター・編集・削除・表示上限を確認し、生成行は終了時に削除します。タグAPI追加に伴うDBマイグレーションはありません。既存環境への反映は `docker compose build bff` の後、`docker compose up -d --no-deps --wait catalog bff` を実行します。OIDC検証環境では `docker compose -f compose.yaml -f compose.verify.yaml up -d --no-deps --wait catalog bff bff-oidc` を使います。

起動後に実API・DB・S3を通して検証します。テストは生成データをDBとS3に残します。初期設定の開発用環境で実行してください。

```sh
python3 scripts/integration.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/media-integration.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/job-recovery.py
PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/recovery.py
```

`integration.py` はセッション・CSRF、S3暗号文、非整列Range / HEAD / If-Range / 416、8並列重複排除、冪等性、ACL、タグ検索、論理削除、DBロール分離を検証します。

`media-integration.py` はテスト用の画像・文字PDF・スキャンPDF・音声・動画を生成し、AC-09〜14を実際のコーデック・OCR・ASR・指紋・モデル・DB・S3を使って検証します。ダミーベクトルや固定の文字起こし結果は使いません。再開時は `--resume` で生成済みの `.cache/media-uploads.json` を使えます。CPU推論は数分かかる場合があります。

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

画面の回帰テストはPlaywrightとChromiumを使います。上記のビルド後、`web/` で実行します。

```sh
npx playwright install chromium
npm run test:ui
```

テストがローカルのプレビューサーバー（`127.0.0.1:4173`）を起動し、生成データのAPI応答で検索・比較・タグ編集・アップロード・削除確認・認証方式の表示・レスポンシブ表示を検証します。DBやS3には接続しません。実サービスとの接続やRangeは上記の結合試験で、動画の再生・シークは実サービスに接続したブラウザで別途確認します。`UI_SCREENSHOTS=1 npm run test:ui` で生成データのPC・モバイル画面を `docs/library-ia.png` と `docs/library-ia-mobile.png` に保存できます。グリッド2種類も `docs/library-grid.png`、`docs/library-detailed-grid.png` と、それぞれの `-mobile.png` に保存します。

詳細パネルの「ファイル名」はEnterまたはフォーカス移動で自動保存し、Escapeで編集前の名前に戻します。日本語変換中のEnterでは保存しません。タグはチップで表示し、入力欄からEnterまたは「追加」で1件ずつ追加、チップの×で削除します。カンマを含む入力も1件のタグとして扱います。保存中は編集操作を無効化し、失敗時は入力を保持して「保存を再試行」を表示します。ファイル名は1024バイト、タグは1件256バイト・合計512件が上限です。画面例は [PC](docs/library-ia.png)、[モバイル](docs/library-ia-mobile.png)、[長いタグ・320px幅](docs/library-metadata-320.png) を参照してください。

詳細のプレビューをクリックするか、一覧のファイルをダブルクリック・選択後に再選択すると、暗い背景の全画面閲覧画面を開きます。左右スワイプ・左右キー・前後ボタンで一覧順に移動でき、一覧のページ境界も越えます。動画・音声はプレイヤーを表示し、画像は元画像、PDFはPDF.jsで描画します。画像・PDFは拡大縮小ボタンとピンチ、拡大後のドラッグに対応します。PDF内のページは専用の前後ボタンで移動します。Escapeまたは閉じるボタンで一覧に戻ります。未対応形式や読み込み失敗時にも、元ファイルへのリンクと前後移動を利用できます。PDF.jsのWorker・フォント・CMap・画像デコーダーはビルドに同梱し、外部CDNは使いません。

`UI_SCREENSHOTS=1 npm run test:ui` は閲覧画面を `docs/library-viewer-mobile.png` と `docs/library-viewer-pdf.png` にも保存します。

通常一覧は1ページ24件で取得します。`GET /api/v1/assets` は `limit`（1〜200、既定200）、`offset`（0以上）、`kind`（`image` / `video` / `audio` / `document`）に対応し、ACLとフィルター適用後の `total` を返します。検索・比較は既存APIが返した結果を24件ずつ表示し、APIの結果上限は維持します。右側の詳細は画面に追従し、長い内容はパネル内でスクロールできます。幅800px以下では一覧の上に表示します。

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

## メディア処理と検索

保存後は `stored → processing → ready` と進みます。失敗したJobは最大4回まで再試行し、最終失敗時は `failed` を表示します。詳細画面の「変換を要求・失敗処理を再試行」から再実行できます。変換済みファイルは同じ元Blob・プロファイルで共有します。派生BlobもTransferで暗号化・重複排除します。

| 入力 | 標準出力・索引 |
|---|---|
| 画像 | WebP、PNGサムネイル、OCR、64bit DCT pHash、ネイティブ画像Embedding |
| 動画 | H.264/AAC MP4（faststart）、PNGサムネイル、5秒間隔・最大12枚のフレームpHash、音声ASR・指紋、30秒単位のネイティブ動画Embedding |
| 音声 | Opus/Ogg、Chromaprint、60秒単位のASRとネイティブ音声Embedding |
| PDF | 全ページのPNGプレビュー、テキストレイヤー抽出／文字のないページのOCR、ページpHash・Embedding |

WorkerはFFprobe / FFmpeg、Poppler、Tesseract（`eng+jpn`）、Chromaprintを使います。ASRはfaster-whisperの多言語`tiny`モデルをCPU/int8で実行します。意味検索は `google/embeddinggemma-2` のリビジョン `914f7f89142e33e77833254d9c9b90c3cef7303b`、768次元です。CPU推論の既定値はfloat32・4スレッドで、`INFERENCE_DTYPE`（float32 / bfloat16）と `INFERENCE_THREADS`（1〜32）で指定します。glibcのarena数を制限し、推論後に不要なCPUメモリを返却して、ページの縦横比の違いによるメモリの蓄積を抑えます。検索側もRuntimeが返す同じモデルID・リビジョンだけを検索対象にします。モデルは名前付き`models`ボリュームへキャッシュします。

画像・動画・PDFにはWD14 Tagger（`SmilingWolf/wd-v1-4-convnext-tagger-v2`、リビジョン `4b34d1b07bdd8e95494072648960b8a6adcbc0ff`）による一般タグを自動追加します。キャラクター（category 4）は一般タグとは独立したメタデータとして閾値0.85で保存します。レーティング（category 9）は除外します。一般タグの閾値は0.35で、それぞれ最大256件を採用します。画像は1枚、動画は全体を等分した最大12フレーム、PDFは全ページを判定し、各タグの最大スコアで集約します。動画の短時間だけ現れる内容をすべて拾う保証はありません。[モデル提供者の実装](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)に合わせ、透過部分の白背景合成・正方形への余白追加・BGR変換を行います。推論はRuntime内のONNX Runtimeで実行し、モデルは既存の`models`ボリュームにキャッシュします。

`tags.generate` Jobはメディア解析後に作成し、失敗時は通常のJobと同じ再試行・リース管理を使います。推論結果はBlob単位で再利用し、各Assetのタグ欄へ一度だけ追加します。手動タグは保持し、追加後は自動タグも編集・削除できます。手動タグを含む合計は512件までとし、自動追加時に上限を超える場合は既存タグを優先します。削除したタグはJob再試行や状態同期で復活しません。重複アップロードにも推論結果だけをコピーし、別Assetの手動タグはコピーしません。タグは既存の一覧・全文検索で検索できます。音声はタグ付け対象外です。

004まで適用済みのDBには005・006を一度適用し、Runtimeと各Goサービスを更新します。005適用済みの場合は、後述の006のみの反映手順を使ってください。005は解析済みの画像・動画・PDFへタグ付けJobを追加するため、保存済みファイルも順次処理します。既存の失敗Jobは詳細画面から再試行してください。

```sh
docker compose stop worker
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/005_wd14_tags.sql
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/006_characters.sql
BUILDX_CONFIG="$PWD/.cache/buildx" docker compose build runtime bff
docker compose up -d --wait
# OIDC・OTLP検証構成を使っている場合は上のupを次で置き換える
# docker compose -f compose.yaml -f compose.verify.yaml up -d --wait
```

キャラクターはタグとは別の `catalog.asset_characters` テーブルに保存し、推論結果も `catalog.wd14_character_results` に分離します。詳細パネルから追加・削除でき、上限はタグとは独立して512件、1件256バイトです。ヘッダーの「キャラクター」で名前検索・一覧・ワードクラウド・共起グラフを表示し、選択するとそのキャラクターが付いたファイルへ移動します。件数と共起は閲覧可能なAssetだけから集計します。通常のキーワード検索でもキャラクター名が一致するAssetを取得できます。

005適用済みの既存DBには006を一度適用します。完了済みのタグJobを再実行し、既存ファイルのキャラクターを判定します。一般タグの適用済み状態は保持し、編集済みのタグを復元しません。失敗済みJobは詳細画面から再試行してください。既存環境への反映手順：

```sh
docker compose stop worker
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/006_characters.sql
BUILDX_CONFIG="$PWD/.cache/buildx" docker compose build runtime bff
docker compose up -d --wait
# OIDC・OTLP検証構成では上のupを次で置き換える
# docker compose -f compose.yaml -f compose.verify.yaml up -d --wait
python3 scripts/characters-integration.py
```

モデルの初回取得には追加の通信・ディスク容量が必要です。タグ推論の失敗は`TAGGING_FAILED`としてJobへ記録し、画像・タグの内容はログに出しません。生成データでの検証手順：

```sh
docker run --rm -i --entrypoint python ocms-runtime:local < runtime/test_tagger.py
python3 scripts/media-integration.py
python3 scripts/tagging-integration.py
```

Workerはマスターキー・S3資格情報を持ちません。Transferは実行中JobのID、対象Blob、リーストークン、期限をWorkerに照会してから復号データを渡します。平文作業領域はtmpfs内の0700一時ディレクトリで、処理後に削除します。Jobは既定2時間、PDFは既定500ページで、それぞれ `MEDIA_JOB_TIMEOUT_SECONDS` と `MEDIA_MAX_PDF_PAGES` で変更できます。入力/出力256 MiB、画像約1600万画素、動画10分、音声30分、Workerのメモリ768 MiB・tmpfs 768 MiBという上限も設けています。PDFのページ画像は保存・抽出後に順次削除し、ページ数に比例してtmpfsを消費しないようにしています。

埋め込みは推論1回ごとにベクトルと入力のSHA-256をWorkerのDBへ保存します。再起動・再試行時は同じJob・モデル・リビジョン・推論型・入力に対する結果を再利用し、検索索引全体の保存とJob完了後にチェックポイントを削除します。長い本文は全文を1000文字ずつに分けて処理します。元の本文・画像はチェックポイントへ保存しません。GrafanaのWorkerログにはページ数・ページ完了・チェックポイント保存/再利用を出し、生のツール診断や文書内容は記録しません。期限超過・作業領域不足・メモリ不足・推論サービス停止を区別し、不正入力は無駄な自動再試行をしません。

既存の003適用済みDBには、チェックポイント用の004を一度適用してからWorkerを更新します。今回の作業環境には適用済みです。

```sh
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/004_embedding_checkpoints.sql
```

PDFの任意ページは `/api/v1/assets/{assetId}/preview?page=2` で取得できます。再エンコード要求・一覧は `/api/v1/assets/{assetId}/renditions`、Job一覧は `/api/v1/assets/{assetId}/jobs`、個別状態は `/api/v1/jobs/{jobId}` です。派生ファイルも元Assetの最新ACLを確認して配信します。

Searchはファイル名・タグに加えて抽出本文をPGroongaで検索します。意味検索はnativeの画像・動画・音声ベクトルと抽出テキストのベクトルを使います。ハイブリッド検索はRRFで順位を統合します。候補生成後にCatalogへ一括認可を問い合わせ、ファイル名やタグはAsset単位で照合します。結果上限は200件、候補上限は1000 Blobです。大規模データのページング・再現率は別途評価が必要です。

## 基盤版からの更新

既存の001/002適用済みDBは保持したまま、先に新しいPostgreSQLイメージへ切り替え、003〜006を一度適用します。

```sh
docker compose build
docker compose stop worker
docker compose up -d --no-deps --wait postgres
docker compose exec -T postgres sh -c 'psql -U ocms -d ocms -v ON_ERROR_STOP=1 -v app_password="$APP_DB_PASSWORD" -f /migrations/003_media_search.sql'
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/004_embedding_checkpoints.sql
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/005_wd14_tags.sql
docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/006_characters.sql
docker compose up -d --wait
```

今回の作業環境には適用済みです。003を繰り返し実行する必要はありません。未配送のOutboxイベントはWorkerが受け取り、既存Blobも処理します。以前の保存テストで使ったPNGヘッダーだけの疑似データや空ファイルは、復号配信できても実メディアとして解析できないため、処理失敗になるのが正常です。

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

マイグレーションは空のPostgreSQLボリュームへの初回起動時に001〜006を番号順で適用します。PostgreSQLイメージにはPGroonga 4.1.0とpgvector 0.8.7を組み込んでいます。既存DBへ自動適用する仕組みは未実装です。既存環境への追加時は対象SQLを `docker compose exec -T postgres psql -U ocms -d ocms -v ON_ERROR_STOP=1 -f /migrations/<filename>` で適用します。

停止は `docker compose down` です。名前付きボリュームは保持します。
