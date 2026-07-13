import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Song } from '../../types/vocadb';
import { getSongById } from '../../api/vocadb';

export default function OriginalVersionLink({ song }: { song: Song }) {
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
    <div className="mt-3 rounded-xl px-3 py-2" style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>原曲</span>
      <Link to={`/watch?v=${original.id}`} className="block mt-0.5 text-sm font-medium hover:underline truncate" title={original.name}>
        {original.name}
      </Link>
    </div>
  );
}
