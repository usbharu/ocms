import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { NativeSelect } from './components/ui/native-select';
import { Progress } from './components/ui/progress';
import './style.css';

type Asset = {
  asset_id: string;
  filename: string;
  mime_type: string;
  tags: string[];
  status: string;
  snippet?: string;
  page_number?: number;
  start_ms?: number;
  end_ms?: number;
};
type Rendition = {
  rendition_id: string;
  profile_id: string;
  mime_type: string;
};
type Job = {
  job_id: string;
  job_type: string;
  status: string;
  attempts: number;
  error_code?: string;
};
type Me = { principal_id: string; csrf_token: string };
type Mode =
  | 'keyword'
  | 'semantic'
  | 'hybrid'
  | 'perceptual'
  | 'exact_duplicate';
type SearchContext = { mode: Mode; query: string; source?: Asset };
type View = 'list' | 'grid' | 'detailed-grid';
type Kind = 'all' | 'image' | 'video' | 'audio' | 'document';
const statuses: Record<string, string> = {
  pending: 'アップロード待ち',
  uploading: 'アップロード中',
  stored: '解析待ち',
  processing: '解析中',
  ready: '完了',
  failed: '失敗',
  queued: '待機中',
  retry: '再試行待ち',
  running: '実行中',
  completed: '完了',
};
const kinds: { id: Kind; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'image', label: '画像' },
  { id: 'video', label: '動画' },
  { id: 'audio', label: '音声' },
  { id: 'document', label: 'PDF・その他' },
];
const allFiles: SearchContext = { mode: 'keyword', query: '' };

function kindOf(asset: Asset): Kind {
  const type = asset.mime_type.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio'
    ? type
    : 'document';
}

function locationOf(asset: Asset) {
  if (asset.page_number !== undefined) return `${asset.page_number} ページ`;
  if (asset.start_ms !== undefined)
    return `${Math.floor(asset.start_ms / 60000)}:${String(Math.floor(asset.start_ms / 1000) % 60).padStart(2, '0')}`;
  return '';
}

function renditionName(profile: string) {
  if (profile === 'thumbnail-v1') return 'サムネイル';
  if (profile === 'image.webp-v1') return '画像 · WebP';
  if (profile === 'video.mp4-v1') return '動画 · MP4';
  if (profile === 'audio.opus-v1') return '音声 · Opus';
  const page = profile.match(/^pdf\.page-(\d+)-v1$/);
  return page ? `${page[1]} ページ · PNG` : profile;
}

function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const kind = kindOf(asset);
  const hasPreview =
    kind === 'image' ||
    kind === 'video' ||
    asset.mime_type === 'application/pdf';
  const url = `/api/v1/assets/${asset.asset_id}/preview${asset.page_number !== undefined ? `?page=${asset.page_number}` : ''}`;
  return (
    <span className="thumbnail" aria-hidden="true">
      {hasPreview && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="thumbnail-placeholder">
          {kind === 'audio'
            ? '音声'
            : ['pending', 'stored', 'processing'].includes(asset.status)
              ? '準備中'
              : 'プレビューなし'}
        </span>
      )}
    </span>
  );
}

