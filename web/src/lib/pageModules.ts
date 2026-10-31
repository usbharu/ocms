// Share import functions between React.lazy and intent-based prefetching.
// Vite preloads the hashed chunks and their CSS; no API/media is fetched here.
export const loadTagsPage = () =>
  import('../components/tags/TagsPage').then((module) => ({
    default: module.TagsPage,
  }));

export const loadSeriesPage = () =>
  import('../components/series/SeriesPage').then((module) => ({
    default: module.SeriesPage,
  }));

export function prefetchPage(section: string) {
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (
    connection?.saveData ||
    ['slow-2g', '2g'].includes(connection?.effectiveType ?? '')
  )
    return;
  const load =
    section === 'tags' || section === 'characters'
      ? loadTagsPage
      : section === 'series'
        ? loadSeriesPage
        : undefined;
  // A speculative load failure must not interrupt the current page.
  void load?.().catch(() => {});
}
