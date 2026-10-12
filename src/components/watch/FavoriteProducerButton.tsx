import { useFavoriteProducerStore } from '../../stores/favoriteProducerStore';
import type { ArtistType } from '../../types/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import Button from '../ui/Button';
import Menu, { MenuItemCheckbox } from '../ui/Menu';
import { CheckIcon, ChevronDownIcon } from '../ui/icons';

export interface FavoriteProducerTarget {
  id: number;
  name: string;
  artistType?: ArtistType;
}

function normalizedType(artistType: ArtistType | undefined): 'Producer' | 'Circle' | 'Band' {
  return artistType === 'Circle' || artistType === 'Band' ? artistType : 'Producer';
}

/**
 * 「お気に入りP」 pill next to the producer name (YouTube's subscribe position).
 * Not yet a favorite: white (primary). A favorite: tonal with ✓.
 * Several producers: the pill opens a menu with one check item per producer.
 */
export default function FavoriteProducerButton({ producers }: { producers: FavoriteProducerTarget[] }) {
  const tk = useTranslate();
  const t = useTranslateSourceText();
  const favoriteProducers = useFavoriteProducerStore(state => state.producers);
  const toggleProducer = useFavoriteProducerStore(state => state.toggleProducer);
  const isFavorite = (id: number) => favoriteProducers.some(producer => producer.id === id);
  const toggle = (producer: FavoriteProducerTarget) => toggleProducer({
    id: producer.id,
    name: producer.name,
    artistType: normalizedType(producer.artistType),
  });
  const ariaFor = (producer: FavoriteProducerTarget) => (isFavorite(producer.id)
    ? t('{producer}をお気に入りPから解除', { producer: producer.name })
    : t('{producer}をお気に入りPに登録', { producer: producer.name }));
  const label = tk('watchFavoriteProducer');

  if (producers.length === 0) return null;

  if (producers.length === 1) {
    const [producer] = producers;
    const favorite = isFavorite(producer.id);
    return (
      <Button
        variant={favorite ? 'tonal' : 'primary'}
        icon={favorite ? <CheckIcon /> : undefined}
        className="watch-favorite-producer-button"
        data-testid="watch-favorite-producer-pill"
        aria-label={ariaFor(producer)}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          toggle(producer);
        }}
      >
        {label}
      </Button>
    );
  }

  const anyFavorite = producers.some(producer => isFavorite(producer.id));
  return (
    <Menu
      trigger={(
        <Button
          variant={anyFavorite ? 'tonal' : 'primary'}
          icon={anyFavorite ? <CheckIcon /> : undefined}
          trailingIcon={<ChevronDownIcon />}
          data-testid="watch-favorite-producer-pill"
        >
          {label}
        </Button>
      )}
      label={label}
      align="end"
    >
      {producers.map(producer => (
        <MenuItemCheckbox
          key={producer.id}
          checked={isFavorite(producer.id)}
          keepOpen
          className="watch-favorite-producer-button"
          aria-label={ariaFor(producer)}
          onSelect={() => toggle(producer)}
        >
          {producer.name}
        </MenuItemCheckbox>
      ))}
    </Menu>
  );
}
