# 実装・検証状況

2026-10-23時点。保存・配信基盤に加え、Media Workerと実推論Runtime、HydraによるOIDC認証、OTLP三信号の受信をDocker Compose上で検証した。仕様全体の受け入れ完了を意味しない。

## 実装範囲

BFF / Catalog / Transfer / Search / Media Worker / 推論Runtimeを別プロセスで起動する。BFFに暗号鍵やS3資格情報は渡さず、CatalogとTransferは別DBロールで自身のスキーマだけを操作する。Searchはファイル名・タグをCatalogで、本文をPGroongaで検索し、pHash・Chromaprint・pgvectorの検索候補を統合する。結果を返す前に、Catalogが許可したAssetだけへ絞り込む。ファイル名・タグの一致を共有Blob内の別Assetへ流用しない。

Transferは平文をファイルへ保存せず、読み取りストリームからSHA-256を計算し、独立したDEKとnonceでAES-256-CTR暗号化する。S3オブジェクトは暗号文のみで、平文と同じ長さを持つ。DEKはBlob IDをAADに含めてAES-256-GCMでラップする。

S3への書き込み前に `storage.upload_objects` へ処理記録を登録し、暗号文保存後にBlobを確定する。同時重複はSHA-256/サイズのUNIQUE制約で収束する。Upload ID単位のadvisory lockで再送を直列化し、Catalogの完了に失敗しても、再送で確定済みBlobを再利用できる。CatalogはAsset参照・Upload完了・Outboxを同じトランザクションで保存する。WorkerはOutboxを取り込み、Jobの一意制約で重複配送を吸収する。JobはSKIP LOCKEDで取得し、90秒のリースを20秒ごとに更新する。異常終了時は期限後に再取得でき、最大4回まで再試行する。失敗処理をUIから再試行できる。

書き込み記録を残したまま失敗したオブジェクトは、1時間の猶予後、Uploadのロックと確定Blobの不在を確認して回収する。確定済みBlobの参照管理GCは未実装で、共有ファイルを誤って削除しないよう物理削除しない。

## 受け入れ基準の対応

