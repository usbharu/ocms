import { type Kind, kinds, type View } from '../../lib/assets';
import { Button } from '../ui/button';
import { NativeSelect } from '../ui/native-select';

export function LibraryToolbar({
  kind,
  view,
  searching,
  onKindChange,
  onViewChange,
  onRefresh,
}: {
  kind: Kind;
  view: View;
  searching: boolean;
  onKindChange: (kind: Kind) => void;
  onViewChange: (view: View) => void;
  onRefresh: () => void;
}) {
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
            disabled={searching}
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
          disabled={searching}
          onClick={onRefresh}
        >
          更新
        </Button>
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
