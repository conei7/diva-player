-- ============================================================
-- VocaDB Recommender - PostgreSQL Schema
-- ============================================================

-- 拡張機能
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- 文字列類似検索
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (オプション: Qdrant側で管理する場合は不要)
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

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
    CONSTRAINT songs_song_type_check CHECK (song_type IN ('Original','Cover','Remix','Remaster','Arrangement','Mashup','MusicPV','DramaPV','Instrumental','Other','Unspecified'))
);

CREATE INDEX IF NOT EXISTS songs_publish_date_idx ON songs (publish_date);
CREATE INDEX IF NOT EXISTS songs_favorited_idx    ON songs (favorited_times DESC);
CREATE INDEX IF NOT EXISTS songs_type_idx         ON songs (song_type);
CREATE INDEX IF NOT EXISTS songs_favorited_search_idx
    ON songs (favorited_times DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_youtube_views_search_idx
    ON songs (youtube_views DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_nico_views_search_idx
    ON songs (nico_views DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_total_views_search_idx
    ON songs ((COALESCE(youtube_views, 0) + COALESCE(nico_views, 0)) DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_rating_search_idx
    ON songs (rating_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_publish_date_search_idx
    ON songs (publish_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS songs_name_trgm_idx
    ON songs USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS songs_name_en_trgm_idx
    ON songs USING gin (name_en gin_trgm_ops);
CREATE INDEX IF NOT EXISTS songs_artist_string_trgm_idx
    ON songs USING gin (artist_string gin_trgm_ops);

-- Heuristic discovery quality signals are refreshed by diva-data-pipeline.
CREATE TABLE IF NOT EXISTS song_discovery_quality (
    song_id             INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    quality_score       REAL NOT NULL DEFAULT 0.5,
    duration_score      REAL NOT NULL DEFAULT 0.5,
    support_score       REAL NOT NULL DEFAULT 0,
    tag_support_score   REAL NOT NULL DEFAULT 0,
    producer_score      REAL NOT NULL DEFAULT 0,
    original_pv_score   REAL NOT NULL DEFAULT 0,
    nico_presence_score REAL NOT NULL DEFAULT 0,
    negative_penalty    REAL NOT NULL DEFAULT 0,
    reason_codes        TEXT[] NOT NULL DEFAULT '{}',
    discovery_eligible  BOOLEAN NOT NULL DEFAULT TRUE,
    eligibility_reason_codes TEXT[] NOT NULL DEFAULT ARRAY['legacy_unclassified']::text[],
    model_version       TEXT NOT NULL DEFAULT 'heuristic-v1',
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS song_discovery_quality_score_idx
    ON song_discovery_quality (quality_score DESC);
CREATE INDEX IF NOT EXISTS song_discovery_eligible_score_idx
    ON song_discovery_quality (quality_score DESC, song_id)
    WHERE discovery_eligible = TRUE;

-- External view counts are maintained by diva-data-pipeline.
ALTER TABLE songs
    ADD COLUMN IF NOT EXISTS youtube_views BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS nico_views BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS view_history (
    id              BIGSERIAL PRIMARY KEY,
    song_id         INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_date   DATE,
    youtube_views   BIGINT NOT NULL DEFAULT 0,
    nico_views      BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS view_history_song_date_idx
    ON view_history (song_id, recorded_at ASC);
CREATE INDEX IF NOT EXISTS view_history_song_recorded_cover_idx
    ON view_history (song_id, recorded_at DESC)
    INCLUDE (youtube_views, nico_views);

-- Supports the time-window baseline used by the trending ranking.
CREATE INDEX IF NOT EXISTS view_history_recorded_song_idx
    ON view_history (recorded_at ASC, song_id);

CREATE UNIQUE INDEX IF NOT EXISTS view_history_song_recorded_date_idx
    ON view_history (song_id, recorded_date)
    WHERE recorded_date IS NOT NULL;

-- Monthly empirical YouTube/NicoNico conversion profiles used by discovery rankings.
CREATE TABLE IF NOT EXISTS platform_view_weight_profiles (
    id              BIGSERIAL PRIMARY KEY,
    profile_month   DATE NOT NULL UNIQUE,
    fallback_weight DOUBLE PRECISION NOT NULL,
    max_weight      DOUBLE PRECISION NOT NULL DEFAULT 25.0,
    song_count      INTEGER NOT NULL DEFAULT 0,
    youtube_total   NUMERIC NOT NULL DEFAULT 0,
    nico_total      NUMERIC NOT NULL DEFAULT 0,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_view_weight_bands (
    profile_id      BIGINT NOT NULL REFERENCES platform_view_weight_profiles(id) ON DELETE CASCADE,
    youtube_min    BIGINT NOT NULL,
    sample_count   INTEGER NOT NULL,
    median_ratio   DOUBLE PRECISION NOT NULL,
    lower_quartile DOUBLE PRECISION NOT NULL,
    upper_quartile DOUBLE PRECISION NOT NULL,
    applied_weight DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (profile_id, youtube_min)
);

CREATE INDEX IF NOT EXISTS platform_view_weight_profiles_latest_idx
    ON platform_view_weight_profiles (profile_month DESC);

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
    stats_last_attempt_at TIMESTAMPTZ,
    stats_last_success_at TIMESTAMPTZ,
    stats_consecutive_failures INTEGER NOT NULL DEFAULT 0,
    UNIQUE (service, pv_id)
);

CREATE INDEX IF NOT EXISTS pvs_song_idx ON pvs (song_id);
CREATE INDEX IF NOT EXISTS pvs_playable_song_idx ON pvs (song_id) WHERE disabled = FALSE;
CREATE INDEX IF NOT EXISTS pvs_stats_due_idx
    ON pvs (service, stats_last_success_at ASC NULLS FIRST, song_id)
    WHERE disabled = FALSE;

-- ============================================================
-- YouTubeプレイリスト同期キャッシュ
-- ============================================================
CREATE TABLE IF NOT EXISTS youtube_playlist_cache (
    playlist_id TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    video_ids   JSONB NOT NULL,
    etag        TEXT,
    truncated   BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS youtube_playlist_cache_fetched_idx
    ON youtube_playlist_cache (fetched_at);

CREATE TABLE IF NOT EXISTS nico_playlist_cache (
    source_kind TEXT NOT NULL CHECK (source_kind IN ('mylist', 'series')),
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    video_ids JSONB NOT NULL,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS nico_playlist_cache_fetched_idx
    ON nico_playlist_cache (fetched_at);

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
    computed_at         TIMESTAMPTZ,
    -- 暗黙的フィードバック (再生完了率EMA)
    implicit_score      REAL    DEFAULT 0,  -- -1 (即スキップ) 〜 +1 (完走/ループ)
    implicit_count      INTEGER DEFAULT 0   -- EMAサンプル数
);

-- Derived locally from archived audio. No waveform or audio excerpt is stored.
CREATE TABLE IF NOT EXISTS song_audio_analysis (
    song_id                     INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    analysis_version            TEXT NOT NULL,
    bpm                         REAL,
    bpm_alternative             REAL,
    bpm_confidence              REAL NOT NULL DEFAULT 0,
    tempo_stability             REAL NOT NULL DEFAULT 0,
    musical_key                 TEXT,
    key_mode                    TEXT,
    key_confidence              REAL NOT NULL DEFAULT 0,
    energy                      REAL,
    brightness                  REAL,
    percussiveness              REAL,
    analyzed_duration_seconds   REAL NOT NULL,
    model_versions              JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT song_audio_analysis_bpm_check CHECK (bpm IS NULL OR bpm BETWEEN 20 AND 400),
    CONSTRAINT song_audio_analysis_bpm_alt_check CHECK (bpm_alternative IS NULL OR bpm_alternative BETWEEN 20 AND 400),
    CONSTRAINT song_audio_analysis_bpm_confidence_check CHECK (bpm_confidence BETWEEN 0 AND 1),
    CONSTRAINT song_audio_analysis_tempo_stability_check CHECK (tempo_stability BETWEEN 0 AND 1),
    CONSTRAINT song_audio_analysis_key_mode_check CHECK (key_mode IS NULL OR key_mode IN ('major', 'minor')),
    CONSTRAINT song_audio_analysis_key_confidence_check CHECK (key_confidence BETWEEN 0 AND 1),
    CONSTRAINT song_audio_analysis_energy_check CHECK (energy IS NULL OR energy BETWEEN 0 AND 1),
    CONSTRAINT song_audio_analysis_brightness_check CHECK (brightness IS NULL OR brightness BETWEEN 0 AND 1),
    CONSTRAINT song_audio_analysis_percussiveness_check CHECK (percussiveness IS NULL OR percussiveness BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS song_audio_analysis_bpm_idx
    ON song_audio_analysis (bpm)
    WHERE bpm IS NOT NULL;
CREATE INDEX IF NOT EXISTS song_audio_analysis_bpm_alternative_idx
    ON song_audio_analysis (bpm_alternative)
    WHERE bpm_alternative IS NOT NULL;
CREATE INDEX IF NOT EXISTS song_audio_analysis_version_idx
    ON song_audio_analysis (analysis_version, computed_at);

CREATE TABLE IF NOT EXISTS song_audio_instruments (
    song_id          INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    instrument_key   TEXT NOT NULL,
    score            REAL NOT NULL,
    rank             SMALLINT NOT NULL,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (song_id, instrument_key),
    CONSTRAINT song_audio_instruments_score_check CHECK (score BETWEEN 0 AND 1),
    CONSTRAINT song_audio_instruments_rank_check CHECK (rank BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS song_audio_instruments_filter_idx
    ON song_audio_instruments (instrument_key, score DESC, song_id);

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
