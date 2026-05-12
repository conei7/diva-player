"""
01_import_dump.py
=================
VocaDB の公開データダンプ (JSON Lines形式) を PostgreSQL に一括インポートする。

データダンプのダウンロード:
  https://vocadb.net/Content/Misc/dbdump/

実行例:
  python 01_import_dump.py --songs songs.jsonl --artists artists.jsonl --tags tags.jsonl

ダンプが入手できない場合は 02_daily_sync.py (API経由の逐次取得) を使用してください。
"""
import argparse
import ujson as json
import psycopg2.extras
from tqdm import tqdm
from utils.db import get_conn, set_sync_state


# ---- パーサー関数 ------------------------------------------------

def parse_artist(obj: dict) -> tuple | None:
    """artistsダンプの1レコードをタプルに変換"""
    try:
        return (
            obj['id'],
            obj.get('name') or '',
            obj.get('additionalNames'),
            obj.get('artistType'),
        )
    except (KeyError, TypeError):
        return None


def parse_song(obj: dict) -> tuple | None:
    """songsダンプの1レコードをタプルに変換"""
    try:
        publish_date = obj.get('publishDate')
        if publish_date:
            publish_date = publish_date[:10]  # ISO8601 → YYYY-MM-DD
        return (
            obj['id'],
            obj.get('name') or '',
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
    except (KeyError, TypeError):
        return None


def parse_tag(obj: dict) -> tuple | None:
    """tagsダンプの1レコードをタプルに変換"""
    try:
        parent_id = None
        if 'parent' in obj and obj['parent']:
            parent_id = obj['parent'].get('id')
        return (
            obj['id'],
            obj.get('name') or '',
            obj.get('categoryName'),
            parent_id,
        )
    except (KeyError, TypeError):
        return None


# ---- インポート関数 -----------------------------------------------

def import_artists(path: str, conn):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    rows = [r for line in lines if (r := parse_artist(json.loads(line.strip())))]
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO artists (id, name, name_en, artist_type)
            VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                name        = EXCLUDED.name,
                name_en     = EXCLUDED.name_en,
                artist_type = EXCLUDED.artist_type,
                synced_at   = now()
            """,
            rows,
            page_size=500,
        )
    conn.commit()
    print(f'  Artists imported: {len(rows)}')


def import_tags(path: str, conn):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    rows = [r for line in lines if (r := parse_tag(json.loads(line.strip())))]
    # 親IDが後から出てくる可能性があるため、parent_id=NULL で先に全件挿入してから更新
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO tags (id, name, category, parent_id)
            VALUES %s
            ON CONFLICT (id) DO UPDATE SET
                name      = EXCLUDED.name,
                category  = EXCLUDED.category,
                parent_id = EXCLUDED.parent_id
            """,
            rows,
            page_size=500,
        )
    conn.commit()
    print(f'  Tags imported: {len(rows)}')


def import_songs(path: str, conn):
    """
    楽曲・アーティスト関係・タグ・PV を一括インポートする。
    大規模ファイルをストリーミングで処理しメモリを節約。
    """
    BATCH = 500
    song_rows = []
    sa_rows   = []
    st_rows   = []
    pv_rows   = []
    total = 0

    def flush():
        nonlocal song_rows, sa_rows, st_rows, pv_rows
        with conn.cursor() as cur:
            if song_rows:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO songs (id,name,name_en,artist_string,length_seconds,
                        song_type,publish_date,rating_score,rating_count,favorited_times,raw_json)
                    VALUES %s
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
                    song_rows, page_size=500,
                )
            if sa_rows:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO song_artists (song_id, artist_id, roles, is_vocalist, is_producer)
                    VALUES %s
                    ON CONFLICT (song_id, artist_id) DO UPDATE SET
                        roles       = EXCLUDED.roles,
                        is_vocalist = EXCLUDED.is_vocalist,
                        is_producer = EXCLUDED.is_producer
                    """,
                    sa_rows, page_size=1000,
                )
            if st_rows:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO song_tags (song_id, tag_id, tag_count)
                    VALUES %s
                    ON CONFLICT (song_id, tag_id) DO UPDATE SET
                        tag_count = EXCLUDED.tag_count
                    """,
                    st_rows, page_size=1000,
                )
            if pv_rows:
                psycopg2.extras.execute_values(
                    cur,
                    """
                    INSERT INTO pvs (song_id, service, pv_id, pv_type, disabled)
                    VALUES %s
                    ON CONFLICT (service, pv_id) DO NOTHING
                    """,
                    pv_rows, page_size=1000,
                )
        conn.commit()
        song_rows.clear(); sa_rows.clear(); st_rows.clear(); pv_rows.clear()

    with open(path, 'r', encoding='utf-8') as f:
        for line in tqdm(f, desc='Songs', unit='song'):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            row = parse_song(obj)
            if not row:
                continue
            song_rows.append(row)
            song_id = obj['id']

            # アーティスト関係
            VOCALIST_TYPES = {'Vocalist', 'OtherVocalist', 'Vocaloid', 'UTAU', 'CeVIO', 'SynthesizerV', 'NEUTRINO', 'VoiSona', 'Voiceroid'}
            PRODUCER_TYPES = {'Composer', 'Arranger', 'Lyricist', 'Instrumentalist', 'Default'}
            for artist_entry in (obj.get('artists') or []):
                artist = artist_entry.get('artist') or {}
                artist_id = artist.get('id')
                if not artist_id:
                    continue
                categories = set(artist_entry.get('categories', '').split(','))
                roles = [r.strip() for r in artist_entry.get('roles', '').split(',') if r.strip()]
                is_vocalist = bool(categories & {'Vocalist'})
                is_producer = bool(categories & {'Producer', 'Circle', 'Band', 'Animator', 'Label'})
                sa_rows.append((song_id, artist_id, roles or None, is_vocalist, is_producer))

            # タグ
            for tag_usage in (obj.get('tags') or []):
                tag = tag_usage.get('tag') or {}
                tag_id = tag.get('id')
                count  = tag_usage.get('count', 1)
                if tag_id:
                    st_rows.append((song_id, tag_id, count))

            # PV
            for pv in (obj.get('pvs') or []):
                service  = pv.get('service', '')
                pv_id    = pv.get('pvId')
                pv_type  = pv.get('pvType', 'Other')
                disabled = pv.get('disabled', False)
                if service and pv_id:
                    pv_rows.append((song_id, service, pv_id, pv_type, disabled))

            total += 1
            if len(song_rows) >= BATCH:
                flush()

    flush()
    print(f'  Songs imported: {total}')


# ---- メイン -------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='VocaDB dump importer')
    parser.add_argument('--songs',   required=True, help='songs JSONL dump path')
    parser.add_argument('--artists', required=True, help='artists JSONL dump path')
    parser.add_argument('--tags',    required=True, help='tags JSONL dump path')
    args = parser.parse_args()

    print('Connecting to PostgreSQL ...')
    conn = get_conn()
    try:
        print('Importing artists ...')
        import_artists(args.artists, conn)

        print('Importing tags ...')
        import_tags(args.tags, conn)

        print('Importing songs (this may take a while) ...')
        import_songs(args.songs, conn)

        set_sync_state('dump_imported', 'true')
        print('Done.')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
