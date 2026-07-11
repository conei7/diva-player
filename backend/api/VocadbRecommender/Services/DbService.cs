using Microsoft.Extensions.Caching.Memory;
using Npgsql;
using System.Diagnostics;

namespace VocadbRecommender.Services;

/// <summary>PostgreSQL アクセスサービス</summary>
public class DbService
{
    private readonly string _connStr;
    private readonly IMemoryCache _cache;

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

    public async Task<(string ItemsJson, int TotalCount)> SearchSongsAsync(
        string? query,
        List<int>? artistIds,
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
        string? audioComputed = null)
    {
        using var conn = Open();
        
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
            conditions.Add($"song_type IN ({string.Join(", ", typeParams)})");
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
            if (totalCount == 0) return ("[]", 0);
        }

        // --- 4. データ取得 (行単位で読み取り、C#側でJSON配列構築) ---
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
        return (itemsJson, totalCount);
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
        await using var cmd = new NpgsqlCommand(@"
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
                   s.youtube_views, s.nico_views
            FROM songs s
            LEFT JOIN song_features sf ON sf.song_id = s.id
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
                NicoViews:      reader.IsDBNull(10) ? 0 : reader.GetInt64(10)
            );

            _cache.Set($"song:{info.Id}", info, TimeSpan.FromMinutes(30));
            result.Add(info);
        }

        return [.. result];
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

    public async Task<string> GetTrendingSongsJsonAsync(int days, int start, int maxResults)
    {
        var clampedDays = Math.Clamp(days, 1, 365);
        var normalizedStart = Math.Max(0, start);
        var clampedMaxResults = Math.Clamp(maxResults, 1, 100);
        var cacheKey = $"trending:{clampedDays}:{normalizedStart}:{clampedMaxResults}";
        if (_cache.TryGetValue(cacheKey, out string? cached))
            return cached!;

        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            WITH baseline_day AS (
                SELECT date_trunc('day', MAX(recorded_at)) AS day
                FROM view_history
                WHERE recorded_at <= now() - ($1::int * interval '1 day')
            ),
            baseline AS (
                SELECT DISTINCT ON (h.song_id)
                       h.song_id,
                       COALESCE(h.youtube_views, 0) + COALESCE(h.nico_views, 0) AS total_views
                FROM view_history h
                CROSS JOIN baseline_day d
                WHERE d.day IS NOT NULL
                  AND h.recorded_at >= d.day
                  AND h.recorded_at < d.day + interval '1 day'
                ORDER BY h.song_id, h.recorded_at ASC
            ),
            growth AS (
                SELECT
                    s.id AS song_id,
                    GREATEST(0, COALESCE(s.youtube_views, 0) + COALESCE(s.nico_views, 0) - b.total_views) AS view_growth,
                    CASE
                        WHEN b.total_views > 0
                            THEN ((COALESCE(s.youtube_views, 0) + COALESCE(s.nico_views, 0) - b.total_views)::double precision / b.total_views)
                        ELSE 0
                    END AS growth_rate
                FROM baseline b
                JOIN songs s ON s.id = b.song_id
            )
            SELECT (s.raw_json || jsonb_strip_nulls(jsonb_build_object(
                'youtubeViews', s.youtube_views,
                'nicoViews', s.nico_views,
                'viewGrowth', g.view_growth,
                'growthRate', g.growth_rate,
                'audioComputed', EXISTS (
                    SELECT 1 FROM song_features sf
                    WHERE sf.song_id = s.id AND sf.audio_computed IS TRUE
                ),
                'thumbUrl', COALESCE(s.raw_json->>'thumbUrl', s.raw_json->'pvs'->0->>'thumbUrl')
            )))::text
            FROM growth g
            JOIN songs s ON s.id = g.song_id
            WHERE g.view_growth > 0
              AND EXISTS (
                  SELECT 1 FROM pvs p
                  WHERE p.song_id = s.id AND p.disabled = FALSE
              )
            ORDER BY g.view_growth DESC, g.growth_rate DESC, s.favorited_times DESC NULLS LAST
            OFFSET $2 LIMIT $3", conn);
        cmd.Parameters.AddWithValue(clampedDays);
        cmd.Parameters.AddWithValue(normalizedStart);
        cmd.Parameters.AddWithValue(clampedMaxResults);

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
        await using var cmd = new NpgsqlCommand(@"
            SELECT DISTINCT sa.song_id
            FROM song_artists sa
            WHERE sa.artist_id = ANY($1)
              AND sa.is_producer = TRUE
              AND sa.song_id <> $2
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
        await using var cmd = new NpgsqlCommand(@"
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
    long    NicoViews
);
