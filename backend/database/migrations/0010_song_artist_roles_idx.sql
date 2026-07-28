-- Speed up credit/role searches such as Illustrator, Composer and Lyricist.
CREATE INDEX IF NOT EXISTS song_artists_roles_gin_idx
    ON song_artists USING GIN (roles);
