using Microsoft.Extensions.Caching.Memory;
using Npgsql;
using NpgsqlTypes;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace VocadbRecommender.Services;

public sealed record ViewHistoryPoint(
    string Date,
    long? Youtube,
    long? Nico,
    bool Baseline = false);

public sealed record ViewHistoryResponse(
    IReadOnlyList<ViewHistoryPoint> Points,
    ViewHistoryPoint? Baseline,
    string Bucket);

public sealed record SongSearchExecution(
    string ItemsJson,
    int TotalCount,
    long ConnectionMs,
    long CountMs,
    long DataMs,
    long TotalMs,
    bool CacheHit);

public sealed record SearchTagItem(int Id, string Name, string? Category, int SongCount);

public sealed record KnowledgeMapSong(
    int SongId,
    string Name,
    string ArtistString,
    long YoutubeViews,
    long NicoViews,
    string? ThumbUrl);

public sealed record KnowledgeMapCatalog(
    DateTimeOffset GeneratedAt,
    long EligibleSongCount,
    long YoutubeSongCount,
    long YoutubeViews,
    long NicoSongCount,
    long NicoViews,
    IReadOnlyList<KnowledgeMapSong> YoutubeTopSongs,
    IReadOnlyList<KnowledgeMapSong> NicoTopSongs);

/// <summary>PostgreSQL アクセスサービス</summary>
public class DbService
{
    internal static readonly string[] VoiceSynthArtistTypes =
    [
        "Vocaloid", "UTAU", "CeVIO", "SynthesizerV", "NEUTRINO", "VoiSona",
        "Voiceroid", "OtherVoiceSynthesizer", "NewType",
        "ACEVirtualSinger", "VOICEVOX", "AIVOICE"
    ];

    private static readonly string VoiceSynthArtistTypesSql = string.Join(
        ", ",
        VoiceSynthArtistTypes.Select(static artistType => $"'{artistType}'"));

    private sealed record ViewWeightBand(long YoutubeMin, double Weight);
    private sealed record ViewWeightProfile(double FallbackWeight, double MaxWeight, IReadOnlyList<ViewWeightBand> Bands);

    private static string FormatSqlNumber(double value) =>
        value.ToString("R", CultureInfo.InvariantCulture);

    private static string LegacyNicoWeightSql(string youtubeExpression) =>
        $"LEAST(8.0, GREATEST(3.0, 3.0 + (LN(1 + GREATEST(0, {youtubeExpression})) / LN(10.0)) * 0.75))";

    private static string NicoWeightSql(string youtubeExpression, ViewWeightProfile? profile)
    {
        if (profile is null || profile.Bands.Count == 0)
            return LegacyNicoWeightSql(youtubeExpression);

        var value = $"GREATEST(0, COALESCE({youtubeExpression}, 0))";
        var fallback = FormatSqlNumber(Math.Min(profile.MaxWeight, profile.FallbackWeight));
        var bands = profile.Bands.OrderBy(static band => band.YoutubeMin).ToArray();
        var parts = new List<string> { $"CASE WHEN {value} <= 0 THEN {fallback}" };
        var first = bands[0];
        parts.Add($"WHEN {value} < {first.YoutubeMin} THEN {FormatSqlNumber(Math.Min(profile.MaxWeight, first.Weight))}");
        for (var index = 1; index < bands.Length; index++)
        {
            var previous = bands[index - 1];
            var current = bands[index];
            var previousWeight = Math.Min(profile.MaxWeight, previous.Weight);
            var currentWeight = Math.Min(profile.MaxWeight, current.Weight);
            var interpolation = $"({FormatSqlNumber(previousWeight)} + ({FormatSqlNumber(currentWeight - previousWeight)}) * (LN({value} / {previous.YoutubeMin}.0) / LN({current.YoutubeMin}.0 / {previous.YoutubeMin}.0)))";
            parts.Add($"WHEN {value} < {current.YoutubeMin} THEN {interpolation}");
        }
        parts.Add($"ELSE {FormatSqlNumber(Math.Min(profile.MaxWeight, bands[^1].Weight))} END");
        return string.Join(" ", parts);
    }

    private static string WeightedViewsSql(string youtubeExpression, string nicoExpression, ViewWeightProfile? profile) =>
        $"(COALESCE({youtubeExpression}, 0) + ({NicoWeightSql($"COALESCE({youtubeExpression}, 0)", profile)} * COALESCE({nicoExpression}, 0)))";

    private readonly string _connStr;
    private readonly IMemoryCache _cache;
    private readonly ILogger<DbService> _logger;
    private readonly ConcurrentDictionary<string, byte> _searchRefreshes = new();
    private readonly ConcurrentDictionary<string, byte> _trendingRefreshes = new();
    private readonly SemaphoreSlim _knowledgeMapCatalogLock = new(1, 1);
    private sealed record CachedSongSearch(string ItemsJson, int TotalCount, DateTimeOffset FreshUntil);
    private sealed record CachedTrending(string ItemsJson, DateTimeOffset FreshUntil);

    private async Task<ViewWeightProfile?> LoadViewWeightProfileAsync(NpgsqlConnection conn)
    {
        const string cacheKey = "platform_view_weight_profile";
        if (_cache.TryGetValue(cacheKey, out ViewWeightProfile? cached))
            return cached;

        try
        {
            await using var cmd = new NpgsqlCommand(@"
                SELECT p.fallback_weight, p.max_weight, b.youtube_min, b.applied_weight
                FROM platform_view_weight_profiles p
                LEFT JOIN platform_view_weight_bands b ON b.profile_id = p.id
                WHERE p.profile_month = (SELECT MAX(profile_month) FROM platform_view_weight_profiles)
                ORDER BY b.youtube_min", conn);
            var bands = new List<ViewWeightBand>();
            double? fallback = null;
            double maxWeight = 25.0;
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                fallback ??= reader.GetDouble(0);
                maxWeight = reader.GetDouble(1);
                if (!reader.IsDBNull(2) && !reader.IsDBNull(3))
                    bands.Add(new ViewWeightBand(reader.GetInt64(2), reader.GetDouble(3)));
            }

            if (fallback is null)
                return null;
            var profile = new ViewWeightProfile(fallback.Value, maxWeight, bands);
            _cache.Set(cacheKey, profile, TimeSpan.FromMinutes(5));
            return profile;
        }
        catch (PostgresException)
        {
            // The API remains compatible while an older database is being migrated.
            return null;
        }
    }

    public DbService(IConfiguration cfg, IMemoryCache cache, ILogger<DbService> logger)
    {
        _connStr = cfg.GetConnectionString("Postgres")
            ?? throw new InvalidOperationException("ConnectionStrings:Postgres is not configured");
        _cache = cache;
        _logger = logger;
    }

    private NpgsqlConnection Open()
    {
        var conn = new NpgsqlConnection(_connStr);
        conn.Open();
        return conn;
    }

    private async Task<NpgsqlConnection> OpenAsync()
    {
        var conn = new NpgsqlConnection(_connStr);
        await conn.OpenAsync();
        return conn;
    }

