import { Link } from 'react-router-dom';
import { useFavoriteProducerStore } from '../stores/favoriteProducerStore';

export default function FavoriteProducersPage() {
  const producers = useFavoriteProducerStore(state => state.producers);
  const removeProducer = useFavoriteProducerStore(state => state.removeProducer);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>お気に入りP</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          登録したPの曲をすぐに検索できます。登録情報はこのブラウザに保存されます。
        </p>
      </div>

      {producers.length === 0 ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>お気に入りPはまだありません。</p>
          <p className="mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>曲の詳細画面で「お気に入りP」を押すと登録できます。</p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {producers.map(producer => (
            <li key={producer.id} className="flex items-center gap-3 rounded-2xl p-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full" style={{ background: 'rgba(250, 204, 21, 0.14)', color: '#facc15' }}>★</div>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/?artistId=${producer.id}&artistName=${encodeURIComponent(producer.name)}`}
                  className="block truncate text-sm font-semibold hover:underline"
                  style={{ color: 'var(--color-text-primary)' }}
                >
                  {producer.name}
                </Link>
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{producer.artistType}</span>
              </div>
              <button
                type="button"
                className="btn-ghost rounded-lg px-2 py-1 text-xs"
                aria-label={`${producer.name}をお気に入りPから解除`}
                onClick={() => removeProducer(producer.id)}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
