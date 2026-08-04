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
