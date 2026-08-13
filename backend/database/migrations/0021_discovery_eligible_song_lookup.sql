-- Recommendation relationship queries join candidate song IDs against the
-- discovery boundary.  The score-first partial index cannot serve that lookup
-- efficiently, so cold API slots otherwise perform a heap read per candidate.
-- Build this separately from writer transactions so normal reads and the
-- scheduled quality refresh can continue while PostgreSQL creates the index.
DO $$
DECLARE
    existing_index regclass := to_regclass('public.song_discovery_eligible_song_idx');
BEGIN
    IF existing_index IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM pg_index index_state
        WHERE index_state.indexrelid = existing_index
          AND index_state.indrelid = 'public.song_discovery_quality'::regclass
          AND index_state.indisvalid
          AND index_state.indisready
          AND NOT index_state.indisunique
          AND index_state.indnkeyatts = 1
          AND index_state.indnatts = 1
          AND pg_get_indexdef(index_state.indexrelid, 1, TRUE) = 'song_id'
          AND pg_get_expr(index_state.indpred, index_state.indrelid, FALSE) = 'discovery_eligible'
    ) THEN
        RAISE EXCEPTION
            'song_discovery_eligible_song_idx exists with invalid or unexpected semantics; inspect and remove it before retrying 0021';
    END IF;
END;
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS song_discovery_eligible_song_idx
    ON song_discovery_quality (song_id)
    WHERE discovery_eligible;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_index index_state
        WHERE index_state.indexrelid = 'public.song_discovery_eligible_song_idx'::regclass
          AND index_state.indrelid = 'public.song_discovery_quality'::regclass
          AND index_state.indisvalid
          AND index_state.indisready
          AND NOT index_state.indisunique
          AND index_state.indnkeyatts = 1
          AND index_state.indnatts = 1
          AND pg_get_indexdef(index_state.indexrelid, 1, TRUE) = 'song_id'
          AND pg_get_expr(index_state.indpred, index_state.indrelid, FALSE) = 'discovery_eligible'
    ) THEN
        RAISE EXCEPTION '0021 did not establish a valid discovery-eligible song lookup index';
    END IF;
END;
$$;
