import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { PageNavigation } from './PageNavigation';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href;

export default function PDFViewer({
  url,
  initialPage,
  zoom,
  offset,
}: {
  url: string;
  initialPage: number;
  zoom: number;
  offset: { x: number; y: number };
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });

  useEffect(() => {
    const task = getDocument({
      url,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
    });
    let active = true;
    task.promise
      .then((pdf) => {
        if (active) {
          setDocument(pdf);
          setPage(Math.max(1, Math.min(initialPage, pdf.numPages)));
        }
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError('PDFを読み込めません。');
        }
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url, initialPage]);

  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !canvas.current || size.width <= 1 || size.height <= 1)
      return;
    let active = true;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>
      | undefined;
    const element = canvas.current;
    setLoading(true);
    document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const fit = Math.min(
          size.width / base.width,
          size.height / base.height,
        );
        // Bound canvas memory independently from zoom and device pixel ratio.
        const density = Math.min(
          window.devicePixelRatio * zoom,
          3,
          Math.sqrt(16000000 / (base.width * base.height * fit * fit)),
        );
        const viewport = pdfPage.getViewport({ scale: fit * density });
        element.width = Math.ceil(viewport.width);
        element.height = Math.ceil(viewport.height);
        element.style.width = `${base.width * fit}px`;
        element.style.height = `${base.height * fit}px`;
        render = pdfPage.render({ canvas: element, viewport });
        await render.promise;
        if (active) setLoading(false);
      })
      .catch(() => {
        if (active) {
          setLoading(false);
          setError('PDFのページを表示できません。');
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page, size, zoom]);

  return (
    <div className="pdf-viewer">
      <div className="pdf-page" ref={container}>
        {loading && (
          <p className="pdf-message" role="status">
            PDFを読み込み中…
          </p>
        )}
        {error ? (
          <p role="alert">{error} 元ファイルを開いて確認してください。</p>
        ) : (
          <canvas
            ref={canvas}
            aria-label={`PDF ${page}ページ目`}
            role="img"
            style={{
              visibility: loading ? 'hidden' : 'visible',
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            }}
          />
        )}
      </div>
      {document && (
        <PageNavigation
          page={page}
          total={document.numPages}
          label="PDF"
          onChange={setPage}
        />
      )}
    </div>
  );
}
