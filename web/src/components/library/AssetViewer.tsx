import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Asset, Rendition } from '../../lib/assets';
import { Button } from '../ui/button';
import { FavoriteButton } from './FavoriteButton';

const PDFViewer = lazy(() => import('./PDFViewer'));

export function AssetViewer({
  asset,
  hasPrevious,
  hasNext,
  onNavigate,
  onFavorite,
  favoriteBusy,
  onClose,
  navigationError,
}: {
  asset: Asset;
  hasPrevious: boolean;
  hasNext: boolean;
  onNavigate: (direction: number) => void;
  onFavorite?: (asset: Asset) => void;
  favoriteBusy?: boolean;
  onClose: () => void;
  navigationError: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [media, setMedia] = useState<{
    id: string;
    rendition?: Rendition;
  } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, y: 0, distance: 0, zoom: 1, multiple: false });
  const visual =
    asset.mime_type.startsWith('image/') ||
    asset.mime_type === 'application/pdf';
  const contentURL = `/api/v1/assets/${asset.asset_id}/content`;
  const mediaURL =
    media?.id === asset.asset_id && media.rendition
      ? `/api/v1/assets/${asset.asset_id}/renditions/${media.rendition.rendition_id}/content`
      : contentURL;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      const target = opener?.isConnected
        ? opener
        : (document.querySelector<HTMLElement>('.file.active') ??
          document.querySelector<HTMLElement>('.preview') ??
          document.querySelector<HTMLElement>('.files'));
      target?.focus({ preventScroll: true });
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: State belongs to the asset identity.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError('');
    pointers.current.clear();
  }, [asset.asset_id]);

  useEffect(() => {
    if (!/^(video|audio)\//.test(asset.mime_type)) return;
    const controller = new AbortController();
    fetch(`/api/v1/assets/${asset.asset_id}/renditions`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((data: { renditions: Rendition[] }) =>
        setMedia({
          id: asset.asset_id,
          rendition: data.renditions.find(
            (r) =>
              r.profile_id ===
              (asset.mime_type.startsWith('video/')
                ? 'video.mp4-v1'
                : 'audio.opus-v1'),
          ),
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setMedia({ id: asset.asset_id });
      });
    return () => controller.abort();
  }, [asset.asset_id, asset.mime_type]);

  function changeZoom(value: number) {
    const next = Math.max(1, Math.min(5, value));
    setZoom(next);
    if (next === 1) setOffset({ x: 0, y: 0 });
  }

  return (
    <dialog
      ref={dialog}
      className="asset-viewer"
      aria-label="ファイル閲覧"
      onCancel={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], video[controls], audio[controls]',
            ),
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('video, audio, input, select')
        )
          return;
        if (event.key === 'ArrowLeft' && hasPrevious) {
          event.preventDefault();
          onNavigate(-1);
        }
        if (event.key === 'ArrowRight' && hasNext) {
          event.preventDefault();
          onNavigate(1);
        }
        if (visual && ['+', '=', '-', '0'].includes(event.key)) {
          event.preventDefault();
          changeZoom(
            event.key === '0' ? 1 : zoom + (event.key === '-' ? -0.25 : 0.25),
          );
        }
      }}
    >
      <header className="viewer-header">
        <div>
          <h2>{asset.filename}</h2>
          <p>{asset.mime_type}</p>
        </div>
        <FavoriteButton
          asset={asset}
          busy={favoriteBusy}
          onToggle={onFavorite}
        />
        <Button variant="ghost" onClick={onClose} aria-label="閲覧を閉じる">
          ×
        </Button>
      </header>
      <div
        className={`viewer-stage${visual ? ' viewer-zoomable' : ''}`}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as HTMLElement).closest('button, a, audio')
          )
            return;
          // Leave the native video control strip available for seeking and volume.
          if (
            event.target instanceof HTMLVideoElement &&
            event.clientY > event.target.getBoundingClientRect().bottom - 60
          )
            return;
          const position = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, position);
          event.currentTarget.setPointerCapture(event.pointerId);
          if (pointers.current.size === 1)
            gesture.current = {
              ...position,
              distance: 0,
              zoom,
              multiple: false,
            };
          else {
            const [a, b] = [...pointers.current.values()];
            gesture.current = {
              ...gesture.current,
              distance: Math.hypot(a.x - b.x, a.y - b.y),
              zoom,
              multiple: true,
            };
          }
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          pointers.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          if (pointers.current.size > 1 && visual) {
            const [a, b] = [...pointers.current.values()];
            if (gesture.current.distance > 0)
              changeZoom(
                (gesture.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
                  gesture.current.distance,
              );
          } else if (visual && zoom > 1 && !gesture.current.multiple) {
            setOffset((current) => ({
              x: current.x + event.clientX - previous.x,
              y: current.y + event.clientY - previous.y,
            }));
          }
        }}
        onPointerUp={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          pointers.current.delete(event.pointerId);
          const dx = event.clientX - gesture.current.x;
          const dy = event.clientY - gesture.current.y;
          if (
            !gesture.current.multiple &&
            zoom === 1 &&
            Math.abs(dx) > 60 &&
            Math.abs(dx) > Math.abs(dy) * 1.5
          ) {
            if (dx < 0 && hasNext) onNavigate(1);
            if (dx > 0 && hasPrevious) onNavigate(-1);
          }
        }}
        onPointerCancel={() => pointers.current.clear()}
      >
        {error ? (
          <p role="alert">{error} 下のリンクから元ファイルを開けます。</p>
        ) : (
          <div
            className="viewer-content"
            style={
              asset.mime_type.startsWith('image/')
                ? {
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                  }
                : undefined
            }
          >
            {asset.mime_type.startsWith('image/') ? (
              <img
                key={contentURL}
                src={contentURL}
                alt={asset.filename}
                draggable={false}
                onError={() => setError('画像を表示できません。')}
              />
            ) : asset.mime_type === 'application/pdf' ? (
              <Suspense fallback={<p role="status">PDFを読み込み中…</p>}>
                <PDFViewer
                  key={asset.asset_id}
                  url={contentURL}
                  initialPage={asset.page_number ?? 1}
                  zoom={zoom}
                  offset={offset}
                />
              </Suspense>
            ) : /^(video|audio)\//.test(asset.mime_type) &&
              media?.id !== asset.asset_id ? (
              <p role="status">プレイヤーを読み込み中…</p>
            ) : asset.mime_type.startsWith('video/') ? (
              // biome-ignore lint/a11y/useMediaCaption: Uploaded media has no caption rendition contract.
              <video
                key={mediaURL}
                controls
                playsInline
                preload="metadata"
                src={`${mediaURL}${asset.start_ms !== undefined ? `#t=${asset.start_ms / 1000}` : ''}`}
                onError={() => setError('動画を再生できません。')}
              />
            ) : asset.mime_type.startsWith('audio/') ? (
              <div className="viewer-audio">
                <span aria-hidden="true">♫</span>
                {/* biome-ignore lint/a11y/useMediaCaption: Uploaded media has no caption rendition contract. */}
                <audio
                  key={mediaURL}
                  controls
                  preload="metadata"
                  src={`${mediaURL}${asset.start_ms !== undefined ? `#t=${asset.start_ms / 1000}` : ''}`}
                  onError={() => setError('音声を再生できません。')}
                />
              </div>
            ) : (
              <p>この形式はプレビューに対応していません。</p>
            )}
          </div>
        )}
      </div>
      <footer className="viewer-footer">
        {navigationError && (
          <p className="viewer-error" role="alert">
            {navigationError}
          </p>
        )}
        <div className="viewer-navigation">
          <Button
            variant="ghost"
            aria-label="前のファイル"
            disabled={!hasPrevious}
            onClick={() => onNavigate(-1)}
          >
            ‹ 前へ
          </Button>
          <Button
            variant="ghost"
            aria-label="次のファイル"
            disabled={!hasNext}
            onClick={() => onNavigate(1)}
          >
            次へ ›
          </Button>
        </div>
        {visual && (
          <div className="viewer-zoom">
            <Button
              variant="ghost"
              aria-label="縮小"
              disabled={zoom === 1}
              onClick={() => changeZoom(zoom - 0.25)}
            >
              −
            </Button>
            <Button
              variant="ghost"
              aria-label="画面に合わせる"
              onClick={() => changeZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </Button>
            <Button
              variant="ghost"
              aria-label="拡大"
              disabled={zoom === 5}
              onClick={() => changeZoom(zoom + 0.25)}
            >
              ＋
            </Button>
          </div>
        )}
        <a href={contentURL} target="_blank" rel="noreferrer">
          元ファイル ↗
        </a>
        <p className="viewer-hint">
          左右にスワイプで移動{visual ? ' · 拡大後はドラッグで移動' : ''}
        </p>
      </footer>
    </dialog>
  );
}
