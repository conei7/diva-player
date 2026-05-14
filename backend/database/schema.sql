-- ============================================================
-- VocaDB Recommender - PostgreSQL Schema
-- ============================================================

-- 拡張機能
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- 文字列類似検索
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (オプション: Qdrant側で管理する場合は不要)

-- ============================================================
-- 楽曲テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS songs (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    name_en         TEXT,
    artist_string   TEXT,
    length_seconds  INTEGER,
    song_type       TEXT,   -- Original / Cover / Remix / Other
    publish_date    DATE,
    rating_score    REAL DEFAULT 0,
    rating_count    INTEGER DEFAULT 0,
    favorited_times INTEGER DEFAULT 0,
    bpm             REAL,
    raw_json        JSONB,
    synced_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT songs_song_type_check CHECK (song_type IN ('Original','Cover','Remix','Remaster','Mashup','MusicPV','DramaPV','Instrumental','Other','Unspecified'))
);

CREATE INDEX IF NOT EXISTS songs_publish_date_idx ON songs (publish_date);
CREATE INDEX IF NOT EXISTS songs_favorited_idx    ON songs (favorited_times DESC);
CREATE INDEX IF NOT EXISTS songs_type_idx         ON songs (song_type);

-- ============================================================
-- アーティストテーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS artists (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    name_en     TEXT,
    artist_type TEXT,   -- Producer, Vocaloid, UTAU, CeVIO, SynthesizerV, etc.
    synced_at   TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 楽曲-アーティスト関係
-- ============================================================
CREATE TABLE IF NOT EXISTS song_artists (
    song_id        INTEGER REFERENCES songs(id) ON DELETE CASCADE,
    artist_id      INTEGER REFERENCES artists(id) ON DELETE CASCADE,
    roles          TEXT[],    -- ['Composer','Arranger','Lyricist','Instrumentalist','Vocalist',...]
    is_vocalist    BOOLEAN DEFAULT FALSE,
    is_producer    BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (song_id, artist_id)
);

CREATE INDEX IF NOT EXISTS sa_artist_idx    ON song_artists (artist_id);
CREATE INDEX IF NOT EXISTS sa_producer_idx  ON song_artists (artist_id) WHERE is_producer = TRUE;
CREATE INDEX IF NOT EXISTS sa_vocalist_idx  ON song_artists (artist_id) WHERE is_vocalist = TRUE;

-- ============================================================
-- タグテーブル (階層構造あり)
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    category    TEXT,       -- Genre / Subjective / Instrumental / Other
    parent_id   INTEGER REFERENCES tags(id)
);

CREATE INDEX IF NOT EXISTS tags_parent_idx ON tags (parent_id);

-- ============================================================
-- 楽曲-タグ関係 (タグの出現頻度付き)
-- ============================================================
CREATE TABLE IF NOT EXISTS song_tags (
    song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
    tag_id      INTEGER REFERENCES tags(id)  ON DELETE CASCADE,
    tag_count   INTEGER DEFAULT 1,  -- タグを付けたユーザー数
    PRIMARY KEY (song_id, tag_id)
);

CREATE INDEX IF NOT EXISTS st_tag_idx  ON song_tags (tag_id);
CREATE INDEX IF NOT EXISTS st_song_idx ON song_tags (song_id);

-- ============================================================
-- PVテーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS pvs (
    id          SERIAL PRIMARY KEY,
    song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
    service     TEXT NOT NULL,  -- Youtube / NicoNicoDouga / SoundCloud / etc.
    pv_id       TEXT NOT NULL,
    pv_type     TEXT,           -- Original / Reprint / Other
    disabled    BOOLEAN DEFAULT FALSE,
    UNIQUE (service, pv_id)
);

CREATE INDEX IF NOT EXISTS pvs_song_idx ON pvs (song_id);

-- ============================================================
-- 特徴量テーブル (Qdrant へのメタデータを補助)
-- ============================================================
CREATE TABLE IF NOT EXISTS song_features (
    song_id             INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    -- メタデータ特徴量
    metadata_dim        INTEGER,            -- ベクトル次元数
    metadata_computed   BOOLEAN DEFAULT FALSE,
    -- 音響特徴量
    audio_dim           INTEGER,
    audio_computed      BOOLEAN DEFAULT FALSE,
    -- マルコフ連鎖用
    state_cluster       INTEGER,            -- K-meansクラスタID
    energy              REAL,               -- 0.0 - 1.0
    danceability        REAL,               -- 0.0 - 1.0
    valence             REAL,               -- 0.0 - 1.0 (明るさ)
    computed_at         TIMESTAMPTZ
);

-- ============================================================
-- マルコフ連鎖遷移確率テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS markov_transitions (
    from_state  INTEGER NOT NULL,
    to_state    INTEGER NOT NULL,
    probability REAL    NOT NULL,
    PRIMARY KEY (from_state, to_state)
);

-- ============================================================
-- セッションテーブル (MMR用の再生履歴)
-- ============================================================
CREATE TABLE IF NOT EXISTS play_sessions (
    session_id  UUID    DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_plays (
    id          SERIAL PRIMARY KEY,
    session_id  UUID REFERENCES play_sessions(session_id) ON DELETE CASCADE,
    song_id     INTEGER REFERENCES songs(id),
    played_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sp_session_idx ON session_plays (session_id, played_at DESC);

-- ============================================================
-- TF-IDF 事前計算テーブル (検索・特徴量生成の高速化)
-- ============================================================
CREATE TABLE IF NOT EXISTS tag_idf (
    tag_id  INTEGER PRIMARY KEY REFERENCES tags(id),
    idf     REAL NOT NULL   -- log(N / df)
);

-- ============================================================
-- 便利なビュー
-- ============================================================
CREATE OR REPLACE VIEW v_song_producers AS
    SELECT sa.song_id, a.id AS artist_id, a.name AS producer_name
    FROM song_artists sa
    JOIN artists a ON a.id = sa.artist_id
    WHERE sa.is_producer = TRUE;

CREATE OR REPLACE VIEW v_song_vocalists AS
    SELECT sa.song_id, a.id AS artist_id, a.name AS vocalist_name, a.artist_type
    FROM song_artists sa
    JOIN artists a ON a.id = sa.artist_id
    WHERE sa.is_vocalist = TRUE;

-- ============================================================
-- 同期メタテーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 初期レコード
INSERT INTO sync_state (key, value) VALUES
    ('last_daily_sync', NULL),
    ('dump_imported',   'false')
ON CONFLICT (key) DO NOTHING;
