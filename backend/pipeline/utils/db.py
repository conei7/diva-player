"""
共通ユーティリティ: DB接続・設定読み込み
"""
import os
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../.env'))

DB_CONFIG = {
    'host':     os.getenv('PG_HOST',     'localhost'),
    'port':     int(os.getenv('PG_PORT', '5432')),
    'dbname':   os.getenv('PG_DBNAME',   'vocadb_recommender'),
    'user':     os.getenv('PG_USER',     'vocadb'),
    'password': os.getenv('PG_PASSWORD', 'vocadb_secret'),
}

QDRANT_URL    = os.getenv('QDRANT_URL',    'http://localhost:6333')
QDRANT_GRPC_PORT = int(os.getenv('QDRANT_GRPC_PORT', '6334'))
QDRANT_COLLECTION_META   = 'song_metadata'
QDRANT_COLLECTION_AUDIO  = 'song_audio'
QDRANT_COLLECTION_HYBRID = 'song_hybrid'
# Named Vectors コレクション（audio + meta を1つのコレクションに格納）
QDRANT_COLLECTION_NAMED  = 'songs_v2'


def get_conn():
    """PostgreSQL接続を返す（呼び出し元がコンテキストマネージャで閉じること）"""
    return psycopg2.connect(
        **DB_CONFIG,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def get_sync_state(key: str) -> str | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM sync_state WHERE key = %s", (key,))
            row = cur.fetchone()
            return row['value'] if row else None


def set_sync_state(key: str, value: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sync_state(key,value,updated_at) VALUES(%s,%s,now()) "
                "ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
                (key, value)
            )
        conn.commit()
