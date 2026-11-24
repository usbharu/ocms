import { useState } from 'react';
import { type Asset, kindOf } from '../../lib/assets';

export function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const kind = kindOf(asset);
  const isPDF = asset.mime_type === 'application/pdf';
  const hasPreview =
    Boolean(asset.cover_asset_id) ||
    kind === 'image' ||
    kind === 'video' ||
    isPDF;
  const query = new URLSearchParams();
  if (isPDF) query.set('thumbnail', '1');
  if (asset.page_number !== undefined)
    query.set('page', String(asset.page_number));
  const url = `/api/v1/assets/${asset.cover_asset_id || asset.asset_id}/preview${query.size ? `?${query}` : ''}`;
  return (
    <span className="thumbnail" aria-hidden="true">
      {hasPreview && !failed ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="thumbnail-placeholder">
          {kind === 'audio'
            ? '音声'
            : ['pending', 'stored', 'processing'].includes(asset.status)
              ? '準備中'
              : 'プレビューなし'}
        </span>
      )}
      {kind === 'video' && (
        <span className="thumbnail-play">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
      )}
      {isPDF && <span className="thumbnail-badge">PDF</span>}
    </span>
  );
}
