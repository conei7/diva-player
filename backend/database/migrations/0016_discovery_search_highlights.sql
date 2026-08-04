ALTER TABLE songs
    ADD COLUMN IF NOT EXISTS original_version_id INTEGER,
    ADD COLUMN IF NOT EXISTS is_self_cover BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE songs
SET original_version_id = (raw_json->>'originalVersionId')::INTEGER
WHERE raw_json->>'originalVersionId' ~ '^[0-9]+$'
  AND original_version_id IS DISTINCT FROM (raw_json->>'originalVersionId')::INTEGER;

CREATE INDEX IF NOT EXISTS songs_original_version_idx
    ON songs (original_version_id)
    WHERE original_version_id IS NOT NULL;

UPDATE songs AS cover
SET is_self_cover = EXISTS (
    SELECT 1
    FROM song_artists AS cover_credit
    JOIN song_artists AS original_credit
      ON original_credit.artist_id = cover_credit.artist_id
     AND original_credit.song_id = cover.original_version_id
     AND original_credit.is_producer = TRUE
    WHERE cover_credit.song_id = cover.id
      AND cover_credit.is_producer = TRUE
)
WHERE cover.song_type = 'Cover'
  AND cover.original_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS songs_self_cover_idx
    ON songs (id)
    WHERE is_self_cover = TRUE;

CREATE TABLE IF NOT EXISTS song_lyrics (
    lyric_id          INTEGER PRIMARY KEY,
    song_id           INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    culture_codes     TEXT[] NOT NULL DEFAULT '{}',
    translation_type  TEXT,
    source             TEXT,
    source_url         TEXT,
    value              TEXT NOT NULL,
    search_text        TEXT NOT NULL,
    synced_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS song_lyrics_song_idx ON song_lyrics (song_id);
CREATE INDEX IF NOT EXISTS song_lyrics_search_trgm_idx
    ON song_lyrics USING gin (search_text gin_trgm_ops);

ALTER TABLE song_audio_analysis
    ADD COLUMN IF NOT EXISTS chorus_start_seconds REAL,
    ADD COLUMN IF NOT EXISTS chorus_end_seconds REAL,
    ADD COLUMN IF NOT EXISTS chorus_confidence REAL NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS chorus_method TEXT;

ALTER TABLE song_audio_analysis
    DROP CONSTRAINT IF EXISTS song_audio_analysis_chorus_range_check;
ALTER TABLE song_audio_analysis
    ADD CONSTRAINT song_audio_analysis_chorus_range_check CHECK (
        (chorus_start_seconds IS NULL AND chorus_end_seconds IS NULL)
        OR (
            chorus_start_seconds IS NOT NULL
            AND chorus_end_seconds IS NOT NULL
            AND chorus_start_seconds >= 0
            AND chorus_end_seconds > chorus_start_seconds
            AND chorus_end_seconds <= analyzed_duration_seconds + 1
        )
    );
ALTER TABLE song_audio_analysis
    DROP CONSTRAINT IF EXISTS song_audio_analysis_chorus_confidence_check;
ALTER TABLE song_audio_analysis
    ADD CONSTRAINT song_audio_analysis_chorus_confidence_check
    CHECK (chorus_confidence BETWEEN 0 AND 1);

CREATE INDEX IF NOT EXISTS song_audio_analysis_chorus_idx
    ON song_audio_analysis (chorus_confidence DESC, song_id)
    WHERE chorus_start_seconds IS NOT NULL;
