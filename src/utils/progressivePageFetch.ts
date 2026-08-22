export interface ProgressivePageResult<T> {
  pages: T[];
  nextPage: number;
}

/**
 * Fetch the first source page immediately and only continue while the caller's
 * post-filtered candidate set is still too small. This keeps the decision
 * policy with the recommendation surface while sharing the bounded sequencing
 * contract.
 */
export async function fetchProgressivePages<T>({
  startPage,
  maxPages,
  fetchPage,
  needsMore,
}: {
  startPage: number;
  maxPages: number;
  fetchPage: (page: number) => Promise<T>;
  needsMore: (pages: T[]) => boolean;
}): Promise<ProgressivePageResult<T>> {
  const pages: T[] = [];
  const pageLimit = Math.max(1, Math.floor(maxPages));

  while (pages.length < pageLimit) {
    pages.push(await fetchPage(startPage + pages.length));
    if (!needsMore(pages)) break;
  }

  return {
    pages,
    nextPage: startPage + pages.length,
  };
}
