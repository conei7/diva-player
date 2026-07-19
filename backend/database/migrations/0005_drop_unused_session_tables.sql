-- Playback history and recommendation feedback are browser-local.
-- These legacy server-side session tables have never held production rows.
DROP TABLE IF EXISTS session_plays;
DROP TABLE IF EXISTS play_sessions;
