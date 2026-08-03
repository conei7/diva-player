-- Covers the per-song latest/baseline lookups used by the trending feed.
-- CONCURRENTLY keeps the external-view writer available while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS view_history_song_recorded_cover_idx
    ON view_history (song_id, recorded_at DESC)
    INCLUDE (youtube_views, nico_views);