| ID | 状態 | 検証内容・残作業 |
|---|---|---|
| AC-01 | Hydra実接続検証済み・Pocket ID未検証 | Hydra 2.3.0のDiscovery・署名付きID Token・Code Flow + PKCEを実行。state/nonce/PKCE改変・コールバック再利用を拒否し、セッション・CSRF・別OIDC主体のACL・ログアウトを確認。Pocket ID固有の接続は残る |
| AC-02 | 検証済み | 実S3暗号文のサイズとSHA-256を平文と比較。全体復号が元データと一致 |
| AC-03 | 検証済み | YAMLの検証、旧/新KEKのDEK復元、誤ったBlob IDでのunwrap拒否 |
| AC-04 | 検証済み | 実DBのDEKを新世代へ再ラップし、Transfer再起動後の復号成功とS3暗号文不変を確認 |
| AC-05 | 検証済み | 先頭・末尾・中間・1/15/17バイト位置、suffix、416、HEAD、If-Range、複数Rangeの全体応答 |
| AC-06 | 検証済み | 生成したH.264/AAC派生MP4をブラウザで再生し、12.03秒の動画の約6.04秒位置へUIからシーク。readyState=4、配信元が派生content URLであることも確認 |
| AC-07 | 検証済み | 別名・別所有者の同一平文が同じBlobを参照 |
| AC-08 | 検証済み | 8並列アップロードで同じBlobへ収束、Outboxは1件 |
| AC-09 | 検証済み | 画像WebP/PNG、動画H.264/AAC MP4 faststart、音声Opus/Ogg、PDFページPNGを生成。復号配信、派生Range、S3暗号文の長さ/ハッシュ、コンテナ識別子を確認 |
| AC-10 | 検証済み | 別所有者の同一BlobでRendition IDを共有。同じプロファイルの再要求・Job再試行で重複する派生結果を作らない |
| AC-11 | 検証済み | 文字PDF、スキャンPDF、画像OCR、音声ASRの実処理結果をPGroongaで検索。ページ番号とstart_ms/end_msを確認。英語の生成資料で検証し、日本語PGroonga演算子も別途確認 |
| AC-12 | 検証済み | PNGとリサイズJPEG、再エンコード動画、スキャンPDFとその元画像で、DCT pHashの類似候補を確認。実データでの閾値・動画時系列の精度評価は残る |
| AC-13 | 検証済み | 実Chromaprintを計算し、同じ読み上げ音声をMP3/OGGへ別々にエンコードした候補を検出 |
| AC-14 | 検証済み | 実EmbeddingGemma 2の画像・動画・音声ネイティブEmbeddingを768次元pgvectorへ保存。テキストから3種類を検索し、赤い車の画像が魚の画像より上位になることを確認。ハイブリッド検索とACL分離も検証 |
| AC-15 | 一部検証済み | 別ユーザーの一覧・全文/意味/ハイブリッド検索・詳細・配信・削除・重複結果・派生結果を分離。read Grantで閲覧可能・変換要求不可を検証。Grant変更の全組み合わせは残る |
| AC-16 | 検証済み | Go全5サービスと推論RuntimeのTrace / Metric / Logを実Collectorで受信。主要Span 12種とMetric 10種、HTTP親子関係、DBに保存した非同期JobのTrace伝搬、全6サービスのLog相関・リソース属性・Metric属性を照合。監査イベント9種と成功時の主体・処理結果・Trace相関、失敗JobのError Span・カウンタ・監査ログも検証 |
| AC-17 | 一部検証済み | S3/DB停止後の復旧、Catalog完了失敗からの再送、孤立書き込み記録の回収。JobのBlob/リース/期限照合、Search停止からのJob再試行とready復旧も検証。確定Blob GC、DB COMMIT応答喪失の実注入・Worker強制終了専用シナリオは残る |
| AC-18 | 一部検証済み | Collector受信データとアプリ標準出力でも、実OIDCのcode/state/nonce・セッション/CSRF・生成資格情報/KEK・本文/検索/ヘッダーの検査用文字列が含まれないことを確認。構造化ログにCookie・DEK・本文を渡さない。全入力・DEK全件・依存サービスの網羅検査ではない |

## 実行結果

以下をローカルのDocker Engine 29.2.1 / Compose 5.6.0、linux/arm64コンテナで実行した。

- `docker compose build`：Go、TypeScript strictチェック、Vite、PGroonga/pgvectorイメージ、実モデル用Python Runtimeのビルド成功。
- `docker compose up -d --wait`：BFF / Catalog / Transfer / Search / Worker / Runtime / PostgreSQL / SeaweedFSの8コンテナがhealthy。
- 独立した `ocms-init-check` プロジェクトの空ボリュームから初回起動：マイグレーション001〜003、PGroonga/pgvectorの導入と8サービスのhealthyを確認し、検証用スタックだけを削除。
- `python3 scripts/integration.py`：実API・DB・S3を使う基盤の結合検証が成功。
- `python3 scripts/media-integration.py`：実メディア10件を生成・投入してAC-09〜14を検証。最終コードで `--resume` による派生Range・MP4 faststart・各モードACLの回帰検証も成功。
- 2ページのスキャンPDF：両ページの暗号化プレビュー・OCR・ネイティブEmbeddingを確認し、存在しないページが404になることも検証。
- `python3 scripts/job-recovery.py`：Workerの秘密情報非保持、実Jobの読み出し認可、read Grantでの変換要求拒否、Search停止からのJob再試行と派生再利用を検証。
- `PYTHONPYCACHEPREFIX="$PWD/.cache/pycache" python3 scripts/recovery.py`：通常の結合検証に加え、障害・鍵更新の検証が成功。
- `go test -race ./...`：暗号化/復号、鍵設定、Range契約、BFF認証/CSRF、pHashの明度変化耐性、Chromaprintのビット解釈・時間ずれ、推論ベクトル検証のテストが成功。
- `go vet ./...`：指摘なし。
- `compose.verify.yaml` の実Hydra・Collectorを起動し、`scripts/verify-oidc.py`、`scripts/verify-otel-workload.py`、`scripts/verify-otel.py` が成功。再現手順・検査範囲はREADMEの「Hydra OIDC・OTLPの実接続検証」を参照。
- 人による検証用の入口を `localhost:4446`、OIDC版OCMSを `localhost:8081`、Grafanaを `localhost:3000` に追加。ブラウザでAlice選択・同意・認証済みSPAへの復帰・画像アップロード・派生表示を実行した。Grafana LGTMのTempo / Prometheus / Lokiで実Trace・Metric・Logを取得し、専用ダッシュボードでも表示を確認。追加構成は起動したまま利用でき、自動試験の実行は手動利用の前提ではない。
- HTTP計測の属性からURL・クエリ・Cookie・本文を除外し、FastAPIの入力値を含み得る標準例外ログを無効化。HTTPの分散Trace伝搬・秘密情報非出力・206応答の維持をGoの回帰テストでも検証。
- フロントエンド依存のインストール時audit：0件。
- ブラウザ：開発ログイン、検索モード、派生ファイル/Job状態、動画描画・再生・途中シークを確認。

