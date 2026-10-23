import cytoscape, { type Core, type Layouts } from 'cytoscape';
import cola from 'cytoscape-cola';
import cloud from 'd3-cloud';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { NativeSelect } from '../ui/native-select';
import type { Tag, TagData } from './TagsPage';

cytoscape.use(cola);

type Word = cloud.Word & { text: string; count: number };

function WordCloud({
  tags,
  label,
  onOpen,
}: {
  tags: Tag[];
  label: string;
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
        aria-label={`${label}のワードクラウド`}
        aria-busy={!complete}
      >
        <svg
          width={size.width}
          height={size.height}
          aria-label={`ファイル件数に応じた${label}の配置`}
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
        <p className="tag-hint">
          配置できなかった{label}は一覧から確認できます。
        </p>
      )}
    </>
  );
}

export default function TagVisualization({
  data,
  label = 'タグ',
  view,
  onOpen,
}: {
  data: TagData;
  label?: string;
  view: 'cloud' | 'graph';
  onOpen: (name: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<Core | null>(null);
  const fitZoom = useRef(1);
  const rearrange = useRef<(() => void) | null>(null);
  const [arranging, setArranging] = useState(false);
  const toggleMotion = useRef<(() => void) | null>(null);
  const [moving, setMoving] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
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
            label: `${Array.from(tag.name).length > 14 ? `${Array.from(tag.name).slice(0, 14).join('')}…` : tag.name}`,
            diameter: 8 + 50 * Math.sqrt(tag.asset_count / max),
          },
        })),
        ...data.links
          .filter((link) => ids.has(link.source) && ids.has(link.target))
          .map((link, i) => ({
            data: {
              id: `edge-${i}`,
              source: ids.get(link.source),
              target: ids.get(link.target),
              weight: Math.min(2, 0.5 + Math.log2(1 + link.asset_count) / 4),
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
            'font-size': 12,
            'min-zoomed-font-size': 8,
            'text-wrap': 'wrap',
            'text-valign': 'bottom',
            'text-margin-y': 8,
            'text-max-width': '120px',
            'text-background-color': '#fff',
            'text-background-opacity': 0.7,
            'text-background-padding': '3px',
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'data(weight)',
            'line-color': '#86b99b',
            'curve-style': 'bezier',
            opacity: 0.16,
          },
        },
        { selector: '.dimmed', style: { opacity: 0.08 } },
        {
          selector: 'node.highlighted',
          style: { 'min-zoomed-font-size': 0, 'font-weight': 'bold' },
        },
        {
          selector: ':selected',
          style: { 'background-color': '#15803d', 'border-width': 4 },
        },
      ],
      layout: { name: 'circle', fit: false, spacingFactor: 1.8 },
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
    let layout: Layouts | null = null;
    let generation = 0;
    let motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setMoving(motion);
    let fitAfterLayout = true;
    let fitting = false;
    const preserveViewport = () => {
      if (!fitting) fitAfterLayout = false;
    };
    cy.on('zoom pan', preserveViewport);
    const runLayout = (fitWhenDone: boolean, live = false) => {
      const version = ++generation;
      layout?.stop();
      fitAfterLayout = fitWhenDone;
      setArranging(!live);
      const options = {
        name: 'cola',
        animate:
          live ||
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        infinite: live,
        centerGraph: !live,
        refresh: 2,
        maxSimulationTime: 2400,
        fit: false,
        randomize: fitWhenDone,
        avoidOverlap: true,
        handleDisconnected: true,
        nodeDimensionsIncludeLabels: true,
        nodeSpacing: () => 28,
        edgeLength: 180,
        convergenceThreshold: 0.01,
        stop: () => {
          if (version !== generation) return;
          setArranging(false);
          if (!live && fitAfterLayout) {
            fitting = true;
            fitGraph();
            fitting = false;
          }
          if (!live && motion && !document.hidden) runLayout(false, true);
        },
      };
      layout = cy.layout(options);
      layout.run();
    };
    rearrange.current = () => runLayout(true);
    runLayout(true);
    toggleMotion.current = () => {
      motion = !motion;
      setMoving(motion);
      if (motion) runLayout(false, true);
      else {
        ++generation;
        layout?.stop();
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        ++generation;
        layout?.stop();
        setArranging(false);
      } else if (motion) runLayout(false, true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    cy.on('mouseover', 'node', (event) => event.target.addClass('highlighted'));
    cy.on('mouseout', 'node', (event) => {
      if (!event.target.selected()) event.target.removeClass('highlighted');
    });
    cy.on('tap', 'node', (event) => setSelected(event.target.data('name')));
    cy.on('zoom', () =>
      setZoom(Math.round((cy.zoom() / fitZoom.current) * 100)),
    );
    const observer = new ResizeObserver(() => {
      fitting = true;
      fitGraph();
      fitting = false;
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      toggleMotion.current = null;
      ++generation;
      layout?.stop();
      rearrange.current = null;
      graph.current = null;
      cy.destroy();
    };
  }, [data, view]);
  useEffect(() => {
    const cy = graph.current;
    if (!cy) return;
    cy.elements().removeClass('dimmed highlighted');
    cy.nodes().unselect();
    if (!selected) return;
    const node = cy.nodes().filter((item) => item.data('name') === selected);
    node.select().addClass('highlighted');
    cy.elements().difference(node.closedNeighborhood()).addClass('dimmed');
    const viewport = {
      center: { eles: node },
      zoom: Math.max(cy.zoom(), 0.85),
    };
    cy.stop();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cy.center(node);
      cy.zoom(viewport.zoom);
    } else {
      cy.animate(viewport, { duration: 250 });
    }
  }, [selected]);
  function changeZoom(factor: number) {
    const cy = graph.current;
    cy?.stop();
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
          <span>線：同じファイルに付いた{label}</span>
          <Button
            variant="ghost"
            onClick={() => rearrange.current?.()}
            disabled={arranging}
          >
            再配置
          </Button>
          <Button
            variant="ghost"
            onClick={() => toggleMotion.current?.()}
            disabled={arranging}
          >
            {moving ? '動きを停止' : '動きを再開'}
          </Button>
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
                  cy.stop();
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
        <WordCloud label={label} tags={data.tags} onOpen={onOpen} />
      ) : (
        <div
          ref={container}
          className="tag-graph"
          role="img"
          aria-busy={arranging}
          aria-label={`${label}の関係グラフ：${tags.length}${label}、${data.links.length}本の線`}
        />
      )}
      <div className="tag-selection">
        <NativeSelect
          aria-label={`${label}を選択`}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">{label}を選択</option>
          {tags.map((tag) => (
            <option key={tag.name} value={tag.name}>
              {tag.name}：{tag.asset_count}件
            </option>
          ))}
        </NativeSelect>
        {active && (
          <span aria-live="polite">
            {active.asset_count}件のファイル
            {view === 'graph' ? ` · 関連${label} ${neighbors}件` : ''}
          </span>
        )}
        <Button disabled={!active} onClick={() => onOpen(selected)}>
          ファイルを表示
        </Button>
      </div>
      {view === 'graph' && data.tags.length > 60 && (
        <p className="tag-hint">
          グラフは被リンク数の上位60{label}
          を表示しています。検索で絞り込めます。
        </p>
      )}
    </>
  );
}
