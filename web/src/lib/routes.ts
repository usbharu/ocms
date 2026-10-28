import {
  type Kind,
  kinds,
  type Mode,
  type Rating,
  ratings,
  type SearchContext,
} from './assets';

export type Section =
  | 'series'
  | 'library'
  | 'tags'
  | 'characters'
  | 'favorites'
  | 'recommendations';
export type RouteState = {
  section: Section;
  context: SearchContext;
  sourceId?: string;
  assetId?: string;
  viewer: boolean;
  page: number;
  kind: Kind;
  tagView: 'list' | 'cloud' | 'graph';
  known: boolean;
};

export function parseRoute(pathname: string, search: string): RouteState {
  const params = new URLSearchParams(search);
  const detail = /^\/assets\/([^/]+)(\/view)?$/.exec(pathname);
  const sections = [
    'library',
    'series',
    'tags',
    'characters',
    'favorites',
    'recommendations',
  ];
  const series = /^\/series(?:\/(?:new|[^/]+)(?:\/(?:edit|view))?)?$/.test(
    pathname,
  );
  const candidate = series
    ? 'series'
    : detail
      ? params.get('from')
      : pathname.slice(1);
  const section = (
    candidate &&
    sections.includes(candidate) &&
    (!detail || !['tags', 'characters'].includes(candidate))
      ? candidate
      : 'library'
  ) as Section;
  const modes: Mode[] = [
    'keyword',
    'semantic',
    'hybrid',
    'perceptual',
    'exact_duplicate',
    'recommendation',
  ];
  const sourceId = params.get('source') || undefined;
  const rawMode = params.get('mode') as Mode;
  const mode =
    modes.includes(rawMode) &&
    (sourceId
      ? ['perceptual', 'exact_duplicate', 'recommendation'].includes(rawMode)
      : ['keyword', 'semantic', 'hybrid'].includes(rawMode))
      ? rawMode
      : sourceId
        ? 'recommendation'
        : 'keyword';
  const tag = params.get('tag') || undefined;
  const character = tag ? undefined : params.get('character') || undefined;
  const rawRatings = params.get('ratings');
  const selectedRatings =
    rawRatings === null
      ? undefined
      : rawRatings === 'none'
        ? []
        : ratings.some((rating) => rawRatings.split(',').includes(rating))
          ? ratings.filter((rating) => rawRatings.split(',').includes(rating))
          : undefined;
  const rawPage = params.get('page') || '1';
  const page =
    /^\d+$/.test(rawPage) &&
    Number.isSafeInteger(Number(rawPage)) &&
    Number(rawPage) > 0
      ? Number(rawPage)
      : 1;
  let assetId: string | undefined;
  try {
    assetId = detail ? decodeURIComponent(detail[1]) : undefined;
  } catch {
    /* Invalid encoded path is an unknown route. */
  }
  return {
    section,
    context: {
      mode,
      query: sourceId || tag || character ? '' : params.get('q') || '',
      tag: sourceId ? undefined : tag,
      character: sourceId ? undefined : character,
      favorites: section === 'favorites',
      personalized: section === 'recommendations' && !sourceId,
      ratings:
        selectedRatings?.length === ratings.length
          ? undefined
          : selectedRatings,
    },
    sourceId,
    assetId,
    viewer: Boolean(detail?.[2]),
    page,
    kind: kinds.find((kind) => kind.id === params.get('kind'))?.id ?? 'all',
    tagView:
      params.get('view') === 'list' || params.get('view') === 'graph'
        ? (params.get('view') as 'list' | 'graph')
        : 'cloud',
    known:
      series ||
      pathname === '/' ||
      sections.includes(pathname.slice(1)) ||
      Boolean(
        detail &&
          assetId &&
          !assetId.includes('/') &&
          assetId !== '.' &&
          assetId !== '..',
      ),
  };
}

export function collectionURL(
  section: Section,
  context: SearchContext,
  page = 1,
  kind: Kind = 'all',
) {
  const params = new URLSearchParams();
  if (context.query) params.set('q', context.query);
  if (context.mode !== 'keyword') params.set('mode', context.mode);
  if (context.tag) params.set('tag', context.tag);
  if (context.character) params.set('character', context.character);
  if (context.source) params.set('source', context.source.asset_id);
  if (kind !== 'all') params.set('kind', kind);
  if (context.ratings && context.ratings.length !== ratings.length)
    params.set(
      'ratings',
      context.ratings.length
        ? ratings.filter((r: Rating) => context.ratings?.includes(r)).join(',')
        : 'none',
    );
  if (page > 1) params.set('page', String(page));
  return `/${section}${params.size ? `?${params}` : ''}`;
}

export function assetURL(
  id: string,
  viewer: boolean,
  section: Section,
  context: SearchContext,
  page: number,
  kind: Kind,
) {
  const collection = collectionURL(section, context, page, kind);
  const params = new URLSearchParams(collection.split('?')[1]);
  if (section !== 'library') params.set('from', section);
  return `/assets/${encodeURIComponent(id)}${viewer ? '/view' : ''}${params.size ? `?${params}` : ''}`;
}
