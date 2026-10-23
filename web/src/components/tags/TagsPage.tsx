import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export type Tag = { name: string; asset_count: number };
type Link = { source: string; target: string; asset_count: number };
type TagData = { tags: Tag[]; links: Link[]; total: number };
type TagView = 'list' | 'cloud' | 'graph';

function layout(tags: Tag[], links: Link[]) {
  const nodes = tags.map((tag, i) => ({
    ...tag,
    x: 600 + Math.cos(i * 2.39996) * Math.sqrt(i + 1) * 44,
    y: 400 + Math.sin(i * 2.39996) * Math.sqrt(i + 1) * 32,
    radius: 20 + 24 * Math.sqrt(tag.asset_count / (tags[0]?.asset_count || 1)),
  }));
  const byName = new Map(nodes.map((node) => [node.name, node]));
  for (let step = 0; step < 180; step++) {
    for (const a of nodes) {
      a.x += (600 - a.x) * 0.002;
      a.y += (400 - a.y) * 0.002;
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = Math.max(
          Math.min(5, 1800 / (distance * distance)),
          (120 - distance) * 0.12,
        );
        a.x += (dx / distance) * force;
        a.y += (dy / distance) * force;
      }
    }
    for (const link of links) {
      const a = byName.get(link.source);
      const b = byName.get(link.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 155) * 0.003;
      a.x += (dx / distance) * force;
      a.y += (dy / distance) * force;
      b.x -= (dx / distance) * force;
      b.y -= (dy / distance) * force;
    }
    for (const node of nodes) {
      node.x = Math.max(90, Math.min(1110, node.x));
      node.y = Math.max(65, Math.min(735, node.y));
    }
  }
  return { nodes, byName };
}

