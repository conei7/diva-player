import { useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';

/** First-visit coach mark over the top of the map; once dismissed it stays dismissed. */
export default function SoundMapGuide({ onDismiss }: { onDismiss: () => void }) {
  const t = useTranslateSourceText();
  return (
    <div
      data-testid="sound-map-guide"
      className="absolute left-1/2 top-14 z-[2] flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-card bg-yt-menu py-1.5 pl-4 pr-1.5 text-sm leading-5 text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.5)]"
    >
      <p className="m-0 min-w-0">{t('点を選ぶと曲の情報が出ます（再生はされません）')}</p>
      <Button size="sm" variant="text" onClick={onDismiss}>{t('OK')}</Button>
    </div>
  );
}
