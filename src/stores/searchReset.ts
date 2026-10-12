/**
 * Lets the frame (logo, guide and bottom-nav Home) reset the search without importing searchStore,
 * which is loaded with the pages that search instead of with the initial JavaScript (DESIGN_SPEC §1-12).
 * searchStore registers its reset when it is created; a store that was never loaded has nothing to reset.
 */
let resetSearch: (() => void) | null = null;

export function registerSearchReset(reset: () => void): void {
  resetSearch = reset;
}

export function resetSearchIfLoaded(): void {
  resetSearch?.();
}
