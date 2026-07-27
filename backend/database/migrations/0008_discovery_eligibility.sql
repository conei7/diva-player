-- Recomputable hard boundary for proactive discovery/recommendation surfaces.
-- Explicit user searches continue to access the complete synchronized catalog.
ALTER TABLE song_discovery_quality
    ADD COLUMN IF NOT EXISTS discovery_eligible BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS eligibility_reason_codes TEXT[] NOT NULL DEFAULT ARRAY['legacy_unclassified']::text[];

-- Preserve a safe boundary until diva-data-pipeline recalculates heuristic-v2.
UPDATE song_discovery_quality q
SET discovery_eligible = (
        s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV')
        AND COALESCE(s.length_seconds, 0) >= 20
        AND NOT ('no_synth_vocalist' = ANY(q.reason_codes))
        AND NOT ('negative_tag:out of scope (music pv)' = ANY(q.reason_codes))
    ),
    eligibility_reason_codes = CASE
        WHEN s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV')
          AND COALESCE(s.length_seconds, 0) >= 20
          AND NOT ('no_synth_vocalist' = ANY(q.reason_codes))
          AND NOT ('negative_tag:out of scope (music pv)' = ANY(q.reason_codes))
        THEN ARRAY['legacy_eligible']::text[]
        ELSE ARRAY['legacy_ineligible']::text[]
    END
FROM songs s
WHERE s.id = q.song_id;

CREATE INDEX CONCURRENTLY IF NOT EXISTS song_discovery_eligible_score_idx
    ON song_discovery_quality (quality_score DESC, song_id)
    WHERE discovery_eligible = TRUE;
