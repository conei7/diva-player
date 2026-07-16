import { useFavoriteProducerStore } from '../../stores/favoriteProducerStore';
import type { ArtistType } from '../../types/vocadb';

interface FavoriteProducerButtonProps {
  id: number;
  name: string;
  artistType?: ArtistType;
}

export default function FavoriteProducerButton({ id, name, artistType = 'Producer' }: FavoriteProducerButtonProps) {
  const isFavorite = useFavoriteProducerStore(state => state.producers.some(producer => producer.id === id));
  const toggleProducer = useFavoriteProducerStore(state => state.toggleProducer);
  const normalizedType = artistType === 'Circle' || artistType === 'Band' ? artistType : 'Producer';

  return (
    <button
      type="button"
      className="rounded-full px-2 py-1 text-[11px] transition-colors"
      style={{
        background: isFavorite ? 'rgba(250, 204, 21, 0.16)' : 'var(--color-surface)',
        color: isFavorite ? '#facc15' : 'var(--color-text-muted)',
        border: '1px solid var(--color-border)',
      }}
      aria-pressed={isFavorite}
      aria-label={isFavorite ? `${name}をお気に入りPから解除` : `${name}をお気に入りPに登録`}
      title={isFavorite ? 'お気に入りPから解除' : 'お気に入りPに登録'}
      onClick={() => toggleProducer({ id, name, artistType: normalizedType })}
    >
      {isFavorite ? '★ お気に入りP' : '☆ お気に入りP'}
    </button>
  );
}
