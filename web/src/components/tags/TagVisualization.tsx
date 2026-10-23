import cytoscape, { type Core } from 'cytoscape';
import cloud from 'd3-cloud';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { NativeSelect } from '../ui/native-select';
import type { Tag, TagData } from './TagsPage';

type Word = cloud.Word & { text: string; count: number };

function WordCloud({
  tags,
  onOpen,
}: {
  tags: Tag[];
  onOpen: (name: string) => void;
}) {
  const container = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 440 });
  const [words, setWords] = useState<Word[]>([]);
  const [complete, setComplete] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      }),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!size.width) return;
    setComplete(false);
    setWords([]);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return;
    context.font = '100px sans-serif';
    const max = tags[0]?.asset_count || 1;
    const layout = cloud<Word>()
      .size([size.width, size.height])
      .words(tags.map((tag) => ({ text: tag.name, count: tag.asset_count })))
      .padding(5)
      .rotate(0)
      .font('sans-serif')
      .fontSize((word) =>
        Math.min(
          16 + 48 * Math.sqrt(word.count / max),
          ((size.width - 32) /
            Math.max(1, context.measureText(word.text).width)) *
            100,
        ),
      )
      .timeInterval(12)
      .on('end', (placed) => {
        setWords(placed);
        setComplete(true);
      });
    layout.start();
    return () => {
      layout.stop();
    };
  }, [size, tags]);
  return (
    <>
      <section
        className="tag-cloud"
        ref={container}
        aria-label="タグのワードクラウド"
        aria-busy={!complete}
      >
        <svg
          width={size.width}
          height={size.height}
          aria-label="ファイル件数に応じたタグの配置"
        >
          <g transform={`translate(${size.width / 2},${size.height / 2})`}>
            {words.map((word) => (
              // biome-ignore lint/a11y/useSemanticElements: SVG text needs button semantics for keyboard activation.
              <text
                key={word.text}
                role="button"
                tabIndex={0}
                textAnchor="middle"
                transform={`translate(${word.x},${word.y})`}
                style={{ fontSize: word.size, fontFamily: 'sans-serif' }}
                aria-label={`${word.text}：${word.count}件`}
                onClick={() => onOpen(word.text)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(word.text);
                  }
                }}
              >
                <title>
                  {word.text}：{word.count}件
                </title>
                {word.text}
              </text>
            ))}
          </g>
        </svg>
      </section>
      {complete && words.length < tags.length && (
        <p className="tag-hint">配置できなかったタグは一覧から確認できます。</p>
      )}
    </>
  );
}