![派生MP4を約6秒へシークした画面](media-library.png)

![OIDCでログインして画像をアップロードした画面](oidc-verification.png)

![実データを表示したGrafanaダッシュボード](telemetry-verification.png)

![GrafanaでTrace詳細を開いた画面](trace-verification.png)

結合テストで見つけたRange解除（SDKのStat呼び出し）と並列重複処理での接続プール枯渇を修正し、同じ結合テストを再実行して通過した。

## 実PDFの解析失敗の修正

Grafanaの失敗ログ・Traceと実Jobを照合し、以下を修正した。

- 70ページPDFがWorkerとTransferそれぞれの固定50ページ制限で拒否されていた。両サービスが共有する `MEDIA_MAX_PDF_PAGES` に統一し、既定値を500へ変更。
- 9ページPDFの埋め込みが毎回600秒で中断され、成功済みの推論まで再計算していた。Job期限を既定7200秒へ変更し、004のチェックポイント表に推論結果を保存。実際の再起動後にページ結果の再利用を確認し、Job完了後は削除。
- CPU推論をfloat32・4スレッドへ変更し、glibcのarena制限と推論後のメモリ返却を追加。本文は全文を1000文字ずつに分割。生成画像での連続推論は約4秒だったが、6GBのColimaでは実ページの推論時にOOMが残ったため、32GBのホスト上でVMを12GBへ増量。最終構成ではRuntimeの再起動なしで処理が完了。
- 生のツール診断・本文を出さずに、期限超過、作業領域不足、メモリ不足、推論サービス停止を区別するログを追加。不正入力は自動再試行を繰り返さず、PDFのページ完了・埋め込みの進捗も記録。

| 実ファイル | 最終状態 | ページプレビュー | ページ埋め込み | 本文を含むベクトル総数 | 追加検証 |
|---|---|---|---|---|---|
| 9ページPDF | ready、両Job完了 | 9 | 9 | 28 | 最終ページの全体/非整列Range、全文検索、意味検索、チェックポイント削除 |
| 70ページPDF | ready、両Job完了 | 70 | 70 | 141 | 最終ページの全体/非整列Range、全文検索、意味検索、チェックポイント削除 |

`scripts/verify-pdf-recovery.py <blob-id> ...` で再検証できる。本文・ファイル名・検索語・資格情報は検査結果へ出さない。結果はGit対象外の `.cache/pdf-recovery-results.json` に保存する。AC-09〜14の回帰試験、追加した30秒動画の実変換・ASR・ネイティブ動画埋め込み、Go race/vet、制限境界・チェックポイント検証・ツール診断の非出力テストも成功した。

