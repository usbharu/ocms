import type { Ref } from 'react';
import {
  type Asset,
  type AssetChanges,
  type Job,
  locationOf,
  type Mode,
  type Rendition,
  renditionName,
} from '../../lib/assets';
import { Button } from '../ui/button';
import { AssetMetadataEditor } from './AssetMetadataEditor';
import { Status } from './Status';

export function AssetDetails({
  selected,
  renditions,
  jobs,
  searching,
  notice,
  detailTitle,
  onClose,
  onOpen,
  onSaveMetadata,
  onSearchTag,
  onSearchCharacter,
  onCompare,
  onRecommend,
  showComparisons = true,
  onReprocess,
  onDelete,
}: {
  onSearchTag: (tag: string) => void;
  onSearchCharacter: (character: string) => void;
  selected: Asset;
  renditions: Rendition[];
  jobs: Job[];
  searching: boolean;
  notice: string;
  detailTitle?: Ref<HTMLHeadingElement>;
  onClose: () => void;
  onOpen?: () => void;
  onSaveMetadata: (changes: AssetChanges) => Promise<Asset>;
  onCompare: (mode: Mode) => void;
  onRecommend?: () => void;
  showComparisons?: boolean;
  onReprocess: () => void;
  onDelete: () => void;
}) {
  const mediaURL = (a: Asset) => {
    const d = renditions.find(
      (d) =>
        d.profile_id ===
        (a.mime_type.startsWith('video/') ? 'video.mp4-v1' : 'audio.opus-v1'),
    );
    const url = `/api/v1/assets/${a.asset_id}/${d ? `renditions/${d.rendition_id}/content` : 'content'}`;
    return url + (a.start_ms !== undefined ? `#t=${a.start_ms / 1000}` : '');
  };

  const pdfPreview = renditions.find(
    (d) => d.profile_id === `pdf.page-${selected?.page_number ?? 1}-v1`,
  );
  return (
    <section
      className="details"
      aria-label="ファイル詳細"
      key={selected.asset_id}
    >
      <div className="detail-heading">
        <h2 ref={detailTitle} tabIndex={-1}>
          {selected.filename}
        </h2>
        <Button
          variant="ghost"
          type="button"
          className="quiet close-detail"
          aria-label="詳細を閉じる"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <div className="detail-meta">
        <span>{selected.mime_type.split('/')[1]?.toUpperCase()}</span>
        <Status value={selected.status} />
      </div>
      <button
        type="button"
        className="preview"
        aria-label="ファイルを閲覧"
        onClick={onOpen}
      >
        {selected.mime_type.startsWith('image/') ? (
          <img
            alt={selected.filename}
            src={`/api/v1/assets/${selected.asset_id}/${renditions.some((d) => d.profile_id === 'thumbnail-v1') ? 'preview' : 'content'}`}
          />
        ) : selected.mime_type.startsWith('video/') ? (
          <video
            key={mediaURL(selected)}
            muted
            preload="metadata"
            src={mediaURL(selected)}
          />
        ) : selected.mime_type.startsWith('audio/') ? (
          <span className="audio-preview">
            <span aria-hidden="true">♫</span>
            <span>音声を再生</span>
          </span>
        ) : selected.mime_type === 'application/pdf' && pdfPreview ? (
          <img
            alt={`PDF ${selected.page_number ?? 1}ページ目`}
            src={`/api/v1/assets/${selected.asset_id}/renditions/${pdfPreview.rendition_id}/content`}
          />
        ) : (
          <span className="muted">
            {selected.mime_type === 'application/pdf' &&
            ['stored', 'processing'].includes(selected.status)
              ? 'プレビューを生成中…'
              : 'プレビューなし'}
          </span>
        )}
      </button>
      {locationOf(selected) && (
        <p className="match-location">
          検索の一致箇所 · {locationOf(selected)}
        </p>
      )}
      <Button asChild variant="outline" className="open-original">
        <a
          href={`/api/v1/assets/${selected.asset_id}/content${selected.page_number ? `#page=${selected.page_number}` : ''}`}
          target="_blank"
          rel="noreferrer"
        >
          元ファイルを開く <span aria-hidden="true">↗</span>
        </a>
      </Button>
      <div className="comparison-section">
        <div className="comparison-actions">
          {onRecommend && (
            <Button
              variant="outline"
              disabled={searching}
              onClick={onRecommend}
            >
              関連コンテンツ
            </Button>
          )}
          {showComparisons && (
            <Button
              variant="outline"
              type="button"
              disabled={searching}
              onClick={() => onCompare('perceptual')}
            >
              類似ファイル
            </Button>
          )}
          {showComparisons && (
            <Button
              variant="outline"
              type="button"
              disabled={searching}
              onClick={() => onCompare('exact_duplicate')}
            >
              完全一致ファイル
            </Button>
          )}
        </div>
      </div>
      <AssetMetadataEditor
        key={selected.asset_id}
        asset={selected}
        onSave={onSaveMetadata}
        onSearchTag={onSearchTag}
        onSearchCharacter={onSearchCharacter}
      />
      <details className="detail-section">
        <summary>処理状況</summary>
        {jobs.length === 0 && <p className="muted">処理情報なし</p>}
        {jobs.map((j) => (
          <div className="job" key={j.job_id}>
            <div>
              <span>
                {j.job_type === 'media.process'
                  ? 'プレビュー・文字抽出'
                  : j.job_type === 'tags.generate'
                    ? '自動タグ付け'
                    : '意味検索の索引'}
              </span>
              <Status value={j.status} />
            </div>
            <small>
              試行 {j.attempts}
              {j.error_code ? ` · ${j.error_code}` : ''}
            </small>
          </div>
        ))}
        <Button variant="outline" type="button" onClick={onReprocess}>
          {selected.status === 'failed' ? '再試行' : '再処理'}
        </Button>
      </details>
      <details className="detail-section">
        <summary>
          変換ファイル <span className="count">{renditions.length}</span>
        </summary>
        {renditions.length === 0 ? (
          <p className="muted">変換ファイルなし</p>
        ) : (
          <ul className="renditions">
            {renditions.map((d) => (
              <li key={d.rendition_id}>
                <a
                  href={`/api/v1/assets/${selected.asset_id}/renditions/${d.rendition_id}/content`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {renditionName(d.profile_id)}{' '}
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </details>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="detail-footer">
        <Button
          variant="link"
          type="button"
          className="text-button danger"
          onClick={onDelete}
        >
          ファイルを削除
        </Button>
      </div>
    </section>
  );
}
