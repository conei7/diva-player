"""
02_daily_sync.py
================
VocaDB API を使って差分同期を行う。
ダンプなしで全件 API 経由で取得することも可能（数日〜1週間かかる）。

実行例:
  python 02_daily_sync.py            # 前回同期以降の差分
  python 02_daily_sync.py --full     # 全件再取得（初回セットアップ用）
"""
import argparse
import ujson as json
import psycopg2.extras
from datetime import datetime, timezone
from tqdm import tqdm
from utils.db import get_conn, get_sync_state, set_sync_state
from utils.vocadb_client import get_songs_page, get_tags_page

PAGE_SIZE = 100


def upsert_song(cur, obj: dict):
    song_id = obj['id']
    publish_date = (obj.get('publishDate') or '')[:10] or None

    # songs テーブル
    cur.execute(
        """
        INSERT INTO songs (id,name,name_en,artist_string,length_seconds,
            song_type,publish_date,rating_score,rating_count,favorited_times,raw_json,synced_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
        ON CONFLICT (id) DO UPDATE SET
            name           = EXCLUDED.name,
            artist_string  = EXCLUDED.artist_string,
            length_seconds = EXCLUDED.length_seconds,
            song_type      = EXCLUDED.song_type,
            publish_date   = EXCLUDED.publish_date,
            rating_score   = EXCLUDED.rating_score,
            rating_count   = EXCLUDED.rating_count,
            favorited_times= EXCLUDED.favorited_times,
            raw_json       = EXCLUDED.raw_json,
            synced_at      = now()
        """,
        (
            song_id,
            obj.get('name', ''),
            obj.get('additionalNames'),
            obj.get('artistString'),
            obj.get('lengthSeconds'),
            obj.get('songType', 'Unspecified'),
            publish_date,
            obj.get('ratingScore', 0.0),
            obj.get('ratingCount', 0),
            obj.get('favoritedTimes', 0),
            json.dumps(obj),
        )
    )

    # artists
    for ae in (obj.get('artists') or []):
        a = ae.get('artist') or {}
        artist_id = a.get('id')
        if not artist_id:
            continue
        cur.execute(
            """
            INSERT INTO artists (id, name, name_en, artist_type)
            VALUES (%s,%s,%s,%s)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, artist_type = EXCLUDED.artist_type
            """,
            (artist_id, a.get('name',''), a.get('additionalNames'), a.get('artistType'))
        )
        categories = set(ae.get('categories', '').split(','))
        roles = [r.strip() for r in ae.get('roles', '').split(',') if r.strip()]
        is_vocalist = 'Vocalist' in categories
        is_producer = bool(categories & {'Producer', 'Circle', 'Band'})
        cur.execute(
            """
            INSERT INTO song_artists (song_id, artist_id, roles, is_vocalist, is_producer)
            VALUES (%s,%s,%s,%s,%s)
            ON CONFLICT (song_id, artist_id) DO UPDATE SET
                roles=EXCLUDED.roles, is_vocalist=EXCLUDED.is_vocalist, is_producer=EXCLUDED.is_producer
            """,
            (song_id, artist_id, roles or None, is_vocalist, is_producer)
        )

    # tags
    for tu in (obj.get('tags') or []):
        tag = tu.get('tag') or {}
        tag_id = tag.get('id')
        if not tag_id:
            continue
        cur.execute(
            """
            INSERT INTO tags (id, name, category)
            VALUES (%s,%s,%s)
            ON CONFLICT (id) DO NOTHING
            """,
            (tag_id, tag.get('name',''), tag.get('categoryName'))
        )
        cur.execute(
            """
            INSERT INTO song_tags (song_id, tag_id, tag_count)
            VALUES (%s,%s,%s)
            ON CONFLICT (song_id, tag_id) DO UPDATE SET tag_count = EXCLUDED.tag_count
            """,
            (song_id, tag_id, tu.get('count', 1))
        )

    # pvs
    cur.execute("DELETE FROM pvs WHERE song_id = %s", (song_id,))
    for pv in (obj.get('pvs') or []):
        service = pv.get('service', '')
        pv_id   = pv.get('pvId')
        if service and pv_id:
            cur.execute(
                """
                INSERT INTO pvs (song_id, service, pv_id, pv_type, disabled)
                VALUES (%s,%s,%s,%s,%s)
                ON CONFLICT (service, pv_id) DO NOTHING
                """,
                (song_id, service, pv_id, pv.get('pvType','Other'), pv.get('disabled', False))
            )


def sync_tags(conn):
    print('Syncing tags ...')
    start = 0
    while True:
        page = get_tags_page(start, 200)
        items = page.get('items', [])
        if not items:
            break
        with conn.cursor() as cur:
            for tag in items:
                parent_id = None
                if tag.get('parent'):
                    parent_id = tag['parent'].get('id')
                cur.execute(
                    """
                    INSERT INTO tags (id, name, category, parent_id)
                    VALUES (%s,%s,%s,%s)
                    ON CONFLICT (id) DO UPDATE SET
                        name=EXCLUDED.name, category=EXCLUDED.category, parent_id=EXCLUDED.parent_id
                    """,
                    (tag['id'], tag.get('name',''), tag.get('categoryName'), parent_id)
                )
        conn.commit()
        start += len(items)
        if start >= page.get('totalCount', 0):
            break
    print(f'  Tags synced. total={start}')


def sync_songs(conn, since_date: str | None, full: bool):
    start = 0
    total_synced = 0
    pbar = tqdm(desc='Syncing songs', unit='song')
    while True:
        page = get_songs_page(start, PAGE_SIZE, since_date if not full else None)
        items = page.get('items', [])
        if not items:
            break
        with conn.cursor() as cur:
            for obj in items:
                upsert_song(cur, obj)
        conn.commit()
        total_synced += len(items)
        pbar.update(len(items))
        start += len(items)
        if start >= page.get('totalCount', 0):
            break
    pbar.close()
    print(f'  Songs synced: {total_synced}')
    return total_synced


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--full', action='store_true', help='全件再同期')
    args = parser.parse_args()

    conn = get_conn()
    try:
        sync_tags(conn)

        last_sync = get_sync_state('last_daily_sync') if not args.full else None
        print(f'Last sync: {last_sync or "none (full sync)"}')
        sync_songs(conn, since_date=last_sync, full=args.full)

        now_str = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        set_sync_state('last_daily_sync', now_str)
        print('Sync complete.')
    finally:
        conn.close()

    # 静的マスターデータをエクスポート（DBアクセス完了後に1回だけ実行）
    try:
        from export_static_data import export_hall_of_fame_singers
        import os
        default_out = os.path.join(
            os.path.dirname(__file__),
            '../../public/data/hall_of_fame_singers.json',
        )
        export_hall_of_fame_singers(default_out)
    except Exception as e:
        print(f'[warn] 静的データエクスポートをスキップ: {e}')


if __name__ == '__main__':
    main()
