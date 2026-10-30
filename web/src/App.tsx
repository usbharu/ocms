import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router';
import { AppHeader } from './components/library/AppHeader';
import { AssetDetails } from './components/library/AssetDetails';
import { AssetList } from './components/library/AssetList';
import { AssetViewer } from './components/library/AssetViewer';
import { LibraryToolbar } from './components/library/LibraryToolbar';
import { LoginPanel } from './components/library/LoginPanel';
import { RecommendationsHeader } from './components/library/RecommendationsHeader';
import { SearchForm } from './components/library/SearchForm';
import { SeriesAssetViewer } from './components/library/SeriesAssetViewer';
import { UploadControl } from './components/library/UploadControl';
import { UploadProgress } from './components/library/UploadProgress';
import { SeriesPage } from './components/series/SeriesPage';
import { TagsPage } from './components/tags/TagsPage';
import { Button } from './components/ui/button';
import { NativeSelect } from './components/ui/native-select';
import {
  type Asset,
  type AssetChanges,
  allFiles,
  type HashStatus,
  type Job,
  type Kind,
  kindOf,
  kinds,
  type Me,
  type Mode,
  pageSize,
  type Recommendation,
  type Rendition,
  ratingLabel,
  ratings,
  type SearchContext,
  type View,
} from './lib/assets';
import {
  assetURL,
  collectionURL,
  parseRoute,
  type Section,
} from './lib/routes';
import {
  filterDuplicateUploadFiles,
  type UploadTask,
  uploadFile,
} from './lib/uploads';

type ExplorationSnapshot = {
  assets: Asset[];
  page: number;
  total: number | null;
  selected: Asset | null;
  context: SearchContext;
  kind: Kind;
  query: string;
  mode: Mode;
  hashStatus: HashStatus | null;
};

const viewStorageKey = 'ocms.library.view';

