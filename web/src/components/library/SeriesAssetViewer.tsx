import { useEffect, useState } from 'react';
import type { Asset } from '../../lib/assets';
import { AssetViewer, type AssetViewerProps } from './AssetViewer';

// Keep series playback inside the ordinary file viewer and its list context.
export function SeriesAssetViewer(props: AssetViewerProps) {
  const { asset, onNavigate, onMemberChange } = props;
  const [items, setItems] = useState<Asset[] | null>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly restarts the request.
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    setError('');
    const get = async (id: string) => {
      const response = await fetch(`/api/v1/series/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error();
      return response.json() as Promise<{ members: Asset[] }>;
    };
    const load = async () => {
      const series = await get(asset.asset_id);
      const nested = await Promise.all(
        series.members.map(async (member) =>
          member.series_kind ? (await get(member.asset_id)).members : [member],
        ),
      );
      if (controller.signal.aborted) return;
      const leaves = nested.flat();
      setItems(leaves);
      setIndex(
        Math.max(
          0,
          leaves.findIndex(
            (member) => member.asset_id === asset.matched_asset_id,
          ),
        ),
      );
    };
    void load().catch(() => {
      if (!controller.signal.aborted) setError('シリーズを読み込めません。');
    });
    return () => controller.abort();
  }, [asset.asset_id, asset.matched_asset_id, retry]);

  const current = items?.[index];
  const display = current
    ? {
        ...current,
        is_favorite: asset.is_favorite,
        ...(current.asset_id === asset.matched_asset_id
          ? {
              page_number: asset.page_number,
              start_ms: asset.start_ms,
              end_ms: asset.end_ms,
            }
          : {}),
      }
    : asset;
  const status = error
    ? { message: error, retry: () => setRetry((value) => value + 1) }
    : items === null
      ? { message: '読み込み中…' }
      : items.length === 0
        ? { message: '作品がありません' }
        : undefined;

  function move(direction: number) {
    const next = index + direction;
    if (items && next >= 0 && next < items.length) {
      setIndex(next);
      onMemberChange?.(items[next]);
    } else onNavigate(direction);
  }

  return (
    <AssetViewer
      {...props}
      asset={display}
      status={status}
      continuous
      autoAdvance={Boolean(items && index < items.length - 1)}
      hasPrevious={index > 0 || props.hasPrevious}
      hasNext={Boolean(items && index < items.length - 1) || props.hasNext}
      onNavigate={move}
      onFavorite={() => props.onFavorite?.(asset)}
    />
  );
}
