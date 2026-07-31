using Microsoft.Extensions.Caching.Memory;
using Npgsql;
using NpgsqlTypes;
using System.Diagnostics;
using System.Globalization;
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
    private sealed record CachedSongSearch(string ItemsJson, int TotalCount);

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

    public DbService(IConfiguration cfg, IMemoryCache cache)
    {
        _connStr = cfg.GetConnectionString("Postgres")
            ?? throw new InvalidOperationException("ConnectionStrings:Postgres is not configured");
        _cache = cache;
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

    public async Task<YouTubePlaylistCache?> GetYouTubePlaylistCacheAsync(string playlistId, CancellationToken cancellationToken)
    {
        await using var conn = await OpenAsync();
        await using var cmd = new NpgsqlCommand(@"
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
            SELECT p.pv_id, (s.raw_json || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
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

    public async Task<AudioFeatureHealth> CheckAudioFeatureHealthAsync(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        try
        {
            await using var conn = await OpenAsync();
            await using var cmd = new NpgsqlCommand(@"
                WITH actionable_targets AS (
                    SELECT s.id, sf.audio_computed
                    FROM songs s
                    JOIN pvs p ON p.song_id = s.id
                        AND p.disabled = FALSE
                        AND p.pv_type IN ('Original', 'Reprint')
                    LEFT JOIN song_features sf ON sf.song_id = s.id
                    WHERE (s.nico_views >= $1 OR s.youtube_views >= $2)
                      AND (
                          s.song_type = 'Original'
                          OR (
                              s.song_type <> 'Original'
                              AND s.raw_json->>'originalVersionId' IS NOT NULL
                              AND EXISTS (
                                  SELECT 1
                                  FROM song_artists sa_cover
                                  JOIN song_artists sa_orig ON sa_cover.artist_id = sa_orig.artist_id
                                  WHERE sa_cover.song_id = s.id
                                    AND sa_cover.is_producer = TRUE
                                    AND sa_orig.song_id = (s.raw_json->>'originalVersionId')::int
                                    AND sa_orig.is_producer = TRUE
                              )
                          )
                      )
                      AND EXISTS (
                          SELECT 1
                          FROM song_artists sa_vocal
                          JOIN artists a_vocal ON a_vocal.id = sa_vocal.artist_id
                          WHERE sa_vocal.song_id = s.id
                            AND sa_vocal.is_vocalist = TRUE
                            AND a_vocal.artist_type IN (" + VoiceSynthArtistTypesSql + @")
                      )
                    GROUP BY s.id, sf.audio_computed
                ), high_view_pool AS (
                    SELECT s.id, sf.audio_computed, sf.computed_at
                    FROM songs s
                    LEFT JOIN song_features sf ON sf.song_id = s.id
                    WHERE s.nico_views >= $1 OR s.youtube_views >= $2
                )
                SELECT COUNT(*)::bigint,
                       COUNT(*) FILTER (WHERE audio_computed IS TRUE)::bigint,
                       COUNT(*) FILTER (WHERE audio_computed IS NOT TRUE)::bigint,
                       MAX(computed_at) FILTER (WHERE audio_computed IS TRUE),
                       (SELECT COUNT(*)::bigint FROM actionable_targets),
                       (SELECT COUNT(*) FILTER (WHERE audio_computed IS TRUE)::bigint FROM actionable_targets),
                       (SELECT COUNT(*) FILTER (WHERE audio_computed IS NOT TRUE)::bigint FROM actionable_targets)
                FROM high_view_pool", conn)
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
        long? minYoutubeViews = null,
        long? minNicoViews = null,
        bool onlyWithPVs = false,
        List<string>? excludedSongTypes = null,
        bool voiceSynthOnly = false,
        bool discoveryOnly = false)
    {
        var totalStopwatch = Stopwatch.StartNew();
        var cacheKey = "song-search:v1:" + JsonSerializer.Serialize(new
        {
            query = query?.Trim().ToLowerInvariant(),
            artistIds,
            anyArtistIds,
            artistIdGroups,
            artistRole,
            songTypes,
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
            minYoutubeViews,
            minNicoViews,
            onlyWithPVs,
            excludedSongTypes,
            voiceSynthOnly,
            discoveryOnly,
        });
        if (_cache.TryGetValue(cacheKey, out CachedSongSearch? cached) && cached is not null)
        {
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

        string whereClause = conditions.Count > 0 ? "WHERE " + string.Join(" AND ", conditions) : "";
        bool hasFilter = conditions.Count > 0;

        // --- 2. ORDER BY 句の構築 ---
        string orderBy = sort switch
        {
            "YoutubeViews" => "youtube_views",
            "NicoViews" => "nico_views",
            "TotalViews" => "(COALESCE(youtube_views, 0) + COALESCE(nico_views, 0))",
            "FavoritedTimes" => "favorited_times",
            "RatingScore" => "rating_score",
            "PublishDate" => "publish_date",
            "AdditionDate" => "id",
            "Name" => "name",
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
                var emptyResult = new CachedSongSearch("[]", 0);
                _cache.Set(cacheKey, emptyResult, TimeSpan.FromMinutes(1));
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
            SELECT raw_json || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', youtube_views,
                'nicoViews', nico_views,
                'audioComputed', EXISTS (
                    SELECT 1 FROM song_features sf
                    WHERE sf.song_id = songs.id AND sf.audio_computed IS TRUE
                ),
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
        var result = new CachedSongSearch(itemsJson, totalCount);
        _cache.Set(cacheKey, result, TimeSpan.FromMinutes(1));
        return new SongSearchExecution(
            result.ItemsJson,
            result.TotalCount,
            connectionStopwatch.ElapsedMilliseconds,
            countStopwatch.ElapsedMilliseconds,
            dataStopwatch.ElapsedMilliseconds,
            totalStopwatch.ElapsedMilliseconds,
            false);
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
                DiscoveryEligible: !reader.IsDBNull(16) && reader.GetBoolean(16)
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

    public async Task<string> GetTrendingSongsJsonAsync(int days, int start, int maxResults, string? mode = null, string? ranking = null, int seed = 0, bool debug = false, long? minYoutubeViews = null, long? minNicoViews = null, IReadOnlyCollection<string>? excludedSongTypes = null)
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
        if (_cache.TryGetValue(cacheKey, out string? cached))
            return cached!;

        var modeCondition = normalizedMode switch
        {
            "surge" when normalizedRanking == "quality" => "AND g.previous_views IS NOT NULL AND g.baseline_views > g.previous_views AND g.prior_window_days >= 3 AND g.view_growth >= 1000 AND g.surge_rate >= 1.5 AND s.song_type IN ('Original', 'Cover', 'Remix', 'Remaster', 'Arrangement', 'Mashup', 'MusicPV') AND NOT (g.quality_score < 0.30 AND g.duration_score < 0.50 AND g.support_score < 0.30) AND NOT (g.quality_score < 0.35 AND g.support_score < 0.30 AND EXISTS (SELECT 1 FROM unnest(g.quality_reasons) reason WHERE reason LIKE 'negative_tag:%'))",
            "surge" => $"AND g.previous_views IS NOT NULL AND g.baseline_views > g.previous_views AND g.prior_window_days >= 3 AND g.view_growth >= 1000 AND g.surge_rate >= 1.5 AND {songTypeExpression} IN ('Original', 'Cover', 'Remix', 'Remaster', 'MusicPV')",
            "recent" => "AND s.publish_date >= CURRENT_DATE - interval '30 days'",
            "deep" => "AND g.baseline_views BETWEEN 100 AND 150000",
            _ => string.Empty,
        };
        var normalizedModeCondition = modeCondition.Replace("s.song_type", songTypeExpression, StringComparison.Ordinal);
        var orderBy = normalizedMode switch
        {
            "surge" when normalizedRanking == "legacy" => "g.surge_rate + (g.ranking_noise - 0.5) * 0.025 DESC, g.view_growth DESC, s.favorited_times DESC NULLS LAST",
            "surge" => "g.surge_rank_score + (g.ranking_noise - 0.5) * 0.025 DESC, g.view_growth DESC, g.quality_score DESC, s.favorited_times DESC NULLS LAST",
            "recent" => "g.recent_score + (g.ranking_noise - 0.5) * 0.015 DESC, g.view_growth DESC, s.publish_date DESC",
            "alltime" => "g.popular_score + (g.ranking_noise - 0.5) * 0.015 DESC, g.view_growth DESC, s.favorited_times DESC NULLS LAST",
            "pace" => "g.recent_score + (g.ranking_noise - 0.5) * 0.015 DESC, g.view_growth DESC, s.publish_date DESC",
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

        await using var cmd = new NpgsqlCommand($@"
            WITH baseline_day AS (
                SELECT date_trunc('day', MAX(recorded_at)) AS day
                FROM view_history
                WHERE recorded_at <= now() - ($1::int * interval '1 day')
            ),
            latest_day AS (
                SELECT date_trunc('day', MAX(recorded_at)) AS day
                FROM view_history
            ),
            latest AS (
                SELECT DISTINCT ON (h.song_id)
                       h.song_id,
                       COALESCE(h.youtube_views, 0) AS youtube_views,
                       COALESCE(h.nico_views, 0) AS nico_views,
                       {latestTotalViewsSql} AS total_views
                FROM view_history h
                CROSS JOIN latest_day d
                WHERE d.day IS NOT NULL
                  AND h.recorded_at >= d.day
                  AND h.recorded_at < d.day + interval '1 day'
                ORDER BY h.song_id, h.recorded_at DESC
            ),
            baseline AS (
                SELECT DISTINCT ON (h.song_id)
                       h.song_id,
                       h.recorded_at AS observed_at,
                       COALESCE(h.youtube_views, 0) AS youtube_views,
                       COALESCE(h.nico_views, 0) AS nico_views,
                       {baselineTotalViewsSql} AS total_views
                FROM view_history h
                CROSS JOIN baseline_day d
                WHERE d.day IS NOT NULL
                  AND h.recorded_at >= d.day
                  AND h.recorded_at < d.day + interval '1 day'
                ORDER BY h.song_id, h.recorded_at ASC
            ),
            previous_baseline AS (
                SELECT DISTINCT ON (h.song_id)
                       h.song_id,
                       h.recorded_at AS observed_at,
                       {baselineTotalViewsSql} AS total_views
                FROM view_history h
                CROSS JOIN baseline_day d
                WHERE d.day IS NOT NULL
                  AND h.recorded_at < d.day - interval '3 days'
                ORDER BY h.song_id, h.recorded_at DESC
            ),
            growth AS (
                SELECT
                    s.id AS song_id,
                    b.total_views AS baseline_views,
                    pb.total_views AS previous_views,
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
                        )::double precision / $1)
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
                    (
                        0.45 * PERCENT_RANK() OVER (ORDER BY g.view_growth)
                        + 0.30 * PERCENT_RANK() OVER (ORDER BY g.surge_rate)
                        + 0.25 * g.quality_score
                    ) AS surge_rank_score
                FROM growth g
            ),
            catalog_candidates AS (
                SELECT
                    s.id AS song_id,
                    {currentSongTotalViewsSql}::double precision AS baseline_views,
                    NULL::double precision AS previous_views,
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
                SELECT song_id, view_growth, growth_rate, quality_score, surge_rank_score, quality_reasons, rank
                FROM ranked_ids
                WHERE rank > $2
                ORDER BY rank
                LIMIT $3
            )
            SELECT (s.raw_json || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
                'viewGrowth', ranked.view_growth,
                'growthRate', ranked.growth_rate,
                'audioComputed', EXISTS (
                    SELECT 1 FROM song_features sf
                    WHERE sf.song_id = s.id AND sf.audio_computed IS TRUE
                ),
                'thumbUrl', COALESCE(s.raw_json->>'thumbUrl', s.raw_json->'pvs'->0->>'thumbUrl'){debugFields}
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
        _cache.Set(cacheKey, json, TimeSpan.FromMinutes(5));
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
    bool    DiscoveryEligible
);
