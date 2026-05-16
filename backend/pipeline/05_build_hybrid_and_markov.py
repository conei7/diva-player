"""
05_build_hybrid_and_markov.py
==============================
メタデータベクトルと音響ベクトルを結合したハイブリッドベクトルを生成し、
マルコフ連鎖用の状態クラスタリングを行う。

手順:
  1. Qdrant からメタデータ・音響ベクトルを取得
  2. 加重結合してハイブリッドベクトルを生成 → Qdrant に格納
  3. K-means でクラスタリング → PostgreSQL に遷移確率行列を保存

実行例:
  python 05_build_hybrid_and_markov.py
"""
import numpy as np
from tqdm import tqdm
from sklearn.cluster import MiniBatchKMeans
from sklearn.preprocessing import normalize as sk_normalize
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, OptimizersConfigDiff, Filter, FieldCondition, MatchAny
from utils.db import get_conn, QDRANT_URL, QDRANT_COLLECTION_META, QDRANT_COLLECTION_AUDIO, QDRANT_COLLECTION_HYBRID
import psycopg2.extras

# ハイパーパラメータ
ALPHA          = 0.6   # メタデータの重み
BETA           = 0.4   # 音響の重み
N_CLUSTERS     = 64    # マルコフ連鎖の状態数
MARKOV_SMOOTH  = 1.0   # Laplace スムージング定数
PAGE_SIZE      = 1000  # Qdrant スクロールページサイズ


def fetch_all_vectors(qdrant: QdrantClient, collection: str, dim: int) -> dict[int, np.ndarray]:
    """コレクションの全ベクトルを取得して {id: vector} 辞書で返す"""
    vectors: dict[int, np.ndarray] = {}
    offset = None
    while True:
        result, offset = qdrant.scroll(
            collection_name=collection,
            with_vectors=True,
            limit=PAGE_SIZE,
            offset=offset,
        )
        for pt in result:
            vectors[pt.id] = np.array(pt.vector, dtype=np.float32)
        if offset is None:
            break
    return vectors


def build_hybrid_vectors(
    meta_vecs: dict[int, np.ndarray],
    audio_vecs: dict[int, np.ndarray],
    alpha: float,
    beta: float,
) -> dict[int, np.ndarray]:
    """メタデータ + 音響を結合したハイブリッドベクトルを返す"""
    common_ids = set(meta_vecs.keys()) & set(audio_vecs.keys())
    meta_only  = set(meta_vecs.keys()) - common_ids
    hybrid: dict[int, np.ndarray] = {}

    for sid in common_ids:
        m = meta_vecs[sid]
        a = audio_vecs[sid]
        # 次元が違う場合は連結してL2正規化
        v = np.concatenate([alpha * m, beta * a])
        norm = np.linalg.norm(v)
        hybrid[sid] = v / norm if norm > 0 else v

    # 音響がない楽曲はメタデータのみ使用 (ゼロパディング)
    audio_dim = next(iter(audio_vecs.values())).shape[0] if audio_vecs else 0
    for sid in meta_only:
        m = meta_vecs[sid]
        pad = np.zeros(audio_dim, dtype=np.float32)
        v = np.concatenate([alpha * m, beta * pad])
        norm = np.linalg.norm(v)
        hybrid[sid] = v / norm if norm > 0 else v

    return hybrid


