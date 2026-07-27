-- 検索APIのORDER BY ... DESC NULLS LASTと同じ定義にして、
-- 上位24曲のために全songsをsortする処理を避ける。
CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_favorited_search_idx
    ON songs (favorited_times DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_youtube_views_search_idx
    ON songs (youtube_views DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_nico_views_search_idx
    ON songs (nico_views DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_total_views_search_idx
    ON songs ((COALESCE(youtube_views, 0) + COALESCE(nico_views, 0)) DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_rating_search_idx
    ON songs (rating_score DESC NULLS LAST);

CREATE INDEX CONCURRENTLY IF NOT EXISTS songs_publish_date_search_idx
    ON songs (publish_date DESC NULLS LAST);
