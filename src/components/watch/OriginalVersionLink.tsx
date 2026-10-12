import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Song } from '../../types/vocadb';
import { getSongById } from '../../api/vocadb';
import { useTranslate } from '../../i18n';
import { watchPath } from '../../utils/routes';

/**
 * 「原曲: {曲名}」 for derived songs (remix, cover…), rendered inline in a meta line.
 * `prefix` is drawn before it only when there is an original to show (e.g. ' · ').
 */
export default function OriginalVersionLink({ song, prefix }: { song: Song; prefix?: string }) {
  const t = useTranslate();
  const originalId = song.songType === 'Original' || song.songType === 'Unspecified' ? undefined : song.originalVersionId;
  const [original, setOriginal] = useState<Song | null>(null);

  useEffect(() => {
    let active = true;
    setOriginal(null);
    if (!originalId || originalId === song.id) return () => { active = false; };
    getSongById(originalId)
      .then(next => { if (active) setOriginal(next); })
      .catch(() => { if (active) setOriginal(null); });
    return () => { active = false; };
  }, [originalId, song.id]);

  if (!originalId || originalId === song.id || !original) return null;
  return (
    <span className="min-w-0">
      {prefix}
      {t('originalSong')}:{' '}
      <Link
        to={watchPath(original.id)}
        className="text-yt-link no-underline hover:underline"
        onClick={event => event.stopPropagation()}
      >
        {original.name}
      </Link>
    </span>
  );
}
