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
