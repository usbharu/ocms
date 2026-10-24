import { useEffect, useRef, useState } from 'react';
import { AppHeader } from './components/library/AppHeader';
import { AssetDetails } from './components/library/AssetDetails';
import { AssetList } from './components/library/AssetList';
import { AssetViewer } from './components/library/AssetViewer';
import { LibraryToolbar } from './components/library/LibraryToolbar';
import { LoginPanel } from './components/library/LoginPanel';
import { SearchForm } from './components/library/SearchForm';
import { UploadControl } from './components/library/UploadControl';
import { UploadProgress } from './components/library/UploadProgress';
import { TagsPage } from './components/tags/TagsPage';
import { Button } from './components/ui/button';
import {
  type Asset,
  type AssetChanges,
  allFiles,
  type Job,
  type Kind,
  kindOf,
  kinds,
  type Me,
  type Mode,
  pageSize,
  type Rendition,
  type SearchContext,
  type View,
} from './lib/assets';

const viewStorageKey = 'ocms.library.view';

function savedView(): View {
  try {
    const value = localStorage.getItem(viewStorageKey);
    if (value === 'grid' || value === 'detailed-grid' || value === 'list')
      return value;
  } catch {
    // Storage may be disabled in the browser; keep the default view usable.
  }
  return 'list';
}

