import { useState } from 'react';
import { type Asset, kindOf } from '../../lib/assets';

export function Thumbnail({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  const kind = kindOf(asset);
  const hasPreview =
    kind === 'image' ||
    kind === 'video' ||
    asset.mime_type === 'application/pdf';
  const query = new URLSearchParams();
  if (asset.mime_type === 'application/pdf') query.set('thumbnail', '1');
  if (asset.page_number !== undefined)
    query.set('page', String(asset.page_number));
  const url = `/api/v1/assets/${asset.asset_id}/preview${query.size ? `?${query}` : ''}`;
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
    </span>
  );
}
