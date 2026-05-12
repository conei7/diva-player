"""
03_extract_metadata_features.py
================================
楽曲のメタデータからベクトル特徴量を計算し Qdrant に格納する。

特徴量の内訳:
  - プロデューサー one-hot (上位 N_PRODUCER 件 + その他)
  - ボーカリスト / 合成音声種別 one-hot
  - タグ TF-IDF (階層タグの親もカウント)
  - 曲長・楽曲タイプ・公開年などのスカラー値

実行例:
  python 03_extract_metadata_features.py
"""
import math
import numpy as np
from tqdm import tqdm
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct, OptimizersConfigDiff
)
from utils.db import get_conn, QDRANT_URL, QDRANT_COLLECTION_META

# ---- ハイパーパラメータ -------------------------------------------
N_PRODUCER  = 500    # 頻出プロデューサー上位N件
N_VOCALIST  = 100    # 頻出ボーカリスト上位N件
N_TAG       = 300    # IDF上位Nタグを特徴量に使用
BATCH_SIZE  = 2000

# ボーカリストタイプ (順序固定)
VOCALIST_TYPES = ['Vocaloid','UTAU','CeVIO','SynthesizerV','NEUTRINO','VoiSona','Voiceroid','OtherVoiceSynthesizer','OtherVocalist','Unknown']
SONG_TYPES     = ['Original','Cover','Remix','Remaster','Mashup','MusicPV','DramaPV','Other','Unspecified']


# ---- ユーティリティ -----------------------------------------------

def get_tag_ancestors(tag_id: int, parent_map: dict[int,int], cache: dict) -> set[int]:
    """タグの全祖先IDセットを返す（キャッシュ付き）"""
    if tag_id in cache:
        return cache[tag_id]
    result = {tag_id}
    p = parent_map.get(tag_id)
    while p and p not in result:
        result.add(p)
        p = parent_map.get(p)
    cache[tag_id] = result
    return result


def compute_idf(conn) -> tuple[dict[int,float], dict[int,int]]:
    """全楽曲数 N とタグ文書頻度 df から IDF を計算"""
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) as n FROM songs")
        N = cur.fetchone()['n']
        cur.execute("""
            SELECT tag_id, COUNT(DISTINCT song_id) as df
            FROM song_tags GROUP BY tag_id
        """)
        rows = cur.fetchall()
    idf: dict[int, float] = {}
    for row in rows:
        df = max(row['df'], 1)
        idf[row['tag_id']] = math.log((N + 1) / (df + 1)) + 1.0  # Smooth IDF
    return idf, N


def build_tag_parent_map(conn) -> dict[int,int]:
    with conn.cursor() as cur:
        cur.execute("SELECT id, parent_id FROM tags WHERE parent_id IS NOT NULL")
        return {row['id']: row['parent_id'] for row in cur.fetchall()}


def select_top_tags(idf: dict[int,float], n: int) -> list[int]:
    """IDF降順で上位 n タグを選択"""
    return [tid for tid, _ in sorted(idf.items(), key=lambda x: -x[1])[:n]]


def select_top_producers(conn, n: int) -> list[int]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT artist_id, COUNT(*) AS cnt
            FROM song_artists WHERE is_producer = TRUE
            GROUP BY artist_id ORDER BY cnt DESC LIMIT %s
        """, (n,))
        return [row['artist_id'] for row in cur.fetchall()]


def select_top_vocalists(conn, n: int) -> list[int]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT artist_id, COUNT(*) AS cnt
            FROM song_artists WHERE is_vocalist = TRUE
            GROUP BY artist_id ORDER BY cnt DESC LIMIT %s
        """, (n,))
        return [row['artist_id'] for row in cur.fetchall()]


