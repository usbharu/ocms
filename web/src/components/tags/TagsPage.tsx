import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { parseRoute } from '../../lib/routes';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { NativeSelect } from '../ui/native-select';

export type Tag = { name: string; asset_count: number };
export type Link = { source: string; target: string; asset_count: number };
export type TagData = { tags: Tag[]; links: Link[]; total: number };
type TagView = 'list' | 'cloud' | 'graph';
type TagSort = 'count' | 'added_desc' | 'added_asc';
const tagSorts: { id: TagSort; label: string }[] = [
  { id: 'count', label: '被リンクが多い順' },
  { id: 'added_desc', label: 'アセット追加が新しい順' },
  { id: 'added_asc', label: 'アセット追加が古い順' },
];
const TagVisualization = lazy(() => import('./TagVisualization'));

export function TagsPage({
  onOpen,
  kind = 'tags',
}: {
  onOpen: (tag: string) => void;
  kind?: 'tags' | 'characters';
}) {
  const label = kind === 'characters' ? 'キャラクター' : 'タグ';
  const searchId = useId();
  const sortId = useId();
  const [params, setParams] = useSearchParams();
  const routeQuery = params.get('q') ?? '';
  const [query, setQuery] = useState(routeQuery);
  const view: TagView = parseRoute(`/${kind}`, `?${params}`).tagView;
  const rawSort = params.get('sort');
  const sort: TagSort = tagSorts.some((item) => item.id === rawSort)
    ? (rawSort as TagSort)
    : 'count';
  useEffect(() => {
    setQuery(routeQuery);
  }, [routeQuery]);
  useEffect(() => {
    if (query === routeQuery) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (query.trim()) next.set('q', query.trim());
      else next.delete('q');
      setParams(next, { replace: true });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, routeQuery, params, setParams]);
  useEffect(() => {
    const rawView = params.get('view');
    if (rawView && !['list', 'graph'].includes(rawView)) {
      const next = new URLSearchParams(params);
      next.delete('view');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => {
    if (rawSort && !tagSorts.some((item) => item.id === rawSort)) {
      const next = new URLSearchParams(params);
      next.delete('sort');
      setParams(next, { replace: true });
    }
  }, [rawSort, params, setParams]);

  function setView(nextView: TagView) {
    const next = new URLSearchParams(params);
    if (nextView === 'cloud') next.delete('view');
    else next.set('view', nextView);
    setParams(next);
  }

  function setSort(nextSort: TagSort) {
    const next = new URLSearchParams(params);
    if (nextSort === 'count') next.delete('sort');
    else next.set('sort', nextSort);
    setParams(next);
  }

  const [data, setData] = useState<TagData | null>(null);
  const dataQuery = useRef<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision triggers an explicit refresh.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    if (dataQuery.current !== query.trim()) setData(null);
    const timer = window.setTimeout(async () => {
      try {
        const search = new URLSearchParams({ q: query.trim() });
        if (sort !== 'count') search.set('sort', sort);
        const response = await fetch(`/api/v1/${kind}?${search}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('tags');
        const raw = await response.json();
        const result: TagData = { ...raw, tags: raw[kind] };
        if (!controller.signal.aborted) {
          dataQuery.current = query.trim();
          setData(result);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, revision, kind, sort]);
  return (
    <section
      className="tags-page"
      aria-label={`${label}一覧`}
      aria-busy={loading}
    >
      <h1 className="visually-hidden">{label}</h1>
      <div className="tags-toolbar">
        <div className="tag-search">
          <label htmlFor={searchId}>{label}を検索</label>
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${label}名`}
          />
        </div>
        <fieldset
          className="view-switch tag-controls"
          aria-label={`${label}の表示方法`}
        >
          {(['list', 'cloud', 'graph'] as const).map((id) => (
            <Button
              key={id}
              variant={view === id ? 'secondary' : 'ghost'}
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              {id === 'list'
                ? '一覧'
                : id === 'cloud'
                  ? 'ワードクラウド'
                  : 'グラフ'}
            </Button>
          ))}
        </fieldset>
        <label className="tag-sort" htmlFor={sortId}>
          <span>並べ替え</span>
          <NativeSelect
            id={sortId}
            aria-label={`${label}の並べ替え`}
            value={sort}
            onChange={(event) => setSort(event.target.value as TagSort)}
          >
            {tagSorts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <Button
          variant="outline"
          onClick={() => setRevision((value) => value + 1)}
        >
          更新
        </Button>
      </div>
      {loading && !data ? (
        <div className="empty" role="status">
          {label}を読み込み中…
        </div>
      ) : error ? (
        <div className="empty" role="alert">
          {label}を読み込めません。
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            再試行
          </Button>
        </div>
      ) : (
        data && (
          <>
            <div className="result-heading">
              <h2>
                {query.trim()
                  ? `「${query.trim()}」の${label}`
                  : `すべての${label}`}
              </h2>
              <span role={loading ? 'status' : undefined}>
                {loading ? `${label}を読み込み中…` : `${data.total}${label}`}
              </span>
            </div>
            {data.total === 0 ? (
              <div className="empty">
                {query.trim()
                  ? `一致する${label}がありません。`
                  : `${label}がありません。ライブラリでファイルに${label}を追加してください。`}
              </div>
            ) : (
              <>
                <p className="tag-hint">
                  被リンク数：{label}が付いたファイルの件数
                </p>
                {view !== 'list' ? (
                  <Suspense
                    fallback={
                      <div className="empty" role="status">
                        表示を準備中…
                      </div>
                    }
                  >
                    <TagVisualization
                      key={query + sort + view}
                      label={label}
                      data={data}
                      view={view}
                      onOpen={onOpen}
                    />
                  </Suspense>
                ) : (
                  <ul className="tag-list">
                    {data.tags.map((tag) => (
                      <li key={tag.name}>
                        <button type="button" onClick={() => onOpen(tag.name)}>
                          <span>{tag.name}</span>
                          <span>{tag.asset_count}件</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {data.total > data.tags.length && (
                  <p className="tag-hint">
                    被リンク数の上位{data.tags.length}
                    {label}を表示しています。検索で絞り込めます。
                  </p>
                )}
              </>
            )}
          </>
        )
      )}
    </section>
  );
}
