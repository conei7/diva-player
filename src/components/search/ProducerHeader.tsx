import { useId } from 'react';
import { useNavigate } from 'react-router';
import type { ArtistType, Song } from '../../types/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { useFavoriteProducerStore } from '../../stores/favoriteProducerStore';
import type { ResolvedSearchArtist } from '../../stores/searchStore';
import { artistRoleLabel, artistTypeLabel, formatCount } from '../../utils/songMeta';
import { artistPath } from '../../utils/routes';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import Button from '../ui/Button';
import { RemovableChip } from '../ui/Chip';
import { CheckIcon } from '../ui/icons';

const FAVORITE_TYPES = new Set<string>(['Producer', 'Circle', 'Band']);

/** The artist type from the header data, or from the credits of the loaded songs. */
function resolveArtistType(artist: ResolvedSearchArtist, songs: readonly Song[]): ArtistType | undefined {
  if (artist.artistType) return artist.artistType;
  for (const song of songs) {
    const credit = song.artists?.find(item => item.artist?.id === artist.id);
    if (credit?.artist?.artistType) return credit.artist.artistType;
  }
  return undefined;
}

interface ProducerHeaderProps {
  artist: ResolvedSearchArtist;
  /** Credit role from `?artistRole=` (shown as a removable chip). */
  role?: string | null;
  songCount: number;
  loading: boolean;
  songs: readonly Song[];
}

/**
 * Header of a producer's (or another artist's) song list: name, 「ボカロP · 61曲」 and the
 * お気に入りP pill. It has no /watch link on purpose (the first result link must be the first song).
 */
export default function ProducerHeader({ artist, role, songCount, loading, songs }: ProducerHeaderProps) {
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const titleId = useId();
  const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const isFavorite = useFavoriteProducerStore(state => state.producers.some(producer => producer.id === artist.id));
  const toggleProducer = useFavoriteProducerStore(state => state.toggleProducer);
  const artistType = resolveArtistType(artist, songs);
  const canFavorite = artistType ? FAVORITE_TYPES.has(artistType) : !role;
  const meta = [
    artistType ? artistTypeLabel(artistType, language) : null,
    loading ? null : formatCount(songCount, 'song', language),
  ].filter(Boolean).join(' · ');

  // The same pill as on the song page and the お気に入りP page (“Favorite producer”, singular).
  const favoriteLabel = tk('watchFavoriteProducer');

  const toggleFavorite = () => {
    const favoriteType = artistType === 'Circle' || artistType === 'Band' ? artistType : 'Producer';
    toggleProducer({ id: artist.id, name: artist.name, artistType: favoriteType });
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-wrap items-center gap-x-4 gap-y-4 border-b border-yt-divider py-4 sm:flex-nowrap sm:gap-x-6 sm:py-6">
      <div className="min-w-0 flex-1">
        <h1 id={titleId} className="m-0 break-words text-xl leading-7 font-bold text-yt-text">{artist.name}</h1>
        {meta && <p className="m-0 mt-1 text-xs leading-[18px] text-yt-text-secondary tabular-nums">{meta}</p>}
        {role && (
          <div className="mt-3 flex">
            <RemovableChip
              label={artistRoleLabel(role, language)}
              onRemove={() => navigate(artistPath({ id: artist.id, name: artist.name }))}
            />
          </div>
        )}
        {canFavorite && !isMobile && (
          <div className="mt-4">
            <FavoriteButton isFavorite={isFavorite} name={artist.name} onToggle={toggleFavorite} label={favoriteLabel} />
          </div>
        )}
      </div>
      {canFavorite && isMobile && (
        <div className="w-full">
          <FavoriteButton isFavorite={isFavorite} name={artist.name} onToggle={toggleFavorite} label={favoriteLabel} fullWidth />
        </div>
      )}
    </section>
  );
}

function FavoriteButton({ isFavorite, name, onToggle, label, fullWidth = false }: {
  isFavorite: boolean;
  name: string;
  onToggle: () => void;
  label: string;
  fullWidth?: boolean;
}) {
  const t = useTranslateSourceText();
  return (
    <Button
      variant={isFavorite ? 'tonal' : 'primary'}
      icon={isFavorite ? <CheckIcon /> : undefined}
      fullWidth={fullWidth}
      size={fullWidth ? 'lg' : 'md'}
      aria-pressed={isFavorite}
      aria-label={isFavorite
        ? t('{producer}をお気に入りPから解除', { producer: name })
        : t('{producer}をお気に入りPに登録', { producer: name })}
      onClick={onToggle}
    >
      {label}
    </Button>
  );
}
