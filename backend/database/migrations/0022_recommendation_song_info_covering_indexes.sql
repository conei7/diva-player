-- Cold recommendation requests hydrate several hundred SongInfo rows.  These
-- covering indexes keep the producer, vocalist, and playable-PV probes on the
-- indexes instead of reading one heap page for every candidate relationship.
-- Keep the reverse artist-first indexes: graph/catalog queries use them for a
-- different access path.
DO $$
DECLARE
    expected RECORD;
    existing_index regclass;
BEGIN
    FOR expected IN
        SELECT *
        FROM (VALUES
            (
                'song_artists_producer_song_idx',
                'song_artists',
                2,
                2,
                'song_id',
                'artist_id',
                '(is_producer = true)'
            ),
            (
                'song_artists_vocalist_song_idx',
                'song_artists',
                2,
                2,
                'song_id',
                'artist_id',
                '(is_vocalist = true)'
            ),
            (
                'pvs_playable_song_cover_idx',
                'pvs',
                1,
                2,
                'song_id',
                'pv_type',
                '(disabled = false)'
            )
        ) AS specifications(
            index_name,
            table_name,
            key_attribute_count,
            total_attribute_count,
            first_attribute,
            second_attribute,
            predicate
        )
    LOOP
        existing_index := to_regclass(format('public.%I', expected.index_name));
        IF existing_index IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM pg_index index_state
            JOIN pg_class index_relation
              ON index_relation.oid = index_state.indexrelid
            JOIN pg_am access_method
              ON access_method.oid = index_relation.relam
            WHERE index_state.indexrelid = existing_index
              AND index_state.indrelid = format('public.%I', expected.table_name)::regclass
              AND index_state.indisvalid
              AND index_state.indisready
              AND NOT index_state.indisunique
              AND index_state.indexprs IS NULL
              AND access_method.amname = 'btree'
              AND index_state.indnkeyatts = expected.key_attribute_count
              AND index_state.indnatts = expected.total_attribute_count
              AND pg_get_indexdef(index_state.indexrelid, 1, TRUE) = expected.first_attribute
              AND pg_get_indexdef(index_state.indexrelid, 2, TRUE) = expected.second_attribute
              AND pg_get_expr(index_state.indpred, index_state.indrelid, FALSE)
                  IS NOT DISTINCT FROM expected.predicate
        ) THEN
            RAISE EXCEPTION
                '% exists with invalid or unexpected semantics; inspect and remove it before retrying 0022',
                expected.index_name;
        END IF;
    END LOOP;
END;
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS song_artists_producer_song_idx
    ON song_artists (song_id, artist_id)
    WHERE is_producer = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS song_artists_vocalist_song_idx
    ON song_artists (song_id, artist_id)
    WHERE is_vocalist = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS pvs_playable_song_cover_idx
    ON pvs (song_id)
    INCLUDE (pv_type)
    WHERE disabled = FALSE;

DO $$
DECLARE
    expected RECORD;
BEGIN
    FOR expected IN
        SELECT *
        FROM (VALUES
            (
                'song_artists_producer_song_idx',
                'song_artists',
                2,
                2,
                'song_id',
                'artist_id',
                '(is_producer = true)'
            ),
            (
                'song_artists_vocalist_song_idx',
                'song_artists',
                2,
                2,
                'song_id',
                'artist_id',
                '(is_vocalist = true)'
            ),
            (
                'pvs_playable_song_cover_idx',
                'pvs',
                1,
                2,
                'song_id',
                'pv_type',
                '(disabled = false)'
            )
        ) AS specifications(
            index_name,
            table_name,
            key_attribute_count,
            total_attribute_count,
            first_attribute,
            second_attribute,
            predicate
        )
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_index index_state
            JOIN pg_class index_relation
              ON index_relation.oid = index_state.indexrelid
            JOIN pg_am access_method
              ON access_method.oid = index_relation.relam
            WHERE index_state.indexrelid = format('public.%I', expected.index_name)::regclass
              AND index_state.indrelid = format('public.%I', expected.table_name)::regclass
              AND index_state.indisvalid
              AND index_state.indisready
              AND NOT index_state.indisunique
              AND index_state.indexprs IS NULL
              AND access_method.amname = 'btree'
              AND index_state.indnkeyatts = expected.key_attribute_count
              AND index_state.indnatts = expected.total_attribute_count
              AND pg_get_indexdef(index_state.indexrelid, 1, TRUE) = expected.first_attribute
              AND pg_get_indexdef(index_state.indexrelid, 2, TRUE) = expected.second_attribute
              AND pg_get_expr(index_state.indpred, index_state.indrelid, FALSE)
                  IS NOT DISTINCT FROM expected.predicate
        ) THEN
            RAISE EXCEPTION
                '0022 did not establish valid semantics for %',
                expected.index_name;
        END IF;
    END LOOP;
END;
$$;
