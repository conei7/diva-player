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
      className="watch-favorite-producer-button inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[15px] leading-none transition-colors sm:h-7 sm:w-7 sm:text-sm"
      style={{
        color: isFavorite ? '#facc15' : 'var(--color-text-muted)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
      }}
      aria-pressed={isFavorite}
      aria-label={isFavorite ? `${name}をお気に入りPから解除` : `${name}をお気に入りPに登録`}
      title={isFavorite ? 'お気に入りPから解除' : 'お気に入りPに登録'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleProducer({ id, name, artistType: normalizedType });
      }}
    >
      {isFavorite ? '★' : '☆'}
    </button>
  );
}
