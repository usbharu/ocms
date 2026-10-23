import { HttpResponse, http } from 'msw';
import type { Asset, Job, Rendition } from '../lib/assets';

// Synthetic examples only; never use private media or authenticated API responses.
export const assets: Asset[] = [
  {
    asset_id: 'story-image',
    filename: '山の風景.png',
    mime_type: 'image/png',
    tags: ['旅行', '風景'],
    status: 'ready',
  },
  {
    asset_id: 'story-video',
    filename: '散歩の記録.mp4',
    mime_type: 'video/mp4',
    tags: ['旅行'],
    status: 'processing',
    snippet: '公園を歩いた記録',
    start_ms: 65000,
    end_ms: 70000,
  },
  {
    asset_id: 'story-audio',
    filename: 'インタビュー.ogg',
    mime_type: 'audio/ogg',
    tags: [],
    status: 'stored',
  },
  {
    asset_id: 'story-pdf',
    filename: '展示会ガイド.pdf',
    mime_type: 'application/pdf',
    tags: ['資料'],
    status: 'failed',
    page_number: 2,
    snippet: '展示会の開催案内',
  },
];
export const renditions: Rendition[] = [
  {
    rendition_id: 'thumbnail',
    profile_id: 'thumbnail-v1',
    mime_type: 'image/png',
  },
  {
    rendition_id: 'page-2',
    profile_id: 'pdf.page-2-v1',
    mime_type: 'image/png',
  },
];
export const jobs: Job[] = [
  {
    job_id: 'story-job',
    job_type: 'media.process',
    status: 'completed',
    attempts: 1,
  },
  {
    job_id: 'story-embedding',
    job_type: 'embedding.generate',
    status: 'retry',
    attempts: 2,
    error_code: 'runtime_unavailable',
  },
];
const preview =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#dcfce7"/><circle cx="490" cy="90" r="40" fill="#f6d87a"/><path d="M0 400 210 90 430 400M300 400 490 180 640 400" fill="#527d67"/></svg>';
export const mediaHandlers = [
  http.get(
    '/api/v1/assets/:id/preview',
    () =>
      new HttpResponse(preview, {
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
  ),
  http.get('/api/v1/assets/:id/content', ({ params }) =>
    params.id === 'story-audio' || params.id === 'story-video'
      ? new HttpResponse(null, { status: 204 })
      : new HttpResponse(preview, {
          headers: { 'Content-Type': 'image/svg+xml' },
        }),
  ),
  http.get(
    '/api/v1/assets/:id/renditions/:rendition/content',
    () =>
      new HttpResponse(preview, {
        headers: { 'Content-Type': 'image/svg+xml' },
      }),
  ),
  http.all('/api/*', () => HttpResponse.error()),
];
