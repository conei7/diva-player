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
