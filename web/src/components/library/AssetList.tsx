import type { Ref } from 'react';
import {
  type Asset,
  type Kind,
  kindOf,
  kinds,
  locationOf,
  pageSize,
  type Recommendation,
  type View,
} from '../../lib/assets';
import { Button } from '../ui/button';
import { RecommendationSummary } from './RecommendationSummary';
import { Status } from './Status';
import { Thumbnail } from './Thumbnail';

export function AssetList({
  assets,
  recommendations,
  selectedId,
  view,
  kind,
  searching,
  isResult,
  uploading,
  currentPage,
  pageCount,
  resultCount,
  fileList,
  onSelect,
  onOpen,
  onReset,
  onUpload,
  onPageChange,
}: {
  assets: Asset[];
  recommendations?: Recommendation[];
  selectedId?: string;
  view: View;
  kind: Kind;
  searching: boolean;
  isResult: boolean;
  uploading: boolean;
  currentPage: number;
  pageCount: number;
  resultCount: number;
  fileList?: Ref<HTMLElement>;
  onSelect: (asset: Asset) => void;
  onOpen?: (asset: Asset) => void;
  onReset: () => void;
  onUpload: () => void;
  onPageChange: (page: number) => void;
}) {
  return (
    <section
      ref={fileList}
      className={`files files-${view}${recommendations ? ' files-recommendations' : ''}`}
      tabIndex={-1}
      aria-label="ファイル一覧"
      aria-busy={searching}
    >
      {assets.length === 0 ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">
            ▤
          </span>
          <h3>
            {searching
              ? '読み込み中…'
              : isResult
                ? '検索結果がありません'
                : kind !== 'all'
                  ? 'この種類のファイルはありません'
                  : 'ファイルはまだありません'}
          </h3>
          {!searching &&
            (isResult || kind !== 'all' ? (
              <Button variant="outline" type="button" onClick={onReset}>
                すべてのファイル
              </Button>
            ) : (
              <Button
                variant="outline"
                type="button"
                onClick={onUpload}
                disabled={uploading}
              >
                ファイルをアップロード
              </Button>
            ))}
        </div>
      ) : (
        <>
          {view === 'list' && (
            <div className="list-header" aria-hidden="true">
              <span>ファイル名</span>
              <span>状態</span>
            </div>
          )}
          <div className={`file-items view-${view}`}>
            {assets.map((a) => {
              const recommendation = recommendations?.find(
                (item) => item.asset_id === a.asset_id,
              );
              return (
                <Button
                  variant="outline"
                  type="button"
                  className={`file ${selectedId === a.asset_id ? 'active' : ''}`}
                  aria-label={a.filename}
                  aria-describedby={
                    recommendation ? `recommendation-${a.asset_id}` : undefined
                  }
                  title={a.filename}
                  aria-pressed={selectedId === a.asset_id}
                  key={a.asset_id}
                  disabled={searching}
                  onClick={() => {
                    if (selectedId === a.asset_id && onOpen) onOpen(a);
                    else onSelect(a);
                  }}
                  onDoubleClick={() => onOpen?.(a)}
                >
                  <Thumbnail
                    key={`${a.asset_id}:${a.status}:${a.page_number ?? 1}`}
                    asset={a}
                  />
                  <span
                    className={`file-info${view === 'grid' ? ' visually-hidden' : ''}`}
                  >
                    <b>{a.filename}</b>
                    {recommendation && (
                      <RecommendationSummary item={recommendation} />
                    )}
                    {view === 'list' && (
                      <>
                        <span className="file-meta">
                          {kinds.find((k) => k.id === kindOf(a))?.label}
                          {a.tags.length > 0 && (
                            <span className="file-tags">
                              {a.tags.join(' · ')}
                            </span>
                          )}
                        </span>
                        {a.snippet && (
                          <span className="snippet">{a.snippet}</span>
                        )}
                        {locationOf(a) && (
                          <span className="match-location">
                            {locationOf(a)}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                  {view === 'list' && <Status value={a.status} />}
                </Button>
              );
            })}
          </div>
        </>
      )}
      {pageCount > 1 && (
        <nav className="pagination" aria-label="ページネーション">
          <span className="count" aria-live="polite">
            {(currentPage - 1) * pageSize + 1}–
            {Math.min(currentPage * pageSize, resultCount)} / {resultCount} 件
          </span>
          <div className="pagination-controls">
            <Button
              variant="outline"
              type="button"
              disabled={searching || currentPage === 1}
              onClick={() => onPageChange(currentPage - 1)}
            >
              前へ
            </Button>
            <span aria-current="page">
              {currentPage} / {pageCount} ページ
            </span>
            <Button
              variant="outline"
              type="button"
              disabled={searching || currentPage === pageCount}
              onClick={() => onPageChange(currentPage + 1)}
            >
              次へ
            </Button>
          </div>
        </nav>
      )}
    </section>
  );
}
