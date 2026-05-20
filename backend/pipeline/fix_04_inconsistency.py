"""
fix_04_inconsistency.py
=======================
DBで audio_computed=TRUE だが Qdrant song_audio に存在しない曲を検出し、
audio_computed=FALSE にリセットする。
これにより、次回 04 スクリプト実行時に再処理される。
"""
import sys
from qdrant_client import QdrantClient
from utils.db import get_conn, QDRANT_URL, QDRANT_COLLECTION_AUDIO

def main():
    qdrant = QdrantClient(url=QDRANT_URL, timeout=120)  # 大規模コレクション対応のため長めに設定

    # Qdrant の全ポイント ID を収集
    print("Qdrant からポイント ID を取得中...")
    qdrant_ids: set[int] = set()
    offset = None
    while True:
        result, next_offset = qdrant.scroll(
            collection_name=QDRANT_COLLECTION_AUDIO,
            limit=1000,
            offset=offset,
            with_vectors=False,
            with_payload=False,
        )
        for point in result:
            qdrant_ids.add(int(point.id))
        if next_offset is None:
            break
        offset = next_offset

    print(f"Qdrant song_audio: {len(qdrant_ids)} ポイント")

    # DB で audio_computed=TRUE の曲を取得
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT song_id FROM song_features
                WHERE audio_computed = TRUE
            """)
            db_ids = {row['song_id'] for row in cur.fetchall()}

    print(f"DB audio_computed=TRUE: {len(db_ids)} 件")

    # 不整合: DB=TRUE だが Qdrant に存在しない
    missing_in_qdrant = db_ids - qdrant_ids
    print(f"不整合 (DB=TRUE だが Qdrant なし): {len(missing_in_qdrant)} 件")

    if not missing_in_qdrant:
        print("不整合なし。修正不要です。")
        return

    # リセット
    confirm = input(f"{len(missing_in_qdrant)} 件の audio_computed を FALSE にリセットしますか？ [y/N]: ")
    if confirm.strip().lower() != 'y':
        print("キャンセルしました。")
        return

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE song_features
                SET audio_computed = FALSE, audio_dim = NULL, computed_at = NULL
                WHERE song_id = ANY(%s)
            """, (list(missing_in_qdrant),))
        conn.commit()

    print(f"リセット完了: {len(missing_in_qdrant)} 件")
    print("次回 04_extract_audio_features.py 実行時にこれらの曲が再処理されます。")


if __name__ == '__main__':
    main()
