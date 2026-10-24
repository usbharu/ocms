import { useEffect, useRef } from 'react';
import type { Asset, HashStatus } from '../../lib/assets';
import { Button } from '../ui/button';
import { Thumbnail } from './Thumbnail';

export function RecommendationsHeader({
  source,
  hashStatus,
  onBack,
}: {
  source: Asset;
  hashStatus: HashStatus | null;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (source.asset_id) heading.current?.focus();
  }, [source.asset_id]);
  return (
    <div className="recommendations-header">
      <Button variant="outline" onClick={onBack}>
        戻る
      </Button>
      <Thumbnail key={`${source.asset_id}:${source.status}`} asset={source} />
      <div>
        <h1 ref={heading} tabIndex={-1}>
          関連コンテンツ
        </h1>
        <p className="recommendation-source">{source.filename}</p>
        {hashStatus === 'pending' && <span role="status">類似解析待ち</span>}
      </div>
    </div>
  );
}
