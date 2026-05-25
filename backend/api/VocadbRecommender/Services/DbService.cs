using Microsoft.Extensions.Caching.Memory;
using Npgsql;

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

    // ---- 楽曲情報 -------------------------------------------------

    public async Task<SongInfo?> GetSongInfoAsync(int songId)
    {
        var key = $"song:{songId}";
        if (_cache.TryGetValue(key, out SongInfo? cached))
            return cached;

        using var conn = Open();
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
            WHERE s.id = $1", conn);
        cmd.Parameters.AddWithValue(songId);

        await using var reader = await cmd.ExecuteReaderAsync();
        if (!await reader.ReadAsync()) return null;

        var info = new SongInfo(
            Id:           reader.GetInt32(0),
            Name:         reader.GetString(1),
            ArtistString: reader.IsDBNull(2) ? "" : reader.GetString(2),
            LengthSeconds: reader.IsDBNull(3) ? 0 : reader.GetInt32(3),
            SongType:     reader.IsDBNull(4) ? "" : reader.GetString(4),
            FavoritedTimes: reader.IsDBNull(5) ? 0 : reader.GetInt32(5),
            StateCluster: reader.IsDBNull(6) ? -1 : reader.GetInt32(6),
            ProducerIds:  reader.IsDBNull(7) ? [] : (int[])reader.GetValue(7),
            VocalistIds:  reader.IsDBNull(8) ? [] : (int[])reader.GetValue(8),
            YoutubeViews: reader.IsDBNull(9) ? 0 : reader.GetInt64(9),
            NicoViews:    reader.IsDBNull(10) ? 0 : reader.GetInt64(10)
        );

        _cache.Set(key, info, TimeSpan.FromMinutes(30));
        return info;
    }

    public async Task<SongInfo[]> GetSongInfoBatchAsync(IEnumerable<int> songIds)
    {
        var ids = songIds.ToArray();
        var tasks = ids.Select(id => GetSongInfoAsync(id));
        var results = await Task.WhenAll(tasks);
        return results.OfType<SongInfo>().ToArray();
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

    // ---- セッション -----------------------------------------------

    public async Task<string> CreateSessionAsync()
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand(
            "INSERT INTO play_sessions DEFAULT VALUES RETURNING session_id", conn);
        var result = await cmd.ExecuteScalarAsync();
        return result!.ToString()!;
    }

    public async Task RecordPlayAsync(string sessionId, int songId)
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO session_plays (session_id, song_id)
            VALUES ($1::uuid, $2)", conn);
        cmd.Parameters.AddWithValue(sessionId);
        cmd.Parameters.AddWithValue(songId);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<int[]> GetSessionHistoryAsync(string sessionId)
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            SELECT song_id FROM session_plays
            WHERE session_id = $1::uuid
            ORDER BY played_at DESC
            LIMIT 50", conn);
        cmd.Parameters.AddWithValue(sessionId);

        var result = new List<int>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add(reader.GetInt32(0));
        return [..result];
    }

    // ---- 暗黙的フィードバック (再生完了率) -----------------------

    /// <summary>
    /// 同一プロデューサーの楽曲を人気順で取得する。
    /// </summary>
    public async Task<List<(int SongId, string Name, string ArtistString)>> GetSongsByProducerAsync(
        int seedSongId, int limit)
    {
        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            SELECT DISTINCT s.id, s.name, s.artist_string
            FROM songs s
            JOIN song_artists sa ON sa.song_id = s.id AND sa.is_producer = TRUE
            WHERE sa.artist_id IN (
                SELECT artist_id FROM song_artists
                WHERE song_id = $1 AND is_producer = TRUE
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

    /// <summary>
    /// 再生完了率 (0.0-1.0) をEMAで song_features.implicit_score に蓄積する。
    /// signal = (completionRate - 0.5) * 2 → -1 (即スキップ) 〜 +1 (最後まで再生)
    /// EMA: score = (old_score * n + signal) / (n + 1)
    /// </summary>
    public async Task UpdateImplicitScoreAsync(int songId, double completionRate)
    {
        var signal = Math.Clamp((completionRate - 0.5) * 2.0, -1.0, 1.0);

        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            INSERT INTO song_features (song_id, implicit_score, implicit_count)
            VALUES ($1, $2, 1)
            ON CONFLICT (song_id) DO UPDATE SET
                implicit_score = (
                    COALESCE(song_features.implicit_score, 0) * COALESCE(song_features.implicit_count, 0)
                    + EXCLUDED.implicit_score
                ) / (COALESCE(song_features.implicit_count, 0) + 1),
                implicit_count = COALESCE(song_features.implicit_count, 0) + 1", conn);
        cmd.Parameters.AddWithValue(songId);
        cmd.Parameters.AddWithValue(signal);
        await cmd.ExecuteNonQueryAsync();

        // キャッシュを無効化
        _cache.Remove($"song:{songId}");
    }

    /// <summary>
    /// 複数曲の implicit_score を一括取得する。
    /// キャッシュにないものだけDBから引く。
    /// </summary>
    public async Task<Dictionary<int, double>> GetImplicitScoreMapAsync(IEnumerable<int> songIds)
    {
        var ids  = songIds.Distinct().ToArray();
        var result = new Dictionary<int, double>();

        if (ids.Length == 0) return result;

        using var conn = Open();
        await using var cmd = new NpgsqlCommand(@"
            SELECT song_id, implicit_score
            FROM song_features
            WHERE song_id = ANY($1)
              AND implicit_score IS NOT NULL
              AND implicit_score <> 0", conn);
        cmd.Parameters.AddWithValue(ids);

        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result[reader.GetInt32(0)] = reader.GetDouble(1);

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
