import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { shortenUrlForDisplay, tokenizeDescriptionText } from '../../utils/descriptionText';
import { formatViewCount, serviceLabel, songTypeLabel, artistRoleLabel } from '../../utils/songMeta';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { cx } from '../ui/overlay';
import SongAlbums from '../playlist/SongAlbums';
import ViewHistoryChart from './ViewHistoryChart';
import OriginalVersionLink from './OriginalVersionLink';
import ServiceIcon from './ServiceIcon';
import { buildCreditGroups, formatCalendarDate, formatExactViewCount } from './watchFormat';
import { videoSourceLabel } from './videoLabels';

const CREDIT_CHIP =
  'inline-flex h-10 max-w-full items-center truncate rounded-chip bg-yt-tonal px-3 text-sm font-medium leading-5 text-yt-text no-underline transition-colors duration-150 hover:bg-yt-tonal-hover sm:h-8';

const SECTION_HEADING = 'text-base font-bold leading-[22px] text-yt-text';

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * 概要 (YouTube's description box). Collapsed: one meta line and three lines of text; anywhere
 * in the box expands it. Expanded: the full text, credits, albums, videos and the view-count chart.
 */
export default function Description({ song }: { song: Song }) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();

  const originalPV = song.pvs?.find(pv => pv.pvType === 'Original' && !pv.disabled);
  const description = originalPV?.description?.trim() ? originalPV.description : '';
  const descriptionTokens = description ? tokenizeDescriptionText(description) : [];
  const publishDate = formatCalendarDate(song.publishDate ?? originalPV?.publishDate, language);
  const pvList = song.pvs?.filter(pv => !pv.disabled) ?? [];
  const credits = expanded ? buildCreditGroups(song) : [];

  const formatViews = (count: number) => (expanded ? formatExactViewCount(count, language) : formatViewCount(count, language));
  const metaParts: ReactNode[] = [];
  if ((song.youtubeViews ?? 0) > 0) metaParts.push(`${serviceLabel('Youtube', language)} ${formatViews(song.youtubeViews ?? 0)}`);
  if ((song.nicoViews ?? 0) > 0) metaParts.push(`${serviceLabel('NicoNicoDouga', language)} ${formatViews(song.nicoViews ?? 0)}`);
  if (publishDate) metaParts.push(publishDate);
  if (song.songType !== 'Original' && song.songType !== 'Unspecified') metaParts.push(songTypeLabel(song.songType, language));

  const creditLabel = (role: string) => {
    if (role === 'producer') return t('ボカロP');
    if (role === 'vocalist') return tk('vocalistLabel');
    return artistRoleLabel(role, language);
  };

  const expandButton = (
    <button
      type="button"
      className={cx(
        'inline-flex cursor-pointer items-center font-medium text-yt-text outline-none focus-visible:outline-2 focus-visible:outline-yt-focus max-sm:min-h-9',
        descriptionTokens.length > 0 && 'sm:absolute sm:bottom-0 sm:right-0 sm:bg-yt-tonal-solid sm:pl-1 sm:group-hover/desc:bg-yt-tonal-solid-hover sm:before:pointer-events-none sm:before:absolute sm:before:inset-y-0 sm:before:right-full sm:before:w-10 sm:before:bg-linear-to-r sm:before:from-transparent sm:before:to-yt-tonal-solid sm:group-hover/desc:before:to-yt-tonal-solid-hover',
      )}
      aria-expanded={false}
      aria-controls={bodyId}
      aria-label={tk('descriptionExpandAria')}
      onClick={event => {
        event.stopPropagation();
        setExpanded(true);
      }}
    >
      …{t('もっと見る')}
    </button>
  );

  return (
    <section
      data-testid="watch-description"
      data-expanded={expanded ? 'true' : 'false'}
      aria-label={t('概要')}
      className={cx(
        'group/desc mt-3 min-w-0 rounded-card bg-yt-tonal-solid p-3 text-sm leading-5 text-yt-text transition-colors duration-150 max-sm:mx-3',
        !expanded && 'cursor-pointer hover:bg-yt-tonal-solid-hover',
      )}
      onClick={() => {
        if (!expanded) setExpanded(true);
      }}
    >
      {(metaParts.length > 0 || song.originalVersionId) && (
        <div className="font-medium tabular-nums">
          {metaParts.map((part, index) => (
            <span key={index}>
              {index > 0 && <span aria-hidden="true">{' · '}</span>}
              {part}
            </span>
          ))}
          <OriginalVersionLink song={song} prefix={metaParts.length > 0 ? ' · ' : undefined} />
        </div>
      )}

      <div id={bodyId} className="relative">
        {descriptionTokens.length > 0 && (
          <p className={cx('mt-1 whitespace-pre-wrap break-words', !expanded && 'line-clamp-3')}>
            {descriptionTokens.map((token, index) => token.type === 'url' ? (
              <a
                key={`url-${index}`}
                href={token.value}
                title={token.value}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-yt-link no-underline hover:underline"
                onClick={stop}
              >
                {shortenUrlForDisplay(token.value)}
              </a>
            ) : (
              <span key={`text-${index}`}>{token.value}</span>
            ))}
          </p>
        )}
        {!expanded && expandButton}
      </div>

      {expanded && (
        <div className="mt-6 space-y-6">
          {credits.length > 0 && (
            <section aria-label={t('クレジット')}>
              <h3 className={SECTION_HEADING}>{t('クレジット')}</h3>
              <div className="mt-1 space-y-3">
                {credits.map(group => (
                  <div key={group.role}>
                    <h4 className="text-xs font-normal leading-[18px] text-yt-text-secondary">{creditLabel(group.role)}</h4>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {group.people.map(person => person.href ? (
                        <Link key={person.key} to={person.href} className={CREDIT_CHIP} onClick={stop}>
                          {person.name}
                        </Link>
                      ) : (
                        <span key={person.key} className={CREDIT_CHIP}>{person.name}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <SongAlbums key={song.id} songId={song.id} />

          {pvList.length > 0 && (
            <section aria-label={tk('pvLinks')}>
              <h3 className={SECTION_HEADING}>{tk('pvLinks')}</h3>
              <ul className="mt-1">
                {pvList.map(pv => (
                  <li key={pv.id}>
                    <a
                      href={pv.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex min-h-10 min-w-0 items-center gap-3 text-yt-text no-underline hover:underline"
                      onClick={stop}
                    >
                      <ServiceIcon service={pv.service} className="text-yt-text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{pv.name || pv.url}</span>
                      <span className="shrink-0 text-xs text-yt-text-secondary">
                        {videoSourceLabel(pv, language, t)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <ViewHistoryChart songId={song.id} />

          <button
            type="button"
            className="inline-flex cursor-pointer items-center font-medium text-yt-text outline-none focus-visible:outline-2 focus-visible:outline-yt-focus max-sm:min-h-9"
            aria-expanded
            aria-controls={bodyId}
            aria-label={tk('descriptionCollapseAria')}
            onClick={event => {
              event.stopPropagation();
              setExpanded(false);
            }}
          >
            {t('一部を表示')}
          </button>
        </div>
      )}
    </section>
  );
}
