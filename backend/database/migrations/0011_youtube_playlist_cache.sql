CREATE TABLE IF NOT EXISTS youtube_playlist_cache (
    playlist_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    video_ids JSONB NOT NULL,
    etag TEXT,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE youtube_playlist_cache
    ADD COLUMN IF NOT EXISTS truncated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS youtube_playlist_cache_fetched_idx
    ON youtube_playlist_cache (fetched_at);
