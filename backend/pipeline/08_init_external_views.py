import json
import psycopg2.extras
import os
from utils.db import get_conn

YT_JSON = r"H:\Vocaloid_Extended\_progress\yt_all_views.json"
NICO_JSON = r"H:\Vocaloid_Extended\_progress\nico_all_views.json"

def main():
    print("DBにカラムを追加します...")
    conn = get_conn()
    with conn.cursor() as cur:
        # カラムが存在しない場合のみ追加
        cur.execute("""
            ALTER TABLE songs 
            ADD COLUMN IF NOT EXISTS youtube_views BIGINT DEFAULT 0,
            ADD COLUMN IF NOT EXISTS nico_views BIGINT DEFAULT 0;
        """)
    conn.commit()

    print("YouTubeの再生回数を読み込み中...")
    with open(YT_JSON, "r", encoding="utf-8") as f:
        yt_data = json.load(f)
    
    print("ニコニコ動画の再生回数を読み込み中...")
    with open(NICO_JSON, "r", encoding="utf-8") as f:
        nico_data = json.load(f)

    # データをマージ (song_id -> [yt_views, nico_views])
    # JSONのキーは文字列なので int(song_id) に変換
    all_song_ids = set(yt_data.keys()).union(set(nico_data.keys()))
    
    rows = []
    for sid_str in all_song_ids:
        try:
            sid = int(sid_str)
            yt_v = yt_data.get(sid_str, -1)
            nico_v = nico_data.get(sid_str, -1)
            
            # -1 は未取得やエラーなので 0 にする
            yt_v = max(0, yt_v)
            nico_v = max(0, nico_v)
            
            rows.append((sid, yt_v, nico_v))
        except ValueError:
            continue

    print(f"データベースを更新中... ({len(rows)}件)")
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            UPDATE songs 
            SET youtube_views = data.yt_v,
                nico_views = data.nico_v
            FROM (VALUES %s) AS data(sid, yt_v, nico_v)
            WHERE songs.id = data.sid
            """,
            rows,
            page_size=1000
        )
    conn.commit()
    conn.close()
    print("完了しました！")

if __name__ == "__main__":
    main()
