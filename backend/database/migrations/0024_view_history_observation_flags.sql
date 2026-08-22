-- Distinguish an observed zero from the zero placeholder used when only the
-- other platform was fetched. Legacy positive values are safe to classify as
-- observed; legacy zeroes remain unknown rather than becoming fabricated data.
ALTER TABLE view_history
    ADD COLUMN IF NOT EXISTS youtube_observed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS nico_observed BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE view_history
SET youtube_observed = youtube_views > 0,
    nico_observed = nico_views > 0
WHERE (youtube_views > 0 AND NOT youtube_observed)
   OR (nico_views > 0 AND NOT nico_observed);

ANALYZE view_history;
