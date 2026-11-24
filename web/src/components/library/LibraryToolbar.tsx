import {
  assetSorts,
  type Kind,
  kinds,
  type LibrarySort,
  type View,
} from '../../lib/assets';
import { Button } from '../ui/button';
import { NativeSelect } from '../ui/native-select';

export function LibraryToolbar({
  kind,
  view,
  sort,
  favorites,
  onKindChange,
  onViewChange,
  onSortChange,
  onRefresh,
}: {
  kind: Kind;
  view: View;
  sort?: LibrarySort;
  favorites?: boolean;
  onKindChange: (kind: Kind) => void;
  onViewChange: (view: View) => void;
  onSortChange?: (sort: LibrarySort) => void;
  onRefresh: () => void;
}) {
  const sortOptions: { id: LibrarySort; label: string }[] = [
    ...(favorites
      ? [{ id: 'favorite_desc' as const, label: 'お気に入り登録が新しい順' }]
      : []),
    ...assetSorts,
  ];
  return (
    <div className="library-toolbar">
      {/* biome-ignore lint/a11y/useSemanticElements: These toggle buttons form a labeled group without fieldset styling. */}
      <div className="filters" role="group" aria-label="ファイルの種類">
        {kinds.map((item) => (
          <Button
            variant="outline"
            type="button"
            key={item.id}
            aria-pressed={kind === item.id}
            onClick={() => onKindChange(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <div className="view-controls">
        <Button
          variant="ghost"
          type="button"
          className="quiet"
          onClick={onRefresh}
        >
          更新
        </Button>
        {sort && onSortChange && (
          <NativeSelect
            aria-label="並べ替え"
            value={sort}
            onChange={(e) => onSortChange(e.target.value as LibrarySort)}
          >
            {sortOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        )}
        <NativeSelect
          aria-label="表示方法"
          value={view}
          onChange={(e) => onViewChange(e.target.value as View)}
        >
          <option value="list">リスト表示</option>
          <option value="grid">グリッド表示</option>
          <option value="detailed-grid">詳細グリッド表示</option>
        </NativeSelect>
      </div>
    </div>
  );
}
