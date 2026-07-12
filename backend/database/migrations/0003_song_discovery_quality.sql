-- Heuristic quality signals used by the surge/discovery ranking.
-- Values are recomputed by diva-data-pipeline after VocaDB/view sync.
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
    model_version       TEXT NOT NULL DEFAULT 'heuristic-v1',
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS song_discovery_quality_score_idx
    ON song_discovery_quality (quality_score DESC);
