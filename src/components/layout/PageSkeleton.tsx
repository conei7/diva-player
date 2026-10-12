import { useTranslateSourceText } from '../../i18n';

/**
 * Suspense fallback while a page chunk downloads (DESIGN_SPEC §6.1.5): on the page background,
 * a heading bar and three 16:9 frames. Plain #272727 blocks (no `.skeleton` class, so Home's
 * "no skeleton under a visible grid" check is never affected).
 */
export default function PageSkeleton() {
  const t = useTranslateSourceText();
  return (
    <div aria-busy="true" className="mx-auto min-h-dvh max-w-[1332px] bg-yt-bg px-6 pt-6 max-lg:px-4 max-sm:px-3">
      <span className="sr-only">{t('読み込み中…')}</span>
      <div aria-hidden="true" className="h-6 w-[200px] max-w-full rounded-badge bg-yt-tonal-solid" />
      <div aria-hidden="true" className="mt-6 grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-x-4 gap-y-10">
        {[0, 1, 2].map(index => (
          <div key={index}>
            <div className="aspect-video w-full rounded-card bg-yt-tonal-solid" />
            <div className="mt-3 h-4 w-11/12 rounded-badge bg-yt-tonal-solid" />
            <div className="mt-2 h-4 w-2/3 rounded-badge bg-yt-tonal-solid" />
          </div>
        ))}
      </div>
    </div>
  );
}
