ALTER TABLE pvs
    ADD COLUMN IF NOT EXISTS stats_last_attempt_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stats_last_success_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stats_consecutive_failures INTEGER NOT NULL DEFAULT 0;

ALTER TABLE view_history
    ADD COLUMN IF NOT EXISTS recorded_date DATE;

UPDATE pvs target
SET stats_last_attempt_at = history.last_success_at,
    stats_last_success_at = history.last_success_at,
    stats_consecutive_failures = 0
FROM (
    SELECT song_id, MAX(recorded_at) AS last_success_at
    FROM view_history
    WHERE youtube_views > 0
    GROUP BY song_id
) history
WHERE target.song_id = history.song_id
  AND target.service = 'Youtube'
  AND target.stats_last_success_at IS NULL;

UPDATE pvs target
SET stats_last_attempt_at = history.last_success_at,
    stats_last_success_at = history.last_success_at,
    stats_consecutive_failures = 0
FROM (
    SELECT song_id, MAX(recorded_at) AS last_success_at
    FROM view_history
    WHERE nico_views > 0
    GROUP BY song_id
) history
WHERE target.song_id = history.song_id
  AND target.service = 'NicoNicoDouga'
  AND target.stats_last_success_at IS NULL;

CREATE INDEX IF NOT EXISTS pvs_stats_due_idx
    ON pvs (service, stats_last_success_at ASC NULLS FIRST, song_id)
    WHERE disabled = FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS view_history_song_recorded_date_idx
    ON view_history (song_id, recorded_date)
    WHERE recorded_date IS NOT NULL;
