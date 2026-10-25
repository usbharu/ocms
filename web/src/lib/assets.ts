export type Asset = {
  is_favorite?: boolean;
  asset_id: string;
  filename: string;
  mime_type: string;
  tags: string[];
  characters?: string[];
  status: string;
  snippet?: string;
  page_number?: number;
  start_ms?: number;
  end_ms?: number;
};
export type AssetChanges = {
  filename?: string;
  tags?: string[];
  characters?: string[];
};

export type Rendition = {
  rendition_id: string;
  profile_id: string;
  mime_type: string;
};
export type Job = {
  job_id: string;
  job_type: string;
  status: string;
  attempts: number;
  error_code?: string;
};
export type Me = { principal_id: string; csrf_token: string };
export type Mode =
  | 'keyword'
  | 'semantic'
  | 'hybrid'
  | 'perceptual'
  | 'exact_duplicate'
  | 'recommendation';
export type SearchContext = {
  favorites?: boolean;
  mode: Mode;
  query: string;
  tag?: string;
  character?: string;
  source?: Asset;
};
export type View = 'list' | 'grid' | 'detailed-grid';
export type Kind = 'all' | 'image' | 'video' | 'audio' | 'document';
export const statuses: Record<string, string> = {
  pending: 'アップロード待ち',
  uploading: 'アップロード中',
  stored: '解析待ち',
  processing: '解析中',
  ready: '完了',
  failed: '失敗',
  queued: '待機中',
  retry: '再試行待ち',
  running: '実行中',
  completed: '完了',
};
export const kinds: { id: Kind; label: string }[] = [
  { id: 'all', label: 'すべて' },
  { id: 'image', label: '画像' },
  { id: 'video', label: '動画' },
  { id: 'audio', label: '音声' },
  { id: 'document', label: 'PDF・その他' },
];
export const pageSize = 24;
export const allFiles: SearchContext = { mode: 'keyword', query: '' };

export function kindOf(asset: Asset): Kind {
  const type = asset.mime_type.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio'
    ? type
    : 'document';
}

export function locationOf(asset: Asset) {
  if (asset.page_number !== undefined) return `${asset.page_number} ページ`;
  if (asset.start_ms !== undefined)
    return `${Math.floor(asset.start_ms / 60000)}:${String(Math.floor(asset.start_ms / 1000) % 60).padStart(2, '0')}`;
  return '';
}

export function renditionName(profile: string) {
  if (profile === 'thumbnail-v1') return 'サムネイル';
  if (profile === 'image.webp-v1') return '画像 · WebP';
  if (profile === 'video.mp4-v1') return '動画 · MP4';
  if (profile === 'audio.opus-v1') return '音声 · Opus';
  const page = profile.match(/^pdf\.page-(\d+)-v1$/);
  return page ? `${page[1]} ページ · PNG` : profile;
}

export type HashStatus = 'pending' | 'ready' | 'unsupported';
export type Recommendation = Asset & {
  score: number;
  common_tags: string[];
  common_characters: string[];
  perceptual?: 'visual' | 'audio';
};