検証用の不正PNGや空ファイルによる過去の失敗ログは履歴として残る。今回修正対象とした実PDF2件の失敗Jobは解消し、検証用構成は起動したままにしている。

## ライブラリ画面の情報構成（2026-10-22）

一覧の上に検索・種類フィルターを集約し、ファイル名と処理状態を一覧の主情報にした。詳細はプレビュー、元ファイル、タグ、比較操作の順に配置し、処理状況と変換ファイルは折りたたみに収めた。類似・完全一致は選択ファイルから実行し、結果見出しに比較元を表示する。技術構成の常設説明と単一項目のサイドバーを削除した。

PDF検索結果では一致ページのプレビューを表示する。タグ保存後も検索のページ・時刻を保持する。狭い画面では詳細を一覧の上に表示し、選択時に詳細見出しへフォーカスを移す。

- `web/` の `npm ci` と `npm run build`：成功。
- `npm run test:ui`：生成データのAPI応答を使うChromiumの画面回帰テスト10件が成功。検索3方式、種類フィルター、比較元・解除、タグ保存、PDF一致ページ、再試行、空結果・エラー、削除確認、アップロード、認証方式の表示、狭い画面でのフォーカスを確認。1440 / 1024 / 800 / 390 / 320px幅で横スクロールが出ないことも確認。
- 今回はDocker Engineが停止しているため、実サービスとの結合試験・実動画再生・実OIDCログインは再実行していない。以下は生成データの画面で、実メディアの検証結果ではない。

![再構成したライブラリ画面（生成データ）](library-ia.png)

[モバイル画面（生成データ）](library-ia-mobile.png)

## 一覧の表示切り替え（2026-10-23）

更新ボタンの右隣に表示方法のドロップダウンを追加した。表示を切り替えても、検索結果・種類フィルター・選択中のファイルを保持する。

| 表示方法 | 表示内容 |
|---|---|
| リスト表示（初期表示） | 左端をサムネイルに変更。ファイル名・タグ・処理状態・検索の一致箇所を表示 |
| グリッド表示 | サムネイルのみの正方形。画像は枠を満たすようクロップし、ファイル名は読み上げとツールチップで確認 |
| 詳細グリッド表示 | 正方形のカードにサムネイルとタイトルを表示。画像はクロップせず、縦横比を保って枠内に収める |

画像・動画・PDFは認証付きの既存プレビューURLを遅延読み込みし、PDF検索結果では一致ページを指定する。音声やプレビューを取得できないファイルは代替表示にする。処理状態が変わるとプレビューを再取得する。元ファイルの一括ダウンロードや一覧ごとの変換要求は行わない。

`web/` の `npm ci`・`npm run build` と、生成データのAPI応答を使う画面回帰テスト15件が成功。新規5件でメニュー位置、サムネイルURL、縦長・横長画像、正方形の寸法、表示切り替え後の選択・フィルター・比較結果、プレビュー失敗からの復帰、PDF一致ページを確認した。両グリッドについて、詳細の開閉時と1440 / 1024 / 800 / 390 / 320px幅で横スクロールがないことも確認。実サービスを使う結合試験は今回は再実行していない。

[グリッド表示（生成データ）](library-grid.png) / [モバイル](library-grid-mobile.png)

[詳細グリッド表示（生成データ）](library-detailed-grid.png) / [モバイル](library-detailed-grid-mobile.png)

## フロントエンドの整形・lint（2026-10-23）

`web/` にBiome 2.6.2を固定バージョンで導入した。2スペース、シングルクォート、セミコロンの整形設定と推奨lintルール、import順の整理を有効にした。依存パッケージ、ビルド成果物、Playwright出力、`package-lock.json` は対象外とする。

