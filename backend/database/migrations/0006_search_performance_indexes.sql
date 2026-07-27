-- ILIKE '%term%'による曲名・英語名・アーティスト文字列検索を高速化する。
-- CONCURRENTLYを使い、既存SBCの検索・再生を止めずに作成する。
CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_name_trgm_idx
    ON songs USING gin (name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_name_en_trgm_idx
    ON songs USING gin (name_en gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_artist_string_trgm_idx
    ON songs USING gin (artist_string gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS pvs_playable_song_idx
    ON pvs (song_id) WHERE disabled = FALSE;