def cluster_and_build_markov(
    hybrid_vecs: dict[int, np.ndarray],
    conn,
    n_clusters: int,
) -> dict[int, int]:
    """K-meansクラスタリング → PostgreSQL に遷移確率行列を保存"""
    ids    = list(hybrid_vecs.keys())
    matrix = np.stack([hybrid_vecs[i] for i in ids], axis=0)

    print(f'K-means clustering: n_clusters={n_clusters}, n_songs={len(ids)} ...')
    kmeans = MiniBatchKMeans(n_clusters=n_clusters, random_state=42, n_init=5, max_iter=200)
    labels = kmeans.fit_predict(matrix)
    song_cluster = {sid: int(labels[i]) for i, sid in enumerate(ids)}

    # DB に書き込み
    with conn.cursor() as cur:
        rows = [(sid, cluster) for sid, cluster in song_cluster.items()]
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO song_features (song_id, state_cluster)
            VALUES %s
            ON CONFLICT (song_id) DO UPDATE SET state_cluster = EXCLUDED.state_cluster
            """,
            rows, page_size=1000,
        )
    conn.commit()

    # 遷移確率行列を計算 (連続再生の順序から推定)
    # 簡易法: クラスタ間距離から遷移確率を生成 (実際の再生ログなしで初期化)
    centroids = kmeans.cluster_centers_  # (n_clusters, dim)
    # コサイン類似度行列
    norms = np.linalg.norm(centroids, axis=1, keepdims=True)
    centroids_norm = centroids / np.where(norms > 0, norms, 1)
    sim_matrix = centroids_norm @ centroids_norm.T  # (K, K)
    np.fill_diagonal(sim_matrix, -1.0)   # 自己遷移を除外

    # softmax で確率に変換
    exp_sim = np.exp(sim_matrix * 5)     # 温度パラメータ
    np.fill_diagonal(exp_sim, 0.0)
    prob_matrix = exp_sim / exp_sim.sum(axis=1, keepdims=True)

    # DBに書き込み
    transition_rows = []
    for from_state in range(n_clusters):
        for to_state in range(n_clusters):
            if from_state != to_state:
                transition_rows.append((from_state, to_state, float(prob_matrix[from_state, to_state])))

    with conn.cursor() as cur:
        cur.execute("TRUNCATE markov_transitions")
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO markov_transitions (from_state, to_state, probability) VALUES %s",
            transition_rows, page_size=1000,
        )
    conn.commit()
    print(f'Markov transition matrix saved ({n_clusters}x{n_clusters}).')
    return song_cluster


def main():
    conn   = get_conn()
    qdrant = QdrantClient(url=QDRANT_URL)

    print('Fetching metadata vectors from Qdrant ...')
    meta_vecs  = fetch_all_vectors(qdrant, QDRANT_COLLECTION_META, 0)
    print(f'  Metadata vectors: {len(meta_vecs)}')

    print('Fetching audio vectors from Qdrant ...')
    audio_vecs = fetch_all_vectors(qdrant, QDRANT_COLLECTION_AUDIO, 0)
    print(f'  Audio vectors: {len(audio_vecs)}')

    # 音声カバレッジを表示（閾値によるスキップは行わず、常にハイブリッドモードで処理）
    audio_coverage = len(audio_vecs) / max(len(meta_vecs), 1)
    print(f'  Audio coverage {audio_coverage:.1%} → hybrid mode (audio data will be embedded)')

    print('Building hybrid vectors ...')
    hybrid_vecs = build_hybrid_vectors(meta_vecs, audio_vecs, ALPHA, BETA)
    print(f'  Hybrid vectors: {len(hybrid_vecs)}')

    if not hybrid_vecs:
        print('No hybrid vectors to process. Run 03 and 04 first.')
        return

    sample_dim = next(iter(hybrid_vecs.values())).shape[0]
    print(f'  Hybrid vector dimension: {sample_dim}')

    # Qdrant ハイブリッドコレクション（次元が変わる場合は再作成）
    existing = [c.name for c in qdrant.get_collections().collections]
    if QDRANT_COLLECTION_HYBRID in existing:
        existing_info = qdrant.get_collection(QDRANT_COLLECTION_HYBRID)
        existing_dim = existing_info.config.params.vectors.size
        if existing_dim != sample_dim:
            print(f'  Dimension changed ({existing_dim} → {sample_dim}). Recreating collection ...')
            qdrant.delete_collection(QDRANT_COLLECTION_HYBRID)
            existing = []  # force create below
    if QDRANT_COLLECTION_HYBRID not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_HYBRID,
            vectors_config=VectorParams(size=sample_dim, distance=Distance.COSINE),
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Qdrant collection: {QDRANT_COLLECTION_HYBRID}')

    print('Upserting hybrid vectors to Qdrant ...')
    batch: list[PointStruct] = []
    for sid, vec in tqdm(hybrid_vecs.items(), unit='song'):
        batch.append(PointStruct(id=sid, vector=vec.tolist(), payload={'song_id': sid}))
        if len(batch) >= 500:
            qdrant.upsert(QDRANT_COLLECTION_HYBRID, batch)
            batch.clear()
    if batch:
        qdrant.upsert(QDRANT_COLLECTION_HYBRID, batch)

    print('Building Markov chain clusters ...')
    cluster_and_build_markov(hybrid_vecs, conn, N_CLUSTERS)

    print('Done.')
    conn.close()


if __name__ == '__main__':
    main()