export function App() {
  const [section, setSection] = useState<
    'library' | 'tags' | 'characters' | 'favorites'
  >('library');
  const [favoriteBusy, setFavoriteBusy] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const favoritePending = useRef(new Set<string>());
  const collectionRef = useRef({
    context: allFiles,
    page: 1,
    kind: 'all' as Kind,
  });
  const sectionRef = useRef(section);
  const [me, setMe] = useState<Me | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dev, setDev] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<Asset | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerMoving, setViewerMoving] = useState(false);
  const [renditions, setRenditions] = useState<Rendition[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('keyword');
  const [context, setContext] = useState<SearchContext>(allFiles);
  const [kind, setKind] = useState<Kind>('all');
  const [view, setView] = useState<View>(savedView);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const fileList = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
  const selectedId = useRef(selected?.asset_id);
  selectedId.current = selected?.asset_id;
  sectionRef.current = section;

  useEffect(() => {
    try {
      localStorage.setItem(viewStorageKey, view);
    } catch {
      // View changes still work when storage is unavailable or full.
    }
  }, [view]);

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

  async function refresh(
    next: SearchContext = context,
    nextPage = page,
    nextKind: Kind = kind,
  ): Promise<Asset[] | undefined> {
    collectionRef.current = { context: next, page: nextPage, kind: nextKind };
    const version = ++requestVersion.current;
    setError('');
    setSearching(true);
    try {
      let res: { assets: Asset[]; total?: number };
      if (next.source) {
        res = await request(
          `/api/v1/assets/${next.source.asset_id}/${next.mode === 'perceptual' ? 'similar' : 'duplicates'}${next.favorites ? '?favorites=true' : ''}`,
        );
      } else if (next.query && !next.tag && !next.character) {
        res = await request('/api/v1/search', {
          method: 'POST',
          body: JSON.stringify({
            query: next.query,
            mode: next.mode,
            limit: 200,
            ...(next.favorites ? { favorites: true } : {}),
          }),
        });
      } else {
        const params = new URLSearchParams({
          ...(next.favorites ? { favorites: 'true' } : {}),
          ...(next.tag ? { tag: next.tag } : {}),
          ...(next.character ? { character: next.character } : {}),
          limit: String(pageSize),
          offset: String((nextPage - 1) * pageSize),
          ...(nextKind !== 'all' ? { kind: nextKind } : {}),
        });
        res = await request(`/api/v1/assets?${params}`);
        if (
          version === requestVersion.current &&
          res.total !== undefined &&
          nextPage > 1 &&
          res.total <= (nextPage - 1) * pageSize
        ) {
          return await refresh(
            next,
            Math.max(1, Math.ceil(res.total / pageSize)),
            nextKind,
          );
        }
      }
      if (version === requestVersion.current) {
        setAssets(res.assets);
        setTotal(res.total ?? null);
        setPage(nextPage);
        setKind(nextKind);
        setContext(next);
        return res.assets;
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
    if (me) refresh(allFiles, 1, 'all').catch((e) => setError(e.message));
  }, [me]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus only when the selected asset changes, not on polling updates.
  useEffect(() => {
    if (selected && !viewerOpen && window.innerWidth <= 800)
      detailTitle.current?.focus();
  }, [selected?.asset_id, viewerOpen]);
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
      await refresh(allFiles, 1, 'all');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  const run = (action: () => Promise<unknown>) =>
    action().catch((e) => setError(e.message));

  const reset = () => {
    setQuery('');
    setMode('keyword');
    setKind('all');
    setSelected(null);
    run(() =>
      refresh({ ...allFiles, favorites: section === 'favorites' }, 1, 'all'),
    );
  };

  const compare = (comparison: Mode) => {
    if (!selected) return;
    setKind('all');
    run(() =>
      refresh(
        {
          mode: comparison,
          query: '',
          source: selected,
          favorites: context.favorites,
        },
        1,
        'all',
      ),
    );
  };

  const visibleAssets = assets.filter(
    (a) => kind === 'all' || kindOf(a) === kind,
  );
  const isResult = Boolean(
    (context.query && !context.tag && !context.character) || context.source,
  );
  const resultCount =
    !isResult && total !== null ? total : visibleAssets.length;
  const pageCount = Math.max(1, Math.ceil(resultCount / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageAssets =
    !isResult && total !== null
      ? visibleAssets
      : visibleAssets.slice(
          (currentPage - 1) * pageSize,
          currentPage * pageSize,
        );

  const selectedIndex = pageAssets.findIndex(
    (asset) => asset.asset_id === selected?.asset_id,
  );

  function changePage(nextPage: number) {
    if (!isResult && total !== null) {
      run(() => refresh(context, nextPage));
    } else {
      setPage(nextPage);
    }
    fileList.current?.scrollIntoView({ block: 'start' });
    fileList.current?.focus({ preventScroll: true });
  }

  function openViewer(asset: Asset) {
    setError('');
    setSelected(asset);
    setViewerOpen(true);
  }

  async function moveViewer(direction: number) {
    if (!selected || viewerMoving) return;
    const index = selectedIndex;
    const next = pageAssets[index + direction];
    if (next) {
      setSelected(next);
      return;
    }
    const nextPage = currentPage + direction;
    if (index < 0 || nextPage < 1 || nextPage > pageCount) return;
    setViewerMoving(true);
    try {
      if (!isResult && total !== null) {
        const items = await refresh(context, nextPage);
        if (items?.length)
          setSelected(direction > 0 ? items[0] : items[items.length - 1]);
      } else {
        const items = visibleAssets.slice(
          (nextPage - 1) * pageSize,
          nextPage * pageSize,
        );
        setPage(nextPage);
        setSelected(direction > 0 ? items[0] : items[items.length - 1]);
      }
    } catch {
      setError('次のファイルを読み込めません。再度お試しください。');
    } finally {
      setViewerMoving(false);
    }
  }

  function logout() {
    run(async () => {
      await request('/auth/logout', { method: 'POST' });
      ++requestVersion.current;
      setMe(null);
      setSection('library');
      setAssets([]);
      setSelected(null);
      setContext(allFiles);
      setQuery('');
      setNotice('');
    });
  }

  function devLogin(user: string) {
    run(async () => {
      const response = await fetch('/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user }),
      });
      if (!response.ok) throw new Error('ログインに失敗しました');
      location.reload();
    });
  }

  function search() {
    setSelected(null);
    setKind('all');
    run(() =>
      refresh(
        { mode, query: query.trim(), favorites: section === 'favorites' },
        1,
        'all',
      ),
    );
  }

  function changeKind(nextKind: Kind) {
    if (!isResult && total !== null) run(() => refresh(context, 1, nextKind));
    else {
      setKind(nextKind);
      setPage(1);
    }
  }

  function closeDetail() {
    (
      fileList.current?.querySelector<HTMLButtonElement>('.file.active') ??
      fileList.current?.querySelector<HTMLButtonElement>('.file') ??
      fileList.current
    )?.focus();
    setSelected(null);
  }

  async function toggleFavorite(asset: Asset) {
    const id = asset.asset_id;
    if (favoritePending.current.has(id)) return;
    favoritePending.current.add(id);
    setFavoriteBusy(new Set(favoritePending.current));
    setError('');
    try {
      await request(`/api/v1/assets/${id}/favorite`, {
        method: asset.is_favorite ? 'DELETE' : 'PUT',
      });
      const update = (a: Asset) =>
        a.asset_id === id ? { ...a, is_favorite: !asset.is_favorite } : a;
      setAssets((current) => current.map(update));
      setSelected((current) => (current ? update(current) : current));
      if (sectionRef.current === 'favorites') {
        try {
          const latest = collectionRef.current;
          await refresh(latest.context, latest.page, latest.kind);
        } catch {
          setError(
            'お気に入りは保存しましたが、一覧を更新できませんでした。更新ボタンで再取得してください。',
          );
        }
      }
    } catch {
      setError('お気に入りを保存できませんでした。再度お試しください。');
    } finally {
      favoritePending.current.delete(id);
      setFavoriteBusy(new Set(favoritePending.current));
    }
  }

  async function saveMetadata(changes: AssetChanges): Promise<Asset> {
    if (!selected) throw new Error('ファイルを選択してください');
    const assetId = selected.asset_id;
    const version = requestVersion.current;
    const updated: Asset = await request(`/api/v1/assets/${assetId}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    const metadata = {
      filename: updated.filename,
      tags: updated.tags,
      characters: updated.characters,
    };
    setSelected((current) =>
      current?.asset_id === assetId ? { ...current, ...metadata } : current,
    );
    setAssets((current) =>
      current.map((a) => (a.asset_id === assetId ? { ...a, ...metadata } : a)),
    );
    setContext((current) =>
      current.source?.asset_id === assetId
        ? { ...current, source: { ...current.source, ...metadata } }
        : current,
    );
    if (selectedId.current === assetId && requestVersion.current === version) {
      const next =
        context.source?.asset_id === assetId
          ? { ...context, source: { ...context.source, ...metadata } }
          : context;
      void refresh(next).catch(() => {
        if (selectedId.current === assetId) {
          setError(
            '変更は保存しましたが、一覧を更新できませんでした。更新ボタンで再取得してください。',
          );
        }
      });
    }
    return updated;
  }

  function reprocess() {
    if (!selected) return;
    run(async () => {
      await request(`/api/v1/assets/${selected.asset_id}/renditions`, {
        method: 'POST',
        body: '{}',
      });
      setNotice('処理をリクエストしました');
    });
  }

  function deleteAsset() {
    if (!selected || !confirm('このファイルを削除しますか？')) return;
    run(async () => {
      await request(`/api/v1/assets/${selected.asset_id}`, {
        method: 'DELETE',
      });
      setSelected(null);
      await refresh(
        context.source?.asset_id === selected.asset_id
          ? { ...allFiles, favorites: context.favorites }
          : context,
      );
    });
  }

  return (
    <div className="shell">
      <AppHeader
        authenticated={Boolean(me)}
        onLogout={logout}
        section={section}
        onSectionChange={(next) => {
          setSection(next);
          setViewerOpen(false);
          if (next === 'library' || next === 'favorites') {
            setSelected(null);
            setQuery('');
            setMode('keyword');
            run(() =>
              refresh(
                { ...allFiles, favorites: next === 'favorites' },
                1,
                'all',
              ),
            );
          } else {
            ++requestVersion.current;
            setSearching(false);
          }
        }}
      >
        {me && section === 'library' && (
          <UploadControl
            uploadInput={uploadInput}
            busy={progress !== null}
            onUpload={upload}
          />
        )}
      </AppHeader>
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
          <LoginPanel development={dev} onDevLogin={devLogin} />
        ) : section === 'tags' || section === 'characters' ? (
          <TagsPage
            key={section}
            kind={section}
            onOpen={(tag) => {
              setSection('library');
              setSelected(null);
              setQuery('');
              setMode('keyword');
              run(() =>
                refresh(
                  {
                    mode: 'keyword',
                    query: '',
                    ...(section === 'characters'
                      ? { character: tag }
                      : { tag }),
                  },
                  1,
                  'all',
                ),
              );
            }}
          />
        ) : (
          <>
            <h1 className="visually-hidden">
              {section === 'favorites' ? 'お気に入り' : 'ライブラリ'}
            </h1>
            {progress !== null && <UploadProgress value={progress} />}
            <div className={`library ${selected ? 'has-selection' : ''}`}>
              <div className="collection">
                <SearchForm
                  query={query}
                  mode={mode}
                  searching={searching}
                  onQueryChange={setQuery}
                  onModeChange={setMode}
                  onSearch={search}
                />
                <LibraryToolbar
                  kind={kind}
                  view={view}
                  searching={searching}
                  onKindChange={changeKind}
                  onViewChange={setView}
                  onRefresh={() => run(() => refresh())}
                />
                <div className="result-heading" aria-live="polite">
                  <h2>
                    {context.source
                      ? `${context.mode === 'perceptual' ? '類似ファイル' : '完全一致ファイル'}：${context.source.filename}`
                      : context.character
                        ? `キャラクター：${context.character}`
                        : context.tag
                          ? `タグ：${context.tag}`
                          : context.query
                            ? `「${context.query}」の検索結果`
                            : kind === 'all'
                              ? section === 'favorites'
                                ? 'お気に入り'
                                : 'すべてのファイル'
                              : kinds.find((k) => k.id === kind)?.label}
                  </h2>
                  <span className="count">
                    {searching
                      ? '読み込み中…'
                      : `${resultCount} 件${kind !== 'all' && (isResult || total === null) ? ` / ${assets.length} 件` : ''}`}
                  </span>
                  {(isResult || context.tag || context.character) && (
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
                <AssetList
                  favorites={section === 'favorites'}
                  favoriteBusy={favoriteBusy}
                  onFavorite={(asset) => {
                    void toggleFavorite(asset);
                  }}
                  onLibrary={() => {
                    setSection('library');
                    setSelected(null);
                    run(() => refresh(allFiles, 1, 'all'));
                  }}
                  assets={pageAssets}
                  selectedId={selected?.asset_id}
                  view={view}
                  kind={kind}
                  searching={searching}
                  isResult={isResult}
                  uploading={progress !== null}
                  currentPage={currentPage}
                  pageCount={pageCount}
                  resultCount={resultCount}
                  fileList={fileList}
                  onSelect={(asset) => {
                    setError('');
                    setSelected(asset);
                  }}
                  onOpen={openViewer}
                  onReset={reset}
                  onUpload={() => uploadInput.current?.click()}
                  onPageChange={changePage}
                />
              </div>
              {selected && (
                <AssetDetails
                  key={selected.asset_id}
                  selected={selected}
                  onFavorite={(asset) => {
                    void toggleFavorite(asset);
                  }}
                  favoriteBusy={favoriteBusy.has(selected.asset_id)}
                  renditions={renditions}
                  jobs={jobs}
                  searching={searching}
                  notice={notice}
                  detailTitle={detailTitle}
                  onClose={closeDetail}
                  onOpen={() => openViewer(selected)}
                  onSaveMetadata={saveMetadata}
                  onCompare={compare}
                  onReprocess={reprocess}
                  onDelete={deleteAsset}
                />
              )}
            </div>
          </>
        )}
      </main>
      {me && viewerOpen && selected && (
        <AssetViewer
          asset={selected}
          onFavorite={(asset) => {
            void toggleFavorite(asset);
          }}
          favoriteBusy={favoriteBusy.has(selected.asset_id)}
          navigationError={error}
          hasPrevious={
            !viewerMoving &&
            selectedIndex >= 0 &&
            (selectedIndex > 0 || currentPage > 1)
          }
          hasNext={
            !viewerMoving &&
            (selectedIndex < pageAssets.length - 1 ||
              (selectedIndex >= 0 && currentPage < pageCount))
          }
          onNavigate={(direction) => {
            void moveViewer(direction);
          }}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}
