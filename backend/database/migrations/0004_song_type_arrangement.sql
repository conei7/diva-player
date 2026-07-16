ALTER TABLE songs DROP CONSTRAINT IF EXISTS songs_song_type_check;

ALTER TABLE songs
    ADD CONSTRAINT songs_song_type_check CHECK (
        song_type IN (
            'Original', 'Cover', 'Remix', 'Remaster', 'Arrangement',
            'Mashup', 'MusicPV', 'DramaPV', 'Instrumental', 'Other', 'Unspecified'
        )
    );
