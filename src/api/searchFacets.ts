const RECOMMENDER_API = import.meta.env.VITE_RECOMMENDER_API || '/backend-api';

export interface SearchTagFacet {
  id: number;
  name: string;
  category?: string;
  songCount: number;
}

export async function searchTagFacets(query: string, signal?: AbortSignal): Promise<SearchTagFacet[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const response = await fetch(
    `${RECOMMENDER_API}/api/search/tags?query=${encodeURIComponent(normalized)}&maxResults=12`,
    { signal },
  );
  if (!response.ok) return [];
  const data = await response.json() as { items?: SearchTagFacet[] };
  return data.items ?? [];
}
