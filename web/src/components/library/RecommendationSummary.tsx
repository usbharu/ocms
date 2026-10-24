import { locationOf, type Recommendation } from '../../lib/assets';

function visibleNames(names: string[]) {
  return (
    names.slice(0, 3).join(' · ') +
    (names.length > 3 ? ` · ほか${names.length - 3}件` : '')
  );
}

export function RecommendationSummary({ item }: { item: Recommendation }) {
  return (
    <span
      className="recommendation-summary"
      id={`recommendation-${item.asset_id}`}
    >
      <span className="recommendation-score">評価 {item.score.toFixed(1)}</span>
      {item.common_characters.length > 0 && (
        <span title={item.common_characters.join(' · ')}>
          共通キャラクター：{visibleNames(item.common_characters)}
        </span>
      )}
      {item.common_tags.length > 0 && (
        <span title={item.common_tags.join(' · ')}>
          共通タグ：{visibleNames(item.common_tags)}
        </span>
      )}
      {item.perceptual && (
        <span>
          {item.perceptual === 'audio' ? '音が近い' : '見た目が近い'}
          {locationOf(item) && ` · ${locationOf(item)}`}
        </span>
      )}
    </span>
  );
}
