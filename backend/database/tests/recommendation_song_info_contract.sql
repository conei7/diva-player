-- Result contract for the optimized SongInfo projection.  The fixture covers
-- empty relationships, nullable booleans, excluded vocalist tags, disabled
-- PVs, and malformed/duplicate album IDs.  It runs in a rolled-back
-- transaction so CI never leaves fixture rows behind.
BEGIN;

INSERT INTO songs (
    id,
    name,
    artist_string,
    length_seconds,
    song_type,
    favorited_times,
    raw_json
)
VALUES
    (900000001, 'contract-full', 'contract artists', 180, 'Original', 10,
        '{"albums":[{"id":"7"},{"id":"bad"},{"id":"7"},{"id":8}]}'::jsonb),
    (900000002, 'contract-empty', NULL, NULL, 'Original', NULL,
        '{"albums":{"id":"9"}}'::jsonb),
    (900000003, 'contract-disabled', 'human', 240, 'Original', 0, NULL);

-- The schema trigger must keep the invalid second JSON element as an ordinal
-- hole and the duplicate album ID as a distinct ordered relationship.
INSERT INTO artists (id, name, artist_type)
VALUES
    (910000001, 'contract-vocaloid', 'Vocaloid'),
    (910000002, 'contract-producer-b', 'Producer'),
    (910000003, 'contract-producer-a', 'Producer'),
    (910000004, 'contract-human', 'Other');

INSERT INTO song_artists (song_id, artist_id, is_vocalist, is_producer)
VALUES
    (900000001, 910000003, FALSE, TRUE),
    (900000001, 910000001, TRUE, FALSE),
    (900000001, 910000002, FALSE, TRUE),
    (900000003, 910000004, TRUE, FALSE);

INSERT INTO tags (id, name, category)
VALUES
    (920000001, 'contract-null-category', NULL),
    (920000002, 'contract-vocalist-category', 'Vocalists'),
    (920000003, 'contract-genre-category', 'Genre');

INSERT INTO song_tags (song_id, tag_id, tag_count)
VALUES
    (900000001, 920000003, 1),
    (900000001, 920000002, 1),
    (900000001, 920000001, 1);

INSERT INTO pvs (song_id, service, pv_id, pv_type, disabled)
VALUES
    (900000001, 'Youtube', 'contract-original', 'Original', FALSE),
    (900000001, 'Youtube', 'contract-disabled-reprint', 'Reprint', TRUE),
    (900000002, 'Youtube', 'contract-reprint', 'Reprint', FALSE),
    (900000003, 'Youtube', 'contract-disabled-original', 'Original', TRUE);

INSERT INTO song_features (song_id, state_cluster, audio_computed)
VALUES
    (900000001, 7, TRUE),
    (900000002, 8, FALSE);

INSERT INTO song_discovery_quality (
    song_id,
    quality_score,
    discovery_eligible,
    model_version
)
VALUES
    (900000001, 0.8, TRUE, 'heuristic-v3'),
    (900000002, 0.2, FALSE, 'heuristic-v3');

CREATE TEMP TABLE recommendation_song_info_contract AS
SELECT s.id,
       sf.state_cluster,
       ARRAY(
           SELECT artist_id
           FROM song_artists
           WHERE song_id = s.id AND is_producer = TRUE
           ORDER BY artist_id
       ) AS producer_ids,
       ARRAY(
           SELECT artist_id
           FROM song_artists
           WHERE song_id = s.id AND is_vocalist = TRUE
           ORDER BY artist_id
       ) AS vocalist_ids,
       ARRAY(
           SELECT st.tag_id
           FROM song_tags st
           JOIN tags t ON t.id = st.tag_id
           WHERE st.song_id = s.id
             AND COALESCE(t.category, '') <> 'Vocalists'
           ORDER BY st.tag_id
       ) AS related_tag_ids,
       ARRAY(
           SELECT album_link.album_id
           FROM song_album_links album_link
           WHERE album_link.song_id = s.id
           ORDER BY album_link.ordinal
       ) AS album_ids,
       EXISTS (
           SELECT 1
           FROM song_artists sa
           JOIN artists a ON a.id = sa.artist_id
           WHERE sa.song_id = s.id
             AND sa.is_vocalist = TRUE
             AND a.artist_type IN (
                 'Vocaloid', 'UTAU', 'CeVIO', 'SynthesizerV', 'NEUTRINO',
                 'VoiSona', 'Voiceroid', 'OtherVoiceSynthesizer', 'NewType',
                 'ACEVirtualSinger', 'VOICEVOX', 'AIVOICE'
             )
       ) AS has_core_voice_synth,
       EXISTS (
           SELECT 1 FROM pvs p
           WHERE p.song_id = s.id AND p.disabled = FALSE
       ) AS has_playable_pv,
       COALESCE(q.discovery_eligible, FALSE) AS discovery_eligible,
       COALESCE(q.quality_score, 0.5)::double precision AS quality_score,
       sf.audio_computed IS TRUE AS has_audio_features,
       EXISTS (
           SELECT 1 FROM pvs original_pv
           WHERE original_pv.song_id = s.id
             AND original_pv.disabled = FALSE
             AND original_pv.pv_type = 'Original'
       ) AS has_original_pv
FROM songs s
LEFT JOIN song_features sf ON sf.song_id = s.id
LEFT JOIN song_discovery_quality q ON q.song_id = s.id
WHERE s.id = ANY(ARRAY[900000003, 900000001, 900000002, 900000001]);

DO $$
BEGIN
    IF (SELECT COUNT(*) FROM recommendation_song_info_contract) <> 3 THEN
        RAISE EXCEPTION 'SongInfo projection did not deduplicate input IDs';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM recommendation_song_info_contract
        WHERE id = 900000001
          AND state_cluster = 7
          AND producer_ids = ARRAY[910000002, 910000003]
          AND vocalist_ids = ARRAY[910000001]
          AND related_tag_ids = ARRAY[920000001, 920000003]
          AND album_ids = ARRAY[7, 7, 8]
          AND has_core_voice_synth
          AND has_playable_pv
          AND discovery_eligible
          AND quality_score > 0.79 AND quality_score < 0.81
          AND has_audio_features
          AND has_original_pv
    ) THEN
        RAISE EXCEPTION 'SongInfo full relationship contract failed';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM recommendation_song_info_contract
        WHERE id = 900000002
          AND state_cluster = 8
          AND producer_ids = '{}'::integer[]
          AND vocalist_ids = '{}'::integer[]
          AND related_tag_ids = '{}'::integer[]
          AND album_ids = '{}'::integer[]
          AND NOT has_core_voice_synth
          AND has_playable_pv
          AND NOT discovery_eligible
          AND quality_score > 0.19 AND quality_score < 0.21
          AND NOT has_audio_features
          AND NOT has_original_pv
    ) THEN
        RAISE EXCEPTION 'SongInfo empty/reprint relationship contract failed';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM recommendation_song_info_contract
        WHERE id = 900000003
          AND state_cluster IS NULL
          AND vocalist_ids = ARRAY[910000004]
          AND NOT has_core_voice_synth
          AND NOT has_playable_pv
          AND NOT discovery_eligible
          AND quality_score = 0.5
          AND NOT has_audio_features
          AND NOT has_original_pv
    ) THEN
        RAISE EXCEPTION 'SongInfo missing/disabled relationship contract failed';
    END IF;
END;
$$;

ROLLBACK;
