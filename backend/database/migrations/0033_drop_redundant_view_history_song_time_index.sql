-- The covering index supplies the same leading keys for per-song lookups.
-- Refuse to remove the legacy index if either deployed definition has drifted.
DO $$
DECLARE
    legacy_index regclass := to_regclass('public.idx_view_history_song_time');
    covering_index regclass := to_regclass('public.view_history_song_recorded_cover_idx');
BEGIN
    IF legacy_index IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am a ON a.oid = c.relam
        WHERE i.indexrelid = legacy_index
          AND i.indrelid = 'public.view_history'::regclass
          AND a.amname = 'btree' AND NOT i.indisunique
          AND i.indnkeyatts = 2 AND i.indnatts = 2 AND i.indpred IS NULL
          AND pg_get_indexdef(i.indexrelid, 1, true) = 'song_id'
          AND pg_get_indexdef(i.indexrelid, 2, true) = 'recorded_at'
    ) THEN
        RAISE EXCEPTION 'Unexpected idx_view_history_song_time definition';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am a ON a.oid = c.relam
        WHERE i.indexrelid = covering_index
          AND i.indrelid = 'public.view_history'::regclass
          AND a.amname = 'btree' AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indnkeyatts = 2 AND i.indnatts = 4 AND i.indpred IS NULL
          AND pg_get_indexdef(i.indexrelid, 1, true) = 'song_id'
          AND pg_get_indexdef(i.indexrelid, 2, true) = 'recorded_at'
          AND pg_get_indexdef(i.indexrelid, 3, true) = 'youtube_views'
          AND pg_get_indexdef(i.indexrelid, 4, true) = 'nico_views'
    ) THEN
        RAISE EXCEPTION 'Valid view_history_song_recorded_cover_idx is required';
    END IF;
END
$$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_view_history_song_time;