function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span aria-hidden="true" />
      {statuses[value] ?? value}
    </span>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dev, setDev] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('keyword');
  const [context, setContext] = useState<SearchContext>(allFiles);
  const [kind, setKind] = useState<Kind>('all');
  const [view, setView] = useState<View>('list');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const fileList = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);

  async function request(path: string, init: RequestInit = {}) {
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': me?.csrf_token ?? '',
        ...init.headers,
      },
    });
    if (!res.ok)
      throw new Error(
        (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`,
      );
    return res.status === 204 ? null : res.json();
  }

  async function refresh(next: SearchContext = context) {
    const version = ++requestVersion.current;
    setError('');
    setSearching(true);
    try {
      let res: { assets: Asset[] };
      if (next.source) {
        res = await request(
          `/api/v1/assets/${next.source.asset_id}/${next.mode === 'perceptual' ? 'similar' : 'duplicates'}`,
        );
      } else if (next.query) {
        res = await request('/api/v1/search', {
          method: 'POST',
          body: JSON.stringify({
            query: next.query,
            mode: next.mode,
            limit: 200,
          }),
        });
      } else {
        res = await request('/api/v1/assets');
      }
      if (version === requestVersion.current) {
        setAssets(res.assets);
        setContext(next);
      }
    } finally {
      if (version === requestVersion.current) setSearching(false);
    }
  }
  useEffect(() => {
    fetch('/auth/config')
      .then((r) => r.json())
      .then((c) => setDev(c.development))
      .catch(() => setError('接続できません'));
    fetch('/api/v1/me')
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => setError('接続できません'))
      .finally(() => setAuthLoading(false));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on authentication changes; refresh also captures the current search.
  useEffect(() => {
    if (me) refresh(allFiles).catch((e) => setError(e.message));
  }, [me]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus only when the selected asset changes, not on polling updates.
  useEffect(() => {
    if (selected && window.innerWidth <= 800) detailTitle.current?.focus();
  }, [selected?.asset_id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Keep the polling lease tied to asset identity and authentication, not status updates.
  useEffect(() => {
    setRenditions([]);
    setJobs([]);
    setNotice('');
    if (!selected || !me) return;
    let active = true;
    const update = async () => {
      const [ds, js, asset] = await Promise.all([
        request(`/api/v1/assets/${selected.asset_id}/renditions`),
        request(`/api/v1/assets/${selected.asset_id}/jobs`),
        request(`/api/v1/assets/${selected.asset_id}`),
      ]);
      if (active) {
        setRenditions(ds.renditions);
        setJobs(js.jobs);
        setSelected((current) =>
          current ? { ...current, status: asset.status } : null,
        );
        setAssets((current) =>
          current.map((a) =>
            a.asset_id === asset.asset_id ? { ...a, status: asset.status } : a,
          ),
        );
      }
    };
    update().catch((e) => {
      if (active && !['pending', 'uploading'].includes(selected.status))
        setError(e.message);
    });
    const timer = window.setInterval(() => update().catch(() => {}), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected?.asset_id, me]);

  async function upload(file: File) {
    if (!me) return;
    setError('');
    setProgress(0);
    try {
      const u = await request('/api/v1/uploads', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          size_bytes: file.size,
        }),
      });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/v1/uploads/${u.upload_id}/content`);
        xhr.setRequestHeader('X-CSRF-Token', me.csrf_token);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(
                new Error(
                  'アップロードに失敗しました。ファイルを選び直してください。',
                ),
              );
        xhr.onerror = () => reject(new Error('通信に失敗しました'));
        xhr.send(file);
      });
      const a = await request(`/api/v1/assets/${u.asset_id}`);
      setSelected(a);
      setQuery('');
      setMode('keyword');
      setKind('all');
      await refresh(allFiles);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  const run = (action: () => Promise<void>) =>
    action().catch((e) => setError(e.message));

  const reset = () => {
    setQuery('');
    setMode('keyword');
    setKind('all');
    setSelected(null);
    run(() => refresh(allFiles));
  };

  const compare = (comparison: Mode) => {
    if (!selected) return;
    setKind('all');
    run(() => refresh({ mode: comparison, query: '', source: selected }));
  };

  const mediaURL = (a: Asset) => {
    const d = renditions.find(
      (d) =>
        d.profile_id ===
        (a.mime_type.startsWith('video/') ? 'video.mp4-v1' : 'audio.opus-v1'),
    );
    const url = `/api/v1/assets/${a.asset_id}/${d ? `renditions/${d.rendition_id}/content` : 'content'}`;
    return url + (a.start_ms !== undefined ? `#t=${a.start_ms / 1000}` : '');
  };

  const visibleAssets = assets.filter(
    (a) => kind === 'all' || kindOf(a) === kind,
  );
  const pdfPreview = renditions.find(
    (d) => d.profile_id === `pdf.page-${selected?.page_number ?? 1}-v1`,
  );
  const isResult = Boolean(context.query || context.source);
  return (
    <div className="shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="OCMS ホーム">
          <span aria-hidden="true">◈</span> OCMS
        </a>
        <span className="workspace-name">メディアライブラリ</span>
        {me && (
          <Button
            variant="ghost"
            type="button"
            className="quiet"
            onClick={() =>
              run(async () => {
                await request('/auth/logout', { method: 'POST' });
                ++requestVersion.current;
                setMe(null);
                setAssets([]);
                setSelected(null);
                setContext(allFiles);
                setQuery('');
                setNotice('');
              })
            }
          >
            ログアウト
          </Button>
        )}
      </header>
      <main>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <Button
              variant="ghost"
              type="button"
              className="quiet"
              aria-label="エラーを閉じる"
              onClick={() => setError('')}
            >
              ×
            </Button>
          </div>
        )}
        {authLoading ? (
          <div className="empty" role="status">
            読み込み中…
          </div>
        ) : !me ? (
          <section className="login">
            <span className="login-mark" aria-hidden="true">
              ◈
            </span>
            <h1>ライブラリにログイン</h1>
            {dev ? (
              <>
                <p className="muted">開発用アカウント</p>
                <div className="login-actions">
                  {['alice', 'bob'].map((user) => (
                    <Button
                      variant="outline"
                      type="button"
                      key={user}
                      onClick={() =>
                        run(async () => {
                          const response = await fetch('/auth/dev-login', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ user }),
                          });
                          if (!response.ok)
                            throw new Error('ログインに失敗しました');
                          location.reload();
                        })
                      }
                    >
                      {user} でログイン
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <Button asChild>
                <a href="/auth/login">SSOでログイン</a>
              </Button>
            )}
          </section>
        ) : (
          <>
            <section className="heading">
              <h1>ライブラリ</h1>
              <Button
                variant="default"
                type="button"
                disabled={progress !== null}
                onClick={() => uploadInput.current?.click()}
              >
                ＋ アップロード
              </Button>
              <Input
                ref={uploadInput}
                className="visually-hidden"
                tabIndex={-1}
                type="file"
                aria-label="アップロードするファイル"
                accept="image/*,video/*,audio/*,application/pdf"
                disabled={progress !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                  e.target.value = '';
                }}
              />
            </section>
            {/* biome-ignore lint/a11y/useSemanticElements: The search landmark is also a submitting form. */}
            <form
              className="search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                setSelected(null);
                setKind('all');
                run(() => refresh({ mode, query: query.trim() }));
              }}
            >
              <div className="search-field">
                <span aria-hidden="true">⌕</span>
                <Input
                  type="search"
                  aria-label="検索クエリ"
                  placeholder="ファイルを検索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <NativeSelect
                aria-label="検索方法"
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                <option value="keyword">キーワード</option>
                <option value="semantic">意味</option>
                <option value="hybrid">キーワード＋意味</option>
              </NativeSelect>
              <Button variant="outline" type="submit" disabled={searching}>
                {searching ? '検索中…' : '検索'}
              </Button>
            </form>
            {progress !== null && (
              <div className="upload-progress" role="status">
                <span>アップロード中</span>
                <Progress
                  max={100}
                  value={progress}
                  aria-label="アップロード進捗"
                />
                <span>{progress}%</span>
              </div>
            )}
            <div className="library-toolbar">
              {/* biome-ignore lint/a11y/useSemanticElements: These toggle buttons form a labeled group without fieldset styling. */}
              <div className="filters" role="group" aria-label="ファイルの種類">
                {kinds.map((item) => (
                  <Button
                    variant="outline"
                    type="button"
                    key={item.id}
                    aria-pressed={kind === item.id}
                    onClick={() => setKind(item.id)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
              <div className="view-controls">
                <Button
                  variant="ghost"
                  type="button"
                  className="quiet"
                  disabled={searching}
                  onClick={() => run(() => refresh())}
                >
                  更新
                </Button>
                <NativeSelect
                  aria-label="表示方法"
                  value={view}
                  onChange={(e) => setView(e.target.value as View)}
                >
                  <option value="list">リスト表示</option>
                  <option value="grid">グリッド表示</option>
                  <option value="detailed-grid">詳細グリッド表示</option>
                </NativeSelect>
              </div>
            </div>
            <div className="result-heading" aria-live="polite">
              <h2>
                {context.source
                  ? `${context.mode === 'perceptual' ? '類似ファイル' : '完全一致ファイル'}：${context.source.filename}`
                  : context.query
                    ? `「${context.query}」の検索結果`
                    : kind === 'all'
                      ? 'すべてのファイル'
                      : kinds.find((k) => k.id === kind)?.label}
              </h2>
              <span className="count">
                {searching
                  ? '読み込み中…'
                  : `${visibleAssets.length} 件${kind !== 'all' ? ` / ${assets.length} 件` : ''}`}
              </span>
              {isResult && (
                <Button
                  variant="link"
                  type="button"
                  className="text-button"
                  onClick={reset}
                >
                  検索を解除
                </Button>
              )}
            </div>
            <div className={`library ${selected ? 'has-selection' : ''}`}>
              <section
                ref={fileList}
                className={`files files-${view}`}
                aria-label="ファイル一覧"
                aria-busy={searching}
              >
                {visibleAssets.length === 0 ? (
                  <div className="empty">
                    <span className="empty-icon" aria-hidden="true">
                      ▤
                    </span>
                    <h3>
                      {searching
                        ? '読み込み中…'
                        : isResult
                          ? '検索結果がありません'
                          : kind !== 'all'
                            ? 'この種類のファイルはありません'
                            : 'ファイルはまだありません'}
                    </h3>
                    {!searching &&
                      (isResult || kind !== 'all' ? (
                        <Button variant="outline" type="button" onClick={reset}>
                          すべてのファイル
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          type="button"
                          onClick={() => uploadInput.current?.click()}
                          disabled={progress !== null}
                        >
                          ファイルをアップロード
                        </Button>
                      ))}
                  </div>
                ) : (
                  <>
                    {view === 'list' && (
                      <div className="list-header" aria-hidden="true">
                        <span>ファイル名</span>
                        <span>状態</span>
                      </div>
                    )}
                    <div className={`file-items view-${view}`}>
                      {visibleAssets.map((a) => (
                        <Button
                          variant="outline"
                          type="button"
                          className={`file ${selected?.asset_id === a.asset_id ? 'active' : ''}`}
                          aria-label={a.filename}
                          title={a.filename}
                          aria-pressed={selected?.asset_id === a.asset_id}
                          key={a.asset_id}
                          disabled={searching}
                          onClick={() => {
                            setError('');
                            setSelected(a);
                          }}
                        >
                          <Thumbnail
                            key={`${a.asset_id}:${a.status}:${a.page_number ?? 1}`}
                            asset={a}
                          />
                          <span
                            className={`file-info${view === 'grid' ? ' visually-hidden' : ''}`}
                          >
                            <b>{a.filename}</b>
                            {view === 'list' && (
                              <>
                                <span className="file-meta">
                                  {kinds.find((k) => k.id === kindOf(a))?.label}
                                  {a.tags.length > 0 && (
                                    <span className="file-tags">
                                      {a.tags.join(' · ')}
                                    </span>
                                  )}
                                </span>
                                {a.snippet && (
                                  <span className="snippet">{a.snippet}</span>
                                )}
                                {locationOf(a) && (
                                  <span className="match-location">
                                    {locationOf(a)}
                                  </span>
                                )}
                              </>
                            )}
                          </span>
                          {view === 'list' && <Status value={a.status} />}
                        </Button>
                      ))}
                    </div>
                  </>
                )}
              </section>
              {selected && (
                <section
                  className="details"
                  aria-label="ファイル詳細"
                  key={selected.asset_id}
                >
                  <div className="detail-heading">
                    <h2 ref={detailTitle} tabIndex={-1}>
                      {selected.filename}
                    </h2>
                    <Button
                      variant="ghost"
                      type="button"
                      className="quiet close-detail"
                      aria-label="詳細を閉じる"
                      onClick={() => {
                        fileList.current
                          ?.querySelector<HTMLButtonElement>('.file.active')
                          ?.focus();
                        setSelected(null);
                      }}
                    >
                      ×
                    </Button>
                  </div>
                  <div className="detail-meta">
                    <span>{selected.mime_type}</span>
                    <Status value={selected.status} />
                  </div>
                  <div className="preview">
                    {selected.mime_type.startsWith('image/') ? (
                      <img
                        alt={selected.filename}
                        src={`/api/v1/assets/${selected.asset_id}/${renditions.some((d) => d.profile_id === 'thumbnail-v1') ? 'preview' : 'content'}`}
                      />
                    ) : selected.mime_type.startsWith('video/') ? (
                      // biome-ignore lint/a11y/useMediaCaption: Uploaded media has no caption rendition contract.
                      <video
                        key={mediaURL(selected)}
                        controls
                        preload="metadata"
                        src={mediaURL(selected)}
                      />
                    ) : selected.mime_type.startsWith('audio/') ? (
                      // biome-ignore lint/a11y/useMediaCaption: Uploaded media has no caption rendition contract.
                      <audio
                        key={mediaURL(selected)}
                        controls
                        preload="metadata"
                        src={mediaURL(selected)}
                      />
                    ) : selected.mime_type === 'application/pdf' &&
                      pdfPreview ? (
                      <img
                        alt={`PDF ${selected.page_number ?? 1}ページ目`}
                        src={`/api/v1/assets/${selected.asset_id}/renditions/${pdfPreview.rendition_id}/content`}
                      />
                    ) : (
                      <span className="muted">
                        {selected.mime_type === 'application/pdf' &&
                        ['stored', 'processing'].includes(selected.status)
                          ? 'プレビューを生成中…'
                          : 'プレビューなし'}
                      </span>
                    )}
                  </div>
                  {locationOf(selected) && (
                    <p className="match-location">
                      検索の一致箇所 · {locationOf(selected)}
                    </p>
                  )}
                  <Button asChild variant="outline" className="open-original">
                    <a
                      href={`/api/v1/assets/${selected.asset_id}/content${selected.page_number ? `#page=${selected.page_number}` : ''}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      元ファイルを開く <span aria-hidden="true">↗</span>
                    </a>
                  </Button>
                  <form
                    className="tag-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      const assetId = selected.asset_id;
                      run(async () => {
                        const updated = await request(
                          `/api/v1/assets/${assetId}`,
                          {
                            method: 'PATCH',
                            body: JSON.stringify({
                              tags: String(data.get('tags'))
                                .split(',')
                                .map((t) => t.trim())
                                .filter(Boolean),
                            }),
                          },
                        );
                        setSelected((current) =>
                          current?.asset_id === assetId
                            ? { ...current, tags: updated.tags }
                            : current,
                        );
                        setNotice('タグを保存しました');
                        await refresh();
                      });
                    }}
                  >
                    <Label htmlFor="asset-tags">タグ</Label>
                    <div className="tag-input">
                      <Input
                        id="asset-tags"
                        name="tags"
                        defaultValue={selected.tags.join(', ')}
                        placeholder="カンマ区切りで追加"
                      />
                      <Button variant="outline" type="submit">
                        保存
                      </Button>
                    </div>
                  </form>
                  <div className="detail-section">
                    <h3>このファイルから探す</h3>
                    <div className="comparison-actions">
                      <Button
                        variant="outline"
                        type="button"
                        disabled={searching}
                        onClick={() => compare('perceptual')}
                      >
                        類似ファイル
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        disabled={searching}
                        onClick={() => compare('exact_duplicate')}
                      >
                        完全一致ファイル
                      </Button>
                    </div>
                  </div>
                  <details className="detail-section">
                    <summary>
                      処理状況 <Status value={selected.status} />
                    </summary>
                    {jobs.length === 0 && <p className="muted">処理情報なし</p>}
                    {jobs.map((j) => (
                      <div className="job" key={j.job_id}>
                        <div>
                          <span>
                            {j.job_type === 'media.process'
                              ? 'プレビュー・文字抽出'
                              : '意味検索の索引'}
                          </span>
                          <Status value={j.status} />
                        </div>
                        <small>
                          試行 {j.attempts}
                          {j.error_code ? ` · ${j.error_code}` : ''}
                        </small>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() =>
                        run(async () => {
                          await request(
                            `/api/v1/assets/${selected.asset_id}/renditions`,
                            { method: 'POST', body: '{}' },
                          );
                          setNotice('処理をリクエストしました');
                        })
                      }
                    >
                      {selected.status === 'failed' ? '再試行' : '再処理'}
                    </Button>
                  </details>
                  <details className="detail-section">
                    <summary>
                      変換ファイル{' '}
                      <span className="count">{renditions.length}</span>
                    </summary>
                    {renditions.length === 0 ? (
                      <p className="muted">変換ファイルなし</p>
                    ) : (
                      <ul className="renditions">
                        {renditions.map((d) => (
                          <li key={d.rendition_id}>
                            <a
                              href={`/api/v1/assets/${selected.asset_id}/renditions/${d.rendition_id}/content`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {renditionName(d.profile_id)}{' '}
                              <span aria-hidden="true">↗</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                  {notice && (
                    <p className="notice" role="status">
                      {notice}
                    </p>
                  )}
                  <div className="detail-footer">
                    <Button
                      variant="link"
                      type="button"
                      className="text-button danger"
                      onClick={() => {
                        if (confirm('このファイルを削除しますか？'))
                          run(async () => {
                            await request(
                              `/api/v1/assets/${selected.asset_id}`,
                              { method: 'DELETE' },
                            );
                            setSelected(null);
                            await refresh(
                              context.source?.asset_id === selected.asset_id
                                ? allFiles
                                : context,
                            );
                          });
                      }}
                    >
                      ファイルを削除
                    </Button>
                  </div>
                </section>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(<App />);
