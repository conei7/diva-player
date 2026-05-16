"""
05_build_hybrid_and_markov.py
==============================
メタデータベクトルと音響ベクトルを結合したハイブリッドベクトルを生成し、
マルコフ連鎖用の状態クラスタリングを行う。

【アーキテクチャ方針】
- データ層の分離:
  ① 音響データ (1024次元): audio コレクション → songs_v2 の named vector "audio"
  ② メタデータ (924次元):  metadata コレクション → songs_v2 の named vector "meta"
  ③ ユーザー思考データ: DBのみ管理、Qdrantベクトルには混ぜない
- songs_v2 コレクションに Named Vectors として audio/meta を格納
- ハイブリッドベクトルはマルコフチェーン用のみ引き続き生成

手順:
  1. Qdrant からメタデータ・音響ベクトルを取得
  2. songs_v2 Named Vectors コレクションを作成/更新
  3. 加重結合してハイブリッドベクトルを生成 → song_hybrid コレクションに格納
  4. K-means でクラスタリング → PostgreSQL に遷移確率行列を保存

実行例:
  python 05_build_hybrid_and_markov.py
"""
import time
import numpy as np
from tqdm import tqdm
from sklearn.cluster import MiniBatchKMeans
from sklearn.preprocessing import normalize as sk_normalize
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct, OptimizersConfigDiff,
    NamedVector, NamedSparseVector, VectorsConfig,
)
from utils.db import (
    get_conn, QDRANT_URL, QDRANT_GRPC_PORT,
    QDRANT_COLLECTION_META, QDRANT_COLLECTION_AUDIO,
    QDRANT_COLLECTION_HYBRID, QDRANT_COLLECTION_NAMED,
)
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
            if isinstance(pt.vector, dict):
                # Named Vectors コレクションの場合は最初のベクトルを取得
                v = next(iter(pt.vector.values()))
            else:
                v = pt.vector
            vectors[pt.id] = np.array(v, dtype=np.float32)
        if offset is None:
            break
    return vectors


def _upsert_with_retry(qdrant_factory, collection: str, batch: list, max_retries: int = 6) -> QdrantClient:
    """接続エラー時に指数バックオフ+クライアント再接続でリトライする upsert ラッパー"""
    client = qdrant_factory()
    for attempt in range(max_retries):
        try:
            client.upsert(collection, batch)
            return client
        except Exception as e:
            if attempt < max_retries - 1:
                wait = 5 * (2 ** attempt)  # 5s, 10s, 20s, 40s, 80s
                print(f'\n[RETRY {attempt+1}/{max_retries}] upsert error: {e}. Waiting {wait}s ...')
                time.sleep(wait)
                client = qdrant_factory()  # 再接続
            else:
                raise
    return client


def upsert_named_vectors(
    qdrant_factory,
    meta_vecs: dict[int, np.ndarray],
    audio_vecs: dict[int, np.ndarray],
    meta_dim: int,
    audio_dim: int,
    batch_size: int = 100,
) -> None:
    """
    songs_v2 Named Vectors コレクションに audio/meta を upsert する。
    ① Named Vectors コレクションを作成/確認
    ② 全楽曲（meta ベクトルがある全曲）を upsert
       - audio がない曲は zero-vector でパディング
    """
    client = qdrant_factory()
    existing = [c.name for c in client.get_collections().collections]
    if QDRANT_COLLECTION_NAMED not in existing:
        client.create_collection(
            collection_name=QDRANT_COLLECTION_NAMED,
            vectors_config={
                'audio': VectorParams(size=audio_dim, distance=Distance.COSINE),
                'meta':  VectorParams(size=meta_dim,  distance=Distance.COSINE),
            },
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Named Vectors collection: {QDRANT_COLLECTION_NAMED}')
    else:
        print(f'Named Vectors collection already exists: {QDRANT_COLLECTION_NAMED}')

    all_ids = set(audio_vecs.keys())  # audio がある曲のみ（Named Vector 検索が意味を持つ曲）
    if not all_ids:
        print('No audio vectors available. Skipping Named Vectors upsert.')
        return
    zero_audio = np.zeros(audio_dim, dtype=np.float32)
    zero_meta  = np.zeros(meta_dim,  dtype=np.float32)

    batch: list[PointStruct] = []
    for sid in tqdm(all_ids, desc='Upserting Named Vectors', unit='song'):
        audio_v = audio_vecs.get(sid, zero_audio)
        meta_v  = meta_vecs.get(sid,  zero_meta)
        batch.append(PointStruct(
            id=sid,
            vector={
                'audio': audio_v.tolist(),
                'meta':  meta_v.tolist(),
            },
            payload={'song_id': sid},
        ))
        if len(batch) >= batch_size:
            client = _upsert_with_retry(qdrant_factory, QDRANT_COLLECTION_NAMED, batch)
            batch.clear()
    if batch:
        _upsert_with_retry(qdrant_factory, QDRANT_COLLECTION_NAMED, batch)
    print(f'Named Vectors upsert complete: {len(all_ids)} songs → {QDRANT_COLLECTION_NAMED}')


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


def _make_qdrant_client() -> QdrantClient:
    return QdrantClient(host='localhost', grpc_port=QDRANT_GRPC_PORT, prefer_grpc=True, timeout=120)


def main():
    conn   = get_conn()
    qdrant = _make_qdrant_client()

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

    # Named Vectors コレクション (songs_v2) に audio/meta を個別保存
    meta_dim  = next(iter(meta_vecs.values())).shape[0]  if meta_vecs  else 924
    audio_dim = next(iter(audio_vecs.values())).shape[0] if audio_vecs else 1024
    print(f'\nBuilding Named Vectors collection (songs_v2) ...')
    upsert_named_vectors(_make_qdrant_client, meta_vecs, audio_vecs, meta_dim, audio_dim)
    print()

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
