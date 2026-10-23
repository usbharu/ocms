import { useEffect, useRef, useState } from 'react';
import { AppHeader } from './components/library/AppHeader';
import { AssetDetails } from './components/library/AssetDetails';
import { AssetList } from './components/library/AssetList';
import { LibraryToolbar } from './components/library/LibraryToolbar';
import { LoginPanel } from './components/library/LoginPanel';
import { SearchForm } from './components/library/SearchForm';
import { UploadControl } from './components/library/UploadControl';
import { UploadProgress } from './components/library/UploadProgress';
import { Button } from './components/ui/button';
import {
  type Asset,
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

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dev, setDev] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
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

  async function refresh(
    next: SearchContext = context,
    nextPage = page,
    nextKind: Kind = kind,
  ) {
    const version = ++requestVersion.current;
    setError('');
    setSearching(true);
    try {
      let res: { assets: Asset[]; total?: number };
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
        const params = new URLSearchParams({
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
          await refresh(
            next,
            Math.max(1, Math.ceil(res.total / pageSize)),
            nextKind,
          );
          return;
        }
      }
      if (version === requestVersion.current) {
        setAssets(res.assets);
        setTotal(res.total ?? null);
        setPage(nextPage);
        setKind(nextKind);
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
    if (me) refresh(allFiles, 1, 'all').catch((e) => setError(e.message));
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
      await refresh(allFiles, 1, 'all');
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
    run(() => refresh(allFiles, 1, 'all'));
  };

  const compare = (comparison: Mode) => {
    if (!selected) return;
    setKind('all');
    run(() =>
      refresh({ mode: comparison, query: '', source: selected }, 1, 'all'),
    );
  };

  const visibleAssets = assets.filter(
    (a) => kind === 'all' || kindOf(a) === kind,
  );
  const isResult = Boolean(context.query || context.source);
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

  function changePage(nextPage: number) {
    if (!isResult && total !== null) {
      run(() => refresh(context, nextPage));
    } else {
      setPage(nextPage);
    }
    fileList.current?.scrollIntoView({ block: 'start' });
    fileList.current?.focus({ preventScroll: true });
  }

  function logout() {
    run(async () => {
      await request('/auth/logout', { method: 'POST' });
      ++requestVersion.current;
      setMe(null);
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
    run(() => refresh({ mode, query: query.trim() }, 1, 'all'));
  }

  function changeKind(nextKind: Kind) {
    if (!isResult && total !== null) run(() => refresh(context, 1, nextKind));
    else {
      setKind(nextKind);
      setPage(1);
    }
  }

  function closeDetail() {
    fileList.current?.querySelector<HTMLButtonElement>('.file.active')?.focus();
    setSelected(null);
  }

  function saveTags(tags: string[]) {
    if (!selected) return;
    const assetId = selected.asset_id;
    run(async () => {
      const updated = await request(`/api/v1/assets/${assetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ tags }),
      });
      setSelected((current) =>
        current?.asset_id === assetId
          ? { ...current, tags: updated.tags }
          : current,
      );
      setNotice('タグを保存しました');
      await refresh();
    });
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
        context.source?.asset_id === selected.asset_id ? allFiles : context,
      );
    });
  }

  return (
    <div className="shell">
      <AppHeader authenticated={Boolean(me)} onLogout={logout} />
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
        ) : (
          <>
            <UploadControl
              uploadInput={uploadInput}
              busy={progress !== null}
              onUpload={upload}
            />
            <SearchForm
              query={query}
              mode={mode}
              searching={searching}
              onQueryChange={setQuery}
              onModeChange={setMode}
              onSearch={search}
            />
            {progress !== null && <UploadProgress value={progress} />}
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
                  : context.query
                    ? `「${context.query}」の検索結果`
                    : kind === 'all'
                      ? 'すべてのファイル'
                      : kinds.find((k) => k.id === kind)?.label}
              </h2>
              <span className="count">
                {searching
                  ? '読み込み中…'
                  : `${resultCount} 件${kind !== 'all' && (isResult || total === null) ? ` / ${assets.length} 件` : ''}`}
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
              <AssetList
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
                onReset={reset}
                onUpload={() => uploadInput.current?.click()}
                onPageChange={changePage}
              />
              {selected && (
                <AssetDetails
                  key={selected.asset_id}
                  selected={selected}
                  renditions={renditions}
                  jobs={jobs}
                  searching={searching}
                  notice={notice}
                  detailTitle={detailTitle}
                  onClose={closeDetail}
                  onSaveTags={saveTags}
                  onCompare={compare}
                  onReprocess={reprocess}
                  onDelete={deleteAsset}
                />
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
