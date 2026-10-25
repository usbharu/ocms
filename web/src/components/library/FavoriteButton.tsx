import type { Asset } from '../../lib/assets';
import { Button } from '../ui/button';

export function FavoriteButton({
  asset,
  busy,
  onToggle,
}: {
  asset: Asset;
  busy?: boolean;
  onToggle?: (asset: Asset) => void;
}) {
  const label = asset.is_favorite ? 'お気に入りを解除' : 'お気に入りに登録';
  return (
    <Button
      type="button"
      variant="ghost"
      className="favorite-button"
      aria-label={`${asset.filename}：${label}`}
      title={label}
      aria-pressed={Boolean(asset.is_favorite)}
      disabled={busy}
      onClick={() => onToggle?.(asset)}
    >
      <span aria-hidden="true">{asset.is_favorite ? '★' : '☆'}</span>
    </Button>
  );
}