// Polling responses contain JSON values; retain references when nothing changed.
function retainUnchanged<T>(current: T, next: T): T {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next;
}

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
  const location = useLocation();
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const route = parseRoute(location.pathname, location.search);
  const [section, setSection] = useState<Section>(route.section);
  const [assetMissing, setAssetMissing] = useState(false);
  const [assetLoadFailed, setAssetLoadFailed] = useState(false);
  const snapshots = useRef(new Map<string, ExplorationSnapshot>());
  const loadedCollection = useRef('');
  const readyRoute = useRef('');
  const capturedSnapshot = useRef<string | null>(null);
  const focusAfterClose = useRef<string | null>(null);
  const focusViewerTrigger = useRef(false);
  const historyEntries = useRef<string[]>([location.key]);
  const historyPosition = useRef(0);
  useLayoutEffect(() => {
    const entries = historyEntries.current;
    const found = entries.indexOf(location.key);
    if (found >= 0) historyPosition.current = found;
    else if (navigationType === 'REPLACE')
      entries[historyPosition.current] = location.key;
    else {
      entries.splice(historyPosition.current + 1);
      entries.push(location.key);
      historyPosition.current = entries.length - 1;
    }
  }, [location.key, navigationType]);
  const lastPrincipal = useRef<string | undefined>(undefined);

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
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [seriesEditable, setSeriesEditable] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('keyword');
  const [context, setContext] = useState<SearchContext>(allFiles);
  const [kind, setKind] = useState<Kind>('all');
  const [view, setView] = useState<View>(savedView);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recommendationFailed, setRecommendationFailed] = useState(false);
  const [hashStatus, setHashStatus] = useState<HashStatus | null>(null);
  const related = context.mode === 'recommendation';
  const personal = Boolean(context.personalized && !context.source);
  const [searching, setSearching] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const uploadRunning = useRef(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const fileList = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
  const metadataVersion = useRef(0);
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
    if (!res.ok) {
      const code = (await res.json().catch(() => ({}))).error;
      throw Object.assign(
        new Error(
          code === 'RECOMMENDATION_SESSION_EXPIRED' ||
            code === 'RECOMMENDATION_SESSION_STALE'
            ? 'おすすめの情報が更新されました。更新ボタンで取得し直してください。'
            : path.startsWith('/api/v1/recommendations')
              ? 'おすすめを取得できませんでした。時間をおいて再試行してください。'
              : (code ?? `HTTP ${res.status}`),
        ),
        { status: res.status },
      );
    }
    return res.status === 204 ? null : res.json();
  }

  async function refresh(
    next: SearchContext = context,
    nextPage = page,
    nextKind: Kind = kind,
    preserveSession = false,
  ): Promise<Asset[] | undefined> {
    collectionRef.current = { context: next, page: nextPage, kind: nextKind };
    const version = ++requestVersion.current;
    setError('');
    setSearching(true);
    setRecommendationFailed(false);
    try {
      let res: {
        assets: Asset[];
        total?: number;
        hash_status?: HashStatus;
        session_id?: string;
        status?: 'ready' | 'insufficient_information';
      };
      if (next.personalized && !next.source) {
        const reuse = preserveSession && next.sessionId;
        if (!reuse) nextPage = 1;
        const params = new URLSearchParams({
          kind: nextKind,
          ...(next.ratings ? { ratings: next.ratings.join(',') } : {}),
          ...(reuse ? { session_id: reuse, page: String(nextPage) } : {}),
        });
        res = await request(`/api/v1/recommendations?${params}`);
        next = {
          ...next,
          sessionId: res.session_id,
          recommendationStatus: res.status,
        };
      } else if (next.source) {
        const params = new URLSearchParams({
          ...(next.favorites ? { favorites: 'true' } : {}),
          ...(next.ratings ? { ratings: next.ratings.join(',') } : {}),
        });
        res = await request(
          `/api/v1/assets/${next.source.asset_id}/${next.mode === 'recommendation' ? 'recommendations' : next.mode === 'perceptual' ? 'similar' : 'duplicates'}${params.size ? `?${params}` : ''}`,
        );
      } else if (next.query && !next.tag && !next.character) {
        res = await request('/api/v1/search', {
          method: 'POST',
          body: JSON.stringify({
            query: next.query,
            mode: next.mode,
            limit: 200,
            media_types:
              nextKind === 'all'
                ? undefined
                : [nextKind === 'document' ? 'pdf' : nextKind],
            ratings: next.ratings,
            ...(next.favorites ? { favorites: true } : {}),
          }),
        });
      } else {
        const params = new URLSearchParams({
          ...(next.favorites ? { favorites: 'true' } : {}),
          ...(next.tag ? { tag: next.tag } : {}),
          ...(next.character ? { character: next.character } : {}),
          ...(next.ratings ? { ratings: next.ratings.join(',') } : {}),
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
          const correctedPage = Math.max(1, Math.ceil(res.total / pageSize));
          const result = await refresh(next, correctedPage, nextKind);
          if (version + 1 === requestVersion.current) {
            navigate(
              route.assetId
                ? assetURL(
                    route.assetId,
                    route.viewer,
                    section,
                    next,
                    correctedPage,
                    nextKind,
                  )
                : collectionURL(section, next, correctedPage, nextKind),
              { replace: true, state: location.state },
            );
          }
          return result;
        }
      }
      let correctedResultPage = false;
      if (next.source || (next.query && !next.tag && !next.character)) {
        const count = res.assets.filter(
          (asset) =>
            (nextKind === 'all' || kindOf(asset) === nextKind) &&
            (!next.ratings || next.ratings.includes(asset.rating ?? 'unrated')),
        ).length;
        const lastPage = Math.max(1, Math.ceil(count / pageSize));
        if (nextPage > lastPage) {
          nextPage = lastPage;
          correctedResultPage = true;
        }
      }
      if (version === requestVersion.current) {
        setAssets(res.assets);
        setHashStatus(res.hash_status ?? null);
        setTotal(res.total ?? null);
        setPage(nextPage);
        if (
          route.page !== nextPage &&
          (next.personalized || correctedResultPage)
        ) {
          navigate(
            route.assetId
              ? assetURL(
                  route.assetId,
                  route.viewer,
                  section,
                  next,
                  nextPage,
                  nextKind,
                )
              : collectionURL(section, next, nextPage, nextKind),
            { replace: true, state: location.state },
          );
        }
        setKind(nextKind);
        setContext(next);
        collectionRef.current = {
          context: next,
          page: nextPage,
          kind: nextKind,
        };
        return res.assets;
      }
    } catch (error) {
      if (version === requestVersion.current) {
        setRecommendationFailed(
          next.mode === 'recommendation' || Boolean(next.personalized),
        );
        if (next.personalized) {
          setAssets([]);
          setTotal(null);
          setSelected(null);
          setPage(1);
        }
        throw error;
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
  const liveSnapshot = useRef<ExplorationSnapshot>({
    assets,
    page,
    total,
    selected,
    context,
    kind,
    query,
    mode,
    hashStatus,
  });
  liveSnapshot.current = {
    assets,
    page,
    total,
    selected,
    context,
    kind,
    query,
    mode,
    hashStatus,
  };

  useLayoutEffect(() => {
    const key = location.key;
    return () => {
      if (capturedSnapshot.current !== key)
        snapshots.current.set(key, liveSnapshot.current);
      if (capturedSnapshot.current === key) capturedSnapshot.current = null;
    };
  }, [location.key]);

  // URL transitions own collection loading. Ordinary refreshes keep the current URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Run once per navigation or authenticated principal, not on fetched state updates.
  useEffect(() => {
    const principal = me?.principal_id;
    const principalChanged = lastPrincipal.current !== principal;
    if (principalChanged) {
      snapshots.current.clear();
      loadedCollection.current = '';
      lastPrincipal.current = principal;
    }
    if (location.pathname === '/') {
      navigate(`/library${location.search}`, { replace: true });
      return;
    }
    const legacySeries = /^\/series\/([^/]+)(\/view)?$/.exec(location.pathname);
    if (legacySeries && legacySeries[1] !== 'new') {
      const hit = new URLSearchParams();
      const previous = new URLSearchParams(location.search);
      for (const key of ['member', 'page_number', 'start_ms', 'end_ms']) {
        const value = previous.get(key);
        if (value !== null) hit.set(key, value);
      }
      navigate(
        `/assets/${legacySeries[1]}${legacySeries[2] || ''}${hit.size ? `?${hit}` : ''}`,
        { replace: true, state: location.state },
      );
      return;
    }
    ++requestVersion.current;
    readyRoute.current = '';
    setSearching(true);
    setError('');
    setAssetMissing(false);
    setAssetLoadFailed(false);
    setSection(route.section);
    setViewerLoading(Boolean(me && route.known && route.viewer));
    // Keep the modal mounted while the next authorized asset is fetched.
    if (principalChanged || !me || !route.known || !route.viewer) {
      setViewerOpen(false);
      setSelected(null);
    }
    if (!me || !route.known) {
      setSearching(false);
      return;
    }
    if (route.section === 'series') snapshots.current.clear();
    if (
      route.section === 'series' ||
      route.section === 'tags' ||
      route.section === 'characters'
    ) {
      loadedCollection.current = '';
      setSearching(false);
      return;
    }
    let active = true;
    const isActive = () => active;
    const cached =
      navigationType === 'POP'
        ? snapshots.current.get(location.key)
        : undefined;
    setQuery(cached?.query ?? route.context.query);
    setMode(
      cached?.mode ??
        (route.context.mode === 'recommendation'
          ? 'keyword'
          : route.context.mode),
    );
    const load = async () => {
      let next = {
        ...route.context,
        ...(route.context.personalized && cached?.context.personalized
          ? {
              sessionId: cached.context.sessionId,
              recommendationStatus: cached.context.recommendationStatus,
            }
          : {}),
      };
      const previous =
        snapshots.current.get(location.state?.previousKey) ??
        liveSnapshot.current;
      if (
        !cached &&
        next.personalized &&
        previous.context.personalized &&
        previous.kind === route.kind &&
        JSON.stringify(previous.context.ratings) ===
          JSON.stringify(next.ratings)
      ) {
        next = { ...next, sessionId: previous.context.sessionId };
      }
      if (route.sourceId) {
        try {
          const source = await request(
            `/api/v1/assets/${encodeURIComponent(route.sourceId)}`,
          );
          if (!active) return;
          next = { ...next, source };
        } catch (error) {
          if (active) {
            const status = (error as { status?: number }).status;
            setSelected(null);
            setViewerOpen(false);
            setAssetMissing(status === 404 || status === 403);
            setAssetLoadFailed(status !== 404 && status !== 403);
            setSearching(false);
          }
          return;
        }
      }
      const collectionKey = collectionURL(
        route.section,
        next,
        route.page,
        route.kind,
      );
      const canonical = route.assetId
        ? assetURL(
            route.assetId,
            route.viewer,
            route.section,
            next,
            route.page,
            route.kind,
            route.hit,
          )
        : collectionKey;
      if (canonical !== location.pathname + location.search) {
        navigate(canonical, { replace: true, state: location.state });
        return;
      }
      setContext(next);
      setKind(route.kind);
      setPage(route.page);
      if (cached) {
        setAssets(cached.assets);
        setTotal(cached.total);
        setHashStatus(cached.hashStatus);
        setPage(route.page);
        setKind(route.kind);
        setContext(next);
      }
      if (loadedCollection.current !== collectionKey || cached) {
        if (!cached && (next.mode === 'recommendation' || next.personalized)) {
          setAssets([]);
          setTotal(null);
          setHashStatus(null);
        }
        loadedCollection.current = collectionKey;
        const result = await refresh(
          next,
          route.page,
          route.kind,
          Boolean(next.sessionId),
        );
        if (!active) return;
        if (!result) {
          setSelected(null);
          setViewerOpen(false);
          return;
        }
      }
      readyRoute.current = location.key;
      setSearching(false);
      if (route.assetId) {
        try {
          const asset = await request(
            `/api/v1/assets/${encodeURIComponent(route.assetId)}`,
          );
          if (!active) return;
          if (asset.composite_id) {
            navigate(
              assetURL(
                asset.composite_id,
                route.viewer,
                route.section,
                next,
                route.page,
                route.kind,
                { ...route.hit, matched_asset_id: asset.asset_id },
              ),
              { replace: true, state: location.state },
            );
            return;
          }
          const match = liveSnapshot.current.assets.find(
            (item) => item.asset_id === route.assetId,
          );
          setSelected({ ...match, ...asset, ...route.hit });
          setViewerOpen(route.viewer);
        } catch (error) {
          if (active) {
            const status = (error as { status?: number }).status;
            setSelected(null);
            setViewerOpen(false);
            setAssetMissing(status === 404 || status === 403);
            setAssetLoadFailed(status !== 404 && status !== 403);
            setSearching(false);
          }
        }
      }
    };
    void load()
      .catch((error: Error) => {
        if (isActive()) {
          setSelected(null);
          setViewerOpen(false);
          setSearching(false);
          loadedCollection.current = '';
          setError(error.message);
        }
      })
      .finally(() => {
        if (active) setViewerLoading(false);
      });
    // The request version invalidates old collection responses immediately on navigation.
    return () => {
      active = false;
      ++requestVersion.current;
    };
  }, [location.key, me?.principal_id]);

  function goCollection(
    next: SearchContext,
    nextPage = 1,
    nextKind: Kind = 'all',
    nextSection: Section = section,
    keepSelection = false,
  ) {
    snapshots.current.set(location.key, liveSnapshot.current);
    capturedSnapshot.current = location.key;
    setSearching(true);
    if (next.mode === 'recommendation' || next.personalized) {
      setAssets([]);
      setTotal(null);
    }
    const explorationReturn =
      next.source && next.source.asset_id !== context.source?.asset_id
        ? { url: location.pathname + location.search, key: location.key }
        : location.state?.explorationReturn;
    navigate(
      keepSelection && selected
        ? assetURL(
            selected.asset_id,
            false,
            nextSection,
            next,
            nextPage,
            nextKind,
          )
        : collectionURL(nextSection, next, nextPage, nextKind),
      {
        state: {
          closeTo: keepSelection
            ? undefined
            : location.pathname + location.search,
          explorationReturn,
          previousKey: location.key,
        },
      },
    );
  }

  function goAsset(
    asset: Asset,
    viewer = false,
    replace = false,
    nextPage = page,
  ) {
    snapshots.current.set(location.key, liveSnapshot.current);
    capturedSnapshot.current = location.key;
    const parent = location.pathname + location.search;
    navigate(
      assetURL(
        asset.asset_id,
        viewer,
        section,
        context,
        nextPage,
        kind,
        asset.series_kind ? asset : undefined,
      ),
      {
        replace,
        state: {
          closeTo: replace ? location.state?.closeTo : parent,
          explorationReturn: location.state?.explorationReturn,
          viewerMoved: replace,
        },
      },
    );
  }

  function closeAsset(viewer = false) {
    if (viewer) focusViewerTrigger.current = true;
    const fallback =
      viewer && selected
        ? assetURL(selected.asset_id, false, section, context, page, kind)
        : collectionURL(section, context, page, kind);
    const parent = location.state?.closeTo;
    if (parent && !location.state?.viewerMoved) navigate(-1);
    else
      navigate(fallback, {
        replace: true,
        state: { explorationReturn: location.state?.explorationReturn },
      });
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus only when the selected asset changes, not on polling updates.
  useEffect(() => {
    if (selected && !viewerOpen && window.innerWidth <= 800)
      detailTitle.current?.focus();
  }, [selected?.asset_id, viewerOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Keep the polling lease tied to asset identity and authentication, not status updates.
  useEffect(() => {
    setRenditions([]);
    setJobs([]);
    setPreviewAsset(null);
    setSeriesEditable(false);
    setNotice('');
    if (!selected || !me) return;
    let active = true;
    let timer: number | undefined;
    const controller = new AbortController();
    const get = (path: string) => request(path, { signal: controller.signal });
    const update = async () => {
      const version = metadataVersion.current;
      let ds: { renditions: Rendition[] };
      let js: { jobs: Job[] };
      let asset: Asset & { editable?: boolean };
      let preview: Asset | null = null;
      if (selected.series_kind) {
        asset = await get(`/api/v1/series/${selected.asset_id}`);
        const previewID =
          selected.matched_asset_id &&
          asset.blob_asset_ids?.includes(selected.matched_asset_id)
            ? selected.matched_asset_id
            : asset.cover_asset_id;
        if (previewID) {
          preview = await get(`/api/v1/assets/${previewID}`);
          ds = await get(`/api/v1/assets/${previewID}/renditions`);
        } else ds = { renditions: [] };
        js = { jobs: [] };
      } else {
        const [renditionResult, jobResult, assetResult] =
          await Promise.allSettled([
            get(`/api/v1/assets/${selected.asset_id}/renditions`),
            get(`/api/v1/assets/${selected.asset_id}/jobs`),
            get(`/api/v1/assets/${selected.asset_id}`),
          ]);
        if (renditionResult.status === 'rejected') throw renditionResult.reason;
        if (jobResult.status === 'rejected') throw jobResult.reason;
        if (assetResult.status === 'rejected') throw assetResult.reason;
        ds = renditionResult.value;
        js = jobResult.value;
        asset = assetResult.value;
      }
      if (active && version === metadataVersion.current) {
        setRenditions((current) => retainUnchanged(current, ds.renditions));
        setJobs((current) => retainUnchanged(current, js.jobs));
        setPreviewAsset((current) => retainUnchanged(current, preview));
        setSeriesEditable(Boolean(asset.editable));
        setSelected((current) =>
          current
            ? retainUnchanged(current, {
                ...current,
                ...(current.series_kind
                  ? {
                      tags: asset.tags,
                      characters: asset.characters,
                      cover_asset_id: asset.cover_asset_id,
                      member_ids: asset.member_ids,
                      series_version: asset.series_version,
                    }
                  : {}),
                status: asset.status,
                rating: asset.rating,
              })
            : null,
        );
        setAssets((current) => {
          const next = current.map((a) =>
            a.asset_id === asset.asset_id
              ? retainUnchanged(a, {
                  ...a,
                  status: asset.status,
                  rating: asset.rating,
                })
              : a,
          );
          return next.every((a, index) => a === current[index])
            ? current
            : next;
        });
      }
    };
    const handleFailure = (
      error: Error & { status?: number },
      initial = false,
    ) => {
      if (!active) return;
      if (error.status === 404 || error.status === 403) {
        snapshots.current.clear();
        setSelected(null);
        setViewerOpen(false);
        setAssetMissing(true);
      } else if (
        initial &&
        !['pending', 'uploading'].includes(selected.status)
      ) {
        setError(error.message);
      }
    };
    const poll = async (initial = false) => {
      try {
        await update();
      } catch (error) {
        handleFailure(error as Error & { status?: number }, initial);
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 5000);
      }
    };
    void poll(true);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [selected?.asset_id, me]);

  async function processUploads(tasks: UploadTask[], filterDuplicates = false) {
    if (!me || uploadRunning.current) return;
    uploadRunning.current = true;
    setError('');
    setProgress(0);
    const update = () => setUploadTasks((current) => [...current]);
    let nextTask = 0;
    const worker = async () => {
      while (nextTask < tasks.length) {
        const task = tasks[nextTask++];
        task.state = 'uploading';
        update();
        try {
          await uploadFile(task, me.csrf_token, request, (value) => {
            task.progress = value;
            setProgress(value);
            update();
          });
          task.state = 'completed';
        } catch {
          task.state = 'failed';
        }
        update();
      }
    };
    try {
      if (filterDuplicates) {
        const retained = new Set(
          await filterDuplicateUploadFiles(tasks.map((task) => task.file)),
        );
        tasks = tasks.filter((task) => retained.has(task.file));
        setUploadTasks(tasks);
      }
      await Promise.all(
        Array.from({ length: Math.min(10, tasks.length) }, () => worker()),
      );
      const lastAsset = [...tasks]
        .reverse()
        .find((task) => task.state === 'completed')?.session?.asset_id;
      if (lastAsset) {
        const asset = await request(`/api/v1/assets/${lastAsset}`);
        loadedCollection.current = '';
        navigate(
          assetURL(asset.asset_id, false, 'library', allFiles, 1, 'all'),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploadRunning.current = false;
      setProgress(null);
    }
  }

  function upload(files: File[]) {
    if (uploadRunning.current) return;
    const tasks: UploadTask[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      state: 'waiting',
      progress: 0,
    }));
    setUploadTasks([]);
    void processUploads(tasks, true);
  }

  const run = (action: () => Promise<unknown>) =>
    action().catch((e) => setError(e.message));

  const reset = () => {
    goCollection({ ...allFiles, favorites: section === 'favorites' });
  };

  const compare = (comparison: Mode) => {
    if (!selected) return;
    goCollection(
      {
        mode: comparison,
        query: '',
        source: selected,
        ratings: context.ratings,
        favorites: context.favorites,
      },
      1,
      'all',
      section,
      true,
    );
  };

  function openRecommendations() {
    if (!selected) return;
    goCollection({
      mode: 'recommendation',
      query: '',
      source: selected,
      ratings: context.ratings,
    });
  }

  function backFromRecommendations() {
    const target = location.state?.explorationReturn;
    const index = target ? historyEntries.current.indexOf(target.key) : -1;
    if (index >= 0 && index < historyPosition.current)
      navigate(index - historyPosition.current);
    else if (target) navigate(target.url, { replace: true });
    else
      navigate(
        collectionURL(section, {
          ...allFiles,
          favorites: context.favorites,
          personalized: section === 'recommendations',
        }),
        { replace: true },
      );
  }

  const visibleAssets = useMemo(
    () =>
      assets.filter(
        (a) =>
          (kind === 'all' || kindOf(a) === kind) &&
          (!context.ratings || context.ratings.includes(a.rating ?? 'unrated')),
      ),
    [assets, kind, context.ratings],
  );
  const isResult = Boolean(
    (context.query && !context.tag && !context.character) || context.source,
  );
  const resultCount =
    !isResult && total !== null ? total : visibleAssets.length;
  const pageCount = Math.max(1, Math.ceil(resultCount / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageAssets = useMemo(
    () =>
      !isResult && total !== null
        ? visibleAssets
        : visibleAssets.slice(
            (currentPage - 1) * pageSize,
            currentPage * pageSize,
          ),
    [isResult, total, visibleAssets, currentPage],
  );

  const selectedIndex = pageAssets.findIndex(
    (asset) => asset.asset_id === selected?.asset_id,
  );

  function changePage(nextPage: number) {
    goCollection(context, nextPage, kind, section, true);
    fileList.current?.scrollIntoView({ block: 'start' });
    fileList.current?.focus({ preventScroll: true });
  }

  function openViewer(asset: Asset) {
    goAsset(asset, true);
  }

  async function moveViewer(direction: number) {
    if (!selected || viewerMoving || viewerLoading) return;
    const index = selectedIndex;
    const next = pageAssets[index + direction];
    if (next) {
      goAsset(next, true, true);
      return;
    }
    const nextPage = currentPage + direction;
    if (index < 0 || nextPage < 1 || nextPage > pageCount) return;
    setViewerMoving(true);
    try {
      if (!isResult && total !== null) {
        const items = await refresh(context, nextPage, kind, true);
        if (items?.length)
          goAsset(
            direction > 0 ? items[0] : items[items.length - 1],
            true,
            true,
            nextPage,
          );
      } else {
        const items = visibleAssets.slice(
          (nextPage - 1) * pageSize,
          nextPage * pageSize,
        );
        goAsset(
          direction > 0 ? items[0] : items[items.length - 1],
          true,
          true,
          nextPage,
        );
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
      snapshots.current.clear();
      navigate('/library', { replace: true });
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
      window.location.reload();
    });
  }

  function search() {
    goCollection({
      mode,
      query: query.trim(),
      favorites: section === 'favorites',
      ratings: context.ratings,
    });
  }

  function openMetadataFilter(field: 'tag' | 'character', name: string) {
    goCollection(
      { mode: 'keyword', query: '', [field]: name },
      1,
      'all',
      'library',
    );
  }

  function changeKind(nextKind: Kind) {
    goCollection(context, 1, nextKind, section, true);
  }

  useEffect(() => {
    if (
      searching ||
      route.assetId ||
      !focusAfterClose.current ||
      readyRoute.current !== location.key
    )
      return;
    const id = focusAfterClose.current;
    const index = pageAssets.findIndex((asset) => asset.asset_id === id);
    fileList.current
      ?.querySelectorAll<HTMLButtonElement>('.file')
      [Math.max(0, index)]?.focus();
    focusAfterClose.current = null;
  }, [searching, route.assetId, pageAssets, location.key]);

  useEffect(() => {
    if (!viewerOpen && selected && focusViewerTrigger.current) {
      document.querySelector<HTMLButtonElement>('button.preview')?.focus();
      focusViewerTrigger.current = false;
    }
  }, [viewerOpen, selected]);

  function closeDetail() {
    focusAfterClose.current = selected?.asset_id ?? null;
    closeAsset();
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
      snapshots.current.clear();
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
    ++metadataVersion.current;
    const assetId = selected.asset_id;
    const version = requestVersion.current;
    const updated: Asset = await request(`/api/v1/assets/${assetId}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    ++metadataVersion.current;
    snapshots.current.clear();
    const metadata = {
      filename: updated.filename,
      tags: updated.tags,
      characters: updated.characters,
      rating: updated.rating,
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
    // Unfiltered library rows already contain the saved metadata. Requery only
    // when the edit can affect membership or ranking of the current results.
    const affectsResults = Boolean(
      context.query ||
        context.tag ||
        context.character ||
        context.source ||
        context.personalized ||
        (context.ratings && changes.rating !== undefined),
    );
    if (
      affectsResults &&
      selectedId.current === assetId &&
      requestVersion.current === version
    ) {
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
    if (
      !selected ||
      !confirm(
        selected.series_kind
          ? 'シリーズを解除しますか？ 元のファイルは残ります。'
          : 'このファイルを削除しますか？',
      )
    )
      return;
    run(async () => {
      await request(`/api/v1/assets/${selected.asset_id}`, {
        method: 'DELETE',
      });
      setSelected(null);
      snapshots.current.clear();
      loadedCollection.current = '';
      navigate(
        collectionURL(
          section,
          context.source?.asset_id === selected.asset_id
            ? { ...allFiles, favorites: context.favorites }
            : context,
          page,
          kind,
        ),
        { replace: true },
      );
    });
  }

  const Viewer = selected?.series_kind ? SeriesAssetViewer : AssetViewer;

  return (
    <div className="shell">
      <AppHeader
        authenticated={Boolean(me)}
        onLogout={logout}
        section={section}
      >
        {me && section === 'library' && !related && (
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
        {!route.known ? (
          <section className="empty">
            <h1>ページが見つかりません</h1>
            <Link to="/library">ライブラリを開く</Link>
          </section>
        ) : authLoading ? (
          <div className="empty" role="status">
            読み込み中…
          </div>
        ) : !me ? (
          <LoginPanel development={dev} onDevLogin={devLogin} />
        ) : assetLoadFailed ? (
          <section className="empty" role="alert">
            <h1>ファイルを読み込めません</h1>
            <Button
              onClick={() =>
                navigate(location.pathname + location.search, {
                  replace: true,
                  state: location.state,
                })
              }
            >
              再試行
            </Button>
          </section>
        ) : assetMissing ? (
          <section className="empty" role="alert">
            <h1>ファイルが見つかりません</h1>
            <Link
              to={collectionURL(section, {
                ...allFiles,
                favorites: section === 'favorites',
              })}
            >
              一覧に戻る
            </Link>
          </section>
        ) : route.section === 'series' ? (
          <SeriesPage key={location.pathname} request={request} />
        ) : section === 'tags' || section === 'characters' ? (
          <TagsPage
            key={section}
            kind={section}
            onOpen={(name) =>
              openMetadataFilter(
                section === 'characters' ? 'character' : 'tag',
                name,
              )
            }
          />
        ) : (
          <>
            {!related && (
              <h1 className="visually-hidden">
                {personal
                  ? 'おすすめ'
                  : section === 'favorites'
                    ? 'お気に入り'
                    : 'ライブラリ'}
              </h1>
            )}
            {uploadTasks.length > 0 && (
              <UploadProgress
                value={progress ?? 0}
                tasks={uploadTasks}
                busy={progress !== null}
                onRetry={(task) => void processUploads([task])}
              />
            )}
            <div className={`library ${selected ? 'has-selection' : ''}`}>
              <div className="collection">
                {related && context.source ? (
                  <RecommendationsHeader
                    source={context.source}
                    hashStatus={hashStatus}
                    onBack={backFromRecommendations}
                  />
                ) : personal ? null : (
                  <SearchForm
                    query={query}
                    mode={mode}
                    searching={searching}
                    onQueryChange={setQuery}
                    onModeChange={setMode}
                    onSearch={search}
                  />
                )}
                {related || personal ? (
                  <div className="library-toolbar">
                    <label
                      htmlFor="recommendation-kind"
                      className="recommendation-kind"
                    >
                      種類{' '}
                      <NativeSelect
                        id="recommendation-kind"
                        aria-label={
                          personal ? 'おすすめの種類' : '関連コンテンツの種類'
                        }
                        disabled={searching}
                        value={kind}
                        onChange={(event) =>
                          changeKind(event.target.value as Kind)
                        }
                      >
                        {kinds.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                    <Button
                      variant="outline"
                      disabled={searching}
                      onClick={() => run(() => refresh())}
                    >
                      更新
                    </Button>
                  </div>
                ) : (
                  <LibraryToolbar
                    kind={kind}
                    view={view}
                    searching={searching}
                    onKindChange={changeKind}
                    onViewChange={setView}
                    onRefresh={() => run(() => refresh())}
                  />
                )}
                <fieldset className="rating-filter" disabled={searching}>
                  <legend>レーティング</legend>
                  {ratings.map((rating) => (
                    <label key={rating}>
                      <input
                        type="checkbox"
                        checked={
                          !context.ratings || context.ratings.includes(rating)
                        }
                        onChange={(event) => {
                          const selectedRatings = context.ratings ?? [
                            ...ratings,
                          ];
                          const nextRatings = event.target.checked
                            ? [...selectedRatings, rating]
                            : selectedRatings.filter(
                                (value) => value !== rating,
                              );
                          const next = { ...context, ratings: nextRatings };
                          goCollection(next, 1, kind);
                          setContext(next);
                        }}
                      />
                      {ratingLabel(rating)}
                    </label>
                  ))}
                </fieldset>
                <div className="result-heading" aria-live="polite">
                  <h2>
                    {personal
                      ? 'おすすめ'
                      : context.source
                        ? related
                          ? 'おすすめ'
                          : `${context.mode === 'perceptual' ? '類似ファイル' : '完全一致ファイル'}：${context.source.filename}`
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
                  {!related &&
                    (isResult || context.tag || context.character) && (
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
                {(related || personal) && recommendationFailed ? (
                  <div className="empty" role="alert">
                    <p>
                      {personal
                        ? 'おすすめを取得できません。'
                        : '関連コンテンツを取得できません。'}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => run(() => refresh())}
                    >
                      再試行
                    </Button>
                  </div>
                ) : personal &&
                  !searching &&
                  context.recommendationStatus ===
                    'insufficient_information' ? (
                  <div className="empty" role="status">
                    <p>情報が足りません</p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        navigate('/favorites');
                      }}
                    >
                      お気に入りを開く
                    </Button>
                  </div>
                ) : personal && !searching && visibleAssets.length === 0 ? (
                  <div className="empty">おすすめがありません</div>
                ) : related && !searching && visibleAssets.length === 0 ? (
                  <div className="empty">関連コンテンツがありません。</div>
                ) : (
                  <AssetList
                    favorites={section === 'favorites'}
                    favoriteBusy={favoriteBusy}
                    onFavorite={(asset) => {
                      void toggleFavorite(asset);
                    }}
                    onLibrary={() => {
                      navigate('/library');
                    }}
                    assets={pageAssets}
                    selectedId={selected?.asset_id}
                    view={related || personal ? 'detailed-grid' : view}
                    recommendations={
                      related || personal
                        ? (pageAssets as Recommendation[])
                        : undefined
                    }
                    kind={kind}
                    searching={searching}
                    isResult={isResult}
                    uploading={progress !== null}
                    currentPage={currentPage}
                    pageCount={pageCount}
                    resultCount={resultCount}
                    fileList={fileList}
                    onSelect={(asset) => {
                      goAsset(asset);
                    }}
                    onOpen={openViewer}
                    onReset={reset}
                    onUpload={() => uploadInput.current?.click()}
                    onPageChange={changePage}
                  />
                )}
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
                  previewAsset={previewAsset ?? undefined}
                  seriesEditable={seriesEditable}
                  jobs={jobs}
                  searching={searching}
                  notice={notice}
                  detailTitle={detailTitle}
                  onClose={closeDetail}
                  onOpen={() => openViewer(selected)}
                  onSaveMetadata={saveMetadata}
                  onSearchTag={(tag) => openMetadataFilter('tag', tag)}
                  onSearchCharacter={(character) =>
                    openMetadataFilter('character', character)
                  }
                  onCompare={compare}
                  onRecommend={openRecommendations}
                  showComparisons={!related}
                  onReprocess={reprocess}
                  onDelete={deleteAsset}
                />
              )}
            </div>
          </>
        )}
      </main>
      {me && viewerOpen && selected && (
        <Viewer
          asset={selected}
          onFavorite={(asset) => {
            void toggleFavorite(asset);
          }}
          favoriteBusy={favoriteBusy.has(selected.asset_id)}
          navigationError={error}
          onMemberChange={(member: Asset) =>
            goAsset(
              {
                ...selected,
                matched_asset_id: member.asset_id,
                page_number: member.page_number,
                start_ms: member.start_ms,
                end_ms: member.end_ms,
              },
              true,
              true,
            )
          }
          hasPrevious={
            !viewerMoving &&
            !viewerLoading &&
            selectedIndex >= 0 &&
            (selectedIndex > 0 || currentPage > 1)
          }
          hasNext={
            !viewerMoving &&
            !viewerLoading &&
            (selectedIndex < pageAssets.length - 1 ||
              (selectedIndex >= 0 && currentPage < pageCount))
          }
          onNavigate={(direction) => {
            void moveViewer(direction);
          }}
          onClose={() => closeAsset(true)}
        />
      )}
    </div>
  );
}
