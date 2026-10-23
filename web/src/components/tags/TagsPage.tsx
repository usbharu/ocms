import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type Tag = { name: string; asset_count: number };
export type Link = { source: string; target: string; asset_count: number };
export type TagData = { tags: Tag[]; links: Link[]; total: number };
type TagView = 'list' | 'cloud' | 'graph';
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
  const [query, setQuery] = useState('');
  const [view, setView] = useState<TagView>('cloud');
  const [data, setData] = useState<TagData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision triggers an explicit refresh.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setData(null);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/v1/${kind}?${new URLSearchParams({ q: query.trim() })}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('tags');
        const raw = await response.json();
        const result: TagData = { ...raw, tags: raw[kind] };
        if (!controller.signal.aborted) setData(result);
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
  }, [query, revision, kind]);
  return (
    <section className="tags-page" aria-label={`${label}一覧`}>
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
        <Button
          variant="outline"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading}
        >
          更新
        </Button>
      </div>
      {loading ? (
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
              <span>
                {data.total}
                {label}
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
                      key={query + view}
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