export default function TagVisualization({
  data,
  view,
  onOpen,
}: {
  data: TagData;
  view: 'cloud' | 'graph';
  onOpen: (name: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<Core | null>(null);
  const fitZoom = useRef(1);
  const [zoom, setZoom] = useState(100);
  const [selected, setSelected] = useState('');
  const tags = view === 'graph' ? data.tags.slice(0, 60) : data.tags;
  const active = tags.find((tag) => tag.name === selected);
  const neighbors = data.links.filter(
    (link) => link.source === selected || link.target === selected,
  ).length;
  useEffect(() => {
    if (view !== 'graph' || !container.current) return;
    const graphTags = data.tags.slice(0, 60);
    const ids = new Map(graphTags.map((tag, i) => [tag.name, `tag-${i}`]));
    const max = graphTags[0]?.asset_count || 1;
    const cy = cytoscape({
      container: container.current,
      elements: [
        ...graphTags.map((tag) => ({
          data: {
            id: ids.get(tag.name),
            name: tag.name,
            label: `${tag.name.length > 24 ? `${tag.name.slice(0, 24)}…` : tag.name}\n${tag.asset_count}件`,
            diameter: 32 + 48 * Math.sqrt(tag.asset_count / max),
          },
        })),
        ...data.links
          .filter((link) => ids.has(link.source) && ids.has(link.target))
          .map((link, i) => ({
            data: {
              id: `edge-${i}`,
              source: ids.get(link.source),
              target: ids.get(link.target),
              weight: Math.min(6, 1 + Math.sqrt(link.asset_count)),
            },
          })),
      ],
      style: [
        {
          selector: 'node',
          style: {
            width: 'data(diameter)',
            height: 'data(diameter)',
            label: 'data(label)',
            'background-color': '#dcfce7',
            'border-color': '#15803d',
            'border-width': 2,
            color: '#24312b',
            'font-size': 13,
            'text-wrap': 'wrap',
            'text-valign': 'bottom',
            'text-margin-y': 8,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(weight)',
            'line-color': '#86b99b',
            'curve-style': 'bezier',
            opacity: 0.6,
          },
        },
        { selector: '.dimmed', style: { opacity: 0.15 } },
        {
          selector: ':selected',
          style: { 'background-color': '#15803d', 'border-width': 4 },
        },
      ],
      layout: {
        name: 'cose',
        animate: false,
        padding: 45,
        nodeDimensionsIncludeLabels: true,
        nodeRepulsion: () => 12000,
        idealEdgeLength: () => 120,
      },
      minZoom: 0.1,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });
    graph.current = cy;
    const fitGraph = () => {
      cy.resize();
      cy.fit(undefined, 45);
      fitZoom.current = cy.zoom();
      setZoom(100);
    };
    fitGraph();
    cy.on('tap', 'node', (event) => setSelected(event.target.data('name')));
    cy.on('zoom', () =>
      setZoom(Math.round((cy.zoom() / fitZoom.current) * 100)),
    );
    const observer = new ResizeObserver(fitGraph);
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      graph.current = null;
      cy.destroy();
    };
  }, [data, view]);
  useEffect(() => {
    const cy = graph.current;
    if (!cy) return;
    cy.elements().removeClass('dimmed');
    cy.nodes().unselect();
    if (!selected) return;
    const node = cy.nodes().filter((item) => item.data('name') === selected);
    node.select();
    cy.elements().difference(node.closedNeighborhood()).addClass('dimmed');
  }, [selected]);
  function changeZoom(factor: number) {
    const cy = graph.current;
    if (cy)
      cy.zoom({
        level: Math.min(
          cy.maxZoom(),
          Math.max(cy.minZoom(), cy.zoom() * factor),
        ),
        renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
      });
  }
  return (
    <>
      {view === 'graph' && (
        <div className="tag-graph-toolbar">
          <span>線：同じファイルに付いたタグ</span>
          <fieldset className="tag-controls" aria-label="グラフの拡大率">
            <Button
              variant="ghost"
              onClick={() => changeZoom(1 / 1.5)}
              aria-label="縮小"
            >
              −
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                const cy = graph.current;
                if (cy) {
                  cy.fit(undefined, 45);
                  fitZoom.current = cy.zoom();
                  setZoom(100);
                }
              }}
              aria-label="全体を表示"
            >
              {zoom}%
            </Button>
            <Button
              variant="ghost"
              onClick={() => changeZoom(1.5)}
              aria-label="拡大"
            >
              ＋
            </Button>
          </fieldset>
        </div>
      )}
      {view === 'cloud' ? (
        <WordCloud tags={data.tags} onOpen={onOpen} />
      ) : (
        <div
          ref={container}
          className="tag-graph"
          role="img"
          aria-label={`タグの関係グラフ：${tags.length}タグ、${data.links.length}本の線`}
        />
      )}
      <div className="tag-selection">
        <NativeSelect
          aria-label="タグを選択"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">タグを選択</option>
          {tags.map((tag) => (
            <option key={tag.name} value={tag.name}>
              {tag.name}：{tag.asset_count}件
            </option>
          ))}
        </NativeSelect>
        {active && (
          <span aria-live="polite">
            {active.asset_count}件のファイル
            {view === 'graph' ? ` · 関連タグ ${neighbors}件` : ''}
          </span>
        )}
        <Button disabled={!active} onClick={() => onOpen(selected)}>
          ファイルを表示
        </Button>
      </div>
      {view === 'graph' && data.tags.length > 60 && (
        <p className="tag-hint">
          グラフは被リンク数の上位60タグを表示しています。検索で絞り込めます。
        </p>
      )}
    </>
  );
}
