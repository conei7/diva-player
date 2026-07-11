CREATE INDEX IF NOT EXISTS view_history_recorded_song_idx
    ON view_history (recorded_at ASC, song_id);