def normalize(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    return v / norm if norm > 0 else v


# ---- メイン -------------------------------------------------------

def main():
    conn = get_conn()
    qdrant = QdrantClient(url=QDRANT_URL)

    print('Computing IDF ...')
    idf, N = compute_idf(conn)
    parent_map = build_tag_parent_map(conn)
    ancestor_cache: dict[int, set[int]] = {}

    top_tags      = select_top_tags(idf, N_TAG)
    top_producers = select_top_producers(conn, N_PRODUCER)
    top_vocalists = select_top_vocalists(conn, N_VOCALIST)

    tag_idx      = {tid: i for i, tid in enumerate(top_tags)}
    producer_idx = {aid: i for i, aid in enumerate(top_producers)}
    vocalist_idx = {aid: i for i, aid in enumerate(top_vocalists)}

    DIM = N_TAG + N_PRODUCER + 1 + N_VOCALIST + 1 + len(VOCALIST_TYPES) + len(SONG_TYPES) + 3
    print(f'Feature vector dimension: {DIM}')

    # Qdrantコレクション作成（存在しない場合）
    existing = [c.name for c in qdrant.get_collections().collections]
    if QDRANT_COLLECTION_META not in existing:
        qdrant.create_collection(
            collection_name=QDRANT_COLLECTION_META,
            vectors_config=VectorParams(size=DIM, distance=Distance.COSINE),
            optimizers_config=OptimizersConfigDiff(indexing_threshold=10000),
        )
        print(f'Created Qdrant collection: {QDRANT_COLLECTION_META}')

    # 楽曲IDを取得
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM songs ORDER BY id")
        song_ids = [row['id'] for row in cur.fetchall()]

    print(f'Processing {len(song_ids)} songs ...')
    points = []

    for song_id in tqdm(song_ids, unit='song'):
        with conn.cursor() as cur:
            cur.execute("""
                SELECT s.song_type, s.length_seconds, s.publish_date, s.favorited_times,
                       s.rating_score
                FROM songs s WHERE s.id = %s
            """, (song_id,))
            song = cur.fetchone()
            if not song:
                continue

            # タグ TF-IDF
            cur.execute("""
                SELECT tag_id, tag_count FROM song_tags WHERE song_id = %s
            """, (song_id,))
            tag_rows = cur.fetchall()

            # プロデューサー / ボーカリスト
            cur.execute("""
                SELECT artist_id, is_producer, is_vocalist,
                       a.artist_type
                FROM song_artists sa
                JOIN artists a ON a.id = sa.artist_id
                WHERE sa.song_id = %s
            """, (song_id,))
            artist_rows = cur.fetchall()

        vec = np.zeros(DIM, dtype=np.float32)
        offset = 0

        # 1. タグ TF-IDF (階層タグの親も加算)
        tf_sum: dict[int, float] = {}
        for tr in tag_rows:
            ancestors = get_tag_ancestors(tr['tag_id'], parent_map, ancestor_cache)
            for anc in ancestors:
                if anc in tag_idx:
                    # TF = count / max_count (正規化), IDF = 事前計算済み
                    tf_sum[anc] = tf_sum.get(anc, 0) + tr['tag_count']
        max_tf = max(tf_sum.values()) if tf_sum else 1
        for tid, tf in tf_sum.items():
            if tid in tag_idx:
                vec[offset + tag_idx[tid]] = (tf / max_tf) * idf.get(tid, 1.0)
        offset += N_TAG

        # 2. プロデューサー (出現: 1.5, それ以外: 0)
        for ar in artist_rows:
            if ar['is_producer'] and ar['artist_id'] in producer_idx:
                vec[offset + producer_idx[ar['artist_id']]] = 1.5  # 高重みづけ
        # 「その他プロデューサー」次元
        has_other_prod = any(
            ar['is_producer'] and ar['artist_id'] not in producer_idx for ar in artist_rows
        )
        if has_other_prod:
            vec[offset + N_PRODUCER] = 0.5
        offset += N_PRODUCER + 1

        # 3. ボーカリスト one-hot
        for ar in artist_rows:
            if ar['is_vocalist'] and ar['artist_id'] in vocalist_idx:
                vec[offset + vocalist_idx[ar['artist_id']]] = 1.0
        has_other_voc = any(
            ar['is_vocalist'] and ar['artist_id'] not in vocalist_idx for ar in artist_rows
        )
        if has_other_voc:
            vec[offset + N_VOCALIST] = 0.5
        offset += N_VOCALIST + 1

        # 4. ボーカリストタイプ (複数ある場合は最大値)
        for ar in artist_rows:
            if ar['is_vocalist'] and ar['artist_type'] in VOCALIST_TYPES:
                i = VOCALIST_TYPES.index(ar['artist_type'])
                vec[offset + i] = max(vec[offset + i], 1.0)
        offset += len(VOCALIST_TYPES)

        # 5. 楽曲タイプ one-hot
        song_type = song['song_type'] or 'Unspecified'
        if song_type in SONG_TYPES:
            vec[offset + SONG_TYPES.index(song_type)] = 1.0
        offset += len(SONG_TYPES)

        # 6. スカラー特徴量 (正規化済み)
        length = min((song['length_seconds'] or 0) / 600.0, 1.0)   # 最大10分で正規化
        year = 0.0
        if song['publish_date']:
            try:
                y = int(str(song['publish_date'])[:4])
                year = max(0.0, min(1.0, (y - 2007) / 18.0))  # 2007〜2025
            except ValueError:
                pass
        popularity = math.log1p(song['favorited_times'] or 0) / 15.0   # log正規化

        vec[offset]     = length
        vec[offset + 1] = year
        vec[offset + 2] = min(popularity, 1.0)
        offset += 3

        assert offset == DIM

        vec = normalize(vec)
        points.append(PointStruct(
            id=song_id,
            vector=vec.tolist(),
            payload={'song_id': song_id},
        ))

        if len(points) >= BATCH_SIZE:
            qdrant.upsert(QDRANT_COLLECTION_META, points)
            points.clear()

    if points:
        qdrant.upsert(QDRANT_COLLECTION_META, points)

    print('Metadata feature extraction complete.')
    conn.close()


if __name__ == '__main__':
    main()