    public async Task<DependencyHealth> CheckHealthAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await using var conn = await OpenAsync();
            await using var cmd = new NpgsqlCommand("SELECT 1", conn) { CommandTimeout = 3 };
            await cmd.ExecuteScalarAsync(cancellationToken);
            return new DependencyHealth(true, stopwatch.ElapsedMilliseconds);
        }
        catch (Exception exception)
        {
            return new DependencyHealth(false, stopwatch.ElapsedMilliseconds, exception.GetType().Name);
        }
    }

    public async Task<DiscoveryQualityHealth> CheckDiscoveryQualityAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await using var conn = await OpenAsync();
            await using var cmd = new NpgsqlCommand(@"
                SELECT COUNT(*)::bigint,
                       COALESCE(AVG(quality_score), 0),
                       COALESCE(AVG(CASE WHEN duration_score < 0.5 THEN 1.0 ELSE 0.0 END), 0),
                       COALESCE(AVG(CASE WHEN nico_presence_score > 0 THEN 1.0 ELSE 0.0 END), 0),
                       COALESCE(AVG(CASE WHEN discovery_eligible THEN 1.0 ELSE 0.0 END), 0),
                       MAX(computed_at)
                FROM song_discovery_quality", conn) { CommandTimeout = 3 };
            await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
                return new DiscoveryQualityHealth(false, stopwatch.ElapsedMilliseconds, 0, 0, 0, 0, 0, null, "no result");

            var total = reader.GetInt64(0);
            var averageQuality = reader.GetDouble(1);
            var shortRatio = reader.GetDouble(2);
            var nicoRatio = reader.GetDouble(3);
            var eligibleRatio = reader.GetDouble(4);
            DateTimeOffset? latest = reader.IsDBNull(5) ? null : reader.GetFieldValue<DateTimeOffset>(5);
            var warnings = new List<string>();
            if (total == 0) warnings.Add("empty");
            if (latest is null || DateTimeOffset.UtcNow - latest.Value > TimeSpan.FromHours(48)) warnings.Add("stale");
            if (nicoRatio == 0) warnings.Add("nico_presence_zero");
            if (shortRatio > 0.08) warnings.Add("short_ratio_high");
            if (eligibleRatio < 0.85) warnings.Add("discovery_eligible_ratio_low");
            return new DiscoveryQualityHealth(
                warnings.Count == 0,
                stopwatch.ElapsedMilliseconds,
                total,
                averageQuality,
                shortRatio,
                nicoRatio,
                eligibleRatio,
                latest,
                warnings.Count == 0 ? null : string.Join(',', warnings));
        }
        catch (Exception exception)
        {
            return new DiscoveryQualityHealth(false, stopwatch.ElapsedMilliseconds, 0, 0, 0, 0, 0, null, exception.GetType().Name);
        }
    }

    public async Task<KnowledgeMapCatalog> GetKnowledgeMapCatalogAsync(CancellationToken cancellationToken)
    {
        const string cacheKey = "knowledge_map_catalog_v1";
        if (_cache.TryGetValue(cacheKey, out KnowledgeMapCatalog? cached) && cached is not null)
            return cached;

        await _knowledgeMapCatalogLock.WaitAsync(cancellationToken);
        try
        {
            if (_cache.TryGetValue(cacheKey, out cached) && cached is not null)
                return cached;

            async Task<(long EligibleSongCount, long YoutubeSongCount, long YoutubeViews, long NicoSongCount, long NicoViews)> LoadAggregateAsync()
            {
                await using var conn = await OpenAsync();
                await using var command = new NpgsqlCommand(@"
                    SELECT COUNT(*)::bigint,
                           COUNT(*) FILTER (WHERE s.youtube_views > 0)::bigint,
                           COALESCE(SUM(GREATEST(0, s.youtube_views)), 0)::bigint,
                           COUNT(*) FILTER (WHERE s.nico_views > 0)::bigint,
                           COALESCE(SUM(GREATEST(0, s.nico_views)), 0)::bigint
                    FROM songs s
                    JOIN song_discovery_quality quality ON quality.song_id = s.id
                    WHERE quality.discovery_eligible = TRUE", conn)
                {
                    CommandTimeout = 15,
                };
                await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                if (!await reader.ReadAsync(cancellationToken))
                    throw new InvalidOperationException("Knowledge map catalog query returned no result.");
                return (
                    reader.GetInt64(0),
                    reader.GetInt64(1),
                    reader.GetInt64(2),
                    reader.GetInt64(3),
                    reader.GetInt64(4));
            }

            async Task<IReadOnlyList<KnowledgeMapSong>> LoadTopSongsAsync(string viewColumn)
            {
                await using var conn = await OpenAsync();
                await using var command = new NpgsqlCommand($@"
                    WITH top_songs AS MATERIALIZED (
                        SELECT s.id,
                               s.name,
                               COALESCE(s.artist_string, '') AS artist_string,
                               GREATEST(0, s.youtube_views) AS youtube_views,
                               GREATEST(0, s.nico_views) AS nico_views
                        FROM songs s
                        WHERE s.{viewColumn} > 0
                          AND EXISTS (
                              SELECT 1
                              FROM song_discovery_quality quality
                              WHERE quality.song_id = s.id
                                AND quality.discovery_eligible = TRUE
                          )
                        ORDER BY s.{viewColumn} DESC, s.id
                        LIMIT 120
                    )
                    SELECT top_songs.id,
                           top_songs.name,
                           top_songs.artist_string,
                           top_songs.youtube_views,
                           top_songs.nico_views,
                           songs.raw_json->>'thumbUrl'
                    FROM top_songs
                    JOIN songs ON songs.id = top_songs.id
                    ORDER BY top_songs.{viewColumn} DESC, top_songs.id", conn)
                {
                    CommandTimeout = 15,
                };
                var songs = new List<KnowledgeMapSong>();
                await using var reader = await command.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken))
                {
                    songs.Add(new KnowledgeMapSong(
                        reader.GetInt32(0),
                        reader.GetString(1),
                        reader.GetString(2),
                        reader.GetInt64(3),
                        reader.GetInt64(4),
                        reader.IsDBNull(5) ? null : reader.GetString(5)));
                }
                return songs;
            }

            var aggregateTask = LoadAggregateAsync();
            var youtubeTopSongsTask = LoadTopSongsAsync("youtube_views");
            var nicoTopSongsTask = LoadTopSongsAsync("nico_views");
            await Task.WhenAll(aggregateTask, youtubeTopSongsTask, nicoTopSongsTask);
            var aggregate = await aggregateTask;
            var catalog = new KnowledgeMapCatalog(
                DateTimeOffset.UtcNow,
                aggregate.EligibleSongCount,
                aggregate.YoutubeSongCount,
                aggregate.YoutubeViews,
                aggregate.NicoSongCount,
                aggregate.NicoViews,
                await youtubeTopSongsTask,
                await nicoTopSongsTask);
            _cache.Set(cacheKey, catalog, TimeSpan.FromMinutes(15));
            return catalog;
        }
        finally
        {
            _knowledgeMapCatalogLock.Release();
        }
    }

    public async Task<IReadOnlyList<KnowledgeMapSong>> GetKnowledgeMapSongsAsync(
        int[] songIds,
        CancellationToken cancellationToken)
    {
        if (songIds.Length == 0) return [];

        await using var conn = await OpenAsync();
        await using var command = new NpgsqlCommand(@"
            SELECT s.id,
                   s.name,
                   COALESCE(s.artist_string, ''),
                   GREATEST(0, s.youtube_views),
                   GREATEST(0, s.nico_views),
                   s.raw_json->>'thumbUrl'
            FROM songs s
            JOIN song_discovery_quality quality ON quality.song_id = s.id
            WHERE s.id = ANY($1)
              AND quality.discovery_eligible = TRUE", conn)
        {
            CommandTimeout = 15,
        };
        command.Parameters.Add(new NpgsqlParameter<int[]> { TypedValue = songIds });

        var songs = new List<KnowledgeMapSong>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            songs.Add(new KnowledgeMapSong(
                reader.GetInt32(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetInt64(3),
                reader.GetInt64(4),
                reader.IsDBNull(5) ? null : reader.GetString(5)));
        }
        return songs;
    }

    public async Task<YouTubePlaylistCache?> GetYouTubePlaylistCacheAsync(string playlistId, CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($@"
            SELECT title, video_ids::text, etag, truncated, fetched_at
            FROM youtube_playlist_cache
            WHERE playlist_id = $1", conn);
        cmd.Parameters.AddWithValue(playlistId);
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var ids = JsonSerializer.Deserialize<string[]>(reader.GetString(1)) ?? [];
        var cache = new YouTubePlaylistCache(
            playlistId,
            reader.GetString(0),
            ids,
            reader.IsDBNull(2) ? null : reader.GetString(2),
            reader.GetFieldValue<DateTimeOffset>(4))
        {
            Truncated = reader.GetBoolean(3),
        };
        return cache;
    }

    public async Task UpsertYouTubePlaylistCacheAsync(YouTubePlaylistCache cache, CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO youtube_playlist_cache (playlist_id, title, video_ids, etag, truncated, fetched_at, updated_at)
            VALUES ($1, $2, $3::jsonb, $4, $5, $6, now())
            ON CONFLICT (playlist_id) DO UPDATE SET
                title = EXCLUDED.title,
                video_ids = EXCLUDED.video_ids,
                etag = EXCLUDED.etag,
                truncated = EXCLUDED.truncated,
                fetched_at = EXCLUDED.fetched_at,
                updated_at = now()", conn);
        cmd.Parameters.AddWithValue(cache.PlaylistId);
        cmd.Parameters.AddWithValue(cache.Title);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(cache.VideoIds));
        cmd.Parameters.AddWithValue(cache.Etag is null ? DBNull.Value : cache.Etag);
        cmd.Parameters.AddWithValue(cache.Truncated);
        cmd.Parameters.AddWithValue(cache.FetchedAt);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<Dictionary<string, string>> GetSongsByYouTubeVideoIdsAsync(
        IReadOnlyCollection<string> videoIds,
        CancellationToken cancellationToken)
    {
        if (videoIds.Count == 0) return [];
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT p.pv_id, ((s.raw_json - 'lyrics') || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
                'isSelfCover', s.is_self_cover,
                'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'thumbUrl', COALESCE(s.raw_json->>'thumbUrl', s.raw_json->'pvs'->0->>'thumbUrl')
            )))::text
            FROM pvs p
            JOIN songs s ON s.id = p.song_id
            WHERE p.service = 'Youtube'
              AND p.disabled = FALSE
              AND p.pv_id = ANY($1)", conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = videoIds.ToArray(), NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text });
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result.TryAdd(reader.GetString(0), reader.GetString(1));
        return result;
    }

    public async Task<NicoPlaylistCache?> GetNicoPlaylistCacheAsync(
        string sourceKind,
        string sourceId,
        CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT title, video_ids::text, truncated, fetched_at
            FROM nico_playlist_cache
            WHERE source_kind = $1 AND source_id = $2", conn);
        cmd.Parameters.AddWithValue(sourceKind);
        cmd.Parameters.AddWithValue(sourceId);
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new NicoPlaylistCache(
            sourceKind,
            sourceId,
            reader.GetString(0),
            JsonSerializer.Deserialize<string[]>(reader.GetString(1)) ?? [],
            reader.GetFieldValue<DateTimeOffset>(3))
        {
            Truncated = reader.GetBoolean(2),
        };
    }

    public async Task UpsertNicoPlaylistCacheAsync(NicoPlaylistCache cache, CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO nico_playlist_cache (source_kind, source_id, title, video_ids, truncated, fetched_at, updated_at)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
            ON CONFLICT (source_kind, source_id) DO UPDATE SET
                title = EXCLUDED.title,
                video_ids = EXCLUDED.video_ids,
                truncated = EXCLUDED.truncated,
                fetched_at = EXCLUDED.fetched_at,
                updated_at = now()", conn);
        cmd.Parameters.AddWithValue(cache.SourceKind);
        cmd.Parameters.AddWithValue(cache.SourceId);
        cmd.Parameters.AddWithValue(cache.Title);
        cmd.Parameters.AddWithValue(JsonSerializer.Serialize(cache.VideoIds));
        cmd.Parameters.AddWithValue(cache.Truncated);
        cmd.Parameters.AddWithValue(cache.FetchedAt);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<Dictionary<string, string>> GetSongsByNicoVideoIdsAsync(
        IReadOnlyCollection<string> videoIds,
        CancellationToken cancellationToken)
    {
        if (videoIds.Count == 0) return [];
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT p.pv_id, ((s.raw_json - 'lyrics') || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
                'isSelfCover', s.is_self_cover,
                'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'thumbUrl', COALESCE(s.raw_json->>'thumbUrl', s.raw_json->'pvs'->0->>'thumbUrl')
            )))::text
            FROM pvs p
            JOIN songs s ON s.id = p.song_id
            WHERE p.service = 'NicoNicoDouga'
              AND p.disabled = FALSE
              AND p.pv_id = ANY($1)", conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = videoIds.ToArray(), NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text });
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            result.TryAdd(reader.GetString(0), reader.GetString(1));
        return result;
    }

    public async Task<AudioFeatureHealth> CheckAudioFeatureHealthAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await using var conn = await OpenAsync();
            await using var cmd = new NpgsqlCommand(@"
                WITH high_view_pool AS MATERIALIZED (
                    SELECT s.id,
                           s.song_type,
                           s.raw_json,
                           sf.audio_computed,
                           sf.computed_at
                    FROM songs s
                    LEFT JOIN song_features sf ON sf.song_id = s.id
                    WHERE (s.nico_views >= $1 OR s.youtube_views >= $2)
                ), high_view_summary AS (
                    SELECT COUNT(*)::bigint AS target_count,
                           COUNT(*) FILTER (WHERE audio_computed IS TRUE)::bigint AS computed_count,
                           COUNT(*) FILTER (WHERE audio_computed IS NOT TRUE)::bigint AS pending_count,
                           MAX(computed_at) FILTER (WHERE audio_computed IS TRUE) AS latest_computed_at
                    FROM high_view_pool
                ), actionable_summary AS (
                    SELECT COUNT(*)::bigint AS target_count,
                           COUNT(*) FILTER (WHERE h.audio_computed IS TRUE)::bigint AS computed_count,
                           COUNT(*) FILTER (WHERE h.audio_computed IS NOT TRUE)::bigint AS pending_count
                    FROM high_view_pool h
                    WHERE EXISTS (
                          SELECT 1
                          FROM pvs p
                          WHERE p.song_id = h.id
                            AND p.disabled = FALSE
                            AND p.pv_type IN ('Original', 'Reprint')
                      )
                      AND (
                          h.song_type = 'Original'
                          OR (
                              h.song_type <> 'Original'
                              AND h.raw_json->>'originalVersionId' IS NOT NULL
                              AND EXISTS (
                                  SELECT 1
                                  FROM song_artists sa_cover
                                  JOIN song_artists sa_orig ON sa_cover.artist_id = sa_orig.artist_id
                                  WHERE sa_cover.song_id = h.id
                                    AND sa_cover.is_producer = TRUE
                                    AND sa_orig.song_id = (h.raw_json->>'originalVersionId')::int
                                    AND sa_orig.is_producer = TRUE
                              )
                          )
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM song_artists sa_vocal
                          JOIN artists a_vocal ON a_vocal.id = sa_vocal.artist_id
                          WHERE sa_vocal.song_id = h.id
                            AND sa_vocal.is_vocalist = TRUE
                            AND a_vocal.artist_type IN (" + VoiceSynthArtistTypesSql + @")
                      )
                )
                SELECT high_view.target_count,
                       high_view.computed_count,
                       high_view.pending_count,
                       high_view.latest_computed_at,
                       actionable.target_count,
                       actionable.computed_count,
                       actionable.pending_count
                FROM high_view_summary high_view
                CROSS JOIN actionable_summary actionable", conn)
            {
                // The actionable boundary joins the large credit/PV tables;
                // keep it separate from the 3s liveness query and allow a
                // cold-cache probe to finish without marking the API broken.
                CommandTimeout = 20
            };
            cmd.Parameters.AddWithValue(5_000);
            cmd.Parameters.AddWithValue(50_000);
            await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
                return new AudioFeatureHealth(false, stopwatch.ElapsedMilliseconds, 0, 0, 0, 0, 0, 0, 0, 0, null, null, "no result");

            var targetCount = reader.GetInt64(0);
            var computedCount = reader.GetInt64(1);
            var pendingCount = reader.GetInt64(2);
            DateTimeOffset? latest = reader.IsDBNull(3) ? null : reader.GetFieldValue<DateTimeOffset>(3);
            var actionableTargetCount = reader.GetInt64(4);
            var actionableComputedCount = reader.GetInt64(5);
            var actionablePendingCount = reader.GetInt64(6);
            double? latestAgeHours = latest is null
                ? null
                : Math.Max(0, (DateTimeOffset.UtcNow - latest.Value).TotalHours);
            var warnings = new List<string>();
            if (targetCount == 0) warnings.Add("empty");
            if (pendingCount > 0 && (latestAgeHours is null || latestAgeHours > 72)) warnings.Add("stale");
            return new AudioFeatureHealth(
                warnings.Count == 0,
                stopwatch.ElapsedMilliseconds,
                targetCount,
                computedCount,
                pendingCount,
                targetCount == 0 ? 0 : computedCount / (double)targetCount,
                actionableTargetCount,
                actionableComputedCount,
                actionablePendingCount,
                actionableTargetCount == 0 ? 0 : actionableComputedCount / (double)actionableTargetCount,
                latest,
                latestAgeHours,
                warnings.Count == 0 ? null : string.Join(',', warnings));
        }
        catch (Exception exception)
        {
            return new AudioFeatureHealth(false, stopwatch.ElapsedMilliseconds, 0, 0, 0, 0, 0, 0, 0, 0, null, null, exception.GetType().Name);
        }
    }

    public async Task<SongSearchExecution> SearchSongsAsync(
        string? query,
        List<int>? artistIds,
        List<int>? anyArtistIds,
        List<List<int>>? artistIdGroups,
        string? artistRole,
        List<string>? songTypes,
        string sort,
        string order,
        int start,
        int maxResults,
        int? publishYearFrom = null,
        int? publishYearTo = null,
        int? lengthMinSeconds = null,
        int? lengthMaxSeconds = null,
        string? pvService = null,
        string? audioComputed = null,
        double? bpmFrom = null,
        double? bpmTo = null,
        List<string>? instrumentKeys = null,
        string instrumentMatchMode = "all",
        long? minYoutubeViews = null,
        long? minNicoViews = null,
        bool onlyWithPVs = false,
        List<string>? excludedSongTypes = null,
        bool voiceSynthOnly = false,
        bool discoveryOnly = false,
        long? maxYoutubeViews = null,
        long? maxNicoViews = null,
        int? minFavoritedTimes = null,
        int? maxFavoritedTimes = null,
        List<int>? tagIds = null,
        string tagMatchMode = "all",
        int? creditArtistId = null,
        string? creditArtistRole = null,
        int randomSeed = 0,
        List<int>? exactVocalistIds = null,
        string? lyricsQuery = null,
        bool selfCoverOnly = false,
        bool chorusOnly = false,
        bool forceRefresh = false)
    {
        var totalStopwatch = Stopwatch.StartNew();
        var cacheKey = "song-search:v2:" + JsonSerializer.Serialize(new
        {
            query = query?.Trim().ToLowerInvariant(),
            artistIds = artistIds is { Count: > 0 } ? artistIds : null,
            anyArtistIds = anyArtistIds is { Count: > 0 } ? anyArtistIds : null,
            artistIdGroups = artistIdGroups is { Count: > 0 } ? artistIdGroups : null,
            artistRole,
            songTypes = songTypes is { Count: > 0 } ? songTypes : null,
            sort,
            order,
            start,
            maxResults,
            publishYearFrom,
            publishYearTo,
            lengthMinSeconds,
            lengthMaxSeconds,
            pvService,
            audioComputed,
            bpmFrom,
            bpmTo,
            instrumentKeys = instrumentKeys is { Count: > 0 } ? instrumentKeys : null,
            instrumentMatchMode,
            minYoutubeViews,
            minNicoViews,
            maxYoutubeViews,
            maxNicoViews,
            minFavoritedTimes,
            maxFavoritedTimes,
            tagIds = tagIds is { Count: > 0 } ? tagIds : null,
            tagMatchMode,
            creditArtistId,
            creditArtistRole,
            randomSeed,
            exactVocalistIds = exactVocalistIds is { Count: > 0 } ? exactVocalistIds : null,
            lyricsQuery = NormalizeLyricsQuery(lyricsQuery),
            selfCoverOnly,
            chorusOnly,
            onlyWithPVs,
            excludedSongTypes = excludedSongTypes is { Count: > 0 } ? excludedSongTypes : null,
            voiceSynthOnly,
            discoveryOnly,
        });
        if (!forceRefresh && _cache.TryGetValue(cacheKey, out CachedSongSearch? cached) && cached is not null)
        {
            if (cached.FreshUntil <= DateTimeOffset.UtcNow && _searchRefreshes.TryAdd(cacheKey, 0))
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await SearchSongsAsync(
                            query, artistIds, anyArtistIds, artistIdGroups, artistRole,
                            songTypes, sort, order, start, maxResults,
                            publishYearFrom, publishYearTo, lengthMinSeconds, lengthMaxSeconds,
                            pvService, audioComputed, bpmFrom, bpmTo, instrumentKeys, instrumentMatchMode,
                            minYoutubeViews, minNicoViews,
                            onlyWithPVs, excludedSongTypes, voiceSynthOnly, discoveryOnly,
                            maxYoutubeViews, maxNicoViews, minFavoritedTimes, maxFavoritedTimes,
                            tagIds, tagMatchMode, creditArtistId, creditArtistRole, randomSeed,
                            exactVocalistIds, lyricsQuery, selfCoverOnly, chorusOnly,
                            forceRefresh: true);
                    }
                    catch (Exception exception)
                    {
                        _logger.LogWarning(
                            exception,
                            "song_search_cache_refresh_failed key={CacheKey}",
                            cacheKey);
                    }
                    finally
                    {
                        _searchRefreshes.TryRemove(cacheKey, out _);
                    }
                });
            }
            return new SongSearchExecution(
                cached.ItemsJson,
                cached.TotalCount,
                0,
                0,
                0,
                totalStopwatch.ElapsedMilliseconds,
                true);
        }

        var connectionStopwatch = Stopwatch.StartNew();
        using var conn = Open();
        connectionStopwatch.Stop();
        
        // --- 1. WHERE 句の構築 ---
        var conditions = new List<string>();
        var paramValues = new List<object>();
        int paramIndex = 1;

        if (!string.IsNullOrWhiteSpace(query))
        {
            conditions.Add($"(name ILIKE ${paramIndex} OR name_en ILIKE ${paramIndex} OR artist_string ILIKE ${paramIndex})");
            paramValues.Add($"%{query}%");
            paramIndex++;
        }

        if (songTypes != null && songTypes.Count > 0)
        {
            var typeParams = new List<string>();
            foreach (var st in songTypes)
            {
                typeParams.Add($"${paramIndex}");
                paramValues.Add(st);
                paramIndex++;
            }
            conditions.Add($"COALESCE(NULLIF(raw_json->>'songType', ''), song_type, 'Unspecified') IN ({string.Join(", ", typeParams)})");
        }

        if (excludedSongTypes != null && excludedSongTypes.Count > 0)
        {
            var typeParams = new List<string>();
            foreach (var st in excludedSongTypes)
            {
                typeParams.Add($"${paramIndex}");
                paramValues.Add(st);
                paramIndex++;
            }
            conditions.Add($"COALESCE(NULLIF(raw_json->>'songType', ''), song_type, 'Unspecified') NOT IN ({string.Join(", ", typeParams)})");
        }

        if (artistIds != null && artistIds.Count > 0)
        {
            foreach (var aId in artistIds)
            {
                conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.artist_id = ${paramIndex})");
                paramValues.Add(aId);
                paramIndex++;
            }
        }

        var normalizedLyricsQuery = NormalizeLyricsQuery(lyricsQuery);
        if (!string.IsNullOrWhiteSpace(normalizedLyricsQuery))
        {
            conditions.Add($@"EXISTS (
                SELECT 1 FROM song_lyrics sl
                WHERE sl.song_id = songs.id
                  AND (sl.search_text ILIKE ${paramIndex} OR ${paramIndex + 1} <% sl.search_text)
            )");
            paramValues.Add($"%{normalizedLyricsQuery}%");
            paramValues.Add(normalizedLyricsQuery);
            paramIndex += 2;
        }

        if (selfCoverOnly)
        {
            conditions.Add("songs.is_self_cover = TRUE");
        }

        if (chorusOnly)
        {
            conditions.Add(@"EXISTS (
                SELECT 1 FROM song_audio_analysis chorus_analysis
                WHERE chorus_analysis.song_id = songs.id
                  AND chorus_analysis.chorus_start_seconds IS NOT NULL
                  AND chorus_analysis.chorus_confidence >= 0.18
            )");
        }

        if (!string.IsNullOrWhiteSpace(artistRole))
        {
            conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.roles @> ARRAY[${paramIndex}]::text[])");
            paramValues.Add(artistRole);
            paramIndex++;
        }

        if (anyArtistIds != null && anyArtistIds.Count > 0)
        {
            conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.artist_id = ANY(${paramIndex}))");
            paramValues.Add(anyArtistIds.Distinct().ToArray());
            paramIndex++;
        }

        if (artistIdGroups != null)
        {
            foreach (var artistIdGroup in artistIdGroups.Where(group => group.Count > 0))
            {
                conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.artist_id = ANY(${paramIndex}))");
                paramValues.Add(artistIdGroup.Distinct().ToArray());
                paramIndex++;
            }
        }

        if (exactVocalistIds != null && exactVocalistIds.Count > 0)
        {
            conditions.Add($"NOT EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.is_vocalist AND (sa.artist_id IS NULL OR NOT (sa.artist_id = ANY(${paramIndex}))))");
            paramValues.Add(exactVocalistIds.Distinct().ToArray());
            paramIndex++;
        }

        if (publishYearFrom.HasValue)
        {
            conditions.Add($"publish_date >= make_date(${paramIndex}, 1, 1)");
            paramValues.Add(publishYearFrom.Value);
            paramIndex++;
        }

        if (publishYearTo.HasValue)
        {
            conditions.Add($"publish_date < make_date(${paramIndex} + 1, 1, 1)");
            paramValues.Add(publishYearTo.Value);
            paramIndex++;
        }

        if (lengthMinSeconds.HasValue)
        {
            conditions.Add($"length_seconds >= ${paramIndex}");
            paramValues.Add(lengthMinSeconds.Value);
            paramIndex++;
        }

        if (lengthMaxSeconds.HasValue)
        {
            conditions.Add($"length_seconds <= ${paramIndex}");
            paramValues.Add(lengthMaxSeconds.Value);
            paramIndex++;
        }

        if (minYoutubeViews is > 0)
        {
            conditions.Add($"youtube_views >= ${paramIndex}");
            paramValues.Add(minYoutubeViews.Value);
            paramIndex++;
        }

        if (minNicoViews is > 0)
        {
            conditions.Add($"nico_views >= ${paramIndex}");
            paramValues.Add(minNicoViews.Value);
            paramIndex++;
        }

        if (maxYoutubeViews.HasValue)
        {
            conditions.Add($"youtube_views <= ${paramIndex}");
            paramValues.Add(maxYoutubeViews.Value);
            paramIndex++;
        }

        if (maxNicoViews.HasValue)
        {
            conditions.Add($"nico_views <= ${paramIndex}");
            paramValues.Add(maxNicoViews.Value);
            paramIndex++;
        }

        if (minFavoritedTimes.HasValue)
        {
            conditions.Add($"favorited_times >= ${paramIndex}");
            paramValues.Add(minFavoritedTimes.Value);
            paramIndex++;
        }

        if (maxFavoritedTimes.HasValue)
        {
            conditions.Add($"favorited_times <= ${paramIndex}");
            paramValues.Add(maxFavoritedTimes.Value);
            paramIndex++;
        }

        if (tagIds is { Count: > 0 })
        {
            if (tagMatchMode == "any")
            {
                conditions.Add($"EXISTS (SELECT 1 FROM song_tags st WHERE st.song_id = songs.id AND st.tag_id = ANY(${paramIndex}))");
                paramValues.Add(tagIds.Distinct().ToArray());
                paramIndex++;
            }
            else
            {
                foreach (var tagId in tagIds.Distinct())
                {
                    conditions.Add($"EXISTS (SELECT 1 FROM song_tags st WHERE st.song_id = songs.id AND st.tag_id = ${paramIndex})");
                    paramValues.Add(tagId);
                    paramIndex++;
                }
            }
        }

        if (creditArtistId.HasValue)
        {
            var roleCondition = string.IsNullOrWhiteSpace(creditArtistRole)
                ? string.Empty
                : $" AND sa.roles @> ARRAY[${paramIndex + 1}]::text[]";
            conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa WHERE sa.song_id = songs.id AND sa.artist_id = ${paramIndex}{roleCondition})");
            paramValues.Add(creditArtistId.Value);
            paramIndex++;
            if (!string.IsNullOrWhiteSpace(creditArtistRole))
            {
                paramValues.Add(creditArtistRole);
                paramIndex++;
            }
        }

        if (onlyWithPVs)
        {
            conditions.Add("EXISTS (SELECT 1 FROM pvs p WHERE p.song_id = songs.id AND p.disabled = FALSE)");
        }

        if (voiceSynthOnly)
        {
            conditions.Add($"EXISTS (SELECT 1 FROM song_artists sa JOIN artists a ON a.id = sa.artist_id WHERE sa.song_id = songs.id AND sa.is_vocalist = TRUE AND a.artist_type IN ({VoiceSynthArtistTypesSql}))");
        }

        if (discoveryOnly)
        {
            conditions.Add("EXISTS (SELECT 1 FROM song_discovery_quality dq WHERE dq.song_id = songs.id AND dq.discovery_eligible = TRUE)");
        }

        if (!string.IsNullOrWhiteSpace(pvService) && pvService != "any")
        {
            if (pvService == "youtube")
            {
                conditions.Add("EXISTS (SELECT 1 FROM pvs p WHERE p.song_id = songs.id AND p.disabled = FALSE AND p.service = 'Youtube')");
            }
            else if (pvService == "niconico")
            {
                conditions.Add("EXISTS (SELECT 1 FROM pvs p WHERE p.song_id = songs.id AND p.disabled = FALSE AND p.service = 'NicoNicoDouga')");
            }
            else if (pvService == "both")
            {
                conditions.Add("EXISTS (SELECT 1 FROM pvs p WHERE p.song_id = songs.id AND p.disabled = FALSE AND p.service = 'Youtube')");
                conditions.Add("EXISTS (SELECT 1 FROM pvs p WHERE p.song_id = songs.id AND p.disabled = FALSE AND p.service = 'NicoNicoDouga')");
            }
        }

        if (!string.IsNullOrWhiteSpace(audioComputed) && audioComputed != "any")
        {
            if (audioComputed == "yes")
            {
                conditions.Add("EXISTS (SELECT 1 FROM song_features sf WHERE sf.song_id = songs.id AND sf.audio_computed IS TRUE)");
            }
            else if (audioComputed == "no")
            {
                conditions.Add("NOT EXISTS (SELECT 1 FROM song_features sf WHERE sf.song_id = songs.id AND sf.audio_computed IS TRUE)");
            }
        }

        if (bpmFrom.HasValue || bpmTo.HasValue)
        {
            var primaryRange = new List<string>();
            var alternativeRange = new List<string>();
            if (bpmFrom.HasValue)
            {
                primaryRange.Add($"aa.bpm >= ${paramIndex}");
                alternativeRange.Add($"aa.bpm_alternative >= ${paramIndex}");
                paramValues.Add((float)bpmFrom.Value);
                paramIndex++;
            }
            if (bpmTo.HasValue)
            {
                primaryRange.Add($"aa.bpm <= ${paramIndex}");
                alternativeRange.Add($"aa.bpm_alternative <= ${paramIndex}");
                paramValues.Add((float)bpmTo.Value);
                paramIndex++;
            }
            var tempoRange = $"(({string.Join(" AND ", primaryRange)}) OR ({string.Join(" AND ", alternativeRange)}))";
            conditions.Add($"EXISTS (SELECT 1 FROM song_audio_analysis aa WHERE aa.song_id = songs.id AND aa.bpm_confidence >= 0.35 AND {tempoRange})");
        }

        if (instrumentKeys is { Count: > 0 })
        {
            if (instrumentMatchMode == "any")
            {
                conditions.Add($"EXISTS (SELECT 1 FROM song_audio_instruments sai WHERE sai.song_id = songs.id AND sai.instrument_key = ANY(${paramIndex}) AND sai.score >= 0.08)");
                paramValues.Add(instrumentKeys.Distinct().ToArray());
                paramIndex++;
            }
            else
            {
                foreach (var instrumentKey in instrumentKeys.Distinct())
                {
                    conditions.Add($"EXISTS (SELECT 1 FROM song_audio_instruments sai WHERE sai.song_id = songs.id AND sai.instrument_key = ${paramIndex} AND sai.score >= 0.08)");
                    paramValues.Add(instrumentKey);
                    paramIndex++;
                }
            }
        }

        string whereClause = conditions.Count > 0 ? "WHERE " + string.Join(" AND ", conditions) : "";
        bool hasFilter = conditions.Count > 0;

        // --- 2. ORDER BY 句の構築 ---
        var viewWeightProfile = sort == "TotalViews"
            ? await LoadViewWeightProfileAsync(conn)
            : null;
        string orderBy = sort switch
        {
            "YoutubeViews" => "youtube_views",
            "NicoViews" => "nico_views",
            "TotalViews" => WeightedViewsSql("youtube_views", "nico_views", viewWeightProfile),
            "FavoritedTimes" => "favorited_times",
            "RatingScore" => "rating_score",
            "PublishDate" => "publish_date",
            "AdditionDate" => "id",
            "Name" => "name",
            "Random" => $"hashint4(id # {randomSeed})",
            _ => "favorited_times"
        };
        string orderDir = (order.ToLower() == "asc") ? "ASC" : "DESC";

        // --- 3. Total Count (フィルターなしは推定値で高速化) ---
        var countStopwatch = Stopwatch.StartNew();
        int totalCount;
        if (!hasFilter)
        {
            await using var estCmd = new NpgsqlCommand(
                "SELECT COALESCE(reltuples, 0)::int FROM pg_class WHERE relname = 'songs'", conn);
            totalCount = Convert.ToInt32(await estCmd.ExecuteScalarAsync() ?? 0);
            if (totalCount == 0) totalCount = 1; // 推定値0の場合は1にして処理続行
        }
        else
        {
            string countSql = $"SELECT COUNT(*) FROM songs {whereClause}";
            await using var countCmd = new NpgsqlCommand(countSql, conn);
            foreach (var v in paramValues) countCmd.Parameters.AddWithValue(v);
            totalCount = Convert.ToInt32(await countCmd.ExecuteScalarAsync() ?? 0);
            if (totalCount == 0)
            {
                countStopwatch.Stop();
                var emptyResult = new CachedSongSearch(
                    "[]",
                    0,
                    DateTimeOffset.UtcNow.AddMinutes(1));
                _cache.Set(cacheKey, emptyResult, TimeSpan.FromHours(6));
                return new SongSearchExecution(
                    emptyResult.ItemsJson,
                    emptyResult.TotalCount,
                    connectionStopwatch.ElapsedMilliseconds,
                    countStopwatch.ElapsedMilliseconds,
                    0,
                    totalStopwatch.ElapsedMilliseconds,
                    false);
            }
        }
        countStopwatch.Stop();

        // --- 4. データ取得 (行単位で読み取り、C#側でJSON配列構築) ---
        var dataStopwatch = Stopwatch.StartNew();
        string dataSql = $@"
            SELECT (raw_json - 'lyrics') || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', youtube_views,
                'nicoViews', nico_views,
                'isSelfCover', is_self_cover,
                'hasLyrics', EXISTS (SELECT 1 FROM song_lyrics sl WHERE sl.song_id = songs.id),
                'audioComputed', EXISTS (
                    SELECT 1 FROM song_features sf
                    WHERE sf.song_id = songs.id AND sf.audio_computed IS TRUE
                ),
                'bpm', (SELECT aa.bpm FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'bpmAlternative', (SELECT aa.bpm_alternative FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'bpmConfidence', (SELECT aa.bpm_confidence FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'musicalKey', (SELECT aa.musical_key FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'keyMode', (SELECT aa.key_mode FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'keyConfidence', (SELECT aa.key_confidence FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                'audioInstruments', COALESCE((
                    SELECT jsonb_agg(
                        jsonb_build_object('key', sai.instrument_key, 'score', sai.score)
                        ORDER BY sai.rank
                    )
                    FROM song_audio_instruments sai
                    WHERE sai.song_id = songs.id AND sai.score >= 0.08
                ), '[]'::jsonb),
                'thumbUrl', COALESCE(raw_json->>'thumbUrl', raw_json->'pvs'->0->>'thumbUrl')
            ))
            FROM songs
            {whereClause}
            ORDER BY {orderBy} {orderDir} NULLS LAST
            OFFSET ${paramIndex} LIMIT ${paramIndex + 1}";

        await using var dataCmd = new NpgsqlCommand(dataSql, conn);
        foreach (var v in paramValues) dataCmd.Parameters.AddWithValue(v);
        dataCmd.Parameters.AddWithValue(start);
        dataCmd.Parameters.AddWithValue(maxResults);

        var items = new List<string>();
        await using var reader = await dataCmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            items.Add(reader.GetString(0));
        }

        var itemsJson = items.Count > 0 ? "[" + string.Join(",", items) + "]" : "[]";
        dataStopwatch.Stop();
        var result = new CachedSongSearch(
            itemsJson,
            totalCount,
            DateTimeOffset.UtcNow.AddMinutes(1));
        _cache.Set(cacheKey, result, TimeSpan.FromHours(6));
        return new SongSearchExecution(
            result.ItemsJson,
            result.TotalCount,
            connectionStopwatch.ElapsedMilliseconds,
            countStopwatch.ElapsedMilliseconds,
            dataStopwatch.ElapsedMilliseconds,
            totalStopwatch.ElapsedMilliseconds,
            false);
    }

    private static string? NormalizeLyricsQuery(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        return string.Join(' ', normalized.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    public async Task<IReadOnlyList<SearchTagItem>> SearchTagsAsync(
        string query,
        int maxResults,
        CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT t.id, t.name, t.category, COUNT(st.song_id)::int AS song_count
            FROM tags t
            JOIN song_tags st ON st.tag_id = t.id
            WHERE t.name ILIKE $1
            GROUP BY t.id, t.name, t.category
            ORDER BY similarity(lower(t.name), lower($2)) DESC, song_count DESC, t.name
            LIMIT $3", conn);
        cmd.Parameters.AddWithValue($"%{query}%");
        cmd.Parameters.AddWithValue(query);
        cmd.Parameters.AddWithValue(maxResults);
        var items = new List<SearchTagItem>();
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
            items.Add(new SearchTagItem(reader.GetInt32(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetInt32(3)));
        return items;
    }

    /// <summary>
    /// Returns the full cached VocaDB payload for a ranked ID list. This keeps
    /// generated playlists from issuing one external request per candidate.
    /// </summary>
    public async Task<Dictionary<int, string>> GetSongsJsonByIdsAsync(IEnumerable<int> songIds)
    {
        var ids = songIds.Where(id => id > 0).Distinct().ToArray();
        if (ids.Length == 0) return [];

        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT id,
                   ((COALESCE(raw_json, '{}'::jsonb) - 'lyrics') || jsonb_strip_nulls(jsonb_build_object(
                       'youtubeViews', youtube_views,
                       'nicoViews', nico_views,
                       'isSelfCover', is_self_cover,
                       'hasLyrics', EXISTS (SELECT 1 FROM song_lyrics sl WHERE sl.song_id = songs.id),
                       'audioComputed', EXISTS (
                           SELECT 1 FROM song_features sf
                           WHERE sf.song_id = songs.id AND sf.audio_computed IS TRUE
                       ),
                       'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                       'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                       'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = songs.id),
                       'thumbUrl', COALESCE(raw_json->>'thumbUrl', raw_json->'pvs'->0->>'thumbUrl')
                   )))::text
            FROM songs
            WHERE id = ANY($1)", conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = ids, NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Integer });

        var result = new Dictionary<int, string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result[reader.GetInt32(0)] = reader.GetString(1);
        return result;
    }

    /// <summary>
    /// Returns the compact playback/card payload needed after recommendation
    /// ranking. Large VocaDB-only fields are omitted and tags/artists are reduced
    /// to the fields consumed by the browser.
    /// </summary>
    public async Task<Dictionary<int, string>> GetSongsCardJsonByIdsAsync(IEnumerable<int> songIds)
    {
        var ids = songIds.Where(id => id > 0).Distinct().Take(100).ToArray();
        if (ids.Length == 0) return [];

        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            SELECT s.id,
                   jsonb_strip_nulls(jsonb_build_object(
                       'id', s.id,
                       'name', COALESCE(s.raw_json->'name', to_jsonb(s.name)),
                       'defaultName', COALESCE(s.raw_json->'defaultName', to_jsonb(s.name)),
                       'defaultNameLanguage', COALESCE(s.raw_json->'defaultNameLanguage', '""Default""'::jsonb),
                       'artistString', to_jsonb(COALESCE(s.artist_string, '')),
                       'createDate', COALESCE(s.raw_json->'createDate', '""""'::jsonb),
                       'publishDate', COALESCE(s.raw_json->'publishDate', to_jsonb(s.publish_date)),
                       'favoritedTimes', COALESCE(to_jsonb(s.favorited_times), '0'::jsonb),
                       'lengthSeconds', COALESCE(to_jsonb(s.length_seconds), '0'::jsonb),
                       'ratingScore', COALESCE(s.raw_json->'ratingScore', '0'::jsonb),
                       'songType', COALESCE(s.raw_json->'songType', to_jsonb(COALESCE(s.song_type, 'Unspecified'))),
                       'status', COALESCE(s.raw_json->'status', '""Finished""'::jsonb),
                       'version', COALESCE(s.raw_json->'version', '0'::jsonb),
                       'originalVersionId', s.raw_json->'originalVersionId',
                       'pvServices', COALESCE(s.raw_json->'pvServices', '""""'::jsonb),
                       'youtubeViews', s.youtube_views,
                       'nicoViews', s.nico_views,
                       'isSelfCover', s.is_self_cover,
                       'hasLyrics', EXISTS (SELECT 1 FROM song_lyrics sl WHERE sl.song_id = s.id),
                       'audioComputed', EXISTS (
                           SELECT 1 FROM song_features sf
                           WHERE sf.song_id = s.id AND sf.audio_computed IS TRUE
                       ),
                       'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                       'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                       'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                       'thumbUrl', COALESCE(s.raw_json->'thumbUrl', s.raw_json->'pvs'->0->'thumbUrl'),
                       'artists', COALESCE((
                           SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                               'id', credit->'id',
                               'name', credit->'name',
                               'roles', credit->'roles',
                               'effectiveRoles', credit->'effectiveRoles',
                               'categories', credit->'categories',
                               'isCustomName', credit->'isCustomName',
                               'isSupport', credit->'isSupport',
                               'artist', CASE
                                   WHEN jsonb_typeof(credit->'artist') = 'object' THEN
                                       jsonb_strip_nulls(jsonb_build_object(
                                           'id', credit->'artist'->'id',
                                           'name', credit->'artist'->'name',
                                           'artistType', credit->'artist'->'artistType'
                                       ))
                                   ELSE NULL
                               END
                           )))
                           FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(s.raw_json->'artists') = 'array'
                                   THEN s.raw_json->'artists' ELSE '[]'::jsonb END
                           ) credit
                       ), '[]'::jsonb),
                       'pvs', COALESCE((
                           SELECT jsonb_agg(pv - 'description')
                           FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(s.raw_json->'pvs') = 'array'
                                   THEN s.raw_json->'pvs' ELSE '[]'::jsonb END
                           ) pv
                       ), '[]'::jsonb),
                       'tags', COALESCE((
                           SELECT jsonb_agg(jsonb_build_object(
                               'tag', jsonb_build_object('name', tag_entry->'tag'->'name')
                           ))
                           FROM jsonb_array_elements(
                               CASE WHEN jsonb_typeof(s.raw_json->'tags') = 'array'
                                   THEN s.raw_json->'tags' ELSE '[]'::jsonb END
                           ) tag_entry
                           WHERE tag_entry->'tag'->>'name' IS NOT NULL
                       ), '[]'::jsonb)
                   ))::text
            FROM songs s
            WHERE s.id = ANY($1)", conn);
        cmd.Parameters.Add(new NpgsqlParameter { Value = ids, NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Integer });

        var result = new Dictionary<int, string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result[reader.GetInt32(0)] = reader.GetString(1);
        return result;
    }

    // ---- 楽曲情報 -------------------------------------------------

    public async Task<SongInfo?> GetSongInfoAsync(int songId)
    {
        var infos = await GetSongInfoBatchAsync([songId]);
        return infos.FirstOrDefault();
    }

    public async Task<SongInfo[]> GetSongInfoBatchAsync(IEnumerable<int> songIds)
    {
        var ids = songIds.Distinct().ToArray();
        if (ids.Length == 0) return [];

        var result = new List<SongInfo>(ids.Length);
        var missingIds = new List<int>(ids.Length);
        foreach (var id in ids)
        {
            if (_cache.TryGetValue($"song:{id}", out SongInfo? cached) && cached is not null)
                result.Add(cached);
            else
                missingIds.Add(id);
        }

        if (missingIds.Count == 0)
            return [.. result];

        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($@"
            SELECT s.id, s.name, s.artist_string, s.length_seconds,
                   s.song_type, s.favorited_times,
                   sf.state_cluster,
                   ARRAY(
                       SELECT artist_id FROM song_artists
                       WHERE song_id = s.id AND is_producer = TRUE
                   ) AS producer_ids,
                   ARRAY(
                       SELECT artist_id FROM song_artists
                       WHERE song_id = s.id AND is_vocalist = TRUE
                   ) AS vocalist_ids,
                   s.youtube_views, s.nico_views, s.publish_date,
                   ARRAY(
                       SELECT st.tag_id
                       FROM song_tags st
                       JOIN tags t ON t.id = st.tag_id
                       WHERE st.song_id = s.id
                         AND COALESCE(t.category, '') <> 'Vocalists'
                   ) AS related_tag_ids,
                   ARRAY(
                       SELECT (album ->> 'id')::int
                       FROM jsonb_array_elements(
                           CASE
                               WHEN jsonb_typeof(s.raw_json -> 'albums') = 'array'
                                   THEN s.raw_json -> 'albums'
                               ELSE '[]'::jsonb
                           END
                       ) album
                       WHERE album ->> 'id' ~ '^[0-9]+$'
                   ) AS album_ids,
                   EXISTS (
                       SELECT 1 FROM song_artists sa
                       JOIN artists a ON a.id = sa.artist_id
                       WHERE sa.song_id = s.id
                         AND sa.is_vocalist = TRUE
                         AND a.artist_type IN ({VoiceSynthArtistTypesSql})
                   ) AS has_core_voice_synth,
                   EXISTS (
                       SELECT 1 FROM pvs p
                       WHERE p.song_id = s.id AND p.disabled = FALSE
                   ) AS has_playable_pv,
                   COALESCE(q.discovery_eligible, FALSE) AS discovery_eligible
                   ,COALESCE(q.quality_score, 0.5)::double precision AS quality_score
                   ,EXISTS (
                       SELECT 1 FROM song_features audio_features
                       WHERE audio_features.song_id = s.id
                         AND audio_features.audio_computed IS TRUE
                   ) AS has_audio_features
                   ,EXISTS (
                       SELECT 1 FROM pvs original_pv
                       WHERE original_pv.song_id = s.id
                         AND original_pv.disabled = FALSE
                         AND original_pv.pv_type = 'Original'
                   ) AS has_original_pv
            FROM songs s
            LEFT JOIN song_features sf ON sf.song_id = s.id
            LEFT JOIN song_discovery_quality q ON q.song_id = s.id
            WHERE s.id = ANY($1)", conn);
        cmd.Parameters.AddWithValue(missingIds.ToArray());

        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var info = new SongInfo(
                Id:             reader.GetInt32(0),
                Name:           reader.GetString(1),
                ArtistString:   reader.IsDBNull(2) ? "" : reader.GetString(2),
                LengthSeconds:  reader.IsDBNull(3) ? 0 : reader.GetInt32(3),
                SongType:       reader.IsDBNull(4) ? "" : reader.GetString(4),
                FavoritedTimes: reader.IsDBNull(5) ? 0 : reader.GetInt32(5),
                StateCluster:   reader.IsDBNull(6) ? -1 : reader.GetInt32(6),
                ProducerIds:    reader.IsDBNull(7) ? [] : (int[])reader.GetValue(7),
                VocalistIds:    reader.IsDBNull(8) ? [] : (int[])reader.GetValue(8),
                YoutubeViews:   reader.IsDBNull(9) ? 0 : reader.GetInt64(9),
                NicoViews:      reader.IsDBNull(10) ? 0 : reader.GetInt64(10),
                PublishDate:    reader.IsDBNull(11) ? null : reader.GetDateTime(11),
                RelatedTagIds:  reader.IsDBNull(12) ? [] : (int[])reader.GetValue(12),
                AlbumIds:       reader.IsDBNull(13) ? [] : (int[])reader.GetValue(13),
                HasCoreVoiceSynthVocalist: !reader.IsDBNull(14) && reader.GetBoolean(14),
                HasPlayablePv:  !reader.IsDBNull(15) && reader.GetBoolean(15),
                DiscoveryEligible: !reader.IsDBNull(16) && reader.GetBoolean(16),
                QualityScore: reader.IsDBNull(17) ? 0.5 : reader.GetDouble(17),
                HasAudioFeatures: !reader.IsDBNull(18) && reader.GetBoolean(18),
                HasOriginalPv: !reader.IsDBNull(19) && reader.GetBoolean(19)
            );

            _cache.Set($"song:{info.Id}", info, TimeSpan.FromMinutes(30));
            result.Add(info);
        }

        return [.. result];
    }

    public async Task<int[]> GetMetadataRelationshipCandidateIdsAsync(int seedSongId, int limit)
    {
        var normalizedLimit = Math.Clamp(limit, 1, 1000);
        var cacheKey = $"metadata-relationship:{seedSongId}:{normalizedLimit}";
        if (_cache.TryGetValue(cacheKey, out int[]? cached) && cached is not null)
            return cached;

        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
            WITH seed_tags AS (
                SELECT st.tag_id
                FROM song_tags st
                JOIN tags t ON t.id = st.tag_id
                WHERE st.song_id = $1
                  AND COALESCE(t.category, '') <> 'Vocalists'
            ),
            tag_frequency AS (
                SELECT candidate_tag.tag_id, COUNT(*)::double precision AS frequency
                FROM song_tags candidate_tag
                JOIN seed_tags seed_tag ON seed_tag.tag_id = candidate_tag.tag_id
                GROUP BY candidate_tag.tag_id
            )
            SELECT candidate_tag.song_id
            FROM song_tags candidate_tag
            JOIN seed_tags seed_tag ON seed_tag.tag_id = candidate_tag.tag_id
            JOIN tag_frequency frequency ON frequency.tag_id = candidate_tag.tag_id
            JOIN song_discovery_quality quality
              ON quality.song_id = candidate_tag.song_id
             AND quality.discovery_eligible = TRUE
            WHERE candidate_tag.song_id <> $1
            GROUP BY candidate_tag.song_id
            ORDER BY
                SUM(
                    (1.0 + LN(1.0 + LEAST(candidate_tag.tag_count, 20)))
                    / LN(2.0 + frequency.frequency)
                ) DESC,
                COUNT(*) DESC,
                candidate_tag.song_id
            LIMIT $2", conn);
        cmd.Parameters.AddWithValue(seedSongId);
        cmd.Parameters.AddWithValue(normalizedLimit);

        var result = new List<int>(normalizedLimit);
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add(reader.GetInt32(0));

        var ids = result.ToArray();
        _cache.Set(cacheKey, ids, TimeSpan.FromMinutes(15));
        return ids;
    }

    public async Task<int[]> GetDiverseFallbackCandidateIdsAsync(int seedSongId, int limit)
    {
        var normalizedLimit = Math.Clamp(limit, 1, 500);
        var cacheKey = $"diverse-fallback:{seedSongId}:{normalizedLimit}";
        if (_cache.TryGetValue(cacheKey, out int[]? cached) && cached is not null)
            return cached;

        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand($@"
            WITH seed AS (
                SELECT s.id, s.song_type, s.publish_date, sf.state_cluster
                FROM songs s
                LEFT JOIN song_features sf ON sf.song_id = s.id
                WHERE s.id = $1
            ),
            seed_producers AS (
                SELECT artist_id
                FROM song_artists
                WHERE song_id = $1 AND is_producer = TRUE
            )
            SELECT candidate.id
            FROM songs candidate
            CROSS JOIN seed
            JOIN song_discovery_quality quality
              ON quality.song_id = candidate.id
             AND quality.discovery_eligible = TRUE
            LEFT JOIN song_features features ON features.song_id = candidate.id
            WHERE candidate.id <> $1
              AND (
                  seed.publish_date IS NULL
                  OR candidate.publish_date BETWEEN seed.publish_date - 730 AND seed.publish_date + 730
              )
              AND EXISTS (
                  SELECT 1
                  FROM pvs playable
                  WHERE playable.song_id = candidate.id AND playable.disabled = FALSE
              )
              AND EXISTS (
                  SELECT 1
                  FROM song_artists vocalist_credit
                  JOIN artists vocalist ON vocalist.id = vocalist_credit.artist_id
                  WHERE vocalist_credit.song_id = candidate.id
                    AND vocalist_credit.is_vocalist = TRUE
                    AND vocalist.artist_type IN ({VoiceSynthArtistTypesSql})
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM song_artists candidate_producer
                  JOIN seed_producers seed_producer
                    ON seed_producer.artist_id = candidate_producer.artist_id
                  WHERE candidate_producer.song_id = candidate.id
                    AND candidate_producer.is_producer = TRUE
              )
            ORDER BY
                CASE WHEN candidate.song_type = seed.song_type THEN 0 ELSE 1 END,
                CASE
                    WHEN seed.state_cluster IS NOT NULL
                     AND features.state_cluster = seed.state_cluster THEN 0
                    ELSE 1
                END,
                CASE
                    WHEN seed.publish_date IS NULL OR candidate.publish_date IS NULL THEN 100000
                    ELSE ABS(candidate.publish_date - seed.publish_date)
                END,
                quality.quality_score DESC,
                mod(abs(hashtext(candidate.id::text || ':' || seed.id::text))::bigint, 100000),
                candidate.id
            LIMIT $2", conn);
        cmd.Parameters.AddWithValue(seedSongId);
        cmd.Parameters.AddWithValue(normalizedLimit);

        var result = new List<int>(normalizedLimit);
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add(reader.GetInt32(0));

        var ids = result.ToArray();
        _cache.Set(cacheKey, ids, TimeSpan.FromMinutes(15));
        return ids;
    }

    public async Task<List<object>> GetViewHistoryAsync(int songId)
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            SELECT recorded_at, youtube_views, nico_views
            FROM view_history
            WHERE song_id = $1
            ORDER BY recorded_at ASC", conn);
        cmd.Parameters.AddWithValue(songId);

        var result = new List<object>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            result.Add(new
            {
                date = reader.GetDateTime(0).ToString("yyyy-MM-dd"),
                youtube = reader.GetInt64(1),
                nico = reader.GetInt64(2)
            });
        }
        return result;
    }

    public async Task<ViewHistoryResponse> GetViewHistoryWindowAsync(int songId, string range, string bucket)
    {
        var days = range switch
        {
            "7d" => 7,
            "30d" => 30,
            "90d" => 90,
            "all" => (int?)null,
            _ => 30,
        };
        var normalizedBucket = bucket is "day" or "week" or "month" ? bucket : "day";
        var bucketExpression = normalizedBucket switch
        {
            "week" => "date_trunc('week', h.recorded_at AT TIME ZONE 'UTC')::date",
            "month" => "date_trunc('month', h.recorded_at AT TIME ZONE 'UTC')::date",
            _ => "(h.recorded_at AT TIME ZONE 'UTC')::date",
        };

        using var conn = Open();
        await using var cmd = new NpgsqlCommand($@"
            WITH latest AS (
                SELECT MAX(recorded_at) AS latest_at
                FROM view_history
                WHERE song_id = @songId
            ), filtered AS (
                SELECT {bucketExpression} AS bucket_date,
                       h.recorded_at,
                       h.youtube_views,
                       h.nico_views
                FROM view_history h
                CROSS JOIN latest l
                WHERE h.song_id = @songId
                  AND l.latest_at IS NOT NULL
                  AND (@days::int IS NULL OR h.recorded_at >= l.latest_at - (@days::int * interval '1 day'))
            ), points AS (
                -- YouTube/Nico updates are stored as separate snapshots and a song can
                -- have multiple PVs per service. Zero means not observed here; the
                -- service-level maximum matches the aggregate kept on songs.
                SELECT bucket_date,
                       MAX(recorded_at) AS recorded_at,
                       MAX(NULLIF(youtube_views, 0)) AS youtube_views,
                       MAX(NULLIF(nico_views, 0)) AS nico_views,
                       false AS is_baseline
                FROM filtered
                GROUP BY bucket_date
            ), baseline AS (
                SELECT (l.latest_at - (@days::int * interval '1 day'))::date AS bucket_date,
                       l.latest_at - (@days::int * interval '1 day') AS recorded_at,
                       (
                           SELECT MAX(NULLIF(h.youtube_views, 0))
                           FROM view_history h
                           WHERE h.song_id = @songId
                             AND h.recorded_at < l.latest_at - (@days::int * interval '1 day')
                       ) AS youtube_views,
                       (
                           SELECT MAX(NULLIF(h.nico_views, 0))
                           FROM view_history h
                           WHERE h.song_id = @songId
                             AND h.recorded_at < l.latest_at - (@days::int * interval '1 day')
                       ) AS nico_views,
                       true AS is_baseline
                FROM latest l
                WHERE @days::int IS NOT NULL
                  AND l.latest_at IS NOT NULL
            )
            SELECT bucket_date, youtube_views, nico_views, is_baseline
            FROM points
            UNION ALL
            SELECT bucket_date, youtube_views, nico_views, is_baseline
            FROM baseline
            WHERE youtube_views IS NOT NULL OR nico_views IS NOT NULL
            ORDER BY bucket_date ASC", conn);
        cmd.Parameters.AddWithValue("songId", songId);
        cmd.Parameters.Add(new NpgsqlParameter("days", NpgsqlDbType.Integer)
        {
            Value = (object?)days ?? DBNull.Value,
        });

        var points = new List<ViewHistoryPoint>();
        ViewHistoryPoint? baselinePoint = null;
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var point = new ViewHistoryPoint(
                reader.GetDateTime(0).ToString("yyyy-MM-dd"),
                reader.IsDBNull(1) ? null : reader.GetInt64(1),
                reader.IsDBNull(2) ? null : reader.GetInt64(2),
                reader.GetBoolean(3));
            if (point.Baseline) baselinePoint = point;
            else points.Add(point);
        }

        return new ViewHistoryResponse(points, baselinePoint, normalizedBucket);
    }

    public async Task<string> GetTrendingSongsJsonAsync(int days, int start, int maxResults, string? mode = null, string? ranking = null, int seed = 0, bool debug = false, long? minYoutubeViews = null, long? minNicoViews = null, IReadOnlyCollection<string>? excludedSongTypes = null, bool forceRefresh = false)
    {
        var clampedDays = Math.Clamp(days, 1, 365);
        var normalizedStart = Math.Max(0, start);
        var clampedMaxResults = Math.Clamp(maxResults, 1, 100);
        var normalizedMode = mode switch
        {
            "alltime" => "alltime",
            "pace" or "popular" => "pace",
            "surge" => "surge",
            "recent" => "recent",
            "deep" => "deep",
            _ => "growth",
        };
        var normalizedRanking = ranking == "legacy" ? "legacy" : "quality";
        var normalizedSeed = Math.Clamp(seed, 0, 63);
        var normalizedExcludedTypes = (excludedSongTypes ?? []).Where(type => !string.IsNullOrWhiteSpace(type)).Distinct(StringComparer.Ordinal).Order().ToArray();
        var normalizedMinYoutube = minYoutubeViews is > 0 ? minYoutubeViews.Value : 0;
        var normalizedMinNico = minNicoViews is > 0 ? minNicoViews.Value : 0;
        const string songTypeExpression = "COALESCE(NULLIF(s.raw_json->>'songType', ''), s.song_type, 'Unspecified')";
        var cacheKey = $"trending:{normalizedMode}:{normalizedRanking}:{normalizedSeed}:{debug}:{clampedDays}:{normalizedStart}:{clampedMaxResults}:{normalizedMinYoutube}:{normalizedMinNico}:{string.Join(',', normalizedExcludedTypes)}";
        if (!forceRefresh && _cache.TryGetValue(cacheKey, out CachedTrending? cached) && cached is not null)
        {
            if (cached.FreshUntil <= DateTimeOffset.UtcNow && _trendingRefreshes.TryAdd(cacheKey, 0))
            {
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await GetTrendingSongsJsonAsync(
                            days, start, maxResults, mode, ranking, seed, debug,
                            minYoutubeViews, minNicoViews, excludedSongTypes,
                            forceRefresh: true);
                    }
                    catch (Exception exception)
                    {
                        _logger.LogWarning(
                            exception,
                            "trending_cache_refresh_failed key={CacheKey}",
                            cacheKey);
                    }
                    finally
                    {
                        _trendingRefreshes.TryRemove(cacheKey, out _);
                    }
                });
            }
            return cached.ItemsJson;
        }

        var modeCondition = normalizedMode switch
        {
            "surge" when normalizedRanking == "quality" => "AND g.current_window_days >= 3 AND (g.previous_views IS NULL OR (g.baseline_views > g.previous_views AND g.prior_window_days >= 3)) AND g.view_growth >= 750 AND g.surge_rate >= 1.25 AND s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV') AND g.quality_score >= 0.45 AND NOT (g.quality_score < 0.60 AND EXISTS (SELECT 1 FROM unnest(g.quality_reasons) reason WHERE reason LIKE 'negative_tag:%')) AND (s.publish_date >= CURRENT_DATE - interval '180 days' OR g.support_score >= 0.10 OR g.growth_rate >= 0.01)",
            "surge" => $"AND g.previous_views IS NOT NULL AND g.baseline_views > g.previous_views AND g.prior_window_days >= 3 AND g.view_growth >= 1000 AND g.surge_rate >= 1.5 AND {songTypeExpression} IN ('Original', 'Cover', 'Remix', 'Remaster', 'MusicPV')",
            "recent" => "AND s.publish_date >= CURRENT_DATE - interval '30 days'",
            "deep" => "AND g.baseline_views BETWEEN 100 AND 150000",
            _ => string.Empty,
        };
        var normalizedModeCondition = modeCondition.Replace("s.song_type", songTypeExpression, StringComparison.Ordinal);
        var orderBy = normalizedMode switch
        {
            // These four feeds are user-facing rankings. Keep their order
            // independent of the optional exploration seed and break ties by
            // song ID so repeated requests produce the same list.
            "surge" when normalizedRanking == "legacy" => "g.surge_rate DESC, g.view_growth DESC, s.favorited_times DESC NULLS LAST, s.id ASC",
            "surge" => "CASE WHEN g.current_window_days >= 7 AND g.previous_views IS NOT NULL AND g.prior_window_days >= 3 THEN 1 ELSE 0 END DESC, g.trend_tier DESC, g.surge_rank_score DESC, g.view_growth DESC, g.quality_score DESC, s.favorited_times DESC NULLS LAST, s.id ASC",
            "recent" => "g.recent_score DESC, g.view_growth DESC, s.publish_date DESC, s.id ASC",
            "alltime" => "g.popular_score DESC, g.view_growth DESC, s.favorited_times DESC NULLS LAST, s.id ASC",
            "pace" => "g.recent_score DESC, g.view_growth DESC, s.publish_date DESC, s.id ASC",
            "deep" => "g.deep_score DESC, g.quality_score DESC, g.view_growth DESC",
            _ => "g.popular_score + (g.ranking_noise - 0.5) * 0.035 DESC, g.growth_rate DESC, s.favorited_times DESC NULLS LAST",
        };
        var sourceTable = normalizedMode switch
        {
            "alltime" or "pace" or "recent" or "deep" => "catalog_candidates",
            "surge" when normalizedRanking == "quality" => "surge_ranked",
            _ => "growth",
        };
        var surgeRankScoreExpression = sourceTable == "growth"
            ? "0::double precision"
            : "g.surge_rank_score";
        var trendTierExpression = sourceTable == "surge_ranked"
            ? "g.trend_tier"
            : "0";
        // Recent songs are intentionally allowed to have zero recorded views;
        // requiring view_growth > 0 made a freshly published song disappear
        // until the first analytics snapshot arrived.
        var minimumCondition = normalizedMode switch
        {
            "growth" => "g.popular_score > 0",
            "surge" => "g.view_growth > 0",
            "alltime" => "g.popular_score > 0",
            "pace" or "recent" => "g.recent_score > 0",
            _ => "TRUE",
        };
        var debugFields = debug && normalizedMode == "surge"
            ? ", 'qualityScore', ranked.quality_score, 'surgeRankScore', ranked.surge_rank_score, 'qualityReasons', to_jsonb(ranked.quality_reasons)"
            : string.Empty;
        var trendFields = normalizedMode == "surge"
            ? ", 'surgeRate', ranked.surge_rate, 'trendTier', ranked.trend_tier, 'trendWindowDays', ROUND(ranked.current_window_days)"
            : string.Empty;
        var filterConditions = new List<string>();
        var nextFilterParameter = 5;
        if (normalizedMinYoutube > 0) filterConditions.Add($"COALESCE(s.youtube_views, 0) >= ${nextFilterParameter++}");
        if (normalizedMinNico > 0) filterConditions.Add($"COALESCE(s.nico_views, 0) >= ${nextFilterParameter++}");
        if (normalizedExcludedTypes.Length > 0) filterConditions.Add($"{songTypeExpression} <> ALL(${nextFilterParameter})");
        var globalFilterCondition = filterConditions.Count > 0 ? "AND " + string.Join(" AND ", filterConditions) : string.Empty;
        using var conn = Open();
        var viewWeightProfile = await LoadViewWeightProfileAsync(conn);
        var latestTotalViewsSql = WeightedViewsSql("h.youtube_views", "h.nico_views", viewWeightProfile);
        var baselineTotalViewsSql = WeightedViewsSql("h.youtube_views", "h.nico_views", viewWeightProfile);
        var currentSongTotalViewsSql = WeightedViewsSql("s.youtube_views", "s.nico_views", viewWeightProfile);
        var growthNicoWeightSql = NicoWeightSql("b.youtube_views", viewWeightProfile);
        var catalogCandidateSql = normalizedMode switch
        {
            "recent" => "SELECT id FROM songs WHERE publish_date >= CURRENT_DATE - interval '30 days'",
            "alltime" or "pace" => $"""
                SELECT id FROM songs WHERE publish_date >= CURRENT_DATE - interval '90 days'
                UNION
                SELECT id FROM (
                    SELECT s.id
                    FROM songs s
                    WHERE s.publish_date IS NOT NULL
                      AND EXISTS (
                          SELECT 1
                          FROM song_artists sa
                          JOIN artists a ON a.id = sa.artist_id
                          WHERE sa.song_id = s.id
                            AND sa.is_vocalist = TRUE
                            AND a.artist_type IN ({VoiceSynthArtistTypesSql})
                      )
                    ORDER BY s.youtube_views DESC NULLS LAST
                    LIMIT 2000
                ) youtube_top
                UNION
                SELECT id FROM (
                    SELECT s.id
                    FROM songs s
                    WHERE s.publish_date IS NOT NULL
                      AND EXISTS (
                          SELECT 1
                          FROM song_artists sa
                          JOIN artists a ON a.id = sa.artist_id
                          WHERE sa.song_id = s.id
                            AND sa.is_vocalist = TRUE
                            AND a.artist_type IN ({VoiceSynthArtistTypesSql})
                      )
                    ORDER BY s.nico_views DESC NULLS LAST
                    LIMIT 2000
                ) nico_top
                """,
            "deep" => """
                SELECT song_id AS id
                FROM song_discovery_quality
                WHERE discovery_eligible
                ORDER BY quality_score DESC, support_score DESC, song_id
                LIMIT 10000
                """,
            _ => "SELECT id FROM songs WHERE FALSE",
        };
        // A newly initialized daily history cannot provide both a seven-day
        // baseline and the preceding comparison window. During that bootstrap
        // period, surge ranking may use an actual three-to-ten-day window and
        // the existing conservative 100 views/day acceleration floor. Once a
        // song has the complete history, the ORDER BY above always prioritizes
        // the normal seven-day + prior-window evidence.
        var baselineMinimumDays = normalizedMode == "surge" ? 3 : clampedDays;

        await using var cmd = new NpgsqlCommand($@"
            WITH latest_watermark AS (
                SELECT MAX(recorded_at) AS observed_at
                FROM view_history
            ),
            latest AS (
                SELECT DISTINCT ON (h.song_id)
                       h.song_id,
                       h.recorded_at AS observed_at,
                       COALESCE(h.youtube_views, 0) AS youtube_views,
                       COALESCE(h.nico_views, 0) AS nico_views,
                       {latestTotalViewsSql} AS total_views
                FROM view_history h
                JOIN songs latest_song ON latest_song.id = h.song_id
                JOIN song_discovery_quality latest_quality
                  ON latest_quality.song_id = h.song_id
                 AND latest_quality.discovery_eligible = TRUE
                CROSS JOIN latest_watermark watermark
                WHERE watermark.observed_at IS NOT NULL
                  AND h.recorded_at >= watermark.observed_at - interval '24 hours'
                  AND EXISTS (
                      SELECT 1
                      FROM song_artists latest_song_artist
                      JOIN artists latest_artist ON latest_artist.id = latest_song_artist.artist_id
                      WHERE latest_song_artist.song_id = latest_song.id
                        AND latest_song_artist.is_vocalist = TRUE
                        AND latest_artist.artist_type IN ({VoiceSynthArtistTypesSql})
                  )
                  AND EXISTS (
                      SELECT 1 FROM pvs latest_pv
                      WHERE latest_pv.song_id = latest_song.id AND latest_pv.disabled = FALSE
                  )
                ORDER BY h.song_id, h.recorded_at DESC
            ),
            baseline AS (
                SELECT latest.song_id,
                       h.recorded_at AS observed_at,
                       COALESCE(h.youtube_views, 0) AS youtube_views,
                       COALESCE(h.nico_views, 0) AS nico_views,
                       {baselineTotalViewsSql} AS total_views
                FROM latest
                JOIN LATERAL (
                    SELECT history.*
                    FROM view_history history
                    WHERE history.song_id = latest.song_id
                      AND history.recorded_at <= latest.observed_at - ({baselineMinimumDays}::int * interval '1 day')
                      AND history.recorded_at >= latest.observed_at - (($1::int + 3) * interval '1 day')
                    ORDER BY
                      CASE WHEN history.recorded_at <= latest.observed_at - ($1::int * interval '1 day') THEN 0 ELSE 1 END,
                      history.recorded_at DESC
                    LIMIT 1
                ) h ON TRUE
            ),
            previous_baseline AS (
                SELECT baseline.song_id,
                       h.recorded_at AS observed_at,
                       -- Preserve the absence of a preceding window. The
                       -- weighted expression coalesces missing counters to
                       -- zero, which would otherwise turn a missing lateral
                       -- row into previous_views = 0 and reject every
                       -- bootstrap candidate because prior_window_days is
                       -- still NULL.
                       CASE WHEN h.recorded_at IS NULL
                           THEN NULL::double precision
                           ELSE {baselineTotalViewsSql}
                       END AS total_views
                FROM baseline
                LEFT JOIN LATERAL (
                    SELECT history.*
                    FROM view_history history
                    WHERE history.song_id = baseline.song_id
                      AND history.recorded_at <= baseline.observed_at - interval '3 days'
                      AND history.recorded_at >= baseline.observed_at - interval '10 days'
                    ORDER BY history.recorded_at DESC
                    LIMIT 1
                ) h ON TRUE
            ),
            growth AS (
                SELECT
                    s.id AS song_id,
                    b.total_views AS baseline_views,
                    pb.total_views AS previous_views,
                    EXTRACT(EPOCH FROM (l.observed_at - b.observed_at)) / 86400.0 AS current_window_days,
                    EXTRACT(EPOCH FROM (b.observed_at - pb.observed_at)) / 86400.0 AS prior_window_days,
                    (
                        CASE WHEN b.youtube_views >= 100 THEN GREATEST(0, l.youtube_views - b.youtube_views) ELSE 0 END
                        + ({growthNicoWeightSql} * CASE WHEN b.nico_views >= 100 THEN GREATEST(0, l.nico_views - b.nico_views) ELSE 0 END)
                    ) AS view_growth,
                    CASE
                        WHEN b.total_views > 0
                            THEN ((
                                CASE WHEN b.youtube_views >= 100 THEN GREATEST(0, l.youtube_views - b.youtube_views) ELSE 0 END
                                + ({growthNicoWeightSql} * CASE WHEN b.nico_views >= 100 THEN GREATEST(0, l.nico_views - b.nico_views) ELSE 0 END)
                            )::double precision / b.total_views)
                        ELSE 0
                    END AS growth_rate,
                    (
                        ((
                            CASE WHEN b.youtube_views >= 100 THEN GREATEST(0, l.youtube_views - b.youtube_views) ELSE 0 END
                            + ({growthNicoWeightSql} * CASE WHEN b.nico_views >= 100 THEN GREATEST(0, l.nico_views - b.nico_views) ELSE 0 END)
                        )::double precision / GREATEST(1.0, EXTRACT(EPOCH FROM (l.observed_at - b.observed_at)) / 86400.0))
                        / GREATEST(100.0, (GREATEST(0, b.total_views - COALESCE(pb.total_views, b.total_views))::double precision
                          / GREATEST(3.0, EXTRACT(EPOCH FROM (b.observed_at - pb.observed_at)) / 86400.0)))
                    ) AS surge_rate,
                    (
                        CASE WHEN b.youtube_views >= 100
                            THEN LN(1 + GREATEST(0, l.youtube_views - b.youtube_views))
                            ELSE 0.35 * LN(1 + l.youtube_views)
                        END
                        + LN(1 + ({growthNicoWeightSql} * CASE WHEN b.nico_views >= 100
                            THEN GREATEST(0, l.nico_views - b.nico_views)
                            ELSE 0.35 * l.nico_views
                        END))
                        + 0.5 * LN(1 + COALESCE(s.favorited_times, 0))
                    ) AS popular_score,
                    CASE WHEN COALESCE(q.duration_score, 0.5) < 0.50
                        THEN GREATEST(0, COALESCE(q.quality_score, 0.5) - 0.25)
                        ELSE COALESCE(q.quality_score, 0.5)
                    END AS quality_score,
                    COALESCE(q.duration_score, 0.5) AS duration_score,
                    COALESCE(q.support_score, 0) AS support_score,
                    COALESCE(q.reason_codes, ARRAY['quality_missing']::text[]) AS quality_reasons,
                    COALESCE(q.discovery_eligible, FALSE) AS discovery_eligible,
                    (
                        (
                            CASE WHEN b.youtube_views >= 100 THEN GREATEST(0, l.youtube_views - b.youtube_views) ELSE 0 END
                            + ({growthNicoWeightSql} * CASE WHEN b.nico_views >= 100 THEN GREATEST(0, l.nico_views - b.nico_views) ELSE 0 END)
                        )
                        * EXP(-GREATEST(0, CURRENT_DATE - s.publish_date) / 30.0)
                    ) AS recent_score,
                    CASE WHEN $4 = 0 THEN 0.5
                         ELSE mod(abs(hashtext(s.id::text || ':' || $4::text))::bigint, 100000)::double precision / 100000.0
                    END AS ranking_noise
                FROM baseline b
                JOIN songs s ON s.id = b.song_id
                JOIN latest l ON l.song_id = b.song_id
                LEFT JOIN previous_baseline pb ON pb.song_id = b.song_id
                LEFT JOIN song_discovery_quality q ON q.song_id = s.id
            ),
            surge_ranked AS (
                SELECT
                    g.*,
                    PERCENT_RANK() OVER (ORDER BY g.view_growth) AS growth_percentile,
                    PERCENT_RANK() OVER (ORDER BY g.surge_rate) AS acceleration_percentile,
                    PERCENT_RANK() OVER (ORDER BY g.growth_rate) AS relative_growth_percentile,
                    CASE
                        WHEN g.view_growth >= 1000 AND g.surge_rate >= 1.5 THEN 2
                        ELSE 1
                    END AS trend_tier,
                    (
                        0.30 * PERCENT_RANK() OVER (ORDER BY g.view_growth)
                        + 0.25 * PERCENT_RANK() OVER (ORDER BY g.surge_rate)
                        + 0.25 * PERCENT_RANK() OVER (ORDER BY g.growth_rate)
                        + 0.20 * g.quality_score
                    ) AS surge_rank_score
                FROM growth g
            ),
            catalog_candidates AS (
                SELECT
                    s.id AS song_id,
                    {currentSongTotalViewsSql}::double precision AS baseline_views,
                    NULL::double precision AS previous_views,
                    0::double precision AS current_window_days,
                    0::double precision AS prior_window_days,
                    {currentSongTotalViewsSql}::double precision AS view_growth,
                    (
                        {currentSongTotalViewsSql}::double precision
                        / GREATEST(1, CURRENT_DATE - s.publish_date)
                    ) AS growth_rate,
                    0::double precision AS surge_rate,
                    LN(1 + {currentSongTotalViewsSql}) AS popular_score,
                    COALESCE(q.quality_score, 0.5) AS quality_score,
                    COALESCE(q.duration_score, 0.5) AS duration_score,
                    COALESCE(q.support_score, 0) AS support_score,
                    COALESCE(q.reason_codes, ARRAY['quality_missing']::text[]) AS quality_reasons,
                    -- A missing quality row is normal for a newly ingested
                    -- song. Keep explicit FALSE values excluded, but let the
                    -- recent feed surface unscored new releases.
                    COALESCE(q.discovery_eligible, TRUE) AS discovery_eligible,
                    0::double precision AS surge_rank_score,
                    (
                        {currentSongTotalViewsSql}::double precision
                        / GREATEST(1, CURRENT_DATE - s.publish_date)
                    ) AS recent_score,
                    CASE WHEN $4 = 0 THEN 0.5
                         ELSE mod(abs(hashtext(s.id::text || ':' || $4::text))::bigint, 100000)::double precision / 100000.0
                    END AS ranking_noise,
                    (
                        0.60 * COALESCE(q.quality_score, 0.5)
                        + 0.20 * COALESCE(q.support_score, 0)
                        + 0.15 * CASE WHEN EXISTS (
                            SELECT 1 FROM song_features sf
                            WHERE sf.song_id = s.id AND sf.audio_computed IS TRUE
                        ) THEN 1.0 ELSE 0.0 END
                        + 0.05 * CASE WHEN $4 = 0 THEN 0.5
                            ELSE mod(abs(hashtext('deep:' || s.id::text || ':' || $4::text))::bigint, 100000)::double precision / 100000.0
                          END
                    ) AS deep_score
                FROM songs s
                JOIN ({catalogCandidateSql}) candidate ON candidate.id = s.id
                LEFT JOIN song_discovery_quality q ON q.song_id = s.id
                WHERE s.publish_date IS NOT NULL
            ),
            ranked_ids AS (
                SELECT
                    s.id AS song_id,
                    g.view_growth,
                    g.growth_rate,
                    g.surge_rate,
                    g.current_window_days,
                    {trendTierExpression} AS trend_tier,
                    g.quality_score,
                    {surgeRankScoreExpression} AS surge_rank_score,
                    g.quality_reasons,
                    ROW_NUMBER() OVER (ORDER BY {orderBy}) AS rank
                FROM {sourceTable} g
                JOIN songs s ON s.id = g.song_id
                WHERE {minimumCondition}
                  AND g.discovery_eligible
                  {globalFilterCondition}
                  AND EXISTS (
                      SELECT 1
                      FROM song_artists sa
                      JOIN artists a ON a.id = sa.artist_id
                      WHERE sa.song_id = s.id
                        AND sa.is_vocalist = TRUE
                        AND a.artist_type IN ({VoiceSynthArtistTypesSql})
                  )
                  AND EXISTS (
                      SELECT 1 FROM pvs p
                      WHERE p.song_id = s.id AND p.disabled = FALSE
                  )
                  {normalizedModeCondition}
            ),
            limited_ids AS (
                SELECT song_id, view_growth, growth_rate, surge_rate, current_window_days, trend_tier, quality_score, surge_rank_score, quality_reasons, rank
                FROM ranked_ids
                WHERE rank > $2
                ORDER BY rank
                LIMIT $3
            )
            SELECT ((s.raw_json - 'lyrics') || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
                'isSelfCover', s.is_self_cover,
                'hasLyrics', EXISTS (SELECT 1 FROM song_lyrics sl WHERE sl.song_id = s.id),
                'viewGrowth', ranked.view_growth,
                'growthRate', ranked.growth_rate,
                'audioComputed', EXISTS (
                    SELECT 1 FROM song_features sf
                    WHERE sf.song_id = s.id AND sf.audio_computed IS TRUE
                ),
                'chorusStartSeconds', (SELECT aa.chorus_start_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusEndSeconds', (SELECT aa.chorus_end_seconds FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'chorusConfidence', (SELECT aa.chorus_confidence FROM song_audio_analysis aa WHERE aa.song_id = s.id),
                'thumbUrl', COALESCE(s.raw_json->>'thumbUrl', s.raw_json->'pvs'->0->>'thumbUrl'){trendFields}{debugFields}
            )))::text
            FROM limited_ids ranked
            JOIN songs s ON s.id = ranked.song_id
            ORDER BY ranked.rank", conn);
        cmd.Parameters.AddWithValue(clampedDays);
        cmd.Parameters.AddWithValue(normalizedStart);
        cmd.Parameters.AddWithValue(clampedMaxResults);
        cmd.Parameters.AddWithValue(normalizedSeed);
        if (normalizedMinYoutube > 0) cmd.Parameters.AddWithValue(normalizedMinYoutube);
        if (normalizedMinNico > 0) cmd.Parameters.AddWithValue(normalizedMinNico);
        if (normalizedExcludedTypes.Length > 0) cmd.Parameters.Add(new NpgsqlParameter { Value = normalizedExcludedTypes, NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text });

        var items = new List<string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            items.Add(reader.GetString(0));
        }

        var json = items.Count > 0 ? "[" + string.Join(",", items) + "]" : "[]";
        _cache.Set(
            cacheKey,
            new CachedTrending(json, DateTimeOffset.UtcNow.AddMinutes(5)),
            TimeSpan.FromHours(6));
        return json;
    }

    // ---- マルコフ遷移確率 -----------------------------------------

    public async Task<Dictionary<int, Dictionary<int, double>>> LoadMarkovMatrixAsync()
    {
        const string cacheKey = "markov_matrix";
        if (_cache.TryGetValue(cacheKey, out Dictionary<int, Dictionary<int, double>>? m))
            return m!;

        using var conn = Open();
        await using var cmd = new NpgsqlCommand(
            "SELECT from_state, to_state, probability FROM markov_transitions", conn);
        await using var reader = await cmd.ExecuteReaderAsync();

        var matrix = new Dictionary<int, Dictionary<int, double>>();
        while (await reader.ReadAsync())
        {
            var from = reader.GetInt32(0);
            var to   = reader.GetInt32(1);
            var prob = reader.GetDouble(2);
            if (!matrix.TryGetValue(from, out var row))
                matrix[from] = row = [];
            row[to] = prob;
        }

        _cache.Set(cacheKey, matrix, TimeSpan.FromHours(1));
        return matrix;
    }

    // ---- プロデューサー関連曲 (知識グラフ) ------------------------

    public async Task<int[]> GetSongsByProducersAsync(int[] producerIds, int excludeSongId, int limit)
    {
        if (producerIds.Length == 0) return [];
        using var conn = Open();
        await using var cmd = new NpgsqlCommand($@"
            SELECT DISTINCT sa.song_id
            FROM song_artists sa
            WHERE sa.artist_id = ANY($1)
              AND sa.is_producer = TRUE
              AND sa.song_id <> $2
              AND EXISTS (
                  SELECT 1 FROM songs s
                  WHERE s.id = sa.song_id
                    AND s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV')
                    AND EXISTS (
                        SELECT 1 FROM song_discovery_quality dq
                        WHERE dq.song_id = s.id AND dq.discovery_eligible = TRUE
                    )
              )
              AND EXISTS (
                  SELECT 1 FROM song_artists synth_artist
                  JOIN artists synth ON synth.id = synth_artist.artist_id
                  WHERE synth_artist.song_id = sa.song_id
                    AND synth_artist.is_vocalist = TRUE
                    AND synth.artist_type IN ({VoiceSynthArtistTypesSql})
              )
              AND EXISTS (
                  SELECT 1 FROM pvs p
                  WHERE p.song_id = sa.song_id AND p.disabled = FALSE
              )
            ORDER BY sa.song_id
            LIMIT $3", conn);
        cmd.Parameters.AddWithValue(producerIds);
        cmd.Parameters.AddWithValue(excludeSongId);
        cmd.Parameters.AddWithValue(limit);

        var result = new List<int>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add(reader.GetInt32(0));
        return [..result];
    }

    /// <summary>
    /// 同一プロデューサーの楽曲を人気順で取得する。
    /// </summary>
    public async Task<List<(int SongId, string Name, string ArtistString)>> GetSongsByProducerAsync(
        int seedSongId, int limit)
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand($@"
            SELECT s.id, s.name, s.artist_string
            FROM songs s
            WHERE EXISTS (
                SELECT 1
                FROM song_artists candidate_artist
                WHERE candidate_artist.song_id = s.id
                  AND candidate_artist.is_producer = TRUE
                  AND candidate_artist.artist_id IN (
                      SELECT seed_artist.artist_id
                      FROM song_artists seed_artist
                      WHERE seed_artist.song_id = $1
                        AND seed_artist.is_producer = TRUE
                  )
            )
            AND s.id <> $1
            AND s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV')
            AND EXISTS (
                SELECT 1 FROM song_discovery_quality dq
                WHERE dq.song_id = s.id AND dq.discovery_eligible = TRUE
            )
            AND EXISTS (
                SELECT 1 FROM song_artists synth_artist
                JOIN artists synth ON synth.id = synth_artist.artist_id
                WHERE synth_artist.song_id = s.id
                  AND synth_artist.is_vocalist = TRUE
                  AND synth.artist_type IN ({VoiceSynthArtistTypesSql})
            )
            AND EXISTS (SELECT 1 FROM pvs WHERE pvs.song_id = s.id AND pvs.disabled = FALSE)
            ORDER BY s.favorited_times DESC NULLS LAST
            LIMIT $2", conn);
        cmd.Parameters.AddWithValue(seedSongId);
        cmd.Parameters.AddWithValue(limit);

        var result = new List<(int, string, string)>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add((reader.GetInt32(0), reader.GetString(1), reader.GetString(2)));
        return result;
    }
}

public record SongInfo(
    int     Id,
    string  Name,
    string  ArtistString,
    int     LengthSeconds,
    string  SongType,
    int     FavoritedTimes,
    int     StateCluster,
    int[]   ProducerIds,
    int[]   VocalistIds,
    long    YoutubeViews,
    long    NicoViews,
    DateTime? PublishDate,
    int[]   RelatedTagIds,
    int[]   AlbumIds,
    bool    HasCoreVoiceSynthVocalist,
    bool    HasPlayablePv,
    bool    DiscoveryEligible,
    double  QualityScore,
    bool    HasAudioFeatures,
    bool    HasOriginalPv
);
