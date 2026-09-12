-- Stable 2D sound-map coordinates. Coordinates are immutable within a map
-- version; a new version is published atomically when the source changes.
CREATE TABLE IF NOT EXISTS sound_map_versions (
    map_version TEXT PRIMARY KEY,
    source_digest TEXT NOT NULL,
    method TEXT NOT NULL,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'building'
        CHECK (status IN ('building', 'ready', 'retired'))
);

CREATE TABLE IF NOT EXISTS sound_map_coordinates (
    map_version TEXT NOT NULL REFERENCES sound_map_versions(map_version) ON DELETE CASCADE,
    song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    x DOUBLE PRECISION NOT NULL CHECK (x >= -1 AND x <= 1),
    y DOUBLE PRECISION NOT NULL CHECK (y >= -1 AND y <= 1),
    PRIMARY KEY (map_version, song_id)
);

CREATE INDEX IF NOT EXISTS ix_sound_map_coordinates_song
    ON sound_map_coordinates(song_id, map_version);

CREATE INDEX IF NOT EXISTS ix_sound_map_versions_ready
    ON sound_map_versions(status, published_at DESC NULLS LAST, generated_at DESC);