既存ファイルを整形し、ボタンのtype、暗黙のany、未使用import、非nullアサーションを修正した。既存のEffectの実行タイミング、検索フォーム・ボタングループの構造、字幕契約のないアップロードメディア、別コンテナの画像セレクターは理由付きの局所的な抑制コメントで扱う。関数間の空行は開発規約に追加したが、Biomeには強制するルールがないため手動・レビューで確認する。

`web/` の `npm ci --cache ../.cache/npm`、`npm run format:check`、`npm run lint`、`npm run check`、`npm run build` が成功した。`npm run test:ui` はサンドボックス内でChromiumのMachポート作成を拒否されたため、権限制限の外で再実行して既存15件が成功した。実サービスを使う結合試験は、今回の変更がフロントエンドの開発ツール導入とlint対応のため再実行していない。

## 残る実装・評価

1. Pocket IDとの実接続、セッションの共有永続化、Grant管理の外部契約/UIと網羅テスト。
2. Upload状態の細分化・期限切れ処理、確定Blobの参照管理GC、マイグレーション適用履歴の管理。
3. 動画pHashの時間的整合性を使う二次判定、音源の切り出し・長さ違いの評価、類似閾値の実データ評価。
4. 日本語・多言語OCR/ASRの精度評価。Tesseractの`eng+jpn`と多言語Whisperを使うが、今回のメディアテストは英語の生成資料。日本語PGroongaの索引検索は別途成功を確認。
5. 負荷・キャンセル・Worker強制終了シナリオ。今回のCollectorとGrafana LGTMはローカル検証専用。本番向けの認証・TLS・保持運用は別途必要。
6. 生メディアを入力する `/api/v1/search/by-media`、追加変換プロファイル、一覧/検索のページング、各処理上限の設定化。

## 実装上の制約

- 検索は最大200結果、最大1000 Blob候補。候補生成後のCatalog認可で非公開情報を除外するため、大量の非公開候補が上位にある場合の検索再現率には改善の余地がある。
- 画像のMIMEヘッダー、PDF署名、FFprobeによる解析、画素数・時間・ページ数・作業領域・メモリ・実行期限を制限する。全形式・圧縮爆弾への網羅的な耐性試験は未完了。
- 動画pHashは5秒間隔・最大12フレームの初期実装。動画Embeddingは全体を30秒単位で処理する。動画の順序/時間を使う知覚類似の二次判定は残る。
- プレビュー・変換は標準プロファイルのみ。画像WebP/PNG、動画H.264/AAC MP4、音声Opus/Ogg、PDFページPNGを実装する。手動画質切替、AVIF/JPEG等の追加プロファイルは未実装。
- CPU推論は動画1区間でも数十秒かかる場合がある。大規模処理の速度や検索品質を保証する評価は行っていない。モデルのリビジョン・次元・プレフィックスは統一している。
- Workerの作業平文はtmpfsで処理後に削除し、鍵・S3資格情報はTransferに限定する。Runtimeのメディア一時ファイルもtmpfsで処理後に削除する。
- アプリログとOTLPの非出力検査にはWorker/Runtimeを含む。依存サービスやDocker自身の診断・設定出力、運用環境での収集・保持・アクセス制御は別途評価が必要。

## 参照した一次資料

- [EmbeddingGemma 2のマルチモーダルAPI](https://ai.google.dev/gemma/docs/embeddinggemma/multimodal-embeddinggemma-with-sentence-transformers)
- [PGroonga公式Dockerイメージ](https://github.com/pgroonga/docker)
- [pgvector](https://github.com/pgvector/pgvector)
- [faster-whisperとPyAV 19の非互換](https://github.com/SYSTRAN/faster-whisper/issues/1589)：PyAV 18.1.0へ固定し、ASRには16kHz波形を渡す。
- [Hydra公式Quickstart](https://www.ory.com/docs/oel/hydra/quickstart)
- [OpenTelemetry Go Exporters](https://opentelemetry.io/docs/languages/go/exporters/)
- [Grafana Docker OpenTelemetry LGTM](https://grafana.com/docs/opentelemetry/docker-lgtm/)