function TagGraph({
  data,
  onOpen,
}: {
  data: TagData;
  onOpen: (tag: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recenter after zoom changes the scrollable dimensions.
  useEffect(() => {
    const el = viewport.current;
    if (el) {
      el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
    }
  }, [zoom]);
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, byName } = useMemo(
    () => layout(data.tags.slice(0, 60), data.links),
    [data],
  );
  const minX = Math.min(...nodes.map((node) => node.x));
  const maxX = Math.max(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxY = Math.max(...nodes.map((node) => node.y));
  const graphWidth = Math.max(720, maxX - minX + 180);
  const graphHeight = Math.max(480, maxY - minY + 150);
  const active = nodes.find((node) => node.name === selected);
  const neighbors = new Set(
    data.links.flatMap((link) =>
      link.source === selected
        ? [link.target]
        : link.target === selected
          ? [link.source]
          : [],
    ),
  );
  return (
    <>
      <div className="tag-graph-toolbar">
        <span>線：同じファイルに付いたタグ</span>
        <fieldset
          className="view-switch tag-controls"
          aria-label="グラフの拡大率"
        >
          <Button
            variant="ghost"
            disabled={zoom <= 1}
            onClick={() => setZoom(Math.max(1, zoom - 0.5))}
            aria-label="縮小"
          >
            −
          </Button>
          <Button variant="ghost" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            variant="ghost"
            disabled={zoom >= 3}
            onClick={() => setZoom(Math.min(3, zoom + 0.5))}
            aria-label="拡大"
          >
            ＋
          </Button>
        </fieldset>
      </div>
      <section
        className="tag-graph-scroll"
        ref={viewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the graph.
        tabIndex={0}
        aria-label="タグの関係グラフ"
      >
        <svg
          viewBox={`${(minX + maxX - graphWidth) / 2} ${(minY + maxY - graphHeight) / 2} ${graphWidth} ${graphHeight}`}
          style={{ width: `${zoom * 100}%`, height: `${zoom * 55}vh` }}
          aria-label="タグの共起関係"
        >
          {data.links.map((link) => {
            const a = byName.get(link.source);
            const b = byName.get(link.target);
            if (!a || !b) return null;
            return (
              <line
                key={`${link.source}\0${link.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={Math.min(6, 1 + Math.sqrt(link.asset_count))}
                className={
                  selected &&
                  link.source !== selected &&
                  link.target !== selected
                    ? 'muted-link'
                    : ''
                }
              >
                <title>
                  {link.source}・{link.target}：{link.asset_count}件
                </title>
              </line>
            );
          })}
          {nodes.map((tag) => (
            <foreignObject
              key={tag.name}
              x={tag.x - 70}
              y={tag.y - tag.radius}
              width={140}
              height={tag.radius * 2 + 26}
            >
              <button
                type="button"
                className={`tag-node ${selected === tag.name ? 'selected' : ''} ${selected && selected !== tag.name && !neighbors.has(tag.name) ? 'muted-node' : ''}`}
                onClick={() => setSelected(tag.name)}
                aria-pressed={selected === tag.name}
                aria-label={`${tag.name}：${tag.asset_count}件`}
                title={tag.name}
              >
                <span
                  className="tag-node-circle"
                  style={{ width: tag.radius * 2, height: tag.radius * 2 }}
                >
                  {tag.asset_count}
                </span>
                <span className="tag-node-label">{tag.name}</span>
              </button>
            </foreignObject>
          ))}
        </svg>
      </section>
      {active && (
        <div className="tag-selection" aria-live="polite">
          <strong>{active.name}</strong>
          <span>
            {active.asset_count}件のファイル · 関連タグ {neighbors.size}件
          </span>
          <Button onClick={() => onOpen(active.name)}>ファイルを表示</Button>
        </div>
      )}
      {data.tags.length > 60 && (
        <p className="tag-hint">
          グラフは被リンク数の上位60タグを表示しています。検索で絞り込めます。
        </p>
      )}
    </>
  );
}

export function TagsPage({ onOpen }: { onOpen: (tag: string) => void }) {
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
          `/api/v1/tags?${new URLSearchParams({ q: query.trim() })}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('tags');
        const result: TagData = await response.json();
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
  }, [query, revision]);
  const maxCount = data?.tags[0]?.asset_count || 1;
  return (
    <section className="tags-page" aria-label="タグ一覧">
      <div className="workspace-heading">
        <h1>タグ</h1>
        <Button
          variant="outline"
          onClick={() => setRevision((value) => value + 1)}
          disabled={loading}
        >
          更新
        </Button>
      </div>
      <div className="tags-toolbar">
        <div className="tag-search">
          <label htmlFor={searchId}>タグを検索</label>
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="タグ名"
          />
        </div>
        <fieldset
          className="view-switch tag-controls"
          aria-label="タグの表示方法"
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
      </div>
      {loading ? (
        <div className="empty" role="status">
          タグを読み込み中…
        </div>
      ) : error ? (
        <div className="empty" role="alert">
          タグを読み込めません。
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
                {query.trim() ? `「${query.trim()}」のタグ` : 'すべてのタグ'}
              </h2>
              <span>{data.total}タグ</span>
            </div>
            {data.total === 0 ? (
              <div className="empty">
                {query.trim()
                  ? '一致するタグがありません。'
                  : 'タグがありません。ライブラリでファイルにタグを追加してください。'}
              </div>
            ) : (
              <>
                <p className="tag-hint">
                  被リンク数：タグが付いたファイルの件数
                </p>
                {view === 'graph' ? (
                  <TagGraph key={query} data={data} onOpen={onOpen} />
                ) : view === 'cloud' ? (
                  <section
                    className="tag-cloud"
                    aria-label="タグのワードクラウド"
                  >
                    {data.tags.map((tag) => (
                      <button
                        type="button"
                        key={tag.name}
                        onClick={() => onOpen(tag.name)}
                        style={{
                          fontSize: `${14 + 34 * Math.sqrt(tag.asset_count / maxCount)}px`,
                        }}
                        aria-label={`${tag.name}：${tag.asset_count}件`}
                        title={`${tag.asset_count}件のファイル`}
                      >
                        {tag.name}
                        <small>{tag.asset_count}</small>
                      </button>
                    ))}
                  </section>
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
                    タグを表示しています。検索で絞り込めます。
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
